import asyncio
import importlib
import shutil
import sqlite3
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.auth import create_access_token, get_password_hash

ROOT = Path(__file__).resolve().parents[1]

USERS = {
    "night": ("usr_night", "night.user", "Nora", "Night", "Night Manager", "night"),
    "staff": ("usr_staff", "staff.user", "Sam", "Staff", "Duty Manager", "staff"),
    "admin": ("usr_admin", "admin.user", "Ada", "Admin", "General Manager", "admin"),
}


@pytest.fixture
def api(tmp_path, monkeypatch):
    data = tmp_path / "data"
    data.mkdir()
    (data / "uploads").mkdir()
    shutil.copy(ROOT / "db" / "novotel.db", data / "novotel.db")
    monkeypatch.setenv("DATA_DIR", str(data))

    import app.database as database
    importlib.reload(database)

    import app.main as main
    importlib.reload(main)

    db_path = data / "novotel.db"
    assert db_path.resolve() != (ROOT / "db" / "novotel.db").resolve()
    assert db_path.is_relative_to(tmp_path)

    asyncio.run(database.init_db())
    _seed_test_users(db_path)

    with TestClient(main.app) as client:
        yield client, db_path


def _seed_test_users(db_path):
    con = sqlite3.connect(db_path)
    try:
        password_hash = get_password_hash("duty-test")
        for user_id, username, first, last, title, role in USERS.values():
            con.execute(
                "INSERT OR IGNORE INTO users (id, username, first_name, last_name, title, password_hash, role) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (user_id, username, first, last, title, password_hash, role),
            )
        con.commit()
    finally:
        con.close()


def _headers(user):
    user_id, username, first, last, title, role = user
    token = create_access_token({
        "sub": user_id,
        "username": username,
        "first_name": first,
        "last_name": last,
        "title": title,
        "role": role,
    })
    return {"Authorization": f"Bearer {token}"}


def _report_count(db_path):
    con = sqlite3.connect(db_path)
    try:
        return con.execute("select count(*) from reports").fetchone()[0]
    finally:
        con.close()


def _complete_duty(date):
    from app.routes.reports import AREA_SECTIONS, CAFETERIA_ITEMS
    return {
        "date": date,
        "checklists": {
            sec["key"]: [{"status": True, "comment": "", "photos": []} for _ in sec["items"]]
            for sec in AREA_SECTIONS
        },
        "cafeteriaItems": [{"status": True, "comment": "", "photos": []} for _ in CAFETERIA_ITEMS],
        "roomsInspection": [{"room": "101", "status": True, "comment": "ok"}],
        "courtesyCalls": [{"room": "202", "impression": True, "comment": "fine"}],
    }


def test_blank_duty_report_cannot_be_submitted(api):
    client, _db_path = api
    headers = _headers(USERS["staff"])
    assert client.post("/api/reports", json={"date": "2099-03-09"}, headers=headers).status_code == 200
    blocked = client.post("/api/reports/2099-03-09/submit", headers=headers)
    assert blocked.status_code == 400
    assert "Courtesy Calls" in blocked.json()["detail"]
    assert "Rooms Inspection" in blocked.json()["detail"]
    assert client.get("/api/reports", params={"date": "2099-03-09"}, headers=headers).json()["status"] == "draft"


def test_first_save_stays_a_draft_even_if_marked_submitted(api):
    client, _db_path = api
    headers = _headers(USERS["staff"])
    saved = client.post(
        "/api/reports",
        json={"date": "2099-08-01", "status": "submitted", "occupancy": "40"},
        headers=headers,
    )
    assert saved.status_code == 200
    report = client.get("/api/reports", params={"date": "2099-08-01"}, headers=headers).json()
    assert report["status"] == "draft"
    assert report["occupancy"] == "40"


def test_saving_a_submitted_report_does_not_reopen_it(api):
    client, _db_path = api
    headers = _headers(USERS["admin"])
    assert client.post("/api/reports", json=_complete_duty("2099-08-02"), headers=headers).status_code == 200
    assert client.post("/api/reports/2099-08-02/submit", headers=headers).status_code == 200
    saved = client.post(
        "/api/reports",
        json={"date": "2099-08-02", "status": "draft", "occupancy": "50"},
        headers=headers,
    )
    assert saved.status_code == 200
    report = client.get("/api/reports", params={"date": "2099-08-02"}, headers=headers).json()
    assert report["status"] == "submitted"
    assert report["occupancy"] == "50"


