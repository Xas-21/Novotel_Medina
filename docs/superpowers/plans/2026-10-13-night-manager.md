# Night Manager section Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the Night Manager section, month archives, occupancy charts, and a read-only Full Report page without changing or deleting existing duty reports, users, or photos.

**Status:** Done. Tasks 1–12 are on main. Later follow-up on the same pages: chart styling, missing days drawn as 0% occupancy, and Day / Week / Month / YTD / From–To on Duty Analysis, Night Analysis, and Full Report.

**Architecture:** Duty reports stay in `reports`. Night reports go in a new `night_reports` table. Formulas live in `app/night_math.py` and are what the API returns. `can_write(role, section)` is the only permission check the write routes use. The new screens live in `static/night.js` so `static/app.js` is extended, not rewritten.

**Tech Stack:** Python 3.12, FastAPI, aiosqlite, SQLite, vanilla JS, Chart.js 4.4.4, jsPDF 2.5.1, pytest on the host only.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-10-13-night-manager-design.md`
- Hotel inventory setting starts at `394`
- Grand total = rooms revenue + F&B + M&E + OOD + other. The 8 Oct sample still matches because OOD is 0.
- Roles: `staff`, `night`, `admin`. Do not change the four existing users
- Brand blue `#1e22aa`. Logo file `static/novotel-logo-blue.png`
- No `DROP`, no `DELETE` of existing rows, no rename of files in `uploads/` or `/data/uploads`
- Do not change `reports` primary key or the `notes` foreign key
- Photo URLs stay `/api/uploads/<filename>` and stay public to image tags
- Runtime data is `/data` (local Docker uses `./data`, gitignored). `db/novotel.db` and `uploads/` are the snapshot
- Tests run with `pytest` on the host. Do not add pytest to `requirements.txt`
- Do not commit unless the user asks in that session. The commit lines below are the message to use when they do
- KSA calendar date uses timezone `Asia/Riyadh`
- Do not build the No Show sheet

---

### Task 1: Night formulas

**Files:**
- Create: `app/night_math.py`
- Test: `tests/test_night_math.py`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `money(value: float) -> int` rounds half up to 0 decimals
  - `pct(part: float, whole: float) -> float | None`
  - `night_figures(rooms_available: int, rooms_occupied: float, rooms_revenue: float, fb_revenue: float, me_revenue: float, ood_revenue: float, other_revenue: float) -> dict`
  - `segment_gap(rooms_occupied: float, segment_rooms: list[float]) -> dict` with `segmentRooms` and `unassigned`
  - `month_to_date(rooms_available: int, day_number: int, rows: list[dict]) -> dict`
  - `missing_dates(year: int, month: int, through_day: int, saved: set[str]) -> list[str]`

- [ ] **Step 1: Write the failing test**

```python
from app.night_math import money, night_figures, segment_gap, month_to_date, missing_dates

def test_oct_8_last_night_matches_workbook():
    figs = night_figures(394, 235, 83561.14, 12833.52, 0, 0, 406.96)
    assert money(figs["occupancy"] * 100) == 60
    assert money(figs["adr"]) == 356
    assert money(figs["revpar"]) == 212
    assert money(figs["grandTotal"]) == 96802

def test_ood_is_included_in_grand_total():
    figs = night_figures(394, 235, 83561.14, 12833.52, 0, 100, 406.96)
    assert figs["grandTotal"] == 83561.14 + 12833.52 + 0 + 100 + 406.96
    assert figs["oodRevenue"] == 100

def test_adr_blank_when_no_rooms_occupied():
    figs = night_figures(394, 0, 0, 0, 0, 0, 0)
    assert figs["adr"] is None

def test_segment_gap_on_oct_8():
    gap = segment_gap(235, [1, 25, 16, 5, 99, 66, 0])
    assert gap == {"segmentRooms": 212, "unassigned": 23}

def test_mtd_matches_workbook_when_prior_rows_sum_to_sheet():
    # One synthetic prior total plus the 8 Oct row is not how MTD is stored.
    # The sheet's MTD is the sum, so the rows themselves must sum to those MTD numbers.
    rows = [
        {"rooms_occupied": 1458, "rooms_revenue": 528049.00, "fb_revenue": 68661.02, "me_revenue": 0, "ood_revenue": 0, "other_revenue": 2980.99},
        {"rooms_occupied": 235, "rooms_revenue": 83561.14, "fb_revenue": 12833.52, "me_revenue": 0, "ood_revenue": 0, "other_revenue": 406.96},
    ]
    mtd = month_to_date(394, 8, rows)
    assert mtd["roomsOccupied"] == 1693
    assert money(mtd["occupancy"] * 100) == 54
    assert money(mtd["adr"]) == 361
    assert money(mtd["revpar"]) == 194
    assert money(mtd["grandTotal"]) == 696493

def test_missing_dates_lists_gaps_only():
    saved = {"2026-10-01", "2026-10-03"}
    assert missing_dates(2026, 10, 4, saved) == ["2026-10-02", "2026-10-04"]
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `python -m pytest tests/test_night_math.py -v`

Expected: FAIL, `app.night_math` cannot be imported.

- [ ] **Step 3: Implement `app/night_math.py`**

```python
from decimal import Decimal, ROUND_HALF_UP

