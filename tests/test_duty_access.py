import asyncio
import importlib
import shutil
import sqlite3
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.auth import create_access_token

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

    with TestClient(main.app) as client:
        yield client, db_path


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


def test_open_note_carries_onto_the_next_report(api):
    client, _db_path = api
    headers = _headers(USERS["staff"])
    assert client.post("/api/reports", json={"date": "2099-03-01"}, headers=headers).status_code == 200
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
            "role": "guest",
        },
    )
    assert res.status_code == 400
    assert res.json()["detail"] == "Role must be staff, night, or admin"


def test_user_form_offers_night_manager_between_staff_and_admin():
    text = (ROOT / "static" / "app.js").read_text(encoding="utf-8")
    staff = '<option value="staff">Staff</option>'
    night = '<option value="night">Night Manager</option>'
    admin = '<option value="admin">Admin</option>'
    assert staff in text
    assert night in text
    assert admin in text
    assert text.index(staff) < text.index(night) < text.index(admin)
