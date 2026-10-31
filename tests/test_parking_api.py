import asyncio
import importlib
import sqlite3

import pytest
from fastapi.testclient import TestClient

from app.auth import create_access_token, get_password_hash

PASSWORD_HASH = get_password_hash("parking-test")

USERS = {
    "admin": ("usr_admin", "admin.user", "Ada", "Admin", "General Manager", "admin"),
    "staff": ("usr_staff", "staff.user", "Sam", "Staff", "Duty Manager", "staff"),
    "parking": ("usr_park", "park.user", "Rana", "Desk", "Parking Attendant", "parking"),
    "night": ("usr_night", "night.user", "Nora", "Night", "Night Manager", "night"),
    "guest": ("usr_guest", "guest.user", "Gina", "Guest", "Guest Relation", "guest"),
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
    asyncio.run(database.init_db())
    con = sqlite3.connect(db_path)
    for user_id, username, first, last, title, role in USERS.values():
        con.execute(
            "INSERT INTO users (id, username, first_name, last_name, title, password_hash, role) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (user_id, username, first, last, title, PASSWORD_HASH, role),
        )
    con.commit()
    con.close()

    with TestClient(main.app) as client:
        yield client, db_path


def _headers(name):
    user_id, username, first, last, title, role = USERS[name]
    token = create_access_token({
        "sub": user_id, "username": username, "first_name": first,
        "last_name": last, "title": title, "role": role,
    })
    return {"Authorization": f"Bearer {token}"}


def _spot(client, spot_id):
    spots = client.get("/api/parking/spots", headers=_headers("staff")).json()
    return next(s for s in spots if s["id"] == spot_id)


CHECKIN = {"room": "101", "isVisitor": False, "date": "2026-10-24", "time": "12:00"}


def test_floors_match_the_parking_layout(api):
    client, _ = api
    spots = client.get("/api/parking/spots", headers=_headers("staff")).json()
    b2 = [s for s in spots if s["floor"] == "B2"]
    b3 = [s for s in spots if s["floor"] == "B3"]
    assert len(b2) == 22 and len(b3) == 21
    assert [s["number"] for s in b2 if s["isHandicap"]] == [15]
    assert [s["number"] for s in b3 if s["isHandicap"]] == [12]
    assert [s["number"] for s in b2 if s["size"] == "S"] == [7, 11]
    assert all(s["status"] == "available" for s in spots)


def test_seeding_twice_keeps_parked_cars(api, monkeypatch):
    client, _ = api
    client.post("/api/parking/spots/B2-1/checkin", json=CHECKIN, headers=_headers("staff"))
    import app.database as database
    asyncio.run(database.init_db())
    assert _spot(client, "B2-1")["status"] == "occupied"


def test_check_in_extend_and_check_out_are_logged(api):
    client, _ = api
    h = _headers("parking")
    res = client.post("/api/parking/spots/B2-5/checkin", json=CHECKIN, headers=h)
    assert res.status_code == 200
    assert res.json()["room"] == "101" and res.json()["status"] == "occupied"

    res = client.post("/api/parking/spots/B2-5/extend", json={"date": "2026-10-26", "time": "14:00"}, headers=h)
    assert res.json()["dateOut"] == "2026-10-26" and res.json()["timeOut"] == "14:00"

    res = client.post("/api/parking/spots/B2-5/checkout", headers=h)
    assert res.json()["status"] == "available" and res.json()["room"] == ""

    logs = client.get("/api/parking/logs", headers=h).json()["items"]
    assert [log["action"] for log in logs] == ["Checked OUT", "Extended stay to 2026-10-26", "Checked IN (Room 101)"]
    assert all(log["spotId"] == "B2-5" and log["actor"] == "Rana Desk" for log in logs)


def test_visitor_needs_no_room_but_guests_do(api):
    client, _ = api
    h = _headers("staff")
    res = client.post("/api/parking/spots/B3-2/checkin", json={**CHECKIN, "room": ""}, headers=h)
    assert res.status_code == 400 and res.json()["detail"] == "Room Number required"
    res = client.post("/api/parking/spots/B3-2/checkin", json={**CHECKIN, "room": "", "isVisitor": True}, headers=h)
    assert res.json()["room"] == "VISITOR" and res.json()["isVisitor"] is True
    res = client.post("/api/parking/spots/B3-3/checkin", json={**CHECKIN, "date": ""}, headers=h)
    assert res.status_code == 400


def test_hod_check_in_records_the_position_and_skips_the_room(api):
    client, _ = api
    h = _headers("staff")
    res = client.post("/api/parking/spots/B2-14/checkin", json={**CHECKIN, "room": "", "isHod": True}, headers=h)
    assert res.status_code == 400 and res.json()["detail"] == "Position required"
    both = {**CHECKIN, "room": "", "isHod": True, "isVisitor": True, "position": "Front Office Manager"}
    assert client.post("/api/parking/spots/B2-14/checkin", json=both, headers=h).status_code == 400
    spot = client.post("/api/parking/spots/B2-14/checkin", json={
        **CHECKIN, "room": "", "isHod": True, "position": "Front Office Manager", "guestName": "Sara Ali",
    }, headers=h).json()
    assert spot["isHod"] is True and spot["isVisitor"] is False
    assert (spot["position"], spot["guestName"], spot["room"]) == ("Front Office Manager", "Sara Ali", "")
    freed = client.post("/api/parking/spots/B2-14/checkout", headers=h).json()
    assert freed["isHod"] is False and freed["position"] == ""
    came_in = client.get("/api/parking/logs", params={"spot": "B2-14"}, headers=h).json()["items"][-1]
    assert came_in["action"] == "Checked IN (HOD)"
    assert came_in["details"]["position"] == "Front Office Manager"
    assert came_in["details"]["guestName"] == "Sara Ali"


def test_a_taken_spot_cannot_be_checked_in_twice(api):
    client, _ = api
    h = _headers("staff")
    client.post("/api/parking/spots/B2-9/checkin", json=CHECKIN, headers=h)
    res = client.post("/api/parking/spots/B2-9/checkin", json={**CHECKIN, "room": "202"}, headers=h)
    assert res.status_code == 409
    assert _spot(client, "B2-9")["room"] == "101"
    res = client.post("/api/parking/spots/B2-10/checkout", headers=h)
    assert res.status_code == 409


def test_every_role_can_park_cars(api):
    client, _ = api
    for name in ("night", "guest", "parking"):
        assert client.post("/api/parking/spots/B2-4/checkin", json=CHECKIN, headers=_headers(name)).status_code == 200
        assert client.post("/api/parking/spots/B2-4/extend", json={"date": "2026-10-25", "time": "10:00"}, headers=_headers(name)).status_code == 200
        assert client.post("/api/parking/spots/B2-4/checkout", headers=_headers(name)).status_code == 200


def test_parking_needs_login(api):
    client, _ = api
    assert client.get("/api/parking/spots").status_code == 401
    assert client.post("/api/parking/spots/B2-4/checkin", json=CHECKIN).status_code == 401


def test_unknown_spot_is_not_found(api):
    client, _ = api
    assert client.post("/api/parking/spots/B9-1/checkout", headers=_headers("staff")).status_code == 404


def test_logs_filter_by_spot_user_and_date(api):
    client, _ = api
    client.post("/api/parking/spots/B2-5/checkin", json=CHECKIN, headers=_headers("staff"))
    client.post("/api/parking/spots/B3-15/checkin", json=CHECKIN, headers=_headers("parking"))
    h = _headers("staff")
    by_spot = client.get("/api/parking/logs", params={"spot": "b3-1"}, headers=h).json()["items"]
    assert [log["spotId"] for log in by_spot] == ["B3-15"]
    by_user = client.get("/api/parking/logs", params={"user": "Sam Staff"}, headers=h).json()["items"]
    assert [log["spotId"] for log in by_user] == ["B2-5"]
    assert client.get("/api/parking/logs", params={"user": "Sam"}, headers=h).json()["items"] == []
    day = by_user[0]["date"]
    assert len(client.get("/api/parking/logs", params={"date": day}, headers=h).json()["items"]) == 2
    assert client.get("/api/parking/logs", params={"date": "2000-01-01"}, headers=h).json()["items"] == []
    assert client.get("/api/parking/logs", params={"user": "%"}, headers=h).json()["items"] == []


def test_user_filter_lists_every_user_and_past_actors(api):
    client, db_path = api
    client.post("/api/parking/spots/B2-5/checkin", json=CHECKIN, headers=_headers("parking"))
    con = sqlite3.connect(db_path)
    con.execute("DELETE FROM users WHERE id = 'usr_park'")
    con.commit()
    con.close()
    names = client.get("/api/parking/users", headers=_headers("guest")).json()
    assert names == ["Ada Admin", "Gina Guest", "Nora Night", "Rana Desk", "Sam Staff"]
    assert client.get("/api/parking/users").status_code == 401


CAR = {"guestName": "Omar Saleh", "plate": "abc 1234", "carModel": "Toyota Camry", "carColour": "Silver"}


def test_car_details_are_kept_on_the_spot_and_in_every_log(api):
    client, _ = api
    h = _headers("staff")
    spot = client.post("/api/parking/spots/B2-5/checkin", json={**CHECKIN, **CAR}, headers=h).json()
    assert (spot["guestName"], spot["plate"], spot["carModel"], spot["carColour"]) == ("Omar Saleh", "ABC 1234", "Toyota Camry", "Silver")
    client.post("/api/parking/spots/B2-5/extend", json={"date": "2026-10-27", "time": "09:00"}, headers=h)
    freed = client.post("/api/parking/spots/B2-5/checkout", headers=h).json()
    assert freed["guestName"] == "" and freed["plate"] == ""
    out, extended, came_in = client.get("/api/parking/logs", headers=h).json()["items"]
    for log in (out, extended, came_in):
        assert log["details"]["plate"] == "ABC 1234" and log["details"]["room"] == "101"
    assert came_in["details"]["dateOut"] == "2026-10-24"
    assert extended["details"]["dateOut"] == "2026-10-27"
    assert out["details"]["guestName"] == "Omar Saleh"


def _oos(client, spot, start, end, who="admin"):
    return client.post(f"/api/parking/spots/{spot}/out-of-service", json={"dateFrom": start, "dateTo": end}, headers=_headers(who))


def test_only_admin_can_put_a_spot_out_of_service(api):
    client, _ = api
    import app.routes.parking as parking
    today = parking._today()
    assert _oos(client, "B2-8", today, "2099-01-01", who="staff").status_code == 403
    spot = _oos(client, "B2-8", today, "2099-01-01").json()
    assert (spot["oosFrom"], spot["oosTo"]) == (today, "2099-01-01")
    res = client.post("/api/parking/spots/B2-8/checkin", json=CHECKIN, headers=_headers("staff"))
    assert res.status_code == 409 and "out of service" in res.json()["detail"]
    assert client.post("/api/parking/spots/B2-8/back-in-service", headers=_headers("staff")).status_code == 403
    assert client.post("/api/parking/spots/B2-8/back-in-service", headers=_headers("admin")).json()["oosTo"] == ""
    assert client.post("/api/parking/spots/B2-8/checkin", json=CHECKIN, headers=_headers("staff")).status_code == 200
    actions = [log["action"] for log in client.get("/api/parking/logs", params={"spot": "B2-8"}, headers=_headers("admin")).json()["items"]]
    assert actions == ["Checked IN (Room 101)", "Back in service", f"Set out of service ({today} to 2099-01-01)"]


def test_out_of_service_dates_are_checked(api):
    client, _ = api
    assert _oos(client, "B2-8", "2099-01-05", "2099-01-01").status_code == 400
    assert _oos(client, "B2-8", "2000-01-01", "2000-01-02").status_code == 400
    assert _oos(client, "B2-8", "", "").status_code == 400
    client.post("/api/parking/spots/B2-9/checkin", json=CHECKIN, headers=_headers("staff"))
    assert _oos(client, "B2-9", "2099-01-01", "2099-01-02").status_code == 409


def test_a_future_out_of_service_window_still_allows_check_in(api):
    client, _ = api
    _oos(client, "B3-1", "2099-01-01", "2099-01-02")
    assert client.post("/api/parking/spots/B3-1/checkin", json=CHECKIN, headers=_headers("staff")).status_code == 200


def test_old_parking_tables_get_the_new_columns(tmp_path, monkeypatch):
    data = tmp_path / "data"
    data.mkdir()
    con = sqlite3.connect(data / "novotel.db")
    con.execute("CREATE TABLE parking_spots (id TEXT PRIMARY KEY, floor TEXT NOT NULL, number INTEGER NOT NULL, size TEXT NOT NULL DEFAULT 'L', is_handicap INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'available', room TEXT NOT NULL DEFAULT '', is_visitor INTEGER NOT NULL DEFAULT 0, date_out TEXT NOT NULL DEFAULT '', time_out TEXT NOT NULL DEFAULT '')")
    con.execute("CREATE TABLE parking_logs (id TEXT PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, spot_id TEXT NOT NULL DEFAULT '-', date TEXT NOT NULL, time TEXT NOT NULL, created_at TEXT NOT NULL)")
    con.execute("INSERT INTO parking_spots (id, floor, number, status, room) VALUES ('B2-1', 'B2', 1, 'occupied', '707')")
    con.commit()
    con.close()
    monkeypatch.setenv("DATA_DIR", str(data))
    import app.database as database
    importlib.reload(database)
    asyncio.run(database.init_db())
    con = sqlite3.connect(data / "novotel.db")
    spot_cols = {r[1] for r in con.execute("PRAGMA table_info(parking_spots)")}
    log_cols = {r[1] for r in con.execute("PRAGMA table_info(parking_logs)")}
    assert {"guest_name", "plate", "car_model", "car_colour", "oos_from", "oos_to", "position", "is_hod"} <= spot_cols
    assert "details_json" in log_cols
    assert con.execute("SELECT room FROM parking_spots WHERE id = 'B2-1'").fetchone()[0] == "707"
    con.close()


def test_changes_are_broadcast(api, monkeypatch):
    client, _ = api
    import app.routes.parking as parking
    events = []

    async def capture(message):
        events.append(message)

    monkeypatch.setattr(parking.ws_manager, "broadcast", capture)
    client.post("/api/parking/spots/B2-5/checkin", json=CHECKIN, headers=_headers("staff"))
    assert events[0]["event"] == "PARKING_UPDATED"
    assert events[0]["spot"]["id"] == "B2-5"


def _security_headers(db_path):
    con = sqlite3.connect(db_path)
    con.execute(
        "INSERT INTO users (id, username, first_name, last_name, title, password_hash, role) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ("usr_sec", "sec.user", "Samir", "Guard", "Security", PASSWORD_HASH, "security"),
    )
    con.commit()
    con.close()
    token = create_access_token({
        "sub": "usr_sec", "username": "sec.user", "first_name": "Samir",
        "last_name": "Guard", "title": "Security", "role": "security",
    })
    return {"Authorization": f"Bearer {token}"}


def test_security_checks_out_only_cars_due_today_or_overdue(api):
    client, db_path = api
    sec = _security_headers(db_path)
    import app.routes.parking as parking
    today = parking._today()
    staff = _headers("staff")

    assert client.get("/api/parking/spots", headers=sec).status_code == 200
    stayed = client.post(
        "/api/parking/spots/B2-6/checkin",
        json={**CHECKIN, "date": "2099-01-01", "time": "12:00", **CAR},
        headers=staff,
    )
    assert stayed.status_code == 200
    assert client.post("/api/parking/spots/B2-7/checkin", json=CHECKIN, headers=sec).status_code == 403
    assert client.post(
        "/api/parking/spots/B2-6/extend",
        json={"date": "2099-02-01", "time": "12:00"},
        headers=sec,
    ).status_code == 403
    blocked = client.post("/api/parking/spots/B2-6/checkout", headers=sec)
    assert blocked.status_code == 403
    assert _spot(client, "B2-6")["room"] == "101"
    assert client.post("/api/parking/spots/B2-6/checkout", headers=staff).status_code == 200

    due = client.post(
        "/api/parking/spots/B2-11/checkin",
        json={**CHECKIN, "date": today, "time": "23:59"},
        headers=staff,
    )
    assert due.status_code == 200
    assert client.post("/api/parking/spots/B2-11/checkout", headers=sec).status_code == 200
    assert _spot(client, "B2-11")["status"] == "available"

    overdue = client.post("/api/parking/spots/B2-12/checkin", json=CHECKIN, headers=staff)
    assert overdue.status_code == 200
    assert client.post("/api/parking/spots/B2-12/checkout", headers=sec).status_code == 200
    assert _spot(client, "B2-12")["status"] == "available"


def test_logs_can_be_filtered_by_the_check_in_room(api):
    client, _ = api
    h = _headers("staff")
    assert client.post("/api/parking/spots/B2-18/checkin", json={**CHECKIN, "room": "4003"}, headers=h).status_code == 200
    assert client.post("/api/parking/spots/B2-19/checkin", json={**CHECKIN, "room": "101"}, headers=h).status_code == 200
    assert client.post("/api/parking/spots/B2-18/extend", json={"date": "2026-10-26", "time": "14:00"}, headers=h).status_code == 200
    assert client.post("/api/parking/spots/B2-18/checkout", headers=h).status_code == 200
    items = client.get("/api/parking/logs", params={"room": "4003"}, headers=h).json()["items"]
    assert [item["spotId"] for item in items] == ["B2-18", "B2-18", "B2-18"]
    assert [item["details"]["room"] for item in items] == ["4003", "4003", "4003"]
    assert client.get("/api/parking/logs", params={"room": "400"}, headers=h).json()["items"] == []
    assert [item["spotId"] for item in client.get("/api/parking/logs", params={"room": "101"}, headers=h).json()["items"]] == ["B2-19"]


def test_a_second_user_cannot_open_check_in_while_someone_else_has_it(api):
    client, _ = api
    import app.routes.parking as parking
    parking._holds.clear()
    staff, guest = _headers("staff"), _headers("guest")
    try:
        held = client.post("/api/parking/spots/B2-16/hold", headers=staff)
        assert held.status_code == 200 and held.json()["held"] is True
        blocked = client.post("/api/parking/spots/B2-16/hold", headers=guest)
        assert blocked.status_code == 409 and blocked.json()["detail"] == parking.HELD_DETAIL
        assert client.post("/api/parking/spots/B2-16/checkin", json=CHECKIN, headers=guest).status_code == 409
        assert _spot(client, "B2-16")["status"] == "available"
        assert _spot(client, "B2-16")["heldBy"] == "usr_staff"
        assert client.post("/api/parking/spots/B2-16/release", headers=guest).status_code == 200
        assert _spot(client, "B2-16")["heldBy"] == "usr_staff"
        assert client.post("/api/parking/spots/B2-16/release", headers=staff).status_code == 200
        assert "heldBy" not in _spot(client, "B2-16")
        assert client.post("/api/parking/spots/B2-16/hold", headers=guest).status_code == 200
        assert client.post("/api/parking/spots/B2-16/checkin", json=CHECKIN, headers=guest).status_code == 200
        assert "heldBy" not in _spot(client, "B2-16")
        assert client.post("/api/parking/spots/B2-16/hold", headers=staff).status_code == 409
    finally:
        parking._holds.clear()


def test_parking_alerts_are_private_to_each_user_until_ok(api):
    client, _ = api
    staff, guest = _headers("staff"), _headers("guest")
    assert client.post("/api/parking/spots/B2-20/checkin", json={**CHECKIN, "room": "4003", "guestName": "Omar Saleh"}, headers=staff).status_code == 200
    staff_alerts = client.get("/api/alerts/parking", headers=staff).json()
    guest_alerts = client.get("/api/alerts/parking", headers=guest).json()
    assert staff_alerts and guest_alerts
    assert staff_alerts[0]["title"] == "Check-in · B2-20"
    assert staff_alerts[0]["room"] == "4003"
    alert_id = staff_alerts[0]["id"]
    assert client.post(f"/api/alerts/parking/{alert_id}/ok", headers=staff).status_code == 200
    assert all(item["id"] != alert_id for item in client.get("/api/alerts/parking", headers=staff).json())
    assert any(item["id"] == alert_id for item in client.get("/api/alerts/parking", headers=guest).json())
    note = client.post("/api/notes/2026-10-31", headers=staff, json={
        "department": "Housekeeping", "priority": "urgent", "text": "Bathroom leak in 4003", "assignees": ["usr_guest"],
    })
    assert note.status_code == 200 and note.json()["assignees"] == ["usr_guest"]
    guest_items = client.get("/api/alerts/followups", headers=guest).json()["items"]
    assert any(item["text"] == "Bathroom leak in 4003" and "Gina Guest" in item["assignedTo"] for item in guest_items)
    assert client.post("/api/alerts/snooze", headers=guest, json={"minutes": 30}).status_code == 200
    assert client.get("/api/alerts/followups", headers=guest).json()["show"] is False


def test_logs_open_on_the_latest_twenty_and_a_room_search_still_finds_older_ones(api):
    client, db_path = api
    con = sqlite3.connect(db_path)
    con.execute(
        "INSERT INTO parking_logs (id, actor, action, spot_id, date, time, created_at, details_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ("plog_old", "Sam Staff", "Checked IN (Room 9999)", "B2-1", "2020-01-01", "1:00 AM", "2020-01-01T00:00:00", '{"room": "9999"}'),
    )
    for i in range(25):
        con.execute(
            "INSERT INTO parking_logs (id, actor, action, spot_id, date, time, created_at, details_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (f"plog_new_{i}", "Sam Staff", "Checked OUT", "B2-2", "2026-10-31", "12:00 PM", f"2026-10-31T12:{i:02d}:00", '{"room": "101"}'),
        )
    con.commit()
    con.close()
    h = _headers("staff")
    first = client.get("/api/parking/logs", headers=h).json()
    assert len(first["items"]) == 20 and first["more"] is True
    assert all(item["id"] != "plog_old" for item in first["items"])
    wider = client.get("/api/parking/logs", params={"limit": 30}, headers=h).json()
    assert len(wider["items"]) == 26 and wider["more"] is False
    found = client.get("/api/parking/logs", params={"room": "9999"}, headers=h).json()
    assert [item["id"] for item in found["items"]] == ["plog_old"]
    assert found["more"] is False


def test_followup_matches_the_whole_name_not_part_of_it(api):
    client, db_path = api
    con = sqlite3.connect(db_path)
    con.execute(
        "INSERT INTO users (id, username, first_name, last_name, title, password_hash, role) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ("usr_sam", "sam.only", "Sam", "", "Lobby", PASSWORD_HASH, "security"),
    )
    con.commit()
    con.close()
    saved = client.put("/api/night", headers=_headers("night"), json={
        "date": "2026-10-31",
        "inspection": {"notes": [{
            "id": "nn_boiler", "text": "Boiler noise", "status": "open", "priority": "normal",
            "department": "Engineering", "manager": "Sam Staff — Night Manager",
            "createdBy": "", "assignees": [], "timeline": [],
        }]},
    })
    assert saved.status_code == 200
    sam = create_access_token({
        "sub": "usr_sam", "username": "sam.only", "first_name": "Sam", "last_name": "",
        "title": "Lobby", "role": "security",
    })
    short = client.get("/api/alerts/followups", headers={"Authorization": f"Bearer {sam}"}).json()["items"]
    assert all(item["text"] != "Boiler noise" for item in short)
    staff_items = client.get("/api/alerts/followups", headers=_headers("staff")).json()["items"]
    assert any(item["text"] == "Boiler noise" for item in staff_items)


def test_assigning_followup_staff_saves_without_reloading_the_duty_report(api, monkeypatch):
    client, _ = api
    sent = []

    async def capture(message):
        sent.append(message)

    import app.routes.notes as notes
    monkeypatch.setattr(notes.ws_manager, "broadcast", capture)
    staff = _headers("staff")
    created = client.post("/api/notes/2026-10-31", headers=staff, json={
        "department": "Housekeeping", "priority": "normal", "text": "Towel run",
    })
    assert created.status_code == 200
    note_id = created.json()["id"]
    sent.clear()
    assigned = client.patch(f"/api/notes/{note_id}", headers=staff, json={"assignees": ["usr_guest"]})
    assert assigned.status_code == 200 and assigned.json()["success"] is True
    assert sent == []
    report = client.get("/api/reports", params={"date": "2026-10-31"}, headers=staff).json()
    assert next(note["assignees"] for note in report["notes"] if note["id"] == note_id) == ["usr_guest"]
    status = client.patch(f"/api/notes/{note_id}", headers=staff, json={"status": "progress"})
    assert status.status_code == 200
    assert any(message.get("event") == "NOTE_UPDATED" for message in sent)


def test_extending_a_stay_keeps_a_dismissed_due_alert_until_the_car_leaves_today(api):
    client, _ = api
    import app.routes.parking as parking
    today = parking._today()
    staff, guest = _headers("staff"), _headers("guest")
    assert client.post(
        "/api/parking/spots/B2-4/checkin",
        json={**CHECKIN, "date": today, "time": "23:59", "guestName": "Omar"},
        headers=staff,
    ).status_code == 200
    due = next(item for item in client.get("/api/alerts/parking", headers=staff).json() if item["kind"] == "due" and item["title"].endswith("B2-4"))
    assert client.post(f"/api/alerts/parking/{due['id']}/ok", headers=staff).status_code == 200
    assert client.post("/api/parking/spots/B2-4/extend", json={"date": today, "time": "23:58"}, headers=staff).status_code == 200
    staff_after = client.get("/api/alerts/parking", headers=staff).json()
    guest_after = client.get("/api/alerts/parking", headers=guest).json()
    assert all(item["id"] != due["id"] for item in staff_after)
    assert any(item["kind"] == "extend" and item["title"].endswith("B2-4") for item in staff_after)
    kept = next(item for item in guest_after if item["id"] == due["id"])
    assert kept["kind"] == "due" and kept["details"]["timeOut"] == "23:58"
    assert client.post("/api/parking/spots/B2-4/checkout", headers=staff).status_code == 200
    assert all(item["id"] != due["id"] for item in client.get("/api/alerts/parking", headers=guest).json())

    assert client.post("/api/parking/spots/B2-9/checkin", json={**CHECKIN, "date": "2026-10-24", "time": "12:00"}, headers=staff).status_code == 200
    overdue = next(item for item in client.get("/api/alerts/parking", headers=guest).json() if item["kind"] == "overdue" and item["title"].endswith("B2-9"))
    assert client.post("/api/parking/spots/B2-9/extend", json={"date": today, "time": "23:59"}, headers=staff).status_code == 200
    moved = client.get("/api/alerts/parking", headers=guest).json()
    assert all(item["id"] != overdue["id"] for item in moved)
    assert any(item["kind"] == "due" and item["title"].endswith("B2-9") for item in moved)


def test_parking_bell_shows_due_alerts_plus_the_latest_twenty_events(api):
    client, db_path = api
    staff = _headers("staff")
    assert client.post("/api/parking/spots/B2-3/checkin", json={**CHECKIN, "date": "2026-10-24", "time": "08:00"}, headers=staff).status_code == 200
    con = sqlite3.connect(db_path)
    for i in range(24):
        con.execute(
            """INSERT INTO parking_alerts
               (id, kind, spot_id, floor, guest_name, room_label, actor_name, log_id, details_json, created_at, dedupe_key)
               VALUES (?, 'checkin', 'B2-1', 'B2', '', '', 'Sam Staff', '', '{}', ?, ?)""",
            (f"pal_old_{i:02d}", f"2026-10-30T10:{i:02d}:00", f"pal_old_{i:02d}"),
        )
    con.commit()
    con.close()
    items = client.get("/api/alerts/parking", headers=staff).json()
    events = [item for item in items if item["kind"] == "checkin"]
    assert len(events) == 20
    assert any(item["kind"] == "overdue" and item["title"].endswith("B2-3") for item in items)
    event_ids = {item["id"] for item in events}
    assert "pal_old_23" in event_ids
    assert "pal_old_00" not in event_ids
