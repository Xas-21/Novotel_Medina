import asyncio
import importlib
import sqlite3
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.auth import create_access_token, get_password_hash
from app.night_math import money

ROOT = Path(__file__).resolve().parents[1]
PASSWORD_HASH = get_password_hash("night-test")

SEGMENT_CODES = ["SLA", "KGACI", "QEACI", "TWBCI", "TWACI", "TWACS", "SKP"]
CHECKLIST_AREAS = [
    "Security Check points",
    "Meeting halls",
    "Departmental Offices",
    "Restaurants",
    "Kitchens",
    "Engineering Section",
    "Staff Cafeteria",
    "Main Lobby",
    "Business Centre",
    "Garbage Room",
    "Floors Inspection",
    "Stores",
    "Car Parking",
]
FORECAST_NUMBERS = ["totalOcc", "arrRooms", "depRooms", "occPct", "compRooms", "averageRate"]

USERS = {
    "night": ("usr_night", "night.user", "Nora", "Night", "Night Manager", "night"),
    "staff": ("usr_staff", "staff.user", "Sam", "Staff", "Duty Manager", "staff"),
    "admin": ("usr_admin", "admin.user", "Ada", "Admin", "General Manager", "admin"),
}

OCT_8 = {
    "date": "2026-10-08",
    "roomsOccupied": 235,
    "roomsRevenue": 83561.14,
    "fbRevenue": 12833.52,
    "meRevenue": 0,
    "oodRevenue": 0,
    "otherRevenue": 406.96,
}


@pytest.fixture
def api(tmp_path, monkeypatch):
    data = tmp_path / "data"
    data.mkdir()
    (data / "uploads").mkdir()
    monkeypatch.setenv("DATA_DIR", str(data))

    import app.database as database
    importlib.reload(database)

    import app.main as main
    importlib.reload(main)

    db_path = data / "novotel.db"
    assert db_path.resolve() != (ROOT / "db" / "novotel.db").resolve()
    assert db_path.is_relative_to(tmp_path)

    asyncio.run(database.init_db())
    _seed(db_path)

    with TestClient(main.app) as client:
        yield client, db_path


def _seed(db_path):
    con = sqlite3.connect(db_path)
    try:
        for user_id, username, first, last, title, role in USERS.values():
            con.execute(
                "INSERT INTO users (id, username, first_name, last_name, title, password_hash, role) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (user_id, username, first, last, title, PASSWORD_HASH, role),
            )
        con.commit()
    finally:
        con.close()


def _headers(user, first_name=None, last_name=None, title=None):
    user_id, username, first, last, user_title, role = user
    token = create_access_token({
        "sub": user_id,
        "username": username,
        "first_name": first if first_name is None else first_name,
        "last_name": last if last_name is None else last_name,
        "title": user_title if title is None else title,
        "role": role,
    })
    return {"Authorization": f"Bearer {token}"}


def _night_count(db_path):
    con = sqlite3.connect(db_path)
    try:
        return con.execute("select count(*) from night_reports").fetchone()[0]
    finally:
        con.close()


def _capture_broadcasts(monkeypatch):
    events = []

    async def capture(message):
        events.append(message)

    monkeypatch.setattr("app.ws.ws_manager.broadcast", capture)
    return events


def test_night_requires_login(api):
    client, db_path = api
    res = client.get("/api/night?date=2026-10-08")
    assert res.status_code == 401
    assert _night_count(db_path) == 0


def test_get_missing_date_returns_blank_without_insert(api, monkeypatch):
    client, db_path = api
    events = _capture_broadcasts(monkeypatch)
    assert _night_count(db_path) == 0

    res = client.get("/api/night?date=2026-10-08", headers=_headers(USERS["staff"]))

    assert res.status_code == 200
    assert res.headers["content-type"].startswith("application/json")
    body = res.json()
    assert body["date"] == "2026-10-08"
    assert "status" not in body
    assert body["roomsAvailable"] == 394
    assert body["roomsOccupied"] == 0
    assert body["segments"] == [{"code": code, "rooms": 0, "adr": 0} for code in SEGMENT_CODES]
    assert [item["area"] for item in body["checklist"]] == CHECKLIST_AREAS
    assert [item["remark"] for item in body["checklist"]] == [""] * len(CHECKLIST_AREAS)
    assert body["comments"] == ["", "", "", ""]
    assert [day["date"] for day in body["forecast"]] == [
        "2026-10-09", "2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13",
        "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17",
    ]
    assert all(day[key] == "" for day in body["forecast"] for key in FORECAST_NUMBERS)
    assert body["groups"] == []
    assert body["vip"] == []
    assert body["calculated"]["adr"] is None
    assert body["calculated"]["oodRevenue"] == 0
    assert body["segmentGap"] == {"segmentRooms": 0, "unassigned": 0}
    assert body["mtd"]["available"] == 394 * 8
    assert body["mtd"]["grandTotal"] == 0
    assert body["missingDates"] == [f"2026-10-{day:02d}" for day in range(1, 9)]
    assert _night_count(db_path) == 0
    assert events == []


