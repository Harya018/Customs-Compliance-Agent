from fastapi import APIRouter, Request, HTTPException, Depends, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from typing import Optional
from models.database import mask_email
from controllers.auth_controller import (
    create_user, authenticate_user, create_access_token, create_refresh_token,
    decode_token, set_otp_for_user, send_otp_email, verify_user_otp, get_user_by_id,
    get_or_create_user_by_google, verify_google_token
)

auth_router = APIRouter()
bearer_scheme = HTTPBearer(auto_error=False)


def get_current_user(credentials: Optional[HTTPAuthorizationCredentials] = Depends(bearer_scheme)) -> dict:
    if not credentials:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    payload = decode_token(credentials.credentials)
    if payload is None or payload.get("type") != "access":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired token")
    user = get_user_by_id(payload.get("sub", ""))
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")
    return user


@auth_router.post("/register")
async def register(request: Request):
    body = await request.json()
    user = create_user(body.get("email", "").strip(), body.get("password", ""))
    return {
        "access_token": create_access_token({"sub": user["id"]}),
        "refresh_token": create_refresh_token({"sub": user["id"]}),
        "token_type": "bearer",
        "user": {"id": user["id"], "email": mask_email(user["email"]), "role": user["role"]}
    }


@auth_router.post("/login")
async def login(request: Request):
    body = await request.json()
    user = authenticate_user(body.get("email", "").strip(), body.get("password", ""))
    if not user:
        raise HTTPException(status_code=401, detail="Invalid credentials")

    # MFA flow — only if mfa_enabled is True in DB
    if user.get("mfa_enabled") == 1:
        otp = set_otp_for_user(user["id"])
        send_otp_email(user["email"], otp)
        return {
            "mfa_required": True,
            "user_id": user["id"],
            "message": "OTP sent to your email"
        }

    # Standard login — existing behavior
    return {
        "access_token": create_access_token({"sub": user["id"]}),
        "refresh_token": create_refresh_token({"sub": user["id"]}),
        "token_type": "bearer",
        "user": {"id": user["id"], "email": mask_email(user["email"]), "role": user["role"]}
    }


@auth_router.post("/verify-otp")
async def verify_otp_endpoint(request: Request):
    body = await request.json()
    user_id = body.get("user_id")
    otp = body.get("otp")

    if not user_id or not otp:
        raise HTTPException(status_code=400, detail="user_id and otp are required")

    if not verify_user_otp(user_id, otp):
        raise HTTPException(status_code=401, detail="Invalid or expired OTP. Please try again.")

    user = get_user_by_id(user_id)
    if not user:
        raise HTTPException(status_code=401, detail="User not found")

    return {
        "access_token": create_access_token({"sub": user["id"]}),
        "refresh_token": create_refresh_token({"sub": user["id"]}),
        "token_type": "bearer",
        "user": {"id": user["id"], "email": mask_email(user["email"]), "role": user["role"]}
    }


@auth_router.post("/google")
async def google_login(request: Request):
    """Google OAuth login — verify token, find/create user, return JWT."""
    try:
        body = await request.json()
        token = body.get("token")
        if not token:
            raise HTTPException(status_code=400, detail="Google token is required")

        google_user = await verify_google_token(token)
        user = get_or_create_user_by_google(google_user["email"], google_user["google_id"])

        return {
            "access_token": create_access_token({"sub": user["id"]}),
            "refresh_token": create_refresh_token({"sub": user["id"]}),
            "token_type": "bearer",
            "user": {"id": user["id"], "email": mask_email(user["email"]), "role": user["role"]}
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=401, detail=f"Google login failed: {str(e)}")


@auth_router.post("/refresh")
async def refresh(request: Request):
    payload = decode_token((await request.json()).get("refresh_token", ""))
    if not payload or payload.get("type") != "refresh":
        raise HTTPException(status_code=401)
    return {"access_token": create_access_token({"sub": payload["sub"]}), "token_type": "bearer"}


@auth_router.get("/me")
async def me(current_user: dict = Depends(get_current_user)):
    return {
        "id": current_user["id"],
        "email": mask_email(current_user["email"]),
        "role": current_user["role"]
    }
