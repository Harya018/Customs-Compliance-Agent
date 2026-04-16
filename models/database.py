"""
models/database.py — PostgreSQL Data Layer (SQLAlchemy)

ROLE: Replaces SQLite singletons with a PostgreSQL-backed SQLAlchemy engine.
      All existing function signatures are preserved exactly so no callers change.
      Fernet PII encryption is applied identically — encrypt before store, decrypt
      after read. The engine uses QueuePool with pool_pre_ping so dropped connections
      are never surfaced to callers.
"""
import os
import json
import uuid
import logging
from datetime import datetime, timezone
from typing import Optional, List
from cryptography.fernet import Fernet

from sqlalchemy import create_engine, Column, String, Text
from sqlalchemy.orm import declarative_base, sessionmaker, scoped_session
from sqlalchemy.pool import QueuePool

logger = logging.getLogger("customs_agent")

# ── Encryption (identical to SQLite version) ───────────────────────────────────
ENCRYPTION_KEY = os.getenv("ENCRYPTION_KEY")
if not ENCRYPTION_KEY:
    ENCRYPTION_KEY = Fernet.generate_key().decode()
cipher_suite = Fernet(ENCRYPTION_KEY.encode())


def encrypt_pii(data: str) -> str:
    if not data:
        return data
    return cipher_suite.encrypt(data.encode()).decode()


def decrypt_pii(encrypted_data: str) -> str:
    if not encrypted_data:
        return encrypted_data
    try:
        return cipher_suite.decrypt(encrypted_data.encode()).decode()
    except Exception:
        return encrypted_data  # Legacy cleartext fallback


def mask_email(email: str) -> str:
    if not email or "@" not in email:
        return email
    parts = email.split("@")
    if len(parts[0]) > 1:
        return f"{parts[0][0]}***@{parts[1]}"
    return f"***@{parts[1]}"


# ── Database URL ───────────────────────────────────────────────────────────────
DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgresql://customs_user:customs_secure_password_2024@localhost:5432/customs_agent"
)

Base = declarative_base()

# ── Singleton engine + session factory ────────────────────────────────────────
_engine = None
_SessionFactory = None


def get_engine():
    global _engine
    if _engine is None:
        _engine = create_engine(
            DATABASE_URL,
            poolclass=QueuePool,
            pool_size=10,
            max_overflow=20,
            pool_pre_ping=True,   # validate connections on checkout
            pool_recycle=300,     # recycle every 5 min to avoid stale sockets
            echo=False
        )
    return _engine


def get_session():
    global _SessionFactory
    if _SessionFactory is None:
        _SessionFactory = scoped_session(
            sessionmaker(bind=get_engine(), autocommit=False, autoflush=False)
        )
    return _SessionFactory()


# ── ORM Models ─────────────────────────────────────────────────────────────────
class User(Base):
    __tablename__ = "users"
    id            = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    email         = Column(String, unique=True, nullable=False)
    password_hash = Column(String, nullable=False)
    role          = Column(String, default="user", nullable=False)
    created_at    = Column(String, nullable=False)
    mfa_enabled   = Column(String, default="0")
    otp_code      = Column(String, nullable=True)
    otp_expires   = Column(String, nullable=True)


class Scan(Base):
    __tablename__ = "scans"
    id          = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id     = Column(String, nullable=False)
    filename    = Column(String, nullable=False)
    country     = Column(String, nullable=False)
    status      = Column(String, default="pending", nullable=False)
    result_json = Column(Text, nullable=True)
    created_at  = Column(String, nullable=False)


def row_to_dict(obj) -> Optional[dict]:
    if obj is None:
        return None
    return {c.name: getattr(obj, c.name) for c in obj.__table__.columns}


def init_db():
    """Create all tables if they don't exist. Called once on app startup."""
    Base.metadata.create_all(get_engine())
    logger.info("PostgreSQL tables initialised (create_all ran)")


# ── Backward-compat stubs (controllers call these directly) ────────────────────
def get_user_db():
    """Backward-compat shim — returns a SQLAlchemy session (not sqlite3 conn)."""
    return get_session()


