# Customs Compliance Agent

## Problem Statement
Autonomous AI agent that extracts, validates, and generates customs-compliant documentation from invoices and bills of lading.

## Solution
Full-stack customs compliance platform with UiPath document processing, Groq AI classification, Redis queue, JWT auth, and multi-country validation.

## Tech Stack
- **Frontend**: React.js
- **Backend**: FastAPI (Python)
- **AI Orchestration**: UiPath + Groq LLaMA 3.1
- **Queue**: Redis + RQ (2 workers)
- **Auth**: JWT + bcrypt
- **Database**: SQLite (`users.db`, `scans.db`)
- **Container**: Docker + docker-compose

## How to Run
1. Clone the repo
2. Add your keys to `.env` file:
   ```
   GROQ_KEY=your_groq_key_here
   JWT_SECRET=customs_agent_secret_key_2024
   EMAIL_USER=your@gmail.com   # optional
   EMAIL_PASS=your_app_password  # optional
   REDIS_URL=redis://localhost:6379
   ```
3. Run: `docker-compose up --build`
4. Open http://localhost:3000

## Development (without Docker)
```bash
# Backend
pip install -r requirements.txt
uvicorn main:app --reload

# Workers (2 terminals)
WORKER_ID=worker1 python worker.py
WORKER_ID=worker2 python worker.py

# Frontend
cd frontend
npm install
npm start
```

## Architecture
- **Event-driven**: frontend → backend → Redis queue → workers → result
- **2 parallel workers** for document processing
- **JWT-protected** API endpoints (access token 30 min, refresh 7 days)
- **Scan history** per user stored in SQLite
- **RBAC**: admin sees all scans, user sees only their own

## API Endpoints

### Auth
| Method | Path | Description |
|--------|------|-------------|
| POST | `/auth/register` | Register new user, returns JWT |
| POST | `/auth/login` | Login, returns access + refresh tokens |
| POST | `/auth/refresh` | Refresh access token |
| GET | `/auth/me` | Current user info (requires auth) |

### Analysis
| Method | Path | Description |
|--------|------|-------------|
| POST | `/analyze` | Upload document → enqueues job, returns job_id (protected) |
| GET | `/job/{job_id}` | Poll job status + result (protected) |
| POST | `/explain` | Groq AI compliance explanation (protected) |

### History
| Method | Path | Description |
|--------|------|-------------|
| GET | `/history` | Last 20 scans for current user (protected) |
| GET | `/history/{scan_id}` | Specific scan result (protected) |

### System
| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check + Redis status |

## File Structure
```
C:\CustomsAgent\
  ├── main.py          ← FastAPI backend (all endpoints)
  ├── auth.py          ← JWT auth + bcrypt + users.db
  ├── database.py      ← Scan history (scans.db)
  ├── worker.py        ← RQ worker (run 2 instances)
  ├── requirements.txt ← Python dependencies
  ├── Dockerfile       ← Backend container
  ├── docker-compose.yml ← Full stack orchestration
  ├── .env             ← Environment variables
  ├── rules.json       ← Compliance rules (IN, UAE, USA)
  └── frontend\
        ├── Dockerfile ← Frontend container
        └── src\
              └── App.js ← React SPA
```

## Security
- Passwords hashed with bcrypt (passlib)
- JWT signed with HS256 (python-jose)
- All `/analyze`, `/explain`, `/history` endpoints require `Authorization: Bearer <token>`
- CORS configured for `localhost:3000`

## Email Notifications (Optional)
If `EMAIL_USER` and `EMAIL_PASS` are set in `.env`, users can receive email reports after each scan.
Uses Gmail SMTP (smtp.gmail.com:587). Requires a Gmail App Password.
