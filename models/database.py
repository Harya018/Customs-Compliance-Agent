import sqlite3
import os
import logging
from cryptography.fernet import Fernet

DB_DIR = os.path.dirname(os.path.dirname(__file__))
USERS_DB_PATH = os.path.join(DB_DIR, "users.db")
SCANS_DB_PATH = os.path.join(DB_DIR, "scans.db")

ENCRYPTION_KEY = os.getenv("ENCRYPTION_KEY")
if not ENCRYPTION_KEY:
    ENCRYPTION_KEY = Fernet.generate_key().decode()
cipher_suite = Fernet(ENCRYPTION_KEY.encode())

# Singletons
_user_db_conn = None
_scan_db_conn = None


def get_user_db():
    global _user_db_conn
    if _user_db_conn is None:
        _user_db_conn = sqlite3.connect(USERS_DB_PATH, check_same_thread=False)
        _user_db_conn.row_factory = sqlite3.Row
    return _user_db_conn


def get_scan_db():
    global _scan_db_conn
    if _scan_db_conn is None:
        _scan_db_conn = sqlite3.connect(SCANS_DB_PATH, check_same_thread=False)
        _scan_db_conn.row_factory = sqlite3.Row
    return _scan_db_conn


def encrypt_pii(data: str) -> str:
    if not data: return data
    return cipher_suite.encrypt(data.encode()).decode()


def decrypt_pii(encrypted_data: str) -> str:
    if not encrypted_data: return encrypted_data
    try:
        return cipher_suite.decrypt(encrypted_data.encode()).decode()
    except Exception:
        return encrypted_data


def mask_email(email: str) -> str:
    if not email or "@" not in email: return email
    parts = email.split("@")
    if len(parts[0]) > 1:
        return f"{parts[0][0]}***@{parts[1]}"
    return f"***@{parts[1]}"


def init_db():
    # USERS DB
    u_conn = get_user_db()
    u_conn.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id          TEXT PRIMARY KEY,
            email       TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            role        TEXT NOT NULL DEFAULT 'user',
            created_at  TEXT NOT NULL
        )
    """)
    u_conn.commit()

    # Soft migration — each column in its own try/except so existing DBs don't crash
    for col_def in [
        "ALTER TABLE users ADD COLUMN mfa_enabled BOOLEAN DEFAULT 0",
        "ALTER TABLE users ADD COLUMN otp_code TEXT",
        "ALTER TABLE users ADD COLUMN otp_expires TEXT",
    ]:
        try:
            u_conn.execute(col_def)
            u_conn.commit()
        except sqlite3.OperationalError:
            pass  # Column already exists

    # SCANS DB
    s_conn = get_scan_db()
    s_conn.execute("""
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
    s_conn.commit()
