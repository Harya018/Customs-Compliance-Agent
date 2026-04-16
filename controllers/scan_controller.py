"""
controllers/scan_controller.py — Scan CRUD (PostgreSQL)

All function signatures identical to SQLite version.
Delegates entirely to models.database — no raw SQL in this layer.
"""
from typing import Optional, List
from models.database import (
    create_scan as _db_create_scan,
    update_scan_result as _db_update_scan_result,
    get_scan_by_id as _db_get_scan_by_id,
    get_scans_for_user as _db_get_scans_for_user,
    get_all_scans as _db_get_all_scans,
)

def create_scan(user_id: str, filename: str, country: str) -> str:
    """Insert a new scan record; returns the new scan_id."""
    return _db_create_scan(user_id, filename, country)

def update_scan_result(scan_id: str, status: str, result: dict):
    """Update a scan with its final status and JSON result."""
    _db_update_scan_result(scan_id, status, result)

def get_scan_by_id(scan_id: str, user_id: Optional[str] = None) -> Optional[dict]:
    """Return a single scan. If user_id given, enforce ownership."""
    return _db_get_scan_by_id(scan_id, user_id)

def get_scans_for_user(user_id: str, limit: int = 20) -> List[dict]:
    """Return latest scans for a given user."""
    return _db_get_scans_for_user(user_id, limit)

def get_all_scans(limit: int = 100) -> List[dict]:
    """Admin only: return all scans."""
    return _db_get_all_scans(limit)
