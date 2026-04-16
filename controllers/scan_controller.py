import uuid
import json
from datetime import datetime, timezone
from typing import Optional, List
from models.database import get_scan_db

def create_scan(user_id: str, filename: str, country: str) -> str:
    """Insert a new scan record; returns the new scan_id."""
    conn = get_scan_db()
    sid = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()
    conn.execute(
        "INSERT INTO scans (id, user_id, filename, country, status, result_json, created_at) VALUES (?,?,?,?,?,?,?)",
        (sid, user_id, filename, country, "pending", None, now)
    )
    conn.commit()
    return sid

def update_scan_result(scan_id: str, status: str, result: dict):
    """Update a scan with its final status and JSON result."""
    conn = get_scan_db()
    conn.execute(
        "UPDATE scans SET status=?, result_json=? WHERE id=?",
        (status, json.dumps(result), scan_id)
    )
    conn.commit()

def get_scan_by_id(scan_id: str, user_id: Optional[str] = None) -> Optional[dict]:
    """Return a single scan. If user_id given, enforce ownership (unless admin)."""
    conn = get_scan_db()
    if user_id:
        row = conn.execute(
            "SELECT * FROM scans WHERE id=? AND user_id=?", (scan_id, user_id)
        ).fetchone()
    else:
        row = conn.execute("SELECT * FROM scans WHERE id=?", (scan_id,)).fetchone()
    if not row:
        return None
    d = dict(row)
    if d.get("result_json"):
        try:
            d["result"] = json.loads(d["result_json"])
        except Exception:
            d["result"] = None
    else:
        d["result"] = None
    return d

def get_scans_for_user(user_id: str, limit: int = 20) -> List[dict]:
    """Return latest scans for a given user."""
    conn = get_scan_db()
    rows = conn.execute(
        "SELECT * FROM scans WHERE user_id=? ORDER BY created_at DESC LIMIT ?",
        (user_id, limit)
    ).fetchall()
    results = []
    for row in rows:
        d = dict(row)
        if d.get("result_json"):
            try:
                d["result"] = json.loads(d["result_json"])
            except Exception:
                d["result"] = None
        else:
            d["result"] = None
        results.append(d)
    return results

def get_all_scans(limit: int = 100) -> List[dict]:
    """Admin only: return all scans."""
    conn = get_scan_db()
    rows = conn.execute(
        "SELECT * FROM scans ORDER BY created_at DESC LIMIT ?", (limit,)
    ).fetchall()
    results = []
    for row in rows:
        d = dict(row)
        if d.get("result_json"):
            try:
                d["result"] = json.loads(d["result_json"])
            except Exception:
                d["result"] = None
        else:
            d["result"] = None
        results.append(d)
    return results