def get_scan_db():
    """Backward-compat shim — returns a SQLAlchemy session."""
    return get_session()


# ── User DB functions ──────────────────────────────────────────────────────────
def get_all_users_raw() -> list:
    """Return all user rows as dicts (used by auth_controller for email scan)."""
    session = get_session()
    try:
        users = session.query(User).all()
        return [row_to_dict(u) for u in users]
    finally:
        session.close()


def create_user_record(id: str, email: str, password_hash: str,
                       role: str, created_at: str) -> dict:
    session = get_session()
    try:
        user = User(id=id, email=email, password_hash=password_hash,
                    role=role, created_at=created_at, mfa_enabled="0")
        session.add(user)
        session.commit()
        return row_to_dict(user)
    except Exception as e:
        session.rollback()
        raise e
    finally:
        session.close()


def get_user_by_email_raw(email_encrypted: str) -> Optional[dict]:
    session = get_session()
    try:
        user = session.query(User).filter(User.email == email_encrypted).first()
        return row_to_dict(user)
    finally:
        session.close()


def get_user_by_id_raw(uid: str) -> Optional[dict]:
    session = get_session()
    try:
        user = session.query(User).filter(User.id == uid).first()
        return row_to_dict(user)
    finally:
        session.close()


def update_user_otp(user_id: str, otp_code: str, otp_expires: str):
    session = get_session()
    try:
        user = session.query(User).filter(User.id == user_id).first()
        if user:
            user.otp_code = otp_code
            user.otp_expires = otp_expires
            session.commit()
    except Exception as e:
        session.rollback()
        raise e
    finally:
        session.close()


def clear_user_otp(user_id: str):
    session = get_session()
    try:
        user = session.query(User).filter(User.id == user_id).first()
        if user:
            user.otp_code = None
            user.otp_expires = None
            session.commit()
    except Exception as e:
        session.rollback()
        raise e
    finally:
        session.close()


# ── Scan DB functions ─────────────────────────────────────────────────────────
def create_scan(user_id: str, filename: str, country: str) -> str:
    session = get_session()
    try:
        scan_id = str(uuid.uuid4())
        now = datetime.now(timezone.utc).isoformat()
        scan = Scan(id=scan_id, user_id=user_id, filename=filename,
                    country=country, status="pending",
                    result_json=None, created_at=now)
        session.add(scan)
        session.commit()
        return scan_id
    except Exception as e:
        session.rollback()
        raise e
    finally:
        session.close()


def update_scan_result(scan_id: str, status: str, result: dict):
    session = get_session()
    try:
        scan = session.query(Scan).filter(Scan.id == scan_id).first()
        if scan:
            scan.status = status
            scan.result_json = json.dumps(result)
            session.commit()
    except Exception as e:
        session.rollback()
        raise e
    finally:
        session.close()


def get_scan_by_id(scan_id: str, user_id: Optional[str] = None) -> Optional[dict]:
    session = get_session()
    try:
        query = session.query(Scan).filter(Scan.id == scan_id)
        if user_id:
            query = query.filter(Scan.user_id == user_id)
        scan = query.first()
        if not scan:
            return None
        d = row_to_dict(scan)
        d["result"] = json.loads(d["result_json"]) if d.get("result_json") else None
        return d
    finally:
        session.close()


def get_scans_for_user(user_id: str, limit: int = 20) -> List[dict]:
    session = get_session()
    try:
        scans = (session.query(Scan)
                 .filter(Scan.user_id == user_id)
                 .order_by(Scan.created_at.desc())
                 .limit(limit).all())
        results = []
        for scan in scans:
            d = row_to_dict(scan)
            d["result"] = json.loads(d["result_json"]) if d.get("result_json") else None
            results.append(d)
        return results
    finally:
        session.close()


def get_all_scans(limit: int = 100) -> List[dict]:
    session = get_session()
    try:
        scans = (session.query(Scan)
                 .order_by(Scan.created_at.desc())
                 .limit(limit).all())
        results = []
        for scan in scans:
            d = row_to_dict(scan)
            d["result"] = json.loads(d["result_json"]) if d.get("result_json") else None
            results.append(d)
        return results
    finally:
        session.close()
