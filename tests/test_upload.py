import asyncio
import importlib
import sqlite3
from io import BytesIO
from pathlib import Path

import pytest
from PIL import Image
from fastapi.testclient import TestClient

from app.auth import create_access_token, get_password_hash

ROOT = Path(__file__).resolve().parents[1]
PASSWORD_HASH = get_password_hash("night-test")

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
    monkeypatch.setenv("DATA_DIR", str(data))

    import app.database as database
    importlib.reload(database)

    import app.routes.upload as upload
    importlib.reload(upload)

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


def _jpeg():
    buf = BytesIO()
    Image.new("RGB", (8, 8), "red").save(buf, format="JPEG")
    return buf.getvalue()


def test_upload_requires_login(api):
    client, _db_path = api
    res = client.post("/api/upload", files={"file": ("x.jpg", _jpeg(), "image/jpeg")})
    assert res.status_code == 401


def test_upload_stores_a_generated_jpeg_name(api):
    client, db_path = api
    headers = _headers(USERS["staff"])
    res = client.post(
        "/api/upload",
        headers=headers,
        files={"file": ("../../outside.jpg", _jpeg(), "image/jpeg")},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["url"].startswith("/api/uploads/img_")
    assert body["url"].endswith(".jpg")
    assert "outside" not in body["url"]
    stored = Path(db_path).parent / "uploads"
    names = [p.name for p in stored.iterdir()]
    assert len(names) == 1
    assert names[0].endswith(".jpg")
    assert ".." not in names[0]


def test_upload_rejects_a_non_photo(api):
    client, db_path = api
    headers = _headers(USERS["staff"])
    res = client.post(
        "/api/upload",
        headers=headers,
        files={"file": ("note.html", b"<html></html>", "text/html")},
    )
    assert res.status_code == 400
    stored = Path(db_path).parent / "uploads"
    assert list(stored.iterdir()) == []