def money(value: float) -> int:
    return int(Decimal(str(value)).quantize(Decimal("1"), rounding=ROUND_HALF_UP))

def pct(part: float, whole: float):
    if not whole:
        return None
    return part / whole

def night_figures(rooms_available, rooms_occupied, rooms_revenue, fb_revenue, me_revenue, ood_revenue, other_revenue):
    return {
        "occupancy": pct(rooms_occupied, rooms_available),
        "adr": pct(rooms_revenue, rooms_occupied),
        "revpar": pct(rooms_revenue, rooms_available),
        "grandTotal": rooms_revenue + fb_revenue + me_revenue + ood_revenue + other_revenue,
        "oodRevenue": ood_revenue,
    }

def segment_gap(rooms_occupied, segment_rooms):
    total = sum(segment_rooms)
    return {"segmentRooms": total, "unassigned": rooms_occupied - total}

def month_to_date(rooms_available, day_number, rows):
    occupied = sum(r["rooms_occupied"] for r in rows)
    rooms_rev = sum(r["rooms_revenue"] for r in rows)
    fb = sum(r["fb_revenue"] for r in rows)
    me = sum(r["me_revenue"] for r in rows)
    ood = sum(r["ood_revenue"] for r in rows)
    other = sum(r["other_revenue"] for r in rows)
    available = rooms_available * day_number
    return {
        "roomsOccupied": occupied,
        "roomsRevenue": rooms_rev,
        "fbRevenue": fb,
        "meRevenue": me,
        "oodRevenue": ood,
        "otherRevenue": other,
        "available": available,
        "occupancy": pct(occupied, available),
        "adr": pct(rooms_rev, occupied),
        "revpar": pct(rooms_rev, available),
        "grandTotal": rooms_rev + fb + me + ood + other,
    }

def missing_dates(year, month, through_day, saved):
    out = []
    for day in range(1, through_day + 1):
        iso = f"{year:04d}-{month:02d}-{day:02d}"
        if iso not in saved:
            out.append(iso)
    return out
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `python -m pytest tests/test_night_math.py -v`

Expected: 6 passed.

- [ ] **Step 5: Commit when the user has asked for commits**

```bash
git add app/night_math.py tests/test_night_math.py
git commit -m "Add night report formulas locked to the 8 Oct workbook."
```

---

### Task 2: Who can write which section

**Files:**
- Modify: `app/auth.py`
- Test: `tests/test_access.py`

**Interfaces:**
- Consumes: `TokenData.role` values `staff`, `night`, `admin`
- Produces: `can_write(role: str, section: str) -> bool` where `section` is `duty` or `night`

- [ ] **Step 1: Write the failing test**

```python
from app.auth import can_write

def test_staff_writes_duty_only():
    assert can_write("staff", "duty") is True
    assert can_write("staff", "night") is False

def test_night_writes_night_only():
    assert can_write("night", "night") is True
    assert can_write("night", "duty") is False

def test_admin_writes_both():
    assert can_write("admin", "duty") is True
    assert can_write("admin", "night") is True

def test_unknown_role_writes_nothing():
    assert can_write("guest", "duty") is False
```

- [ ] **Step 2: Run it**

Run: `python -m pytest tests/test_access.py -v`

Expected: FAIL, `can_write` is not defined.

- [ ] **Step 3: Add the function at the end of `app/auth.py`**

```python
def can_write(role: str, section: str) -> bool:
    if role == "admin":
        return section in ("duty", "night")
    if role == "staff":
        return section == "duty"
    if role == "night":
        return section == "night"
    return False
```

- [ ] **Step 4: Run it**

Run: `python -m pytest tests/test_access.py -v`

Expected: 4 passed.

- [ ] **Step 5: Commit when asked**

