"""
worker_traced.py — Traced async document processing worker

ROLE IN THE SYSTEM:
    This file is the EVENT-DRIVEN async worker that runs SEPARATELY from the FastAPI
    backend. It connects to the Redis queue (customs_queue), picks jobs atomically,
    processes customs documents with UiPath/Groq AI, and writes structured JSON logs
    to /app/logs/worker.log. Two instances (worker-1, worker-2) run in docker-compose
    to demonstrate true parallelisation. Each instance is identified by WORKER_ID
    (injected from docker-compose environment).

WHAT THIS FILE DOES:
    1. Connects to Redis and listens on the 'customs_queue' queue
    2. Picks tasks ATOMICALLY — RQ's SimpleWorker locks each job so no two workers
       process the same job (idempotency via Redis SETEX key TTL=7 days)
    3. For each job, calls process_document() from worker.py (business logic reuse)
    4. Emits a structured JSON log line per job with fields:
          timestamp, level, worker_id, job_id, scan_id, country, status,
          duration_ms, service
       This log is written to /app/logs/worker.log, which Promtail scrapes and
       pushes to Loki — so async worker jobs appear in the Grafana dashboard
       under the 'service=worker' label alongside backend API traces.
    5. Logs job START, job END (success/error), and any CRITICAL errors

WHAT THIS FILE MUST NOT DO:
    - Must NOT import or invoke any FastAPI/HTTP code
    - Must NOT write to scans.db directly — calls update_scan_result from database.py
    - Must NOT change any logic in worker.py — this file wraps it with logging only
    - Must NOT expose any HTTP port — workers are headless queue consumers
    - Must NOT run inline inside the backend process — it is a completely separate
      Docker container with its own process lifecycle

PARALLELISATION PROOF:
    Two docker-compose services (worker-1, worker-2) both run this file.
    Each has a different WORKER_ID env var. When 2 jobs arrive simultaneously,
    RQ's atomic BLPOP ensures each worker picks exactly one job — zero duplicates.
    The Grafana logs panel will show two different worker_ids processing in parallel.
"""

import os
import sys
import json
import time
import uuid
import logging
from datetime import datetime, timezone

# ── Path setup so worker.py imports work ────────────────────────────────────────
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import redis
from rq import SimpleWorker, Queue
from rq.timeouts import BaseDeathPenalty

# Windows fix (inherited from worker.py pattern)
class NoDeathPenalty(BaseDeathPenalty):
    def setup_death_penalty(self): pass
    def cancel_death_penalty(self): pass

SimpleWorker.death_penalty_class = NoDeathPenalty

# ── Configuration ───────────────────────────────────────────────────────────────
REDIS_URL  = os.getenv("REDIS_URL", "redis://localhost:6379")
WORKER_ID  = os.getenv("WORKER_ID", f"worker-{uuid.uuid4().hex[:6]}")
QUEUE_NAME = "customs_queue"

# ── Structured JSON Logger (writes to worker.log for Promtail → Loki) ──────────
log_dir = "/app/logs" if os.path.exists("/app") else os.path.join(os.path.dirname(__file__), "logs")
os.makedirs(log_dir, exist_ok=True)
worker_log_path = os.path.join(log_dir, "worker.log")


class WorkerJSONFormatter(logging.Formatter):
    """Emits one JSON object per line — Promtail can parse each line as a log entry."""
    def format(self, record):
        return json.dumps({
            "timestamp": self.formatTime(record),
            "level": record.levelname,
            "worker_id": WORKER_ID,
            "job_id": getattr(record, "job_id", ""),
            "scan_id": getattr(record, "scan_id", ""),
            "country": getattr(record, "country", ""),
            "status": getattr(record, "status", ""),
            "duration_ms": getattr(record, "duration_ms", ""),
            "message": record.getMessage(),
            "service": "customs-worker"
        })


_file_handler = logging.FileHandler(worker_log_path)
_file_handler.setFormatter(WorkerJSONFormatter())

_stream_handler = logging.StreamHandler()
_stream_handler.setFormatter(logging.Formatter(
    f"[{WORKER_ID}] %(asctime)s %(levelname)s — %(message)s"
))

wlogger = logging.getLogger("customs_worker")
wlogger.setLevel(logging.INFO)
wlogger.addHandler(_file_handler)
wlogger.addHandler(_stream_handler)


# ── Traced job wrapper ──────────────────────────────────────────────────────────
def traced_process_document(file_path: str, country: str, groq_key: str,
                             scan_id: str = None, user_email: str = None,
                             send_email: bool = False, job_id: str = None):
    """
    Wraps worker.process_document() with structured JSON logging so every
    async job execution is traceable in Loki/Grafana under service=worker.

    Parameters match worker.process_document exactly so RQ can enqueue this
    function using the same payload structure as the legacy worker.
    """
    start = time.time()
    trace_id = job_id or str(uuid.uuid4())

    wlogger.info(
        f"JOB START file={os.path.basename(file_path)} country={country}",
        extra={"job_id": trace_id, "scan_id": scan_id or "", "country": country, "status": "started", "duration_ms": 0}
    )

    try:
        # Delegate ALL business logic to the original worker.py — no duplication
        from worker import process_document
        result = process_document(
            file_path=file_path,
            country=country,
            groq_key=groq_key,
            scan_id=scan_id,
            user_email=user_email,
            send_email=send_email
        )
        duration_ms = round((time.time() - start) * 1000, 2)
        status = result.get("status", "unknown")

        wlogger.info(
            f"JOB END status={status} duration={duration_ms}ms",
            extra={"job_id": trace_id, "scan_id": scan_id or "", "country": country,
                   "status": status, "duration_ms": duration_ms}
        )
        return result

    except Exception as e:
        duration_ms = round((time.time() - start) * 1000, 2)
        wlogger.error(
            f"JOB FAILED error={str(e)} duration={duration_ms}ms",
            extra={"job_id": trace_id, "scan_id": scan_id or "", "country": country,
                   "status": "error", "duration_ms": duration_ms}
        )
        raise


# ── Entry point ─────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    wlogger.info(f"Worker starting — queue={QUEUE_NAME} redis={REDIS_URL}",
                 extra={"job_id": "", "scan_id": "", "country": "", "status": "boot", "duration_ms": 0})

    redis_conn = redis.from_url(REDIS_URL)
    queue = Queue(QUEUE_NAME, connection=redis_conn)
    worker = SimpleWorker([queue], connection=redis_conn, name=WORKER_ID)

    wlogger.info(f"Listening for jobs atomically on '{QUEUE_NAME}' as '{WORKER_ID}'",
                 extra={"job_id": "", "scan_id": "", "country": "", "status": "ready", "duration_ms": 0})
    worker.work()