def test_open_note_carries_onto_the_next_report(api):
    client, _db_path = api
    headers = _headers(USERS["staff"])
    assert client.post("/api/reports", json=_complete_duty("2099-03-01"), headers=headers).status_code == 200
    created = client.post(
        "/api/notes/2099-03-01",
        json={"department": "Maintenance", "priority": "urgent", "text": "Lobby light out"},
        headers=headers,
    )
    assert created.status_code == 200
    note_id = created.json()["id"]
    assert client.post("/api/reports/2099-03-01/submit", headers=headers).status_code == 200

    nxt = client.get("/api/reports", params={"date": "2099-03-02"}, headers=headers)
    assert nxt.status_code == 200
    carried = [n for n in nxt.json()["notes"] if n["id"] == note_id]
    assert len(carried) == 1
    assert carried[0]["carried"] is True
    assert carried[0]["status"] == "open"
    assert carried[0]["timeline"][0]["status"] == "open"

    closed = client.patch(f"/api/notes/{note_id}", json={"status": "closed"}, headers=headers)
    assert closed.status_code == 200
    assert [event["status"] for event in closed.json()["timeline"]] == ["open", "closed"]
    after = client.get("/api/reports", params={"date": "2099-03-02"}, headers=headers)
    assert all(n["id"] != note_id for n in after.json()["notes"])


def test_notes_require_login(api):
    client, _db_path = api
    created = client.post(
        "/api/notes/2099-05-01",
        json={"department": "Maintenance", "text": "Open door"},
    )
    assert created.status_code == 401
    assert client.patch("/api/notes/note_missing", json={"status": "closed"}).status_code == 401
    assert client.delete("/api/notes/note_missing").status_code == 401


def test_incidents_and_general_comments_save_separately(api):
    client, _db_path = api
    headers = _headers(USERS["staff"])
    saved = client.post(
        "/api/reports",
        json={
            "date": "2099-04-01",
            "incidents": [{"description": "Power cut", "time": "02:10"}],
            "generalComments": [{"comment": "Lobby was quiet", "time": "03:00"}],
        },
        headers=headers,
    )
    assert saved.status_code == 200
    report = client.get("/api/reports", params={"date": "2099-04-01"}, headers=headers).json()
    assert report["incidents"] == [{"description": "Power cut", "time": "02:10"}]
    assert report["generalComments"] == [{"comment": "Lobby was quiet", "time": "03:00"}]


def test_guest_index_lists_vip_arrivals_and_departures(api):
    client, _db_path = api
    staff = _headers(USERS["staff"])
    saved = client.put(
        "/api/guest",
        json={"date": "2099-06-02", "arrivals": "12", "departures": "5"},
        headers=staff,
    )
    assert saved.status_code == 200
    rows = client.get("/api/guest/index", headers=staff).json()
    row = next(item for item in rows if item["date"] == "2099-06-02")
    assert row["arrivals"] == "12"
    assert row["departures"] == "5"


def test_guest_call_status_and_note_are_saved(api):
    client, _db_path = api
    staff = _headers(USERS["staff"])
    saved = client.put(
        "/api/guest",
        json={
            "date": "2099-06-03",
            "preArrival": [{"name": "Ada", "action": "Called", "note": "Arrives after midnight", "callStatus": "No Answer"}],
            "inHouse": [{"name": "Ben", "note": "Welcome drink declined", "callStatus": "Answered"}],
            "departure": [{"name": "Cia", "note": "Asked for a late checkout", "callStatus": "Pending"}],
        },
        headers=staff,
    )
    assert saved.status_code == 200
    report = client.get("/api/guest", params={"date": "2099-06-03"}, headers=staff).json()
    assert report["preArrival"][0]["note"] == "Arrives after midnight"
    assert report["preArrival"][0]["callStatus"] == "No Answer"
    assert report["preArrival"][0]["action"] == "Called"
    assert report["inHouse"][0]["note"] == "Welcome drink declined"
    assert report["inHouse"][0]["callStatus"] == "Answered"
    assert report["departure"][0]["note"] == "Asked for a late checkout"
    assert report["departure"][0]["callStatus"] == "Pending"


