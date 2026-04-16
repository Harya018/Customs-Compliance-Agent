"""
worker.py — Redis Queue Worker
Run with: python worker.py
Two instances: WORKER_ID=worker1 and WORKER_ID=worker2
"""

import os
import json
import subprocess
import smtplib
from datetime import datetime, timezone
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart

import redis
from rq import SimpleWorker, Queue
from rq import get_current_job

# ── Config ─────────────────────────────────────────────────────────────────────
REDIS_URL  = os.getenv("REDIS_URL",  "redis://localhost:6379")
WORKER_ID  = os.getenv("WORKER_ID",  "worker-default")
GROQ_KEY   = os.getenv("GROQ_KEY",   "")
EMAIL_USER = os.getenv("EMAIL_USER", "")
EMAIL_PASS = os.getenv("EMAIL_PASS", "")

UIROBOT    = r"C:\Users\harya\AppData\Local\Programs\UiPathPlatform\Studio\26.0.190-cloud.22532\UiRobot.exe"
PACKAGE    = r"C:\CustomsAgent\CustomsComplianceAgent.1.0.1.nupkg"
QUEUE_NAME = "customs_queue"

# ── Redis connection ───────────────────────────────────────────────────────────
redis_conn = redis.from_url(REDIS_URL)

# ── Idempotency ────────────────────────────────────────────────────────────────
IDEMPOTENCY_PREFIX = "idempotent:"

def is_already_processed(job_id: str) -> bool:
    return redis_conn.exists(f"{IDEMPOTENCY_PREFIX}{job_id}") == 1

def mark_processed(job_id: str, ttl_seconds: int = 86400 * 7):
    redis_conn.setex(f"{IDEMPOTENCY_PREFIX}{job_id}", ttl_seconds, "1")

# ── Email ──────────────────────────────────────────────────────────────────────
def send_email_notification(to_email, filename, fields, issues, explanation):
    if not EMAIL_USER or not EMAIL_PASS or not to_email:
        return
    try:
        msg = MIMEMultipart("alternative")
        msg["Subject"] = f"Customs Compliance Report — {filename}"
        msg["From"]    = EMAIL_USER
        msg["To"]      = to_email
        status_text    = "Needs Review" if issues else "Compliant"
        issues_text    = "\n".join(f"  • {i}" for i in issues) if issues else "  • None"
        body = f"""
Customs Compliance Agent Report
================================
File      : {filename}
Status    : {status_text}
Generated : {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}

EXTRACTED FIELDS
----------------
Exporter  : {fields.get('Exporter','—')}
Origin    : {fields.get('Origin','—')}
Value     : {fields.get('Value','—')} {fields.get('Currency','')}
Goods     : {fields.get('Goods','—')}
HS Code   : {fields.get('HSCode','—')}

ISSUES
------
{issues_text}

AI RECOMMENDATIONS
------------------
{explanation or 'No AI explanation available.'}

-- Customs Compliance Agent
        """.strip()
        msg.attach(MIMEText(body, "plain"))
        with smtplib.SMTP("smtp.gmail.com", 587) as server:
            server.ehlo()
            server.starttls()
            server.login(EMAIL_USER, EMAIL_PASS)
            server.sendmail(EMAIL_USER, to_email, msg.as_string())
    except Exception as e:
        print(f"[{WORKER_ID}] Email failed: {e}")

# ── Country rules ──────────────────────────────────────────────────────────────
COUNTRY_RULES = {
    "IN":  {"max_value_usd": 800,  "restricted": ["9301","9302"]},
    "UAE": {"max_value_usd": 1000, "restricted": ["9301","9302","2402"]},
    "USA": {"max_value_usd": 800,  "restricted": ["9301"]},
}

# ── Helpers ────────────────────────────────────────────────────────────────────
def _extract_fields(raw: str) -> dict:
    try:
        import re
        outer   = json.loads(raw)
        inner   = json.loads(outer.get("out_ResultJSON", "{}"))
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
            "Goods":  parsed.get("Goods") or parsed.get("goods") or parsed.get("Goods_Description") or "",
            "HSCode": parsed.get("HSCode") or parsed.get("HS Code") or parsed.get("HS_Code") or parsed.get("hsCode") or "",
        }
    except Exception:
        return {}


