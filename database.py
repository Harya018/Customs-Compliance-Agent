"""
database.py — Scan History Storage
SQLite (scans.db) using raw sqlite3. No ORM.
"""

import sqlite3
import uuid
import json
import os
from datetime import datetime, timezone
from typing import Optional, List

DB_PATH = os.path.join(os.path.dirname(__file__), "scans.db")


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_scans_db():
    conn = get_db()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS scans (
            id          TEXT PRIMARY KEY,
            user_id     TEXT NOT NULL,
            filename    TEXT NOT NULL,
            country     TEXT NOT NULL,
            status      TEXT NOT NULL DEFAULT 'pending',
            result_json TEXT,
            created_at  TEXT NOT NULL
        )
    """)
    conn.commit()
    conn.close()


# ── CRUD ───────────────────────────────────────────────────────────────────────

def create_scan(user_id: str, filename: str, country: str) -> str:
    """Insert a new scan record; returns the new scan_id."""
    conn = get_db()
    try:
        sid = str(uuid.uuid4())
        now = datetime.now(timezone.utc).isoformat()
        conn.execute(
            "INSERT INTO scans (id, user_id, filename, country, status, result_json, created_at) VALUES (?,?,?,?,?,?,?)",
            (sid, user_id, filename, country, "pending", None, now)
        )
        conn.commit()
        return sid
    finally:
        conn.close()


def update_scan_result(scan_id: str, status: str, result: dict):
    """Update a scan with its final status and JSON result."""
    conn = get_db()
    try:
        conn.execute(
            "UPDATE scans SET status=?, result_json=? WHERE id=?",
            (status, json.dumps(result), scan_id)
        )
        conn.commit()
    finally:
        conn.close()


def get_scan_by_id(scan_id: str, user_id: Optional[str] = None) -> Optional[dict]:
    """Return a single scan. If user_id given, enforce ownership (unless admin)."""
    conn = get_db()
    try:
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
    finally:
        conn.close()


def get_scans_for_user(user_id: str, limit: int = 20) -> List[dict]:
    """Return latest scans for a given user."""
    conn = get_db()
    try:
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
    finally:
        conn.close()


def get_all_scans(limit: int = 100) -> List[dict]:
    """Admin only: return all scans."""
    conn = get_db()
    try:
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
    finally:
        conn.close()


# Initialise on import
init_scans_db()