def test_guest_relation_saves_without_touching_other_reports(api):
    client, db_path = api
    staff = _headers(USERS["staff"])
    night = _headers(USERS["night"])
    blank = client.get("/api/guest", params={"date": "2099-05-01"}, headers=staff)
    assert blank.status_code == 200
    assert "status" not in blank.json()
    assert blank.json()["membership"] == []
    assert blank.json()["scores"] == []
    denied = client.put("/api/guest", json={"date": "2099-05-01", "inCharge": "Nora"}, headers=night)
    assert denied.status_code == 403
    saved = client.put(
        "/api/guest",
        json={
            "date": "2099-05-01",
            "inCharge": "Sara",
            "arrivals": "197",
            "scores": [{"type": "TrustYou", "ytd": "90"}],
            "membership": [{"tier": "Gold", "vip": "V2", "arrival": "3", "inHouse": "1", "departure": "2"}],
            "inHouse": [{"satisfaction": "Non Satisfied", "contacted": "Call", "name": "Ada", "priority": "Urgent", "feedback": "Late room"}],
            "generalComments": [{"comment": "Follow up", "time": "19:10"}],
        },
        headers=staff,
    )
    assert saved.status_code == 200
    assert saved.json()["status"] == "draft"
    assert saved.json()["inCharge"] == "Sara"
    assert saved.json()["occupancy"] == "50"
    assert saved.json()["scores"] == [{"type": "TrustYou", "ytd": "90"}]
    assert saved.json()["membership"][0]["tier"] == "Gold"
    assert saved.json()["membership"][0]["vip"] == "V2"
    assert "arrivalRooms" not in saved.json()["membership"][0]
    assert saved.json()["inHouse"][0]["priority"] == "Urgent"
    assert saved.json()["generalComments"][0]["comment"] == "Follow up"
    analysis = client.get("/api/guest/analysis", params={"date": "2099-05-01", "range": "week"}, headers=staff)
    assert analysis.status_code == 200
    summary = analysis.json()
    assert summary["priority"]["Urgent"] == 1
    assert summary["satisfaction"]["Non Satisfied"] == 1
    assert summary["membershipTiers"][0]["tier"] == "Gold"
    assert summary["vipArrivals"][-1] == 197
    assert summary["vipOcc"][-1] == 50
    listed = client.get("/api/guest/index", headers=staff).json()
    guest_row = next(item for item in listed if item["date"] == "2099-05-01")
    assert guest_row["occupancy"] == "50"
    assert guest_row["submittedBy"] in (None, "")
    assert saved.json()["inHouse"][0]["satisfaction"] == "Non Satisfied"
    import sqlite3
    con = sqlite3.connect(db_path)
    try:
        assert con.execute("select count(*) from guest_reports").fetchone()[0] == 1
    finally:
        con.close()


def test_reports_index_requires_login(api):
    client, _ = api
    res = client.get("/api/reports/index")
    assert res.status_code == 401


def test_night_cannot_save_duty_report(api):
    client, db_path = api
    res = client.post(
        "/api/reports",
        json={"date": "2099-01-01"},
        headers=_headers(USERS["night"]),
    )
    assert res.status_code == 403
    assert res.json()["detail"] == "Duty section is read-only for this user"
    assert _report_count(db_path) == 32


def test_night_cannot_submit_reopen_or_delete(api):
    client, db_path = api
    headers = _headers(USERS["night"])
    submit = client.post("/api/reports/2099-01-01/submit", headers=headers)
    reopen = client.post("/api/reports/2099-01-01/reopen", headers=headers)
    delete = client.delete("/api/reports/2099-01-01", headers=headers)
    assert submit.status_code == 403
    assert reopen.status_code == 403
    assert delete.status_code == 403
    assert _report_count(db_path) == 32


def test_staff_and_admin_can_save(api):
    client, _ = api
    for role, day in (("staff", "2099-02-01"), ("admin", "2099-02-02")):
        res = client.post(
            "/api/reports",
            json={"date": day},
            headers=_headers(USERS[role]),
        )
        assert res.status_code == 200


