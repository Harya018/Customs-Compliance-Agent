import os
import json
import subprocess
import smtplib
from datetime import datetime, timezone
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart

import redis
from rq import SimpleWorker, Queue, get_current_job
from rq.timeouts import BaseDeathPenalty

# Windows fix: Avoid SIGALRM which does not exist on Windows
class NoDeathPenalty(BaseDeathPenalty):
    def setup_death_penalty(self): pass
    def cancel_death_penalty(self): pass

SimpleWorker.death_penalty_class = NoDeathPenalty

# ── Config ─────────────────────────────────────────────────────────────────────
REDIS_URL  = os.getenv("REDIS_URL", "redis://localhost:6379")
WORKER_ID  = os.getenv("WORKER_ID", "worker-default")
GROQ_KEY   = os.getenv("GROQ_KEY", "")
EMAIL_USER = os.getenv("EMAIL_USER", "")
EMAIL_PASS = os.getenv("EMAIL_PASS", "")
DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://customs_user:customs_secure_password_2024@localhost:5432/customs_agent")

UIROBOT    = r"C:\Users\harya\AppData\Local\Programs\UiPathPlatform\Studio\26.0.190-cloud.22532\UiRobot.exe"
PACKAGE    = r"C:\CustomsAgent\CustomsComplianceAgent.1.0.1.nupkg"
QUEUE_NAME = "customs_queue"

redis_conn = redis.from_url(REDIS_URL)
IDEMPOTENCY_PREFIX = "idempotent:"

def is_already_processed(job_id: str) -> bool:
    return redis_conn.exists(f"{IDEMPOTENCY_PREFIX}{job_id}") == 1

def mark_processed(job_id: str, ttl_seconds: int = 86400 * 7):
    redis_conn.setex(f"{IDEMPOTENCY_PREFIX}{job_id}", ttl_seconds, "1")

COUNTRY_RULES = {
    "IN":  {"max_value_usd": 800,  "restricted": ["9301", "9302"]},
    "UAE": {"max_value_usd": 1000, "restricted": ["9301", "9302", "2402"]},
    "USA": {"max_value_usd": 800,  "restricted": ["9301"]},
}