```bash
git add app/auth.py tests/test_access.py
git commit -m "Limit duty and night edits to the matching role."
```

---

### Task 3: Add tables without touching live rows

**Files:**
- Modify: `app/database.py` (`init_db`)
- Test: `tests/test_migration_safety.py`

**Interfaces:**
- Consumes: existing `init_db`
- Produces: tables `settings` and `night_reports`. `settings.hotel_rooms` is `394` when the key was absent. Existing row counts stay the same.

- [ ] **Step 1: Write the failing test**

The test copies the snapshot. It must not open `db/novotel.db` for writing.

```python
import asyncio
import os
import shutil
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def test_migration_keeps_snapshot_rows(tmp_path, monkeypatch):
    data = tmp_path / "data"
    data.mkdir()
    shutil.copy(ROOT / "db" / "novotel.db", data / "novotel.db")
    uploads = data / "uploads"
    uploads.mkdir()
    monkeypatch.setenv("DATA_DIR", str(data))

    import importlib
    import app.database as database
    importlib.reload(database)

    asyncio.run(database.init_db())

    con = sqlite3.connect(data / "novotel.db")
    assert con.execute("select count(*) from reports").fetchone()[0] == 32
    assert con.execute("select count(*) from users").fetchone()[0] == 4
    assert con.execute("select count(*) from uploads").fetchone()[0] == 51
    assert con.execute("select count(*) from notes").fetchone()[0] == 0
    url = con.execute(
        "select url from uploads where filename = ?",
        ("img_92ca64c9693f.jpg",),
    ).fetchone()[0]
    assert url == "/api/uploads/img_92ca64c9693f.jpg"
    assert con.execute("select value from settings where key = 'hotel_rooms'").fetchone()[0] == "394"
    assert con.execute("select count(*) from night_reports").fetchone()[0] == 0
    roles = sorted(r[0] for r in con.execute("select role from users"))
    assert roles == ["admin", "staff", "staff", "staff"]
```

- [ ] **Step 2: Run it**

Run: `python -m pytest tests/test_migration_safety.py -v`

Expected: FAIL, `settings` does not exist.

- [ ] **Step 3: Inside `init_db`, after the `uploads` table is created and before the Houssin seed, add**

```python
        await db.execute("""
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )
        """)
        await db.execute(
            "INSERT INTO settings (key, value) SELECT 'hotel_rooms', '394' WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'hotel_rooms')"
        )
        await db.execute("""
        CREATE TABLE IF NOT EXISTS night_reports (
            date TEXT PRIMARY KEY,
            status TEXT NOT NULL DEFAULT 'draft',
            submitted_at TEXT,
            submitted_by TEXT,
            rooms_available INTEGER NOT NULL,
            rooms_occupied REAL NOT NULL DEFAULT 0,
            rooms_revenue REAL NOT NULL DEFAULT 0,
            fb_revenue REAL NOT NULL DEFAULT 0,
            me_revenue REAL NOT NULL DEFAULT 0,
            ood_revenue REAL NOT NULL DEFAULT 0,
            other_revenue REAL NOT NULL DEFAULT 0,
            segments_json TEXT NOT NULL DEFAULT '[]',
            forecast_json TEXT NOT NULL DEFAULT '[]',
            groups_json TEXT NOT NULL DEFAULT '[]',
            vip_json TEXT NOT NULL DEFAULT '[]',
            checklist_json TEXT NOT NULL DEFAULT '[]',
            comments_json TEXT NOT NULL DEFAULT '[]',
            created_at TEXT,
            updated_at TEXT
        )
        """)
```

`DATA_DIR` is read at import in `app/database.py`. The test reloads the module after setting `DATA_DIR`. Do not point this test at `./data` or `db/novotel.db`.

- [ ] **Step 4: Run it**

Run: `python -m pytest tests/test_migration_safety.py tests/test_night_math.py tests/test_access.py -v`

Expected: all passed. `db/novotel.db` byte size is unchanged. Confirm with `git status -- db/novotel.db` showing no modification.

- [ ] **Step 5: Commit when asked**

```bash
git add app/database.py tests/test_migration_safety.py
git commit -m "Add night report tables without changing existing rows."
```

---

### Task 4: Night API

**Files:**
- Create: `app/routes/night.py`
- Modify: `app/main.py` (register the router next to the other `include_router` calls)
- Test: `tests/test_night_api.py`

