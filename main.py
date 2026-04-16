from fastapi import FastAPI, UploadFile, File, Form, Depends, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request as StarletteRequest
import subprocess, json, os, shutil, uuid
import httpx
import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from datetime import datetime, timezone

from dotenv import load_dotenv
load_dotenv()

from auth import (
    get_current_user, create_user, authenticate_user,
    create_access_token, create_refresh_token, decode_token
)
from database import (
    create_scan, update_scan_result,
    get_scan_by_id, get_scans_for_user, get_all_scans
)

UIROBOT   = r"C:\Users\harya\AppData\Local\Programs\UiPathPlatform\Studio\26.0.190-cloud.22532\UiRobot.exe"
PACKAGE   = r"C:\CustomsAgent\CustomsComplianceAgent.1.0.1.nupkg"
GROQ_KEY  = os.getenv("", "")
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379")
EMAIL_USER = os.getenv("EMAIL_USER", "")
EMAIL_PASS = os.getenv("EMAIL_PASS", "")

app = FastAPI(title="Customs Compliance Agent API", version="2.0.0")

class ForceCORSMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: StarletteRequest, call_next):
        if request.method == "OPTIONS":
            from starlette.responses import Response
            response = Response()
            response.headers["Access-Control-Allow-Origin"] = "*"
            response.headers["Access-Control-Allow-Methods"] = "*"
            response.headers["Access-Control-Allow-Headers"] = "*"
            return response
        response = await call_next(request)
        response.headers["Access-Control-Allow-Origin"] = "*"
        response.headers["Access-Control-Allow-Methods"] = "*"
        response.headers["Access-Control-Allow-Headers"] = "*"
        return response

