import logging
import uuid
import time
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
import os

from models.database import init_db
from routes.auth_routes import auth_router
from routes.analyze_routes import analyze_router

# Setup Logging
log_dir = "/app/logs" if os.path.exists("/app") else os.path.join(os.path.dirname(__file__), "logs")
if not os.path.exists(log_dir):
    os.makedirs(log_dir, exist_ok=True)
    
log_file = os.path.join(log_dir, "app.log")
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler(log_file),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger("customs_agent")

app = FastAPI(title="Customs Compliance Agent API")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=False, allow_methods=["*"], allow_headers=["*"])

@app.on_event("startup")
def on_startup():
    init_db()
    logger.info("Database initialized. Starting application.")

# Request Tracing and Logging Middleware
@app.middleware("http")
async def add_request_tracing_and_logging(request: Request, call_next):
    request_id = str(uuid.uuid4())
    # Attach tracking ID to request state
    request.state.request_id = request_id
    
    start_time = time.time()
    
    # Try to extract user info if auth header present for logging
    auth_header = request.headers.get("Authorization")
    user_log = "Anonymous"
    if auth_header and auth_header.startswith("Bearer "):
        try:
            # Decode JWT payload without full verification just for quick logging context
            import jwt
            from jose import jwt as jose_jwt
            token = auth_header.split(" ")[1]
            payload = jose_jwt.get_unverified_claims(token)
            user_log = payload.get("sub", "Unknown")
        except Exception:
            pass
            
    logger.info(f"[ReqID: {request_id}] START {request.method} {request.url.path} | User: {user_log}")
    
    try:
        response = await call_next(request)
        process_time = (time.time() - start_time) * 1000
        logger.info(f"[ReqID: {request_id}] END {request.method} {request.url.path} | Status: {response.status_code} | Time: {process_time:.2f}ms")
        response.headers["X-Request-ID"] = request_id
        return response
    except Exception as e:
        process_time = (time.time() - start_time) * 1000
        logger.error(f"[ReqID: {request_id}] ERROR {request.method} {request.url.path} | Exception: {str(e)} | Time: {process_time:.2f}ms")
        raise

# Mount Routes
app.include_router(auth_router, prefix="/auth", tags=["auth"])
app.include_router(analyze_router, tags=["analyze"])

@app.get("/health")
async def health():
    return {"status": "ok"}