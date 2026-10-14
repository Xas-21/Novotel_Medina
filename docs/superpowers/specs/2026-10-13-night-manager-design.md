# Night Manager section — design

Date: 2026-10-13
Status: implemented on main

## Goal

Add a Night Manager section beside the existing Duty Manager section, plus a read-only Full Report page. Keep every existing duty report, user, note, and uploaded photo. Extend the database by adding tables. Do not rewrite or move the data that is already there.

## Locked decisions

- Hotel inventory in the 8 Oct 2026 workbook is **394 rooms**. That number is the starting setting. Each night report stores the inventory it was calculated with, so a later change does not rewrite history.
- Grand total is `Rooms + F&B + M&E + OOD + Other`. The workbook omitted OOD only because that revenue was zero. The app includes OOD so future OOD revenue is in the total. On the 8 Oct sample, OOD is 0, so the displayed totals stay 96,802 and 696,493.
- The third workbook sheet, No Show & Cancellation, is out of this version. It is a May 2026 placeholder.
- Full Report is one date, read-only, duty and night together, with one combined PDF. Editing stays on each section's Today page.
- Month-to-date figures are calculated from saved night reports. They are not typed.
- Segment room-nights may not equal rooms occupied. The form shows the gap and still allows save.
- Brand blue stays `#1e22aa`. The real logo file stays `static/novotel-logo-blue.png`.

## Menu

```
DUTY MANAGER
  Today's Report
  Archive
  Analysis
NIGHT MANAGER
  Today's Report
  Archive
  Analysis
GENERAL
  Full Report
  Users
```

Users stays admin-only. A staff user lands on Duty Today's Report. A night user lands on Night Today's Report. An admin lands on Duty Today's Report.

## Roles

The `users.role` values become `staff`, `night`, and `admin`. Existing rows stay as they are: Houssin is admin, the other three users are staff. Title stays a label. Role stays the permission.

| Role | Duty | Night | Full Report | Users |
|---|---|---|---|---|
| staff | create, edit own drafts, submit, export | view and export | view | no |
| night | view and export | create, edit own drafts, submit, export | view | no |
| admin | full, including edit, reopen, delete after submit | full, including edit, reopen, delete after submit | view | yes |

A read-only user can open a saved report and export its PDF. They cannot save, submit, reopen, or delete. Opening a date that has no report shows "No report for this date" and does not insert a row.

The same rules are enforced in the API. Hiding a button is not the control.

Submitted reports can be changed only by admin, in both sections. This matches the duty rule already in `save_report`.

## Data that must survive

Checked against `db/novotel.db` on 2026-10-13:

- 32 duty reports, all submitted, from 2026-09-06 through 2026-10-12
- 4 users and their password hashes, names, titles, and roles
- 0 notes
- 51 upload rows, URLs shaped `/api/uploads/<filename>`
- 51 files under `uploads/`, served from `/data/uploads` in Docker

Rules for the migration and every later change:

- No `DROP TABLE`, no `DELETE` of existing rows, no change to `reports.date` as the duty primary key.
- `notes.report_date` keeps its foreign key to `reports(date)`.
- Upload filenames and `uploads.url` values stay the same. Photo files are not renamed, recompressed, or moved.
- New tables are created with `CREATE TABLE IF NOT EXISTS`. The settings row is inserted only when the key is missing.
- Runtime data stays in the Docker data directory (`/data/novotel.db` and `/data/uploads`). The copies in `db/` and `uploads/` are the Git snapshot. Local Docker keeps using `data/`, which is gitignored, so running the app does not rewrite the snapshot.
- A test copies `db/novotel.db` to a temp file, runs the migration, and asserts the counts and one known photo URL are unchanged.

## Schema

Leave `users`, `reports`, `notes`, and `uploads` in place.

Add `settings`:

- `key` text primary key
- `value` text not null
- First row: `hotel_rooms` = `394`

Add `night_reports`, one row per date:

- `date` text primary key, `YYYY-MM-DD`
- `status` text, `draft` or `submitted`
- `submitted_at` text, `submitted_by` text
- `rooms_available` integer, copied from `hotel_rooms` on first save and kept after that
- `rooms_occupied` real
- `rooms_revenue` real
- `fb_revenue` real
- `me_revenue` real
- `ood_revenue` real
- `other_revenue` real
- `segments_json` text
- `forecast_json` text
- `groups_json` text
- `vip_json` text
- `checklist_json` text
- `comments_json` text
- `created_at` text, `updated_at` text