app.add_middleware(ForceCORSMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

def get_redis_queue():
    try:
        import redis
        from rq import Queue
        r = redis.from_url(REDIS_URL)
        r.ping()
        return Queue("customs_queue", connection=r)
    except Exception:
        return None

def _extract_fields(raw: str) -> dict:
    import re
    try:
        outer = json.loads(raw)
        inner = json.loads(outer.get("out_ResultJSON", "{}"))
        content = inner.get("openai_response", {}).get("choices", [{}])[0].get(
            "message", {}).get("content", "")
        matches = list(re.finditer(r"```json\n([\s\S]*?)```", content))
        if not matches:
            return {}
        parsed = json.loads(matches[-1].group(1))
        return {
            "Exporter": (
                parsed.get("Exporter", {}).get("Name") or
                parsed.get("Exporter", {}).get("CompanyName") or
                (parsed.get("Exporter") if isinstance(parsed.get("Exporter"), str) else "") or
                parsed.get("exporter") or ""
            ),
            "Origin": (
                parsed.get("Origin", {}).get("Country")
                if isinstance(parsed.get("Origin"), dict)
                else parsed.get("Origin") or parsed.get("origin") or ""
            ),
            "Value": (
                parsed.get("Value", {}).get("amount")
                if isinstance(parsed.get("Value"), dict)
                else parsed.get("Value") or parsed.get("value") or ""
            ),
            "Currency": (
                parsed.get("Value", {}).get("currency")
                if isinstance(parsed.get("Value"), dict)
                else parsed.get("Currency") or parsed.get("currency") or "USD"
            ),
            "Goods": (
                parsed.get("Description of Goods", {}).get("Goods") or
                parsed.get("Goods") or parsed.get("goods") or
                parsed.get("Goods_Description") or ""
            ),
            "HSCode": (
                parsed.get("Tariff Classification", {}).get("HS Code") or
                parsed.get("HS Code") or parsed.get("HSCode") or
                parsed.get("HS_Code") or parsed.get("hsCode") or ""
            ),
        }
    except Exception:
        return {}

COUNTRY_RULES = {
    "IN":  {"max_value_usd": 800,  "restricted": ["9301","9302"]},
    "UAE": {"max_value_usd": 1000, "restricted": ["9301","9302","2402"]},
    "USA": {"max_value_usd": 800,  "restricted": ["9301"]},
}

def _check_compliance(fields: dict, country: str) -> list:
    rules = COUNTRY_RULES.get(country, {})
    issues = []
    try:
        val = float(fields.get("Value") or 0)
        if val > rules.get("max_value_usd", float("inf")):
            issues.append(f"Value USD {val} exceeds {country} threshold of USD {rules['max_value_usd']}")
    except Exception:
        pass
    hs = str(fields.get("HSCode") or "")
    for r in rules.get("restricted", []):
        if hs.startswith(r):
            issues.append(f"HS Code {hs} is restricted for {country} imports")
    return issues


# ── AUTH ───────────────────────────────────────────────────────────────────────

@app.post("/auth/register")
async def register(request: Request):
    body = await request.json()
    email = body.get("email", "").strip()
    password = body.get("password", "")
    if not email or not password:
        raise HTTPException(status_code=400, detail="email and password required")
    if len(password) < 6:
        raise HTTPException(status_code=400, detail="Password must be at least 6 characters")
    user = create_user(email, password)
    return {
        "access_token": create_access_token({"sub": user["id"]}),
        "refresh_token": create_refresh_token({"sub": user["id"]}),
        "token_type": "bearer",
        "user": {"id": user["id"], "email": user["email"], "role": user["role"]}
    }

@app.post("/auth/login")
async def login(request: Request):
    body = await request.json()
    user = authenticate_user(body.get("email", "").strip(), body.get("password", ""))
    if not user:
        raise HTTPException(status_code=401, detail="Invalid email or password")
    return {
        "access_token": create_access_token({"sub": user["id"]}),
        "refresh_token": create_refresh_token({"sub": user["id"]}),
        "token_type": "bearer",
        "user": {"id": user["id"], "email": user["email"], "role": user["role"]}
    }

@app.post("/auth/refresh")
async def refresh(request: Request):
    body = await request.json()
    payload = decode_token(body.get("refresh_token", ""))
    if not payload or payload.get("type") != "refresh":
        raise HTTPException(status_code=401, detail="Invalid or expired refresh token")
    return {"access_token": create_access_token({"sub": payload["sub"]}), "token_type": "bearer"}

@app.get("/auth/me")
async def me(current_user: dict = Depends(get_current_user)):
    return {"id": current_user["id"], "email": current_user["email"],
            "role": current_user["role"], "created_at": current_user["created_at"]}


# ── ANALYZE ────────────────────────────────────────────────────────────────────

@app.post("/analyze")
async def analyze(
    file: UploadFile = File(...),
    country: str = Form(...),
    send_email_flag: str = Form("false"),
    current_user: dict = Depends(get_current_user)
):
    filename = file.filename
    temp_path = f"C:\\CustomsAgent\\temp_{uuid.uuid4().hex}_{filename}"

    with open(temp_path, "wb") as f:
        shutil.copyfileobj(file.file, f)

    scan_id = create_scan(current_user["id"], filename, country)
    user_email = current_user["email"] if send_email_flag.lower() == "true" else None

    queue = get_redis_queue()
    if queue:
        job = queue.enqueue(
            'worker.process_document',
            temp_path, country, GROQ_KEY, scan_id, user_email,
            send_email_flag.lower() == "true",
            job_timeout=180
        )
        return {"job_id": job.id, "scan_id": scan_id, "status": "queued",
                "message": "Document queued for processing"}

    # Fallback: synchronous
    result = subprocess.run(
        [UIROBOT, "execute", "--file", PACKAGE,
         "--input", json.dumps({
             "in_FilePath": temp_path,
             "in_Country": country,
             "in_OpenAI_Key": GROQ_KEY
         })],
        capture_output=True, text=True, timeout=120
    )
    if os.path.exists(temp_path):
        os.remove(temp_path)

    fields = _extract_fields(result.stdout)
    issues = _check_compliance(fields, country) if fields else []
    payload = {
        "raw_output": result.stdout,
        "error": result.stderr,
        "status": "success" if result.returncode == 0 else "error",
        "fields": fields,
        "issues": issues,
    }
    update_scan_result(scan_id, payload["status"], payload)
    return {**payload, "scan_id": scan_id, "job_id": None}


# ── JOB STATUS ─────────────────────────────────────────────────────────────────

@app.get("/job/{job_id}")
async def job_status(job_id: str, current_user: dict = Depends(get_current_user)):
    try:
        import redis as redis_lib
        from rq.job import Job as RQJob
        r = redis_lib.from_url(REDIS_URL)
        job = RQJob.fetch(job_id, connection=r)
        status = job.get_status()
        if status == "finished":
            return {"job_id": job_id, "status": "finished", "result": job.result}
        elif status == "failed":
            return {"job_id": job_id, "status": "failed", "error": str(job.exc_info)}
        else:
            return {"job_id": job_id, "status": str(status)}
    except Exception as e:
        raise HTTPException(status_code=404, detail=f"Job not found: {e}")


# ── EXPLAIN ────────────────────────────────────────────────────────────────────

@app.post("/explain")
async def explain(request: Request, current_user: dict = Depends(get_current_user)):
    body = await request.json()
    fields = body.get("fields", {})
    country = body.get("country", "IN")
    issues = body.get("issues", [])

    prompt = f"""You are a customs compliance expert. A document has been analyzed:
Fields: {json.dumps(fields)}
Country: {country}
Issues: {issues}
Provide:
1. VERDICT: Compliant or Needs Action
2. ISSUES: List each issue
3. FIXES: Exact steps to resolve
4. RISK: Low/Medium/High and why
Be specific and concise."""

    async with httpx.AsyncClient() as client:
        response = await client.post(
            "https://api.groq.com/openai/v1/chat/completions",
            headers={"Authorization": f"Bearer {GROQ_KEY}", "Content-Type": "application/json"},
            json={"model": "llama-3.1-8b-instant",
                  "messages": [{"role": "user", "content": prompt}],
                  "max_tokens": 500},
            timeout=30
        )
        explanation = response.json()["choices"][0]["message"]["content"]
    return {"explanation": explanation}


# ── HISTORY ────────────────────────────────────────────────────────────────────

@app.get("/history")
async def history(current_user: dict = Depends(get_current_user)):
    if current_user["role"] == "admin":
        scans = get_all_scans(limit=100)
    else:
        scans = get_scans_for_user(current_user["id"], limit=20)
    return {"scans": scans}

@app.get("/history/{scan_id}")
async def history_detail(scan_id: str, current_user: dict = Depends(get_current_user)):
    if current_user["role"] == "admin":
        scan = get_scan_by_id(scan_id)
    else:
        scan = get_scan_by_id(scan_id, user_id=current_user["id"])
    if not scan:
        raise HTTPException(status_code=404, detail="Scan not found")
    return scan


# ── HEALTH ─────────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    redis_ok = False
    try:
        import redis as redis_lib
        r = redis_lib.from_url(REDIS_URL)
        r.ping()
        redis_ok = True
    except Exception:
        pass
    return {"status": "ok", "redis": redis_ok}