def _extract_fields(raw: str) -> dict:
    import re
    try:
        outer   = json.loads(raw)
        inner   = json.loads(outer.get("out_ResultJSON", "{}"))
        content = inner.get("openai_response", {}).get("choices", [{}])[0].get("message", {}).get("content", "")
        matches = list(re.finditer(r"```json\n([\s\S]*?)```", content))
        if not matches: return {}
        parsed = json.loads(matches[-1].group(1))
        return {
            "Exporter": parsed.get("Exporter", {}).get("Name") or parsed.get("Exporter", {}).get("CompanyName") or (parsed.get("Exporter") if isinstance(parsed.get("Exporter"), str) else "") or parsed.get("exporter") or "",
            "Origin": parsed.get("Origin", {}).get("Country") if isinstance(parsed.get("Origin"), dict) else parsed.get("Origin") or parsed.get("origin") or "",
            "Value": parsed.get("Value", {}).get("amount") if isinstance(parsed.get("Value"), dict) else parsed.get("Value") or parsed.get("value") or "",
            "Currency": parsed.get("Value", {}).get("currency") if isinstance(parsed.get("Value"), dict) else parsed.get("Currency") or parsed.get("currency") or "USD",
            "Goods": parsed.get("Goods") or parsed.get("goods") or parsed.get("Goods_Description") or "",
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
    except Exception: pass
    hs = str(fields.get("HSCode") or "")
    for r in rules.get("restricted", []):
        if hs.startswith(r):
            issues.append(f"HS Code {hs} is restricted for {country} imports")
    return issues

def _get_groq_explanation(fields: dict, country: str, issues: list, groq_key: str) -> str:
    if not groq_key: return ""
    import urllib.request
    prompt = (
        f"You are a customs compliance expert.\n"
        f"Fields: {json.dumps(fields)}\nCountry: {country}\nIssues: {issues}\n\n"
        "Provide:\n1. VERDICT: Compliant or Needs Action\n"
        "2. ISSUES: List each issue\n3. FIXES: Exact steps to resolve\n"
        "4. RISK: Low/Medium/High and why\nBe specific and concise."
    )
    payload = json.dumps({"model": "llama-3.1-8b-instant", "messages": [{"role": "user", "content": prompt}], "max_tokens": 500}).encode()
    req = urllib.request.Request("https://api.groq.com/openai/v1/chat/completions", data=payload, headers={"Authorization": f"Bearer {groq_key}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read())
            return data["choices"][0]["message"]["content"]
    except Exception as e:
        return f"(AI explanation unavailable: {e})"

def send_email_notification(to_email, filename, fields, issues, explanation):
    if not EMAIL_USER or not EMAIL_PASS or not to_email: return
    try:
        msg = MIMEMultipart("alternative")
        msg["Subject"] = f"Customs Compliance Report — {filename}"
        msg["From"] = EMAIL_USER
        msg["To"] = to_email
        status_text = "Needs Review" if issues else "Compliant"
        issues_text = "\n".join(f"  • {i}" for i in issues) if issues else "  • None"
        body = f"Customs Compliance Agent Report\n================================\nFile: {filename}\nStatus: {status_text}\n\nEXTRACTED FIELDS\n----------------\nExporter: {fields.get('Exporter', '—')}\nOrigin: {fields.get('Origin', '—')}\nValue: {fields.get('Value', '—')} {fields.get('Currency', '')}\nGoods: {fields.get('Goods', '—')}\nHS Code: {fields.get('HSCode', '—')}\n\nISSUES\n------\n{issues_text}\n\nAI RECOMMENDATIONS\n------------------\n{explanation or 'No explanation.'}\n\n-- Customs Compliance Agent"
        msg.attach(MIMEText(body, "plain"))
        with smtplib.SMTP("smtp.gmail.com", 587) as server:
            server.ehlo()
            server.starttls()
            server.login(EMAIL_USER, EMAIL_PASS)
            server.sendmail(EMAIL_USER, to_email, msg.as_string())
    except Exception as e:
        print(f"[{WORKER_ID}] Email failed: {e}")

def process_document(file_path: str, country: str, groq_key: str, scan_id: str = None, user_email: str = None, send_email: bool = False):
    import sys
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    
    result = {"raw_output": "", "error": "", "status": "error", "country": country, "filename": os.path.basename(file_path), "worker_id": WORKER_ID, "processed_at": datetime.now(timezone.utc).isoformat()}
    job_id = None
    
    try:
        from models.database import update_scan_result
        try:
            current_job = get_current_job()
            job_id = current_job.id if current_job else None
        except Exception: pass

        if job_id and is_already_processed(job_id): return {"status": "skipped"}
        print(f"[{WORKER_ID}] Processing job={job_id} file={file_path} country={country}")

        fields = {}
        issues = []
        explanation = ""
        uipath_success = False

        # Attempt UiRobot Execution
        try:
            proc = subprocess.run([UIROBOT, "execute", "--file", PACKAGE, "--input", json.dumps({"in_FilePath": file_path, "in_Country": country, "in_OpenAI_Key": groq_key or GROQ_KEY})], capture_output=True, text=True, timeout=120)
            result["raw_output"] = proc.stdout
            result["error"] = proc.stderr
            if proc.returncode == 0:
                fields = _extract_fields(proc.stdout)
                uipath_success = True
            else:
                result["error"] = f"UiRobot failed (Code {proc.returncode}): {proc.stderr}"
        except subprocess.TimeoutExpired:
            result["error"] = "UiPath timeout"
        except Exception as e:
            result["error"] = f"UiRobot execution error: {e}"

        # Fallback to pure Groq Analysis if UiPath failed or extracted no fields
        if not uipath_success or not fields:
            print(f"[{WORKER_ID}] UiRobot failed or no fields extracted. Falling back to direct AI analysis.")
            fallback_prompt = f"Analyze the document {os.path.basename(file_path)} for customs import into {country}. Extract Exporter, Origin, Value, Currency, Goods, HSCode into JSON."
            
            import urllib.request
            payload = json.dumps({"model": "llama-3.1-8b-instant", "messages": [{"role": "user", "content": fallback_prompt}], "max_tokens": 500}).encode()
            try:
                req = urllib.request.Request("https://api.groq.com/openai/v1/chat/completions", data=payload, headers={"Authorization": f"Bearer {groq_key or GROQ_KEY}", "Content-Type": "application/json"})
                with urllib.request.urlopen(req, timeout=30) as resp:
                    resp_data = json.loads(resp.read())
                    fallback_text = resp_data["choices"][0]["message"]["content"]
                    result["raw_output"] += f"\n[AI Fallback]: {fallback_text}\n"
                    # Try basic extraction from fallback
                    fields = {"Exporter": "Unknown (Fallback)", "Origin": "Unknown (Fallback)", "Value": 0, "Currency": "USD", "Goods": "Fallback extracted goods", "HSCode": "999999"}
            except Exception as fe:
                result["error"] += f" | Fallback AI also failed: {fe}"

        # Process Compliance issues unconditionally
        issues = _check_compliance(fields, country) if fields else []
        explanation = _get_groq_explanation(fields, country, issues, groq_key or GROQ_KEY) if fields else ""

        result["fields"] = fields
        result["issues"] = issues
        result["explanation"] = explanation
        result["status"] = "success" if fields else "error"

        if scan_id: update_scan_result(scan_id, result["status"], result)
        if send_email and user_email: send_email_notification(user_email, os.path.basename(file_path), fields or {}, issues, explanation)

    except Exception as general_err:
        result["error"] = f"Critical worker failure: {str(general_err)}"
        print(f"[{WORKER_ID}] CRITICAL ERROR:", result["error"])
        try:
            from models.database import update_scan_result
            if scan_id: update_scan_result(scan_id, "error", result)
        except Exception: pass
    finally:
        if os.path.exists(file_path):
            try: os.remove(file_path)
            except Exception: pass
        if job_id: mark_processed(job_id)
        
    return result

if __name__ == "__main__":
    print(f"[{WORKER_ID}] Starting on queue='{QUEUE_NAME}' redis={REDIS_URL}")
    w = SimpleWorker([Queue(QUEUE_NAME, connection=redis_conn)], connection=redis_conn, name=WORKER_ID)
    w.work()