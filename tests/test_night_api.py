import asyncio
import importlib
import sqlite3
from datetime import date
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

def _ready_inspection():
    from app.routes.reports import CAFETERIA_ITEMS
    from app.submit_gate import night_sections
    return {
        "checklists": {
            sec["key"]: [{"status": True, "comment": "", "photos": []} for _ in sec["items"]]
            for sec in night_sections()
        },
        "cafeteriaItems": [{"status": True, "comment": "", "photos": []} for _ in CAFETERIA_ITEMS],
        "roomsInspection": [{"room": "101", "status": True, "comment": "ok"}],
    }


def _submittable(payload):
    body = dict(payload)
    body["inspection"] = _ready_inspection()
    return body


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
    assert body["mtd"]["available"] == 0

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


def test_new_night_uses_the_saved_room_count(api):
    client, db_path = api
    admin = _headers(USERS["admin"])
    night = _headers(USERS["night"])
    denied = client.put("/api/settings/rooms", json={"rooms": 410}, headers=night)
    assert denied.status_code == 403
    updated = client.put("/api/settings/rooms", json={"rooms": 410}, headers=admin)
    assert updated.status_code == 200
    assert updated.json()["rooms"] == 410

    payload = dict(OCT_8)
    payload["date"] = "2026-10-20"
    assert client.put("/api/night", json=payload, headers=night).status_code == 200
    body = client.get("/api/night?date=2026-10-20", headers=night).json()
    assert body["roomsAvailable"] == 410

    con = sqlite3.connect(db_path)
    try:
        assert con.execute("select value from settings where key = 'hotel_rooms'").fetchone()[0] == "410"
    finally:
        con.close()


def test_forecast_occupancy_uses_total_rooms(api):
    client, _db_path = api
    payload = dict(OCT_8)
    payload["date"] = "2026-10-21"
    payload["forecast"] = [{"totalOcc": "197"}]
    saved = client.put("/api/night", json=payload, headers=_headers(USERS["night"]))
    assert saved.status_code == 200
    first = saved.json()["forecast"][0]
    assert first["totalOcc"] == "197"
    assert first["occPct"] == "50"


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


def test_night_save_leaves_stored_in_house_alone(api):
    client, db_path = api
    headers = _headers(USERS["night"])
    assert client.put("/api/night", json=OCT_8, headers=headers).status_code == 200
    con = sqlite3.connect(db_path)
    con.execute(
        "update night_reports set in_house = ?, overview_occupancy = ? where date = ?",
        ("120", "61", "2026-10-08"),
    )
    con.commit()
    con.close()
    again = dict(OCT_8)
    again["roomsOccupied"] = 236
    saved = client.put("/api/night", json=again, headers=headers)
    assert saved.status_code == 200
    assert saved.json()["roomsOccupied"] == 236
    con = sqlite3.connect(db_path)
    row = con.execute(
        "select in_house, overview_occupancy from night_reports where date = ?",
        ("2026-10-08",),
    ).fetchone()
    con.close()
    assert row == ("120", "61")


def test_blank_night_report_cannot_be_submitted(api):
    client, _db_path = api
    headers = _headers(USERS["night"])
    assert client.put("/api/night", json=OCT_8, headers=headers).status_code == 200
    blocked = client.post("/api/night/submit?date=2026-10-08", headers=headers)
    assert blocked.status_code == 400
    assert "Rooms Inspection" in blocked.json()["detail"]
    assert "Courtesy Calls" not in blocked.json()["detail"]
    assert client.get("/api/night?date=2026-10-08", headers=headers).json()["status"] == "draft"


def test_submit_reads_name_from_users_table(api, monkeypatch):
    client, _db_path = api
    events = _capture_broadcasts(monkeypatch)
    night = _headers(USERS["night"], first_name="Wrong", last_name="Person", title="Impostor")
    assert client.put("/api/night", json=_submittable(OCT_8), headers=night).status_code == 200

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
    assert client.put("/api/night", json=_submittable(OCT_8), headers=night).status_code == 200
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
    assert client.put("/api/night", json=_submittable(OCT_8), headers=night).status_code == 200
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
        "allMembers": "",
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


