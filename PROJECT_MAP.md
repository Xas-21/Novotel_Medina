# PROJECT_MAP — Novotel Duty Manager Report System

## [TECH_STACK]
| Layer | Technology | Version | Rationale |
|-------|-----------|---------|-----------|
| Frontend | HTML5 / CSS3 / Vanilla JS + Chart.js + jsPDF | Standard / 4.4.4 / 2.5.1 | Lightweight, ultra-responsive, zero compilation overhead, exact Fraunces/Inter branding matching original design |
| Backend | FastAPI + Uvicorn | 0.115+ / Python 3.12 | Async REST API, WebSockets real-time sync, robust data validation with Pydantic |
| Database | SQLite with WAL mode & Foreign Keys | SQLite 3 | Embedded, zero-maintenance, ACID transactional storage in persistent Docker volume |
| Real-time | WebSockets | FastAPI Native | Instant sync across duty managers' phones and desktop stations |
| Storage | Persistent Volume (`/data`) | Docker Volume | Safe, durable storage for SQLite database and uploaded high-res inspection photos |
| Reverse Proxy | Traefik v3 | Latest | Hostinger VPS unified reverse proxy, SSL automated via Let's Encrypt |

## [SYSTEM_FLOW]
1. **Access & Authentication:**
   - User visits `https://novotel.as-web.cloud`.
   - If not logged in, prompt for Duty Manager login (or PIN/credentials) and manager name.
2. **Daily Inspection Rounds:**
   - Duty Manager selects date (defaults to today).
   - Fills Shift Info (Occupancy, Arrivals/Departures, In-house, ALL loyalty members).
   - Performs rounds across Public Areas (GF), Surrounding, Basements (1-4), Restaurant, 1st Floor, and 12 Guest Floors.
   - Logs Rooms Inspection, Courtesy Calls, Staff Cafeteria audit, Guest Complaints, and Incidents.
   - Uploads photos & notes tagged with Department, Priority, and Status.
3. **Real-Time Collaboration:**
   - As any manager updates an item or adds a note, changes are broadcast via WebSocket and synced in real-time on all active screens.
4. **Report Finalization & PDF Generation:**
   - Duty Manager submits report, locking it and logging timestamp + manager identity.
   - Export official formatted PDF for records and management review.
5. **Archive & Analysis:**
   - Archive tab allows browsing past dates and historical reports.
   - Analysis tab computes weekly and monthly metrics: failure rates by area, top recurring issues, complaints breakdown, incident logs, TrustYou trends, and GM Summary PDF export.

## [ARCHITECTURE]
- `app/main.py`: FastAPI application entrypoint, routers, WebSocket connection manager, static file mount.
- `app/database.py`: Database connection, schema migration, and seed initialization.
- `app/models.py`: Pydantic schemas for requests/responses.
- `app/routes/auth.py`: Authentication endpoints (login, register, me).
- `app/routes/reports.py`: CRUD endpoints for reports, checklists, dynamic entries, and analysis.
- `app/routes/notes.py`: CRUD endpoints for notes and status updates.
- `app/routes/upload.py`: Photo upload handler with image optimization.
- `static/index.html`: Complete UI matching duty manager visual specifications.
- `static/app.js`: Reactive client logic, WebSocket sync, Chart.js analysis, and jsPDF reporting.
- `static/style.css`: Refined styles with Fraunces/Inter typography and responsive layout.

## [DEPLOYMENT]
- **Host:** `/opt/data/novotel/` on Hostinger VPS (187.55.225.134)
- **Container name:** `novotel` (image `novotel-web`)
- **Subdomain:** `https://novotel.as-web.cloud` (Traefik v3 + Let's Encrypt, network `proxy`)
- **Port:** internal 8000 (not published to host)
- **Volume:** `novotel_novotel_data` → `/data` (SQLite + uploads)
- **Build/deploy:** `docker compose -f /opt/data/novotel/docker-compose.yml up -d --build`
- **Seeded login:** `Houssin` / `112233` (admin) — the ONLY account.

## [AUTH & ROLES]
- Login page requires **username + password** (JWT bearer, bcrypt-hashed, 30-day token).
- **Admin (Houssin)** only: sees the "Users" nav, can create/delete users and edit/delete reports.
- **User create form fields:** First name, Last name, Username, Password, Title/Position, Role.
- Role gate: only `admin` can reopen submitted reports or delete reports (UI + backend).

## [FEATURES NOTED]
- Checklist items: marking ✗ auto-opens a **remarks** field + **photo upload (max 2 per item)**.
- Photos attach to individual checklist items and are persisted in the report JSON.
- Daily report + GM weekly/monthly summary export as **Novotel-branded PDFs** with the logo, navy/brass color scheme, and tabular layout (evidence photos embedded for failed items).

## [ORPHANS & PENDING]
- None — implementation complete and verified end-to-end.

