# Novotel Duty Manager Report — Novotel_Medina

Single-tenant web app for Novotel (Madinah) duty managers to run their daily inspection rounds, log complaints/incidents, attach photos, submit the daily report, export a branded PDF, and browse the archive/analysis.

- **Live:** https://novotel.as-web.cloud
- **Admin login:** `Houssin` / `112233` (seeded, see [Database](#database))
- **Owner:** Abdullah (Xas-21). Deployed on Abdullah's Hostinger VPS.
- **Sibling apps on the same VPS:** MICE/Shaden (`as-web` at https://shaden.as-web.cloud), TURAYA, AS V3, Wajeh Investor, OmniRoute. This app is one small FastAPI+SQLite container behind the shared Traefik proxy.

---

## 1. Where everything lives

| Thing | Location |
|---|---|
| Source code (VPS) | `/opt/data/novotel/` |
| Git remote | `git@github.com:Xas-21/Novotel_Medina.git` (branch `main`) |
| Running container | `novotel` (image `novotel-web`) |
| Data (SQLite DB + photos) | Docker volume `novotel_novotel_data` → mounted at `/data` inside the container |
| Reverse proxy / TLS | Shared Traefik container, network `proxy`, Let's Encrypt auto-cert for `novotel.as-web.cloud` |
| DB file inside volume | `/data/novotel.db` (SQLite, WAL mode) |
| Uploaded photos | `/data/uploads/` (served at `/api/uploads/...`) |
| Logs | `docker logs -f novotel` |

## 2. The VPS (production host)

- **Provider:** Hostinger
- **IP:** 187.55.225.134 (Tailscale: 100.112.243.101)
- **OS:** Ubuntu 24.04, Docker Engine + Docker Compose v2
- **Access:** SSH as user `hermes` (Abdullah's agent account) from Abdullah's machine; the Hermes agent (full-stack-lead profile) operates in `/opt/data/` on this box.
- **GitHub access:** push uses SSH key `/opt/data/.ssh/id_ed25519` (registered to `Xas-21`). This VPS is the canonical dev/deploy environment — code is written here, pushed from here, deployed from here.
- Other stacks on the box: AS V3 (`/opt/data/V3-Advanced-Sales`), TURAYA (`/opt/data/turaya*`), Wajeh (`/opt/data/wajeh*`), OmniRoute (`/opt/omniroute`). Wider system reference: `/opt/data/as-system-reference.md`.

## 3. How the server works (architecture)

```
Internet
   │ https://novotel.as-web.cloud
   ▼
Traefik (shared, container "traefik-rea0-traefik-1")
   │ network: proxy  ·  TLS via Let's Encrypt  ·  http→https redirect
   ▼
novotel container (image novotel-web, port 8000 INTERNAL — not published to host)
   │ FastAPI (uvicorn) serving:
   │   /api/auth/*      login, users, me
   │   /api/reports/*   daily report CRUD, checklists, analysis
   │   /api/notes/*     notes + status updates
   │   /api/upload      photo upload (Pillow optimization)
   │   /ws              WebSocket real-time sync between open browsers
   │   / + /assets/*    static SPA (index.html, app.js, style.css, logo)
   │   /health          healthcheck
   ▼
Volume novotel_novotel_data → /data
   ├── novotel.db   (SQLite, WAL — all data)
   └── uploads/     (inspection photos)
```

- ONE container. No separate DB container, no build step for the frontend (vanilla HTML/JS/CSS served directly by FastAPI).
- **Code is baked into the image** (Dockerfile `COPY`s it). There is **no bind mount** — after any code change you MUST `docker compose build && up -d`.
- Container restarts with `restart: unless-stopped` and has a Docker HEALTHCHECK hitting `/health`.
- Data survives rebuilds because it lives in the named volume, not the image.

## 4. Tech stack

| Layer | Tech | Notes |
|---|---|---|
| Frontend | Vanilla HTML/CSS/JS + Chart.js (4.4.4) + jsPDF (2.5.1) from CDN | No framework, no npm build |
| Backend | Python 3.12, FastAPI (≥0.115), uvicorn, Pydantic v2 | Async; aiosqlite |
| DB | SQLite 3 (WAL, foreign_keys=ON) | In volume, zero-admin |
| Auth | JWT (python-jose HS256) + **bcrypt directly** (NOT passlib — passlib is broken with bcrypt≥5) | 30-day tokens |
| Photos | Pillow (optimization/resize on upload) | |
| Realtime | FastAPI WebSocket `/ws` | Broadcast REPORT_UPDATED / NOTES_UPDATED etc. |
| Proxy/TLS | Traefik v3 + Let's Encrypt on shared `proxy` network | |

Run locally for dev: `python3 -m venv .venv && .venv/bin/pip install -r requirements.txt`, then `DATA_DIR=./data .venv/bin/uvicorn app.main:app --port 8001`. The app seeds the DB on first boot.

## 5. Project structure

```
/opt/data/novotel/
├── Dockerfile                # python:3.12-slim, Pillow deps, healthcheck
├── docker-compose.yml        # one service; SECRET_KEY comes from .env (see §9)
├── requirements.txt
├── deploy.sh                 # pull → build → up → healthcheck (the release script)
├── .env                      # SECRET_KEY — NEVER COMMIT, already in .gitignore
├── .gitignore
├── README.md
├── app/
│   ├── main.py               # FastAPI app, CORS, routers, /ws, static mount, /health
│   ├── database.py           # aiosqlite, schema (CREATE TABLE IF NOT EXISTS), idempotent admin seed
│   ├── auth.py               # JWT create/decode, require_auth / require_admin, bcrypt helpers
│   ├── models.py             # Pydantic request/response schemas
│   ├── ws.py                 # WebSocket connection manager (broadcast)
│   └── routes/
│       ├── auth.py           # login, /me (queries DB for fresh name/title!), users CRUD (admin)
│       ├── reports.py        # daily report CRUD, checklists, drafts, submit, analysis endpoints
│       ├── notes.py          # notes CRUD + status updates
│       └── upload.py         # photo upload → /data/uploads, returns URL
└── static/
    ├── index.html            # SPA shell (navbar, overlays, photo input)
    ├── app.js                # ALL client logic: render, WS sync, Chart.js analysis, jsPDF export
    ├── style.css             # brand styling — primary brand blue #1e22aa
    └── novotel-logo-blue.png # real Novotel logo asset
```

## 6. Database

SQLite file `/data/novotel.db` inside the volume. Schema is created idempotently in `app/database.py` on startup (no migration framework — additive `ALTER TABLE` migrations live there too).

| Table | Purpose | Key columns |
|---|---|---|
| `users` | Login accounts | `id` (PK), `username` (UNIQUE), `first_name`, `last_name`, `title`, `password_hash` (bcrypt), `role` (`staff`\|`admin`), `created_at` |
| `reports` | ONE row per date | `date` (PK, YYYY-MM-DD), `status` (`draft`\|`submitted`), `submitted_at`, `submitted_by`, shift/occupancy columns, plus JSON payload columns: `checklists_json`, `cafeteria_items_json`, `rooms_inspection_json`, `courtesy_calls_json`, `trust_you_json`, `complaints_json`, `incidents_json` |
| `notes` | Free-text notes | `id`, `report_date` (FK → reports.date ON DELETE CASCADE), `department`, `priority`, `text`, `photo_url`, `manager`, `time`, `status`, `created_at` |
| `uploads` | Photo registry | `id`, `filename`, `original_name`, `url`, `mime_type`, `size_bytes`, `created_at` |

Backup = copy the volume (or `docker cp novotel:/data/novotel.db ./novotel-backup.db` with the app stopped or in WAL checkpoint). There is no automated backup job today.

## 7. Auth, roles & business rules (non-negotiable)

1. **`role` ≠ `title`.** `role` is a hidden permission enum (`staff`|`admin`); `title` is the human label ("Duty Manager") shown to other users. Never surface `role` as the label. Reports/PDF show `First Last — Title` (e.g. "Prepared by: Houssin Fayraq — Duty Manager").
2. **RBAC for editing:** `staff` can only edit/submit reports in `draft`. Once `submitted`, only `admin` can edit/reopen/delete. Gates live in BOTH backend (routes/reports.py) and frontend (buttons hidden dynamically).
3. **Admin-only:** "Users" nav (create users: first/last/username/password/title/role), delete reports.
4. **JWT staleness trap:** name/title/role are baked into the 30-day token. `/api/auth/me` and report submit MUST read fresh values from the DB, not token claims — otherwise stale titles stick in reports. (This was a real bug, fixed — don't reintroduce it.)
5. **All timestamps are KSA timezone** (`timezone(timedelta(hours=3))`), never UTC — Saudi users notice immediately.
6. **Exact brand blue:** `#1e22aa` for sidebar, primary buttons, PDF table headers, "Prepared by" text. Use the real `novotel-logo-blue.png` — never a placeholder.
7. **PDF export** (jsPDF): real logo centered on a **white** header, tabular `<table>`-style columns (not `[OK] text` lines), occupancy color bands (1-10 red, 11-49 yellow, 50-100 green, 0 gray), evidence photos 3-per-row, `maxWidth` on every `doc.text()` + dynamic row heights, Calibri font stack on screen.
8. **Submit gate:** 8 sections must be complete before submit (6 checklist areas, staff cafeteria, ≥1 rooms-inspection room, ≥1 courtesy call) — `validateSubmit()` returns section titles to show a modal.
9. **Checklist ✗** auto-opens remark field + photo upload (max 2 per item, `photos: []` in JSON). Rooms inspection failures do the same via the dyn-list renderer.
10. **WebSocket echo:** the browser that typed must early-return on `REPORT_UPDATED` in the WS handler (data is already in local state) or typing eats keystrokes. Structural events only (notes added/submitted/reopened/deleted) trigger full re-render.
11. **Long text** (complaints, incidents, TrustYou, remarks) must use `<textarea>` — one-line inputs overflow and Abdullah will flag it.
12. **Mobile photo upload:** both `<input type="file">` elements (checklist hidden input + notes visible input) must have NO `capture` attribute, else mobile forces camera-only. Grep `static/` before assuming.

## 8. Deployment on the VPS

```bash
ssh hermes@187.55.225.134   # or Tailscale: hermes@100.112.243.101
cd /opt/data/novotel
./deploy.sh                 # git pull → docker compose build → up -d → healthcheck
```

`deploy.sh` is the whole release process. Manual equivalent:

```bash
git pull --ff-only origin main
docker compose build
docker compose up -d
curl -fsS https://novotel.as-web.cloud/health   # expect {"status":"healthy",...}
```

Verify after deploy: `curl -k https://novotel.as-web.cloud/health`, open the site, log in, check browser console for 0 errors.

Operational commands:

| Task | Command |
|---|---|
| Logs | `docker logs -f novotel` |
| Shell in container | `docker exec -it novotel sh` |
| Inspect DB | `docker exec -it novotel python -c "import sqlite3;c=sqlite3.connect('/data/novotel.db');print(c.execute('select count(*) from reports').fetchone())"` |
| Backup | `docker cp novotel:/data/novotel.db ./novotel-backup-$(date +%F).db` |
| Restart | `docker restart novotel` |
| Full rebuild | `cd /opt/data/novotel && docker compose build && docker compose up -d` |

There is NO Docker UI (Portainer/etc.) on this box — everything is the plain Docker CLI / `docker compose`.

## 9. Secrets

- `docker-compose.yml` reads `SECRET_KEY` from `.env` (same directory — Docker Compose auto-loads it): `${SECRET_KEY:?Set SECRET_KEY in .env}`.
- `.env` on the VPS holds the production JWT signing secret. **Never commit `.env`** (it's in `.gitignore`).
- If you change `SECRET_KEY`, every logged-in user is logged out (30-day JWTs invalidate). Keep it stable.
- There is also a hardcoded fallback in `app/auth.py` (`os.getenv("SECRET_KEY", "novotel-secret-key-2026-dmr-super-secure")`) — dead in production because the env var is always set, but it IS in the repo; don't rely on it, and if this repo ever goes public, rotate the fallback.

## 10. Git workflow (for Abdullah + any dev agent)

Push code changes to GitHub from the VPS:

```bash
cd /opt/data/novotel
git add -A
git commit -m "describe the change"
git push origin main
```

- **Auth:** SSH key `/opt/data/.ssh/id_ed25519` (owner: Xas-21). To use it explicitly: `GIT_SSH_COMMAND="ssh -i /opt/data/.ssh/id_ed25519 -o IdentitiesOnly=yes" git push origin main`.
- **Identity:** `user.name` = `Abdullah`, `user.email` = `Abdullah@turaya.sa` (already configured globally on the VPS).
- Then deploy: `cd /opt/data/novotel && ./deploy.sh`.

**Full loop for a feature:** write/edit code in `/opt/data/novotel/` → test locally or against the live app → commit & push → `./deploy.sh` → verify health + UI.

## 11. Dev conventions (read before touching code)

- FastAPI routers per domain (auth/reports/notes/upload), Pydantic models for I/O, dependency injection for auth + DB session.
- bcrypt directly (`bcrypt.hashpw`/`checkpw`) — do NOT bring passlib back.
- Keep brand blue `#1e22aa`, real logo, Calibri first in font stacks.
- After ANY code change: rebuild the image (no bind mount). `deploy.sh` does this.
- When Abdullah asks to "delete X everywhere", search ALL of `static/` (and `app/`) first — he's been burned by single-file edits leaving the button in another file/modal.
- Leave a fresh DB (seed only) when handing over a demo — no test rows.