Numbers the night manager types are columns, because charts and PDFs read them. Repeating blocks stay JSON, the same way duty checklists already work.

`segments_json` is this list, in this order: SLA, KGACI, QEACI, TWBCI, TWACI, TWACS, SKP. Each item is `{code, rooms, adr}`.

`forecast_json` is nine days, the day after the report date through nine days later. Each item is `{date, totalOcc, arrRooms, depRooms, occPct, compRooms, averageRate}`. Date and weekday are produced by the app. The occupancies on this block are typed, as they are in the workbook. They are a forecast, not the night's own occupancy formula.

`groups_json` items are `{day, name, rooms, arrival, departure}`.

`vip_json` items are `{date, gold, platinum, diamond, stay}`. `stay` is `in house` or `arrival`.

`checklist_json` items, in order, each `{area, remark}`:

1. Security Check points
2. Meeting halls
3. Departmental Offices
4. Restaurants
5. Kitchens
6. Engineering Section
7. Staff Cafeteria
8. Main Lobby
9. Business Centre
10. Garbage Room
11. Floors Inspection
12. Stores
13. Car Parking

`comments_json` is four strings, matching the four General Comments rows.

## Calculations

Pure functions live in `app/night_math.py`. The API returns them. The page may preview with the same formulas. The saved response is the source of truth.

Inputs for one night: `rooms_available`, `rooms_occupied`, and the five revenue numbers.

- Day number = the calendar day of the report date. 2026-10-08 is 8. It is not typed.
- Occupancy % = rooms occupied ÷ rooms available.
- ADR = rooms revenue ÷ rooms occupied. If rooms occupied is 0, ADR is blank.
- RevPAR = rooms revenue ÷ rooms available.
- Grand total = rooms revenue + F&B + M&E + OOD + other.
- Segment rooms = the sum of the seven segment room counts.
- Unassigned rooms = rooms occupied − segment rooms. Shown even when it is not zero.

Month-to-date uses saved night rows from the first of that month through the report date.

- MTD rooms occupied = sum of `rooms_occupied`
- MTD rooms revenue, F&B, M&E, OOD, and other = sums of those columns
- MTD available room-nights = that report's `rooms_available` × day number
- MTD occupancy % = MTD rooms occupied ÷ MTD available room-nights
- MTD ADR = MTD rooms revenue ÷ MTD rooms occupied
- MTD RevPAR = MTD rooms revenue ÷ MTD available room-nights
- MTD grand total = MTD rooms + MTD F&B + MTD M&E + MTD OOD + MTD other

If any date from the 1st through the report date has no night row, the API returns `missingDates`. The page shows that list. The denominator still uses the calendar day number, which is what the workbook does.

Worked example, 8 Oct 2026, inventory 394, which the tests must match:

| Figure | Last night | Month to date |
|---|---|---|
| Rooms occupied | 235 | 1693 |
| Occupancy | 235 ÷ 394 = 59.6447%, shown as 60% | 1693 ÷ (394 × 8) = 53.7119%, shown as 54% |
| Rooms revenue | 83561.14 | 611610.14 |
| ADR | 83561.14 ÷ 235 = 355.579, shown as 356 | 611610.14 ÷ 1693 = 361.258, shown as 361 |
| RevPAR | 83561.14 ÷ 394 = 212.084, shown as 212 | 611610.14 ÷ 3152 = 194.038, shown as 194 |
| F&B | 12833.52 | 81494.54 |
| M&E | 0 | 0 |
| OOD | 0 | 0 |
| Other | 406.96 | 3387.95 |
| Grand total | 96801.62, shown as 96,802 | 696492.63, shown as 696,493 |

Display uses thousands separators and zero decimal places for money, occupancy, ADR, and RevPAR, matching the workbook's `#,##0` and `0%` formats. Stored values stay exact.

Segment rooms on that sample are 1+25+16+5+99+66+0 = 212. Unassigned = 235 − 212 = 23.

## Night Today page

The form follows the workbook's two used sheets.

General information: date, calculated day number, last-night column, MTD column, then segments, groups, and VIP.

Night observation: the 13 areas with a remark each, four general comments, and "Prepared by" taken from the signed-in user's first name, last name, and title at submit time. The name is read from the database, not from the token, same rule as duty submit.