def test_night_put_then_get_returns_adr_356(api, monkeypatch):
    client, _db_path = api
    events = _capture_broadcasts(monkeypatch)
    headers = _headers(USERS["night"])

    saved = client.put("/api/night", json=OCT_8, headers=headers)
    assert saved.status_code == 200

    res = client.get("/api/night?date=2026-10-08", headers=headers)
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "draft"
    assert body["roomsAvailable"] == 394
    assert body["roomsOccupied"] == 235
    calc = body["calculated"]
    assert money(calc["occupancy"] * 100) == 60
    assert money(calc["adr"]) == 356
    assert money(calc["revpar"]) == 212
    assert money(calc["grandTotal"]) == 96802
    assert "2026-10-08" not in body["missingDates"]
    assert events == [{"event": "NIGHT_REPORT_UPDATED", "date": "2026-10-08"}]


def test_staff_can_save_a_night_report_when_covering(api, monkeypatch):
    client, db_path = api
    events = _capture_broadcasts(monkeypatch)

    res = client.put("/api/night", json=OCT_8, headers=_headers(USERS["staff"]))

    assert res.status_code == 200
    assert _night_count(db_path) == 1
    assert events == [{"event": "NIGHT_REPORT_UPDATED", "date": "2026-10-08"}]


def test_grand_total_includes_ood(api):
    client, _db_path = api
    payload = dict(OCT_8)
    payload["date"] = "2026-10-09"
    payload["oodRevenue"] = 100
    headers = _headers(USERS["night"])

    assert client.put("/api/night", json=payload, headers=headers).status_code == 200
    body = client.get("/api/night?date=2026-10-09", headers=headers).json()

    assert body["calculated"]["oodRevenue"] == 100
    assert body["calculated"]["grandTotal"] == pytest.approx(83561.14 + 12833.52 + 0 + 100 + 406.96)


def test_later_save_keeps_stored_rooms_available(api):
    client, db_path = api
    headers = _headers(USERS["night"])
    assert client.put("/api/night", json=OCT_8, headers=headers).status_code == 200

    con = sqlite3.connect(db_path)
    con.execute("UPDATE settings SET value = '500' WHERE key = 'hotel_rooms'")
    con.commit()
    con.close()

    changed = dict(OCT_8)
    changed["roomsOccupied"] = 236
    assert client.put("/api/night", json=changed, headers=headers).status_code == 200
    body = client.get("/api/night?date=2026-10-08", headers=headers).json()
    assert body["roomsAvailable"] == 394
    assert body["roomsOccupied"] == 236


def test_submit_reads_name_from_users_table(api, monkeypatch):
    client, _db_path = api
    events = _capture_broadcasts(monkeypatch)
    night = _headers(USERS["night"], first_name="Wrong", last_name="Person", title="Impostor")
    assert client.put("/api/night", json=OCT_8, headers=night).status_code == 200

    before = len(events)
    res = client.post("/api/night/submit?date=2026-10-08", headers=night)
    assert res.status_code == 200
    assert res.json()["submittedBy"] == "Nora Night — Night Manager"
    body = client.get("/api/night?date=2026-10-08", headers=night).json()
    assert body["status"] == "submitted"
    assert body["submittedBy"] == "Nora Night — Night Manager"
    assert "Wrong Person" not in body["submittedBy"]
    assert events[before:] == [{"event": "NIGHT_REPORT_UPDATED", "date": "2026-10-08"}]


