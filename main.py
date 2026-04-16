import logging
import uuid
import time
import json
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
import os

from models.database import init_db
from routes.auth_routes import auth_router
from routes.analyze_routes import analyze_router

# ── Structured JSON Logger ─────────────────────────────────────────────────────
log_dir = "/app/logs" if os.path.exists("/app") else os.path.join(os.path.dirname(__file__), "logs")
if not os.path.exists(log_dir):
    os.makedirs(log_dir, exist_ok=True)

log_file = os.path.join(log_dir, "app.log")


class JSONFormatter(logging.Formatter):
    def format(self, record):
        return json.dumps({
            "timestamp": self.formatTime(record),
            "level": record.levelname,
            "endpoint": getattr(record, 'endpoint', ''),
            "user_id": getattr(record, 'user_id', ''),
            "request_id": getattr(record, 'request_id', ''),
            "message": record.getMessage(),
            "service": "customs-backend"
        })


handler_file = logging.FileHandler(log_file)
handler_file.setFormatter(JSONFormatter())
handler_stream = logging.StreamHandler()
handler_stream.setFormatter(logging.Formatter('%(asctime)s - %(levelname)s - %(message)s'))

logging.basicConfig(level=logging.INFO, handlers=[handler_file, handler_stream])
logger = logging.getLogger("customs_agent")

# ── App ────────────────────────────────────────────────────────────────────────
app = FastAPI(title="Customs Compliance Agent API")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=False, allow_methods=["*"], allow_headers=["*", "X-Request-ID"])


@app.on_event("startup")
def on_startup():
    init_db()
    logger.info("Database initialized. Starting application.")


# Request Tracing and JSON Logging Middleware
@app.middleware("http")
async def add_request_tracing_and_logging(request: Request, call_next):
    request_id = str(uuid.uuid4())
    request.state.request_id = request_id

    start_time = time.time()

    auth_header = request.headers.get("Authorization")
    user_log = "Anonymous"
    if auth_header and auth_header.startswith("Bearer "):
        try:
            from jose import jwt as jose_jwt
            token = auth_header.split(" ")[1]
            payload = jose_jwt.get_unverified_claims(token)
            user_log = payload.get("sub", "Unknown")
        except Exception:
            pass

    extra = {"endpoint": request.url.path, "user_id": user_log, "request_id": request_id}
    logger.info(f"START {request.method} {request.url.path} | User: {user_log}", extra=extra)

    try:
        response = await call_next(request)
        process_time = (time.time() - start_time) * 1000
        logger.info(f"END {request.method} {request.url.path} | Status: {response.status_code} | Time: {process_time:.2f}ms", extra=extra)
        response.headers["X-Request-ID"] = request_id
        return response
    except Exception as e:
        process_time = (time.time() - start_time) * 1000
        logger.error(f"ERROR {request.method} {request.url.path} | Exception: {str(e)} | Time: {process_time:.2f}ms", extra=extra)
        raise


# Mount Routes
app.include_router(auth_router, prefix="/auth", tags=["auth"])
app.include_router(analyze_router, tags=["analyze"])


@app.get("/health")
async def health():
    return {"status": "ok"}