**Interfaces:**
- Consumes: `night_figures`, `month_to_date`, `missing_dates`, `segment_gap`, `can_write`, `require_auth`, `get_db`
- Produces:
  - `GET /api/night?date=YYYY-MM-DD` any logged-in role. Missing row returns a blank payload and does not insert.
  - `PUT /api/night` body is the typed fields. Staff receives 403. Night and admin save a draft. A submitted row can be saved only by admin.
  - `POST /api/night/submit?date=` night and admin. Sets `submitted_by` from the users table (`first_name`, `last_name`, `title`), not from the token.
  - `POST /api/night/reopen?date=` admin only
  - `DELETE /api/night?date=` admin only
  - `GET /api/night/index` list of `{date, status, submittedBy, occupancy}` where occupancy is the calculated percent for that row
  - `GET /api/night/analysis?date=&range=week|month` series for the charts in the spec

Blank payload segments are the seven codes with rooms 0 and adr 0. Checklist is the 13 areas with empty remarks. Comments are four empty strings. Forecast is nine days starting the day after `date`, with empty numbers. `rooms_available` on a new payload is the current `hotel_rooms` setting. On an existing row it is the stored `rooms_available`.

The GET response adds `calculated` from `night_figures`, `segments` gap, `mtd` from `month_to_date`, and `missingDates`.

- [ ] **Step 1: Write the failing API test**

Use FastAPI `TestClient`, a temp `DATA_DIR`, and a user inserted directly into sqlite. Hash the password with `get_password_hash`. Cover these cases:

- night user PUT then GET returns ADR 356 for the 8 Oct inputs in the spec
- staff user PUT returns 403 and leaves `night_reports` empty
- GET of a date with no row returns 200 and `night_reports` count stays 0
- admin DELETE removes only that night row

Create the token with `create_access_token` using the same claims `login` already writes (`sub`, `username`, `first_name`, `last_name`, `title`, `role`). Read `app/routes/auth.py` `login` and copy those claim names. Do not invent a second token shape.

- [ ] **Step 2: Run it and confirm failure**

Run: `python -m pytest tests/test_night_api.py -v`

Expected: FAIL, route 404.

- [ ] **Step 3: Implement the router and register it**

In `app/main.py`:

```python
from app.routes import auth, reports, notes, upload, night
```

```python
app.include_router(night.router)
```

Write enforcement at the start of every mutating handler:

```python
if not can_write(user.role, "night") and not (user.role == "admin"):
    raise HTTPException(status_code=403, detail="Night section is read-only for this user")
```

`can_write("admin", "night")` is already true, so the admin clause is unnecessary. Use only `can_write(user.role, "night")`. Submitted-row edits check `user.role == "admin"` the same way `save_report` does.

On first insert, set `rooms_available` from settings. Do not update `rooms_available` on later saves.

Broadcast `{"event": "NIGHT_REPORT_UPDATED", "date": date}` on save, submit, reopen, and delete, using the existing `ws_manager`.

- [ ] **Step 4: Run the night tests**

Run: `python -m pytest tests/test_night_api.py tests/test_migration_safety.py -v`

Expected: passed, and the snapshot file is still unmodified.

- [ ] **Step 5: Commit when asked**

```bash
git add app/routes/night.py app/main.py tests/test_night_api.py
git commit -m "Add the night report API without creating rows on read."
```

---

### Task 5: Duty side honors the same roles

**Files:**
- Modify: `app/routes/reports.py` (`get_reports_index`, `get_report`, `get_analysis`, `save_report`, `submit_report`, `reopen_report`, `delete_report`)
- Modify: `app/models.py` `UserCreate.role` stays a string. Reject anything other than `staff`, `night`, or `admin` in `create_user`
- Modify: `app/routes/auth.py` `create_user`
- Modify: `static/app.js` `renderUsers` role `<select>`
- Test: `tests/test_duty_access.py`

**Interfaces:**
- Consumes: `can_write`, `require_auth`
- Produces: night users get 403 on duty save, submit, reopen, and delete. Staff and admin still save. All three roles can GET.

- [ ] **Step 1: Write the failing test**

Copy the TestClient setup from Task 4. Assert:

- no token on `GET /api/reports/index` returns 401
- a night token on `POST /api/reports` returns 403
- a staff token on `GET /api/reports/index` returns 200 and 32 rows when `DATA_DIR` points at a copy of the snapshot

- [ ] **Step 2: Run it**

Run: `python -m pytest tests/test_duty_access.py -v`

Expected: FAIL, the index currently returns 200 without a token.

- [ ] **Step 3: Change the duty routes**