def test_staff_index_returns_snapshot_rows(api):
    client, _ = api
    res = client.get("/api/reports/index", headers=_headers(USERS["staff"]))
    assert res.status_code == 200
    assert len(res.json()) == 32


def test_logged_in_roles_can_read_duty(api):
    client, db_path = api
    con = sqlite3.connect(db_path)
    try:
        date = con.execute("select date from reports order by date limit 1").fetchone()[0]
    finally:
        con.close()
    for role in ("night", "staff", "admin"):
        headers = _headers(USERS[role])
        index = client.get("/api/reports/index", headers=headers)
        report = client.get("/api/reports", params={"date": date}, headers=headers)
        analysis = client.get("/api/reports/analysis", params={"date": date}, headers=headers)
        assert index.status_code == 200
        assert len(index.json()) == 32
        assert report.status_code == 200
        assert analysis.status_code == 200


def test_duty_reads_require_login(api):
    client, _ = api
    assert client.get("/api/reports/index").status_code == 401
    assert client.get("/api/reports", params={"date": "2026-10-08"}).status_code == 401
    assert client.get("/api/reports/analysis", params={"date": "2026-10-08", "range": "week"}).status_code == 401


def test_admin_can_save_contact_and_reset_password(api):
    client, _db_path = api
    admin = _headers(USERS["admin"])
    created = client.post(
        "/api/auth/users",
        headers=admin,
        json={
            "username": "edit.user",
            "password": "old-pass",
            "first_name": "Edit",
            "last_name": "User",
            "title": "Duty Manager",
            "role": "staff",
        },
    )
    assert created.status_code == 200
    user_id = created.json()["id"]

    denied = client.patch(
        f"/api/auth/users/{user_id}",
        headers=_headers(USERS["staff"]),
        json={"email": "a@b.co", "phone": "0500000000"},
    )
    assert denied.status_code == 403

    saved = client.patch(
        f"/api/auth/users/{user_id}",
        headers=admin,
        json={"email": "edit.user@novotel.test", "phone": "0551234567"},
    )
    assert saved.status_code == 200
    assert saved.json()["email"] == "edit.user@novotel.test"
    assert saved.json()["phone"] == "0551234567"

    mismatch = client.post(
        f"/api/auth/users/{user_id}/password",
        headers=admin,
        json={"password": "new-pass", "confirm": "other"},
    )
    assert mismatch.status_code == 400
    signed_in = client.post("/api/auth/login", json={"username": "edit.user", "password": "old-pass"})
    assert signed_in.status_code == 200
    old_token = signed_in.json()["token"]

    reset = client.post(
        f"/api/auth/users/{user_id}/password",
        headers=admin,
        json={"password": "new-pass", "confirm": "new-pass"},
    )
    assert reset.status_code == 200
    assert client.post("/api/auth/login", json={"username": "edit.user", "password": "old-pass"}).status_code == 401
    assert client.get("/api/auth/me", headers={"Authorization": f"Bearer {old_token}"}).status_code == 401
    fresh = client.post("/api/auth/login", json={"username": "edit.user", "password": "new-pass"})
    assert fresh.status_code == 200
    assert client.get("/api/auth/me", headers={"Authorization": f"Bearer {fresh.json()['token']}"}).status_code == 200


def test_create_user_rejects_unknown_role(api):
    client, _ = api
    res = client.post(
        "/api/auth/users",
        headers=_headers(USERS["admin"]),
        json={
            "username": "new.guest",
            "password": "secret",
            "first_name": "Gina",
            "last_name": "Guest",
            "title": "Visitor",
            "role": "visitor",
        },
    )
    assert res.status_code == 400
    assert res.json()["detail"] == "Role must be staff, night, guest, parking, or admin"


def test_user_form_offers_night_manager_between_staff_and_admin():
    text = (ROOT / "static" / "app.js").read_text(encoding="utf-8")
    staff = '<option value="staff">Staff</option>'
    night = '<option value="night">Night Manager</option>'
    guest = '<option value="guest">Guest Relation</option>'
    admin = '<option value="admin">Admin</option>'
    assert staff in text
    assert night in text
    assert guest in text
    assert admin in text
    assert text.index(staff) < text.index(night) < text.index(guest) < text.index(admin)