def test_submitted_night_can_be_saved_only_by_admin(api):
    client, _db_path = api
    night = _headers(USERS["night"])
    admin = _headers(USERS["admin"])
    assert client.put("/api/night", json=OCT_8, headers=night).status_code == 200
    assert client.post("/api/night/submit?date=2026-10-08", headers=night).status_code == 200

    changed = dict(OCT_8)
    changed["roomsOccupied"] = 100
    denied = client.put("/api/night", json=changed, headers=night)
    assert denied.status_code == 403
    assert client.get("/api/night?date=2026-10-08", headers=night).json()["roomsOccupied"] == 235

    changed["roomsOccupied"] = 200
    assert client.put("/api/night", json=changed, headers=admin).status_code == 200
    saved = client.get("/api/night?date=2026-10-08", headers=admin).json()
    assert saved["roomsOccupied"] == 200
    assert saved["status"] == "submitted"


def test_reopen_is_admin_only(api, monkeypatch):
    client, _db_path = api
    events = _capture_broadcasts(monkeypatch)
    night = _headers(USERS["night"])
    admin = _headers(USERS["admin"])
    assert client.put("/api/night", json=OCT_8, headers=night).status_code == 200
    assert client.post("/api/night/submit?date=2026-10-08", headers=night).status_code == 200

    before = len(events)
    denied = client.post("/api/night/reopen?date=2026-10-08", headers=night)
    assert denied.status_code == 403
    assert len(events) == before
    assert client.get("/api/night?date=2026-10-08", headers=night).json()["status"] == "submitted"

    reopened = client.post("/api/night/reopen?date=2026-10-08", headers=admin)
    assert reopened.status_code == 200
    body = client.get("/api/night?date=2026-10-08", headers=admin).json()
    assert body["status"] == "draft"
    assert body["submittedBy"] is None
    assert events[before:] == [{"event": "NIGHT_REPORT_UPDATED", "date": "2026-10-08"}]


def test_admin_delete_removes_only_that_night_row(api, monkeypatch):
    client, db_path = api
    events = _capture_broadcasts(monkeypatch)
    night = _headers(USERS["night"])
    admin = _headers(USERS["admin"])
    other = dict(OCT_8)
    other["date"] = "2026-10-07"
    assert client.put("/api/night", json=OCT_8, headers=night).status_code == 200
    assert client.put("/api/night", json=other, headers=night).status_code == 200

    con = sqlite3.connect(db_path)
    con.execute("INSERT INTO reports (date, status) VALUES ('2026-10-08', 'draft')")
    con.commit()
    con.close()

    before = len(events)
    denied = client.delete("/api/night?date=2026-10-08", headers=night)
    assert denied.status_code == 403
    assert len(events) == before

    deleted = client.delete("/api/night?date=2026-10-08", headers=admin)
    assert deleted.status_code == 200
    assert events[before:] == [{"event": "NIGHT_REPORT_UPDATED", "date": "2026-10-08"}]

    con = sqlite3.connect(db_path)
    try:
        nights = [row[0] for row in con.execute("select date from night_reports order by date")]
        reports = [row[0] for row in con.execute("select date from reports order by date")]
    finally:
        con.close()
    assert nights == ["2026-10-07"]
    assert reports == ["2026-10-08"]
    assert _night_count(db_path) == 1

    reread = client.get("/api/night?date=2026-10-08", headers=admin)
    assert reread.status_code == 200
    assert "status" not in reread.json()
    assert _night_count(db_path) == 1


def test_index_occupancy_is_calculated_percent(api):
    client, _db_path = api
    headers = _headers(USERS["night"])
    assert client.put("/api/night", json=OCT_8, headers=headers).status_code == 200

    res = client.get("/api/night/index", headers=headers)
    assert res.status_code == 200
    assert res.json() == [{
        "date": "2026-10-08",
        "status": "draft",
        "submittedBy": None,
        "occupancy": 60,
    }]


def test_analysis_is_available_to_a_logged_in_user(api):
    client, db_path = api
    res = client.get(
        "/api/night/analysis?date=2026-10-08&range=month",
        headers=_headers(USERS["staff"]),
    )
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("application/json")
    assert isinstance(res.json(), dict)
    assert _night_count(db_path) == 0