Add `user: TokenData = Depends(require_auth)` to `get_reports_index`, `get_report`, and `get_analysis`.

At the start of `save_report` and `submit_report`:

```python
if not user or not can_write(user.role, "duty"):
    raise HTTPException(status_code=403, detail="Duty section is read-only for this user")
```

Keep the existing submitted-report admin check after that.

In `create_user`, before insert:

```python
if data.role not in ("staff", "night", "admin"):
    raise HTTPException(status_code=400, detail="Role must be staff, night, or admin")
```

In `renderUsers`, add `<option value="night">Night Manager</option>` between Staff and Admin.

- [ ] **Step 4: Run duty and migration tests**

Run: `python -m pytest tests/test_duty_access.py tests/test_migration_safety.py -v`

Expected: passed.

- [ ] **Step 5: Commit when asked**

```bash
git add app/routes/reports.py app/routes/auth.py static/app.js tests/test_duty_access.py
git commit -m "Stop night users editing duty reports and require login to read them."
```

---

### Task 6: Menu, Riyadh today, read-only duty screens

**Files:**
- Modify: `static/index.html` nav
- Modify: `static/app.js` `todayStr`, `state`, `render`, `enterApp`
- Modify: `static/style.css`

**Interfaces:**
- Consumes: `state.user.role`
- Produces: `state.section` is `duty`, `night`, or `full`. `state.view` stays `today`, `archive`, `analysis`, `users`. `state.canWrite` is true only when `canWrite(state.user.role, state.section)` in JS, matching Task 2.

- [ ] **Step 1: Replace the four nav buttons in `static/index.html` with**

```html
      <div class="nav-section">Duty Manager</div>
      <button class="dmr-navbtn active" data-section="duty" data-view="today">Today's Report</button>
      <button class="dmr-navbtn" data-section="duty" data-view="archive">Archive</button>
      <button class="dmr-navbtn" data-section="duty" data-view="analysis">Analysis</button>
      <div class="nav-section">Night Manager</div>
      <button class="dmr-navbtn" data-section="night" data-view="today">Today's Report</button>
      <button class="dmr-navbtn" data-section="night" data-view="archive">Archive</button>
      <button class="dmr-navbtn" data-section="night" data-view="analysis">Analysis</button>
      <div class="nav-section">General</div>
      <button class="dmr-navbtn" data-section="full" data-view="today">Full Report</button>
      <button class="dmr-navbtn" data-view="users" id="usersNavBtn" style="display:none;">Users</button>
```

Add `<script src="/assets/night.js"></script>` after `app.js`.

- [ ] **Step 2: Change `todayStr`**

```javascript
  function todayStr(){
    return new Date().toLocaleDateString('en-CA', {timeZone: 'Asia/Riyadh'});
  }
```

`en-CA` yields `YYYY-MM-DD`. Do not rewrite stored report dates.

- [ ] **Step 3: In `enterApp`, set the landing section**

```javascript
    state.section = (state.user && state.user.role === 'night') ? 'night' : 'duty';
    state.view = 'today';
```

Add `state.section = 'duty'` to the initial `state` object.

- [ ] **Step 4: Nav clicks set both section and view**

In the existing nav button handler, read `dataset.section` when it is present and assign `state.section` before `render()`.

`state.canWrite` is:

```javascript
function canWrite(role, section){
  if (role === 'admin') return section === 'duty' || section === 'night';
  if (role === 'staff') return section === 'duty';
  if (role === 'night') return section === 'night';
  return false;
}
```

When `state.section === 'duty'` and `canWrite` is false, `renderToday` still shows the report, and the save, submit, and edit controls are not rendered. `persistReport` returns immediately when `!canWrite(state.user.role, 'duty')`.

When `state.section === 'night'` or `state.section === 'full'`, `render()` calls `renderNightSection()` defined in `night.js`. Until Task 7, that function can return a heading "Night Manager" so the menu is navigable.

- [ ] **Step 5: Add CSS**

```css
.nav-section {
  margin: 16px 16px 6px;
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: rgba(255,255,255,0.65);
}
```

Use the existing nav background. Do not change `#1e22aa`.

- [ ] **Step 6: Check in the browser**

Open `http://localhost:8000`, sign in as the admin account, and confirm both section labels, Full Report, and Users. Existing October duty reports still open.

Rebuild is required because the image copies `static/`. From the project root:

```bash
docker compose -f docker-compose.local.yml up -d --build
```

- [ ] **Step 7: Commit when asked**

