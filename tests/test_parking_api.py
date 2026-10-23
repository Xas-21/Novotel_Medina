import asyncio
import importlib
import sqlite3

import pytest
from fastapi.testclient import TestClient

from app.auth import create_access_token, get_password_hash

PASSWORD_HASH = get_password_hash("parking-test")

USERS = {
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
    by_user = client.get("/api/parking/logs", params={"user": "sam"}, headers=h).json()["items"]
    assert [log["spotId"] for log in by_user] == ["B2-5"]
    day = by_user[0]["date"]
    assert len(client.get("/api/parking/logs", params={"date": day}, headers=h).json()["items"]) == 2
    assert client.get("/api/parking/logs", params={"date": "2000-01-01"}, headers=h).json()["items"] == []
    assert client.get("/api/parking/logs", params={"user": "%"}, headers=h).json()["items"] == []


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
