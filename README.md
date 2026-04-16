# Customs Compliance Agent

> **Autonomous customs compliance platform with AI document extraction, JWT + MFA + Google OAuth security, event-driven async processing with 2 parallel workers, full Loki + Grafana observability stack, and Kubernetes Minikube deployment.**

---

## Problem Statement

Build an AI agent that extracts, validates, and generates customs-compliant documentation from invoices and bills of lading — validating against country-specific regulations for India, UAE, and USA.

---

## Solution

An autonomous, production-grade customs compliance platform featuring:
- **UiPath + Groq LLaMA 3.1** AI extraction pipeline with hardened fallback
- **JWT + MFA (OTP) + Google OAuth** multi-layer authentication
- **Redis queue + 2 parallel workers** with atomic pickup and idempotency
- **Loki + Promtail + Grafana** full-stack observability (backend API + async worker traces)
- **Fernet PII encryption** at rest with email masking in all API responses
- **Kubernetes Minikube** deployment with HPA (2–10 worker replicas)

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React.js + @react-oauth/google (Docker, port 3000) |
| Backend | FastAPI Python 3.12 (Docker, port 8000) |
| AI Orchestration | UiPath Studio + Groq LLaMA 3.1 (with hardened fallback) |
| Queue | Redis + RQ — 2 parallel workers, atomic BLPOP pickup, idempotency via Redis SETEX |
| Auth | JWT + bcrypt + RBAC (Admin/User) + MFA OTP (Gmail SMTP) + Google OAuth |
| Database | SQLite — `users.db` (Fernet-encrypted PII), `scans.db` (scan history) |
| Observability | Loki (port 3100) + Promtail + Grafana (port 3001) |
| Container | Docker + docker-compose (single `customs-network`, 9 services) |
| Kubernetes | Minikube + kubectl — `k8s/` manifests with HPA |

---

## Architecture

```
Browser (React :3000)
      │
      ▼
FastAPI Backend (:8000)
      │  JWT Auth + MFA + Google OAuth
      │  X-Request-ID tracing middleware
      │  Fernet email encryption
      │
      ├─── SQLite users.db  (bcrypt passwords, encrypted emails)
      ├─── SQLite scans.db  (scan history + results)
      │
      └─── Redis Queue (customs_queue)
                │  Atomic BLPOP — each job picked by exactly one worker
                │
          ┌─────┴──────┐
       worker-1      worker-2      ← 2 containers in docker-compose
          │              │           each writes to logs/worker.log
          └──────┬───────┘
                 │
     UiPath (Windows) OR Groq AI fallback
                 │
         Compliance check + Email notification

Observability:
  logs/app.log ──┐
  logs/worker.log─┤── Promtail → Loki (:3100) → Grafana (:3001)
```

**Event-driven pipeline:**
`Browser → POST /analyze → FastAPI → Redis Queue → worker-1 OR worker-2 → UiPath/Groq → DB update → JSON response`

---

## Platform Security

| Feature | Implementation |
|---|---|
| Login | JWT access token (30 min) + refresh token (7 days) |
| MFA | 6-digit OTP via Gmail SMTP — `secrets.randbelow`, bcrypt-hashed in DB, 10 min TTL |
| Google OAuth | `POST /auth/google` → userinfo API → find/create user → JWT |
| RBAC | `admin` sees all scans; `user` sees only their own |
| PII Protection | Fernet symmetric encryption on `email` column in `users.db` |
| API Masking | All responses return `u***@domain.com` — raw email never exposed |
| Password | bcrypt with salt rounds |
| Request Tracing | `X-Request-ID` UUID injected on every request, logged to Loki |

---

## Scalability

| Feature | Implementation |
|---|---|
| Event-driven | Redis queue decouples HTTP layer from processing |
| Separate workers | `worker_traced.py` runs as independent Docker containers — NOT inline in FastAPI |
| 2 parallel workers | `worker-1` and `worker-2` in docker-compose, both listening on `customs_queue` |
| Atomic pickup | RQ's `SimpleWorker` uses Redis `BLPOP` — each job processed by exactly one worker |
| Idempotency | `Redis SETEX` key per `job_id` with 7-day TTL — duplicate jobs skipped |
| Kubernetes | `k8s/` manifests with `worker` Deployment (2 replicas) + HPA scaling to 10 |

---

## Observability

| Signal | Source | Label |
|---|---|---|
| API request logs | `logs/app.log` | `service=backend`, `endpoint`, `user_id`, `request_id` |
| Worker job logs | `logs/worker.log` | `service=worker`, `worker_id`, `job_id`, `status`, `duration_ms` |

**Grafana dashboard panels** (auto-provisioned at startup):
1. Total API requests per minute
2. Error rate (ERROR level)
3. Endpoint breakdown (pie chart)
4. Request log search by `X-Request-ID`
5. Worker processing time trend