```bash
git add static/index.html static/app.js static/style.css static/night.js
git commit -m "Split the menu into Duty Manager and Night Manager."
```

---

### Task 7: Night Today form

**Files:**
- Create: `static/night.js`
- Modify: `static/style.css` for a two-column last-night / MTD table

**Interfaces:**
- Consumes: `GET /api/night?date=`, `PUT /api/night`, `POST /api/night/submit`
- Produces: `renderNightSection()` used by `render()` in `app.js`

- [ ] **Step 1: Load and render**

`renderNightSection` for `state.view === 'today'` fetches `/api/night?date=` + `state.selectedDate`. Render the date control with the same control the duty page uses.

Calculated cells (day number, occupancy, ADR, RevPAR, grand total, MTD, unassigned rooms) are text, not inputs. Fill them from `calculated`, `mtd`, and `segmentGap` on the response.

Inputs: rooms occupied, five revenue boxes, seven segment rows (rooms and ADR), add/remove group rows, add/remove VIP rows, nine forecast rows with dates already filled, 13 remarks, four comments.

If `canWrite` is false, render every control disabled and hide Save and Submit. If the payload's `status` is missing because there is no row, show "No night report for this date" and do not PUT.

- [ ] **Step 2: Save**

PUT the typed fields only. After a successful PUT, replace the calculated cells with the response. Debounce 500ms, same pattern as `queueSave` in `app.js`. Do not PUT when `canWrite` is false.

Submit calls `POST /api/night/submit?date=`. The prepared-by line shows `submittedBy` from the response.

Show `missingDates` above the MTD column when the list is not empty: "Missing night reports: 2 Oct, 5 Oct".

Show unassigned rooms under the segment table, including when the number is negative or zero.

- [ ] **Step 3: Check the workbook sample in the browser**

As a night user or admin, enter the 8 Oct last-night inputs from the spec on a date that has no night row, such as 2026-10-13 if none exists. Confirm the page shows occupancy 60%, ADR 356, RevPAR 212, grand total 96,802. Do not submit that practice row if it would be confused with a real operational report. Delete it as admin when the check is done, or use a date outside the live archive and delete it before finishing.

- [ ] **Step 4: Commit when asked**

```bash
git add static/night.js static/style.css static/app.js
git commit -m "Add the night manager daily report form."
```

---

### Task 8: Month groups and date search on both archives

**Files:**
- Modify: `static/app.js` `renderArchive` and `loadArchiveList`
- Modify: `static/night.js` night archive
- Modify: `static/style.css`

**Interfaces:**
- Consumes: `GET /api/reports/index` and `GET /api/night/index`, each item has `date`
- Produces: month groups and a date search that both archives use

- [ ] **Step 1: Add a shared helper in `app.js`**

```javascript
  function groupByMonth(entries){
    const groups = new Map();
    entries.forEach(entry => {
      const [year, month] = entry.date.split('-');
      const key = year + '-' + month;
      if (!groups.has(key)) {
        const label = new Date(entry.date + 'T00:00:00').toLocaleDateString('en-US', {month:'long', year:'numeric', timeZone:'Asia/Riyadh'});
        groups.set(key, {key, label, entries: []});
      }
      groups.get(key).entries.push(entry);
    });
    return Array.from(groups.values());
  }
```

The index is already newest first. Keep that order inside each month.

- [ ] **Step 2: Render groups**

Replace the flat list in `loadArchiveList` with one `<details class="archive-month">` per group. The group whose `key` matches `state.selectedDate.slice(0, 7)` has the `open` attribute. The summary text is the month label and the count.

Put the existing row markup inside the details body. Keep Open, Export PDF, Edit, and Delete under the same conditions as now, and also hide Edit and Delete when `canWrite(state.user.role, 'duty')` is false.

Add `<input type="date" id="archiveSearch">` under the archive heading. On change, if it has a value, render only rows with that date and open their month. If it is empty, render all months again.

- [ ] **Step 3: Use the same markup for the night archive**

`loadNightArchive` calls `groupByMonth` and the same details markup. Edit and Delete show only when `canWrite(state.user.role, 'night')` is true. Open switches to night Today for that date.

- [ ] **Step 4: Check in the browser**

Duty archive shows September 2026 (21 reports) and October 2026 (11 reports). October starts open. Searching 2026-10-08 shows that day only. Clearing the search restores both months. No report row disappears.

- [ ] **Step 5: Commit when asked**

```bash
git add static/app.js static/night.js static/style.css
git commit -m "Group both archives by month and add a date search."
```

---

### Task 9: Duty occupancy chart and PDF

