import uuid
import os
import smtplib
from email.message import EmailMessage
import random
from datetime import datetime, timedelta, timezone
from typing import Optional
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

def hash_password(plain: str) -> str:
    salt = bcrypt.gensalt()
    return bcrypt.hashpw(plain.encode('utf-8'), salt).decode('utf-8')

def verify_password(plain: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(plain.encode('utf-8'), hashed.encode('utf-8'))
    except ValueError:
        return False

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

def create_user(email: str, password: str, role: str = "user") -> dict:
    conn = get_user_db()
    # Check if exists first because email is encrypted so UNIQUE constraint natively on encrypted string works
    clean_email = email.lower().strip()
    enc_email = encrypt_pii(clean_email)
    
    # Verify if email exists
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
    # Needs to match both encrypted and legacy active cleartext emails
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

def authenticate_user(email: str, password: str) -> Optional[dict]:
    user = get_user_by_email(email)
    if not user:
        return None
    if not verify_password(password, user["password_hash"]):
        return None
    return user

def generate_otp() -> str:
    return str(random.randint(100000, 999999))

def set_otp_for_user(uid: str) -> str:
    otp = generate_otp()
    expires = (datetime.now(timezone.utc) + timedelta(minutes=10)).isoformat()
    
    conn = get_user_db()
    conn.execute("UPDATE users SET otp_code = ?, otp_expires = ? WHERE id = ?", (otp, expires, uid))
    conn.commit()
    return otp

def verify_user_otp(uid: str, otp: str) -> bool:
    conn = get_user_db()
    row = conn.execute("SELECT otp_code, otp_expires FROM users WHERE id = ?", (uid,)).fetchone()
    if not row or not row["otp_code"]:
        return False
        
    expires = datetime.fromisoformat(row["otp_expires"])
    if datetime.now(timezone.utc) > expires or row["otp_code"] != otp:
        return False
        
    # Clear OTP after successful use
    conn.execute("UPDATE users SET otp_code = NULL, otp_expires = NULL WHERE id = ?", (uid,))
    conn.commit()
    return True

def send_otp_email(to_email: str, otp: str):
    if not EMAIL_USER or not EMAIL_PASS:
        print(f"WARNING: Email credentials not set. OTP is: {otp}")
        return
        
    try:
        msg = EmailMessage()
        msg.set_content(f"Your Customs Compliance Agent verification code is: {otp}\n\nThis code expires in 10 minutes.")
        msg['Subject'] = 'Your Login Verification Code'
        msg['From'] = EMAIL_USER
        msg['To'] = to_email

        with smtplib.SMTP_SSL('smtp.gmail.com', 465) as server:
            server.login(EMAIL_USER, EMAIL_PASS)
            server.send_message(msg)
    except Exception as e:
        print(f"Failed to send OTP email: {e}")