def test_month_analysis_series_and_ood_grand_total(api):
    client, db_path = api
    headers = _headers(USERS["night"])
    sample_total = 83561.14 + 12833.52 + 0 + 0 + 406.96
    assert money(sample_total) == 96802

    assert client.put("/api/night", json=OCT_8, headers=headers).status_code == 200
    saved = client.get("/api/night?date=2026-10-08", headers=headers).json()
    assert money(saved["calculated"]["grandTotal"]) == 96802

    month = client.get(
        "/api/night/analysis?date=2026-10-08&range=month",
        headers=headers,
    ).json()
    assert month["labels"] == [f"{day:02d}" for day in range(1, 9)]
    assert month["occupancy"] == [None] * 7 + [60]
    assert month["adr"] == [None] * 7 + [356]
    assert month["revpar"] == [None] * 7 + [212]
    assert month["revenue"] == {
        "rooms": money(83561.14),
        "fb": money(12833.52),
        "me": money(0),
        "ood": money(0),
        "other": money(406.96),
    }
    assert month["segments"] == [{"code": code, "rooms": 0} for code in SEGMENT_CODES]
    assert _night_count(db_path) == 1

    second = dict(OCT_8)
    second["date"] = "2026-10-01"
    second["oodRevenue"] = 100
    second["segments"] = [{"code": "SLA", "rooms": 12}]
    assert client.put("/api/night", json=second, headers=headers).status_code == 200
    other = client.get("/api/night?date=2026-10-01", headers=headers).json()
    assert money(other["calculated"]["grandTotal"]) == money(sample_total + 100)

    month = client.get(
        "/api/night/analysis?date=2026-10-08&range=month",
        headers=headers,
    ).json()
    assert month["occupancy"][0] == money((235 / 394) * 100)
    assert month["occupancy"][-1] == 60
    assert month["revenue"] == {
        "rooms": money(83561.14 * 2),
        "fb": money(12833.52 * 2),
        "me": money(0),
        "ood": money(100),
        "other": money(406.96 * 2),
    }
    assert month["segments"] == [{"code": code, "rooms": 0} for code in SEGMENT_CODES]

    selected = client.get(
        "/api/night/analysis?date=2026-10-01&range=month",
        headers=headers,
    ).json()
    assert selected["labels"] == ["01"]
    assert selected["segments"] == [{"code": "SLA", "rooms": 12}] + [
        {"code": code, "rooms": 0} for code in SEGMENT_CODES if code != "SLA"
    ]

    week = client.get(
        "/api/night/analysis?date=2026-10-08&range=week",
        headers=headers,
    ).json()
    assert week["labels"] == ["02", "03", "04", "05", "06", "07", "08"]
    assert week["occupancy"] == [None] * 6 + [60]
    assert week["adr"] == [None] * 6 + [356]
    assert week["revpar"] == [None] * 6 + [212]
    assert week["revenue"]["ood"] == 0
    assert week["segments"][0] == {"code": "SLA", "rooms": 0}


def test_night_inspection_roundtrip(api):
    client, _db_path = api
    headers = _headers(USERS["night"])
    payload = dict(OCT_8)
    payload["date"] = "2026-10-10"
    payload["inspection"] = {
        "cafeteriaMealTime": "Dinner",
        "checklists": {
            "publicAreas": [{"status": False, "comment": "door", "photos": ["/api/uploads/x.jpg"]}]
        },
        "complaints": [{"complaint": "noise", "room": "12", "action": "called"}],
        "notes": [{
            "id": "n1",
            "text": "leak",
            "department": "Maintenance",
            "priority": "urgent",
            "status": "open",
            "photo_url": None,
            "manager": "Nora",
            "time": "01:00",
        }],
    }

    saved = client.put("/api/night", json=payload, headers=headers)
    assert saved.status_code == 200
    body = saved.json()
    assert body["inspection"]["cafeteriaMealTime"] == "Dinner"
    assert body["inspection"]["checklists"]["publicAreas"][0]["comment"] == "door"
    assert body["inspection"]["notes"][0]["text"] == "leak"

    again = client.get("/api/night?date=2026-10-10", headers=headers)
    assert again.status_code == 200
    assert again.json()["inspection"]["complaints"][0]["room"] == "12"

    keep = dict(OCT_8)
    keep["date"] = "2026-10-10"
    kept = client.put("/api/night", json=keep, headers=headers)
    assert kept.status_code == 200
    assert kept.json()["inspection"]["cafeteriaMealTime"] == "Dinner"

    blank = client.get("/api/night?date=2026-10-03", headers=headers)
    assert blank.json()["inspection"] is None