**Files:**
- Modify: `static/app.js` `loadArchiveList`, `renderAnalysis`, `drawChart`, `exportPdf`
- Modify: `app/routes/reports.py` `get_analysis` only if the monthly range must become the calendar month. Prefer computing the series in the browser from `GET /api/reports/index`, which already returns `occupancy` and `date`. Do not add a second analysis payload if the index is enough.

**Interfaces:**
- Consumes: index rows `{date, occupancy}`
- Produces: `parseOccupancy(text) -> number | null` and `occupancySeries(rows, startIso, endIso) -> {labels, values}`

- [ ] **Step 1: Add the parsers in `app.js`**

```javascript
  function parseOccupancy(text){
    if (text == null) return null;
    const cleaned = String(text).replace('%', '').trim();
    if (cleaned === '') return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }

  function occupancySeries(rows, startIso, endIso){
    const byDate = new Map(rows.map(r => [r.date, parseOccupancy(r.occupancy)]));
    const labels = [];
    const values = [];
    let cursor = new Date(startIso + 'T00:00:00');
    const end = new Date(endIso + 'T00:00:00');
    while (cursor <= end) {
      const iso = cursor.toLocaleDateString('en-CA', {timeZone:'Asia/Riyadh'});
      labels.push(iso.slice(8));
      values.push(byDate.has(iso) ? byDate.get(iso) : null);
      cursor.setDate(cursor.getDate() + 1);
    }
    return {labels, values};
  }
```

A missing day is `null`, which Chart.js leaves as a gap.

- [ ] **Step 2: Draw the line**

```javascript
  function drawOccupancyChart(canvasId, series){
    const canvas = document.getElementById(canvasId);
    if (!canvas || !window.Chart) return;
    if (canvas._chart) canvas._chart.destroy();
    canvas._chart = new Chart(canvas, {
      type: 'line',
      data: {
        labels: series.labels,
        datasets: [{
          label: 'Occupancy %',
          data: series.values,
          borderColor: '#1e22aa',
          backgroundColor: 'rgba(30,34,170,0.12)',
          spanGaps: false,
          tension: 0.2
        }]
      },
      options: {
        plugins: {legend: {display: false}},
        scales: {y: {beginAtZero: true, suggestedMax: 100}}
      }
    });
  }
```

Archive: one canvas in the open month, from the 1st through today for the current Riyadh month, otherwise through the last calendar day of that month.

Analysis weekly: 7 days ending `state.selectedDate`. Analysis monthly: from the 1st of `state.selectedDate`'s month through `state.selectedDate`. Keep the existing failure bar chart.

- [ ] **Step 3: Put the chart on the duty PDF**

In `exportPdf`, after the header, add a line chart image for the 1st of that report's month through that report's date. Build the chart on an off-screen canvas, then `doc.addImage(canvas.toDataURL('image/png'), 'PNG', ...)`. If Chart is unavailable, still export the rest of the PDF.

- [ ] **Step 4: Check October**

On the archive, the October chart runs from day 1 through today (13 Oct 2026 while that is today). Days with no duty report are gaps. Export PDF for 12 Oct includes 1 Oct through 12 Oct. September export for 30 Sep includes 1 Sep through 30 Sep.

- [ ] **Step 5: Commit when asked**

```bash
git add static/app.js
git commit -m "Show month-to-date duty occupancy on the archive, analysis, and PDF."
```

---

### Task 10: Night charts and night PDF

**Files:**
- Modify: `static/night.js`
- Consumes: `GET /api/night/analysis?date=&range=week|month`

**Interfaces:**
- Produces: four canvases on the night Analysis page and a night PDF from the GET `/api/night` payload

The analysis endpoint returns:

```json
{
  "labels": ["01", "02"],
  "occupancy": [60.0, null],
  "adr": [356, null],
  "revpar": [212, null],
  "revenue": {"rooms": 0, "fb": 0, "me": 0, "ood": 0, "other": 0},
  "segments": [{"code": "SLA", "rooms": 0}]
}
```

`occupancy`, `adr`, and `revpar` use `money()` for the displayed series so they match the workbook rounding. `null` is a missing night. Revenue is the sum across the range. Segments are the selected date only.

Week and month use the same date windows as Task 9.

The night PDF prints last night and MTD, the segment table with the unassigned line, the nine-day forecast, groups, VIP, the 13 remarks, the four comments, and prepared by. Use `pdfHeader`, `pdfTable`, and `addPdfFooter` already in `app.js`. Expose them on `window` only if `night.js` cannot call them; they are in the same IIFE today, so move those three functions to `window.NovotelPdf` instead of copying them.

