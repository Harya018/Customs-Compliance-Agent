import uuid
import os
import secrets
import smtplib
from email.message import EmailMessage
from datetime import datetime, timedelta, timezone
from typing import Optional
import httpx
from fastapi import HTTPException
import bcrypt
from jose import JWTError, jwt

from models.database import get_user_db, encrypt_pii, decrypt_pii

JWT_SECRET = os.getenv("JWT_SECRET", "customs_agent_secret_key_2024")
ALGORITHM  = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES  = 30
REFRESH_TOKEN_EXPIRE_DAYS    = 7

EMAIL_USER = os.getenv("EMAIL_USER", "")
EMAIL_PASS = os.getenv("EMAIL_PASS", "")
GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID", "")

# ── Password helpers ──────────────────────────────────────────────────────────
def hash_password(plain: str) -> str:
    salt = bcrypt.gensalt()
    return bcrypt.hashpw(plain.encode('utf-8'), salt).decode('utf-8')

def verify_password(plain: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(plain.encode('utf-8'), hashed.encode('utf-8'))
    except ValueError:
        return False

# ── JWT helpers ───────────────────────────────────────────────────────────────
def create_access_token(data: dict) -> str:
    payload = data.copy()
    payload["exp"] = datetime.now(timezone.utc) + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    payload["type"] = "access"
    return jwt.encode(payload, JWT_SECRET, algorithm=ALGORITHM)

def create_refresh_token(data: dict) -> str:
    payload = data.copy()
    payload["exp"] = datetime.now(timezone.utc) + timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS)
    payload["type"] = "refresh"
    return jwt.encode(payload, JWT_SECRET, algorithm=ALGORITHM)

def decode_token(token: str) -> Optional[dict]:
    try:
        return jwt.decode(token, JWT_SECRET, algorithms=[ALGORITHM])
    except JWTError:
        return None

# ── User CRUD ─────────────────────────────────────────────────────────────────
def create_user(email: str, password: str, role: str = "user") -> dict:
    conn = get_user_db()
    clean_email = email.lower().strip()
    enc_email = encrypt_pii(clean_email)

    row = conn.execute("SELECT id FROM users WHERE email = ? OR email = ?", (enc_email, clean_email)).fetchone()
    if row:
        raise HTTPException(status_code=409, detail="Email already registered")

    uid = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()
    ph  = hash_password(password)

    conn.execute(
        "INSERT INTO users (id, email, password_hash, role, created_at, mfa_enabled) VALUES (?,?,?,?,?,?)",
        (uid, enc_email, ph, role, now, 0)
    )
    conn.commit()
    return {"id": uid, "email": clean_email, "role": role, "created_at": now}

def get_user_by_email(email: str) -> Optional[dict]:
    conn = get_user_db()
    clean_email = email.lower().strip()
    rows = conn.execute("SELECT * FROM users").fetchall()
    for row in rows:
        d = dict(row)
        decrypted = decrypt_pii(d["email"])
        if decrypted == clean_email or d["email"] == clean_email:
            d["email"] = decrypted
            return d
    return None

def get_user_by_id(uid: str) -> Optional[dict]:
    conn = get_user_db()
    row = conn.execute("SELECT * FROM users WHERE id = ?", (uid,)).fetchone()
    if row:
        d = dict(row)
        d["email"] = decrypt_pii(d["email"])
        return d
    return None

def get_or_create_user_by_google(email: str, google_id: str) -> dict:
    """Find existing user by email or create new one for Google OAuth."""
    existing = get_user_by_email(email)
    if existing:
        return existing
    # Create new user with no password (Google-only login)
    conn = get_user_db()
    clean_email = email.lower().strip()
    enc_email = encrypt_pii(clean_email)
    uid = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()
    # Use google_id as a placeholder password hash (user cannot log in with password)
    ph = hash_password(google_id + JWT_SECRET)
    conn.execute(
        "INSERT INTO users (id, email, password_hash, role, created_at, mfa_enabled) VALUES (?,?,?,?,?,?)",
        (uid, enc_email, ph, "user", now, 0)
    )
    conn.commit()
    return {"id": uid, "email": clean_email, "role": "user", "created_at": now}

def authenticate_user(email: str, password: str) -> Optional[dict]:
    user = get_user_by_email(email)
    if not user:
        return None
    if not verify_password(password, user["password_hash"]):
        return None
    return user

# ── MFA / OTP helpers ─────────────────────────────────────────────────────────
def generate_otp() -> str:
    """Generate cryptographically secure 6-digit OTP."""
    return str(secrets.randbelow(1000000)).zfill(6)

def store_otp(user_id: str, otp: str) -> None:
    """Store hashed OTP and expiry (10 minutes) in users table."""
    otp_hash = hash_password(otp)
    expires = (datetime.now(timezone.utc) + timedelta(minutes=10)).isoformat()
    conn = get_user_db()
    conn.execute(
        "UPDATE users SET otp_code = ?, otp_expires = ? WHERE id = ?",
        (otp_hash, expires, user_id)
    )
    conn.commit()

def verify_otp(user_id: str, otp: str) -> bool:
    """Verify OTP against stored hash, check expiry, clear after success."""
    conn = get_user_db()
    row = conn.execute("SELECT otp_code, otp_expires FROM users WHERE id = ?", (user_id,)).fetchone()
    if not row or not row["otp_code"]:
        return False
    try:
        expires = datetime.fromisoformat(row["otp_expires"])
        if datetime.now(timezone.utc) > expires:
            return False
        if not verify_password(otp, row["otp_code"]):
            return False
        # Clear OTP after successful use
        conn.execute("UPDATE users SET otp_code = NULL, otp_expires = NULL WHERE id = ?", (user_id,))
        conn.commit()
        return True
    except Exception:
        return False

# Keep legacy aliases for existing code compatibility
def set_otp_for_user(uid: str) -> str:
    otp = generate_otp()
    store_otp(uid, otp)
    return otp

def verify_user_otp(uid: str, otp: str) -> bool:
    return verify_otp(uid, otp)

def send_otp_email(to_email: str, otp: str) -> None:
    """Send OTP via Gmail SMTP. Prints to console if credentials not set."""
    if not EMAIL_USER or not EMAIL_PASS:
        print(f"[OTP TEST MODE] OTP for {to_email}: {otp}")
        return
    try:
        msg = EmailMessage()
        msg['Subject'] = 'Your Customs Agent OTP'
        msg['From'] = EMAIL_USER
        msg['To'] = to_email
        msg.set_content(f"Your OTP is: {otp}. Valid for 10 minutes.")
        with smtplib.SMTP('smtp.gmail.com', 587) as server:
            server.starttls()
            server.login(EMAIL_USER, EMAIL_PASS)
            server.send_message(msg)
    except Exception as e:
        print(f"Failed to send OTP email: {e}")

# ── Google OAuth helpers ──────────────────────────────────────────────────────
async def verify_google_token(token: str) -> dict:
    """Verify Google access token and return user email + google_id."""
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.get(
                f"https://www.googleapis.com/oauth2/v1/userinfo?access_token={token}",
                timeout=10.0
            )
            if resp.status_code != 200:
                raise HTTPException(status_code=401, detail="Invalid Google token")
            data = resp.json()
            if not data.get("email"):
                raise HTTPException(status_code=401, detail="Google token missing email")
            return {"email": data["email"], "google_id": data.get("id", "")}
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=401, detail="Google token verification failed")