def _check_compliance(fields: dict, country: str) -> list:
    rules  = COUNTRY_RULES.get(country, {})
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


def _get_groq_explanation(fields: dict, country: str, issues: list, groq_key: str) -> str:
    if not groq_key:
        return ""
    import urllib.request
    prompt  = (
        f"You are a customs compliance expert.\n"
        f"Fields: {json.dumps(fields)}\nCountry: {country}\nIssues: {issues}\n\n"
        "Provide:\n1. VERDICT: Compliant or Needs Action\n"
        "2. ISSUES: List each issue\n3. FIXES: Exact steps to resolve\n"
        "4. RISK: Low/Medium/High and why\nBe specific and concise."
    )
    payload = json.dumps({
        "model":    "llama-3.1-8b-instant",
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": 500
    }).encode()
    req = urllib.request.Request(
        "https://api.groq.com/openai/v1/chat/completions",
        data=payload,
        headers={
            "Authorization": f"Bearer {groq_key}",
            "Content-Type":  "application/json"
        }
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read())
            return data["choices"][0]["message"]["content"]
    except Exception as e:
        return f"(AI explanation unavailable: {e})"


# ── Core job function (called by RQ) ──────────────────────────────────────────
def process_document(file_path: str, country: str, groq_key: str,
                     scan_id: str = None, user_email: str = None,
                     send_email: bool = False):
    import sys
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from database import update_scan_result

    job_id = None
    try:
        current_job = get_current_job()
        job_id = current_job.id if current_job else None
    except Exception:
        pass

    if job_id and is_already_processed(job_id):
        print(f"[{WORKER_ID}] Job {job_id} already processed, skipping.")
        return {"status": "skipped", "reason": "already processed"}

    print(f"[{WORKER_ID}] Processing job={job_id} file={file_path} country={country}")

    result = {
        "raw_output":   "",
        "error":        "",
        "status":       "error",
        "country":      country,
        "filename":     os.path.basename(file_path),
        "worker_id":    WORKER_ID,
        "processed_at": datetime.now(timezone.utc).isoformat(),
    }

    try:
        proc = subprocess.run(
            [UIROBOT, "execute", "--file", PACKAGE,
             "--input", json.dumps({
                 "in_FilePath":   file_path,
                 "in_Country":    country,
                 "in_OpenAI_Key": groq_key or GROQ_KEY
             })],
            capture_output=True, text=True, timeout=120
        )
        result["raw_output"] = proc.stdout
        result["error"]      = proc.stderr
        result["status"]     = "success" if proc.returncode == 0 else "error"

        fields  = _extract_fields(proc.stdout)
        issues  = _check_compliance(fields, country) if fields else []
        explanation = _get_groq_explanation(fields, country, issues, groq_key or GROQ_KEY) if fields else ""

        result["fields"]      = fields or {}
        result["issues"]      = issues
        result["explanation"] = explanation

        if scan_id:
            update_scan_result(scan_id, result["status"], result)

        if send_email and user_email:
            send_email_notification(user_email, os.path.basename(file_path),
                                    fields or {}, issues, explanation)

    except subprocess.TimeoutExpired:
        result["error"] = "UiPath workflow timed out"
        if scan_id:
            update_scan_result(scan_id, "error", result)
    except Exception as e:
        result["error"] = str(e)
        if scan_id:
            update_scan_result(scan_id, "error", result)
    finally:
        if os.path.exists(file_path):
            try:
                os.remove(file_path)
            except Exception:
                pass

    if job_id:
        mark_processed(job_id)

    return result


# ── Entry point ────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    print(f"[{WORKER_ID}] Starting on queue='{QUEUE_NAME}' redis={REDIS_URL}")
    w = SimpleWorker(
    [Queue(QUEUE_NAME, connection=redis_conn)],
    connection=redis_conn,
    name=WORKER_ID
)
w.work()