Empty numeric inputs save as 0. Remarks and comments save as empty strings.

## Archive

Both archives group by calendar month, newest month first. Labels are `October 2026`, `September 2026`. The month that contains the selected date starts open. Other months start closed. The first saved report of a new month creates that month's group.

A date field filters to that day. Clearing it shows the months again.

Each row keeps Open, Export PDF, and, when the user may write, Edit. Admin also keeps Delete. A read-only user does not see Edit or Delete.

## Charts and PDFs

Duty occupancy is parsed from the existing `reports.occupancy` text. `61.93`, `61.93%`, and `54.06%` are all valid. A blank or unparseable value is a gap, not zero.

The duty occupancy chart is a line, one point per calendar day:

- On a day's PDF, from the 1st of that month through that report's date.
- On the archive page, inside the open month: from the 1st through today if it is the current month, otherwise through the last day of that month.
- On Analysis, Weekly: the 7 days ending on the selected date.
- On Analysis, Monthly: the calendar month of the selected date, ending on the selected date when that date is before the month ends.

The existing failure bar chart stays.

Night Analysis, same week and month ranges:

- Occupancy % line, using the calculated night occupancy
- ADR and RevPAR lines
- Revenue by department for the range: rooms, F&B, M&E, OOD, other
- Segment room-nights for the selected night

The night PDF follows the workbook: last night and MTD, segments, the next 9 days, groups, VIP, the checklist, comments, and prepared by. The duty PDF gains the occupancy chart for that report's month-to-date. The combined PDF is the duty PDF content and the night PDF content, one after the other, for the same date. If one of the two reports does not exist, the combined PDF contains the one that does and names the one that is missing.

Chart.js 4.4.4 and jsPDF 2.5.1 stay the libraries already loaded in `index.html`. No new chart library.

## Full Report page

A date picker. Under it, the duty report and the night report for that date, both read-only. Export combined PDF. No save and no submit on this page.

## Auth and dates

`GET /api/reports`, `GET /api/reports/index`, and `GET /api/reports/analysis` require a logged-in user. The page already sends the bearer token from `apiFetch`. Photo files stay on `/api/uploads/...` without a token, because the report images are normal image tags and cannot send the header. Those URLs do not change.

`todayStr()` in `static/app.js` currently uses UTC. It will use `Asia/Riyadh` so a report opened after midnight in Medina gets that calendar date. Saved dates are not rewritten.

Duty write endpoints reject `role = night` with 403. Night write endpoints reject `role = staff` with 403. Admin is allowed on both. Read endpoints allow every logged-in role.

## What this version does not build

- The No Show & Cancellation sheet
- A typed MTD column
- A second database or a move off SQLite
- Renaming or relocating the 51 photos
- Authentication on the photo URLs
- Automatic backup scheduling on the VPS

## Files

- Create `app/night_math.py` for the formulas
- Create `app/routes/night.py` for `/api/night`
- Create `static/night.js` for the night pages, night archive, night analysis, and full report
- Modify `app/database.py` to add the two tables inside `init_db`
- Modify `app/auth.py` with `can_write(role, section)`
- Modify `app/routes/reports.py` so night users cannot write duty reports, and report reads require login
- Modify `app/routes/auth.py` so the user form accepts `night`
- Modify `app/main.py` to register the night router
- Modify `static/index.html` for the grouped menu and `night.js`
- Modify `static/app.js` for the menu, read-only duty mode, month archive, occupancy chart, and Riyadh "today"
- Modify `static/style.css` only for the section labels, month groups, and chart cards
- Create `tests/test_night_math.py`, `tests/test_access.py`, and `tests/test_migration_safety.py`

## Test bar

- The 8 Oct formulas match the table in this spec. OOD is inside the grand total; the sample still matches because OOD is 0. A non-zero OOD increases the total by that amount. Unassigned rooms on the sample are 23.
- Division by zero rooms occupied returns a blank ADR.
- Migration of a copy of `db/novotel.db` leaves 32 reports, 4 users, 51 upload rows, and the URL `/api/uploads/img_92ca64c9693f.jpg`.
- `can_write("night", "duty")` is false. `can_write("staff", "night")` is false. `can_write("admin", "duty")` and `can_write("admin", "night")` are true.
- After implementation, the local site at `http://localhost:8000` still opens the existing October archive, and one existing photo still loads.