def test_index_lists_loyalty_members_for_the_archive_chart(api):
    client, _db_path = api
    headers = _headers(USERS["night"])
    body = dict(OCT_8)
    body["allMembers"] = "71"
    assert client.put("/api/night", json=body, headers=headers).status_code == 200
    rows = client.get("/api/night/index", headers=headers).json()
    assert rows[0]["date"] == "2026-10-08"
    assert rows[0]["occupancy"] == 60
    assert rows[0]["allMembers"] == "71"


def test_analysis_totals_rooms_sold_and_occupancy(api):
    client, _db_path = api
    headers = _headers(USERS["night"])
    assert client.put("/api/night", json=OCT_8, headers=headers).status_code == 200
    second = dict(OCT_8)
    second["date"] = "2026-10-06"
    second["roomsOccupied"] = 100
    assert client.put("/api/night", json=second, headers=headers).status_code == 200
    month = client.get("/api/night/analysis?date=2026-10-08&range=month", headers=headers).json()
    assert month["roomsSold"] == 335
    assert month["filedNights"] == 2
    assert month["avgOccupancy"] == round(335 / (394 * 2) * 100, 1)
    assert date(2026, 10, 6).weekday() == 1
    assert date(2026, 10, 8).weekday() == 3
    assert month["weekdayOccupancy"] == round(100 / 394 * 100, 1)
    assert month["weekendOccupancy"] == round(235 / 394 * 100, 1)
    tuesday_adr = money(83561.14 / 100)
    thursday_adr = money(83561.14 / 235)
    assert month["weekdayAdr"] == tuesday_adr
    assert month["weekendAdr"] == thursday_adr
    assert month["avgAdr"] == money((tuesday_adr + thursday_adr) / 2)
    assert month["grandTotal"] == money(2 * (83561.14 + 12833.52 + 406.96))


def test_analysis_sums_segment_rooms_across_the_period(api):
    client, _db_path = api
    headers = _headers(USERS["night"])
    first = dict(OCT_8, segments=[{"code": "SLA", "rooms": 120, "adr": 0}, {"code": "SKP", "rooms": 5, "adr": 0}])
    second = dict(OCT_8, date="2026-10-06", segments=[{"code": "SLA", "rooms": 30, "adr": 0}, {"code": "KGACI", "rooms": 12, "adr": 0}])
    assert client.put("/api/night", json=first, headers=headers).status_code == 200
    assert client.put("/api/night", json=second, headers=headers).status_code == 200
    data = client.get("/api/night/analysis?date=2026-10-09&range=month", headers=headers).json()
    assert [seg["rooms"] for seg in data["segments"]] == [0] * len(SEGMENT_CODES)
    totals = {seg["code"]: seg["rooms"] for seg in data["segmentsPeriod"]}
    assert [seg["code"] for seg in data["segmentsPeriod"]] == SEGMENT_CODES
    assert totals == {"SLA": 150, "KGACI": 12, "QEACI": 0, "TWBCI": 0, "TWACI": 0, "TWACS": 0, "SKP": 5}


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


def test_deleted_user_token_is_rejected(api):
    client, db_path = api
    headers = _headers(USERS["staff"])
    assert client.get("/api/auth/me", headers=headers).status_code == 200
    con = sqlite3.connect(db_path)
    con.execute("delete from users where id = ?", (USERS["staff"][0],))
    con.commit()
    con.close()
    assert client.get("/api/auth/me", headers=headers).status_code == 401


def test_role_is_read_from_the_database(api):
    client, _db_path = api
    user_id, username, first, last, title, _role = USERS["staff"]
    token = create_access_token({
        "sub": user_id,
        "username": username,
        "first_name": first,
        "last_name": last,
        "title": title,
        "role": "admin",
    })
    headers = {"Authorization": f"Bearer {token}"}
    assert client.get("/api/auth/users", headers=headers).status_code == 403


def test_logout_makes_the_token_useless(api):
    client, _db_path = api
    headers = _headers(USERS["staff"])
    assert client.post("/api/auth/logout", headers=headers).status_code == 200
    assert client.get("/api/auth/me", headers=headers).status_code == 401
    assert client.get("/api/night?date=2026-10-08").status_code == 401