- [ ] **Step 1: Return the analysis JSON from `GET /api/night/analysis`**

Add a test in `tests/test_night_api.py` that saves the 8 Oct numbers, requests `range=month` for 2026-10-08, and expects occupancy label `08` to be 60. Grand total for that night is rooms + F&B + M&E + OOD + other. With the sample's OOD of 0, money(grand total) is 96802. A second saved row with OOD 100 increases that night's grand total by 100.

- [ ] **Step 2: Draw the four charts and the PDF**

Chart colors use `#1e22aa` for the main series. Revenue bars use one color per department, with rooms in `#1e22aa`.

- [ ] **Step 3: Check in the browser**

Night Analysis monthly for a date that has a saved night report shows the occupancy point. Weekly shows the seven-day window. Export PDF downloads and contains the grand total.

- [ ] **Step 4: Commit when asked**

```bash
git add app/routes/night.py static/night.js static/app.js tests/test_night_api.py
git commit -m "Add night analysis charts and the night PDF."
```

---

### Task 11: Full Report page

**Files:**
- Modify: `static/night.js` `renderNightSection` when `state.section === 'full'`

**Interfaces:**
- Consumes: `GET /api/reports?date=` and `GET /api/night?date=`
- Produces: a read-only page and `exportCombinedPdf(date)`

- [ ] **Step 1: Render both payloads**

Show the duty summary (date, status, occupancy, arrivals, departures, in house, prepared by) and the night calculated table. Neither form posts. If a GET says there is no saved report, say which one is missing.

- [ ] **Step 2: Combined PDF**

`exportCombinedPdf` calls the duty `exportPdf` builder and then the night PDF builder into the same jsPDF document, adding a page between them. When one side is missing, print one line: "Duty report was not filed for this date" or "Night report was not filed for this date".

- [ ] **Step 3: Check as staff and as a night user**

Both can open Full Report and export. Neither sees a save button. A night user still cannot save a duty report: change a duty field is impossible because the inputs are not there, and `POST /api/reports` from the console returns 403.

- [ ] **Step 4: Commit when asked**

```bash
git add static/night.js static/app.js
git commit -m "Add a read-only combined duty and night report."
```

---

### Task 12: Local Docker check against the snapshot

**Files:**
- None, unless a code fix is required

- [ ] **Step 1: Rebuild**

```bash
docker compose -f docker-compose.local.yml up -d --build
```

- [ ] **Step 2: Confirm the old data is still there**

```bash
docker exec novotel-local python -c "import sqlite3; c=sqlite3.connect('/data/novotel.db'); print(c.execute('select count(*) from reports').fetchone()[0]); print(c.execute('select count(*) from uploads').fetchone()[0]); print(c.execute(\"select count(*) from night_reports\").fetchone()[0])"
```

Expected: `32`, `51`, and `0` until someone saves a night report.

```bash
curl -fsS http://localhost:8000/health
curl -fsS -o NUL -w "%{http_code} %{size_download}" http://localhost:8000/api/uploads/img_92ca64c9693f.jpg
```

Expected: healthy JSON, then `200` and `261834`.

- [ ] **Step 3: Click through**

Login page, duty archive months, one existing photo inside a duty report, night Today empty state, Users role list includes Night Manager. Browser console shows no errors on those pages.

- [ ] **Step 4: Run the host tests once more**

```bash
python -m pytest tests -v
```

Expected: all passed.

---

## Spec coverage

- Menu, roles, and read-only rules: Tasks 2, 5, 6, 7
- Schema and data safety: Task 3, Task 12
- Workbook formulas, OOD included in the grand total, segment gap: Task 1, Task 7
- Night form, forecast, groups, VIP, checklist: Task 7
- Month archive and date search: Task 8
- Duty occupancy chart, archive, analysis, PDF: Task 9
- Night charts and PDF: Task 10
- Full Report: Task 11
- Login required on duty reads, photos left public: Task 5
- Riyadh today: Task 6
- No Show sheet: not in any task

## Self-review notes

- `month_to_date` in Task 1 sums saved rows. The workbook MTD numbers in the test are two rows that add up to the sheet, so the formula is locked without pretending those two rows exist in production.
- `can_write` is the same rule in Python and in the JS copy in Task 6. The tests lock the Python side.
- Task 4's first draft of the write check included a redundant admin clause. The plan tells the implementer to use only `can_write`.