---

## Maintainability

```
models/             ← Data layer (SQLite singleton, Fernet encryption)
controllers/        ← Business logic (Auth, Scan CRUD)
routes/             ← HTTP layer (FastAPI routers)
worker.py           ← Core job processing logic
worker_traced.py    ← Async worker entry point with JSON logging
main.py             ← App entrypoint, middleware, route mounting
observability/      ← Loki, Promtail, Grafana configs
k8s/                ← Kubernetes manifests
```

- **MVC pattern**: models / controllers / routes fully separated
- **Singleton DB**: `get_user_db()` and `get_scan_db()` return one connection per lifetime
- **Structured JSON logging**: every request and every worker job emits a parseable JSON line
- **REST API**: proper HTTP verbs, status codes, and error bodies throughout
- **Error handling**: every endpoint has try/except blocks; fallbacks never crash the response

---

## How to Run

### Prerequisites
- Docker Desktop running
- (Optional) Redis standalone: `docker run -d -p 6379:6379 --name standalone-redis redis:alpine`

### Start Everything
```bash
docker-compose up --build -d
```

### Verify
```bash
curl http://localhost:8000/health   # → {"status":"ok"}
curl -I http://localhost:3000       # → 200 OK
curl http://localhost:3100/ready    # → ready
```

### Access
| Service | URL | Credentials |
|---|---|---|
| Frontend | http://localhost:3000 | Register or Sign In |
| Backend API | http://localhost:8000/docs | — |
| Grafana | http://localhost:3001 | `admin` / `admin` |
| Loki | http://localhost:3100/ready | — |

---

## Running Containers (docker-compose)

| Container | Image | Port |
|---|---|---|
| `customsagent-backend-1` | Python 3.12-slim | 8000 |
| `customsagent-frontend-1` | Node 22-alpine | 3000 |
| `customsagent-worker-1-1` | Python 3.12-slim | — |
| `customsagent-worker-2-1` | Python 3.12-slim | — |
| `customsagent-redis-internal-1` | redis:alpine | 6379 (internal) |
| `customsagent-loki-1` | grafana/loki:2.9.0 | 3100 |
| `customsagent-promtail-1` | grafana/promtail:2.9.0 | — |
| `customsagent-grafana-1` | grafana/grafana:10.0.0 | 3001 |
| `standalone-redis` | redis:alpine | 6379 |

---

## API Reference

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| POST | `/auth/register` | No | Create account |
| POST | `/auth/login` | No | Login — returns JWT or triggers MFA |
| POST | `/auth/verify-otp` | No | Submit OTP → full JWT |
| POST | `/auth/google` | No | Google OAuth → JWT |
| POST | `/auth/refresh` | No | Refresh access token |
| GET | `/auth/me` | Yes | Current user (masked email) |
| POST | `/analyze` | Yes | Upload document → extract + validate |
| POST | `/explain` | Yes | Groq AI compliance explanation |
| GET | `/history` | Yes | Scan history (last 20 / all for admin) |
| GET | `/history/{id}` | Yes | Single scan detail |
| GET | `/health` | No | Health check |

---

## Kubernetes Deployment (Minikube)

```powershell
cd k8s
.\deploy.ps1
```

Resources created:
- Namespace `customs-agent`
- Secrets from `k8s/secrets.yaml`
- Redis PVC + Deployment + Service
- Backend PVC + Deployment (2 replicas) + Service + readiness/liveness probes
- Frontend Deployment + NodePort Service (port 30000)
- Worker Deployment (2 replicas) — each pod gets unique `WORKER_ID` via Downward API
- HPA: 2–10 worker replicas at CPU > 70%

---

## Screenshots

<img src="https://raw.githubusercontent.com/Harya018/Customs-Compliance-Agent/main/assets/scan_process.png" width="100%" alt="Document Analysis Flow" />

<img src="https://raw.githubusercontent.com/Harya018/Customs-Compliance-Agent/main/assets/extracted_fields.png" width="100%" alt="Extracted Fields Grid" />

<img src="https://raw.githubusercontent.com/Harya018/Customs-Compliance-Agent/main/assets/compliance_advisor.png" width="100%" alt="AI Compliance Advisor" />

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `GROQ_KEY` | Yes | Groq API key for LLaMA 3.1 |
| `JWT_SECRET` | Yes | JWT signing secret |
| `ENCRYPTION_KEY` | Yes | Fernet key for PII encryption |
| `EMAIL_USER` | No | Gmail address for MFA OTP |
| `EMAIL_PASS` | No | Gmail app password |
| `GOOGLE_CLIENT_ID` | No | Google OAuth client ID |
| `REDIS_URL` | No | Redis URL (default: redis://localhost:6379) |

---

*Built with ❤️ — DeepFrog AI Solutions Pvt. Ltd.*
