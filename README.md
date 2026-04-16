# Customs Compliance Agent

## Problem Statement
Build an AI agent that extracts, validates, and generates customs-compliant documentation from invoices and bills of lading.

## Solution
Autonomous customs compliance platform with UiPath document processing, Groq AI classification, Redis queue with 2 parallel workers, JWT authentication, and multi-country validation.

## Tech Stack
- Frontend: React.js (Docker)
- Backend: FastAPI Python (Docker)
- AI Orchestration: UiPath + Groq LLaMA 3.1
- Queue: Redis + RQ (2 parallel workers, atomic pickup, idempotency)
- Auth: JWT + bcrypt + RBAC (Admin/User roles)
- Database: SQLite (users.db, scans.db)
- Container: Docker + docker-compose (single network)

## Architecture
Event-driven pipeline:
Browser → FastAPI → Redis Queue → Worker1/Worker2 → UiPath → Groq AI → Result

## How to Run
1. Start Redis: `docker run -d -p 6379:6379 --name standalone-redis redis:alpine`
2. Start containers: `cd C:\CustomsAgent && docker-compose up --build -d`
3. Start workers: `.\start_workers.ps1`
4. Open: http://localhost:3000

## API Endpoints
| Method | Endpoint | Description | Auth |
|--------|----------|-------------|------|
| POST | /auth/register | Register user | No |
| POST | /auth/login | Login, get JWT | No |
| POST | /auth/refresh | Refresh token | No |
| GET | /auth/me | Current user | Yes |
| POST | /analyze | Analyze document | Yes |
| GET | /job/{id} | Job status | Yes |
| POST | /explain | AI compliance advice | Yes |
| GET | /history | Scan history | Yes |
| GET | /health | System health | No |

## Security
- JWT access tokens (30 min expiry)
- Refresh tokens (7 days)
- bcrypt password hashing
- RBAC: Admin sees all scans, User sees own scans only
- PII not exposed in frontend API calls

## Scalability
- Redis queue with 2 workers running in parallel
- Tasks picked atomically — no duplicate processing
- Idempotency maintained via job ID tracking
- Add more workers to scale horizontally

## Countries Supported
- India (IN) — threshold USD 800, Bill of Entry required above
- UAE — threshold USD 1000, VAT registration required
- USA — threshold USD 800, Section 321 de minimis applies
