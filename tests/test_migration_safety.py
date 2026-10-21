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


def test_init_db_keeps_existing_password_and_ships_no_default(tmp_path, monkeypatch):
    data = tmp_path / "data"
    data.mkdir()
    shutil.copy(ROOT / "db" / "novotel.db", data / "novotel.db")
    monkeypatch.setenv("DATA_DIR", str(data))

    import importlib
    import app.database as database
    importlib.reload(database)

    con = sqlite3.connect(data / "novotel.db")
    before = con.execute("select password_hash from users where username = 'Houssin'").fetchone()[0]
    con.close()

    asyncio.run(database.init_db())

    con = sqlite3.connect(data / "novotel.db")
    after = con.execute("select password_hash from users where username = 'Houssin'").fetchone()[0]
    assert after == before
    assert con.execute("select count(*) from users").fetchone()[0] == 4
    con.close()

    source = (ROOT / "app" / "database.py").read_text(encoding="utf-8")
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    project_map = (ROOT / "PROJECT_MAP.md").read_text(encoding="utf-8")
    assert "112233" not in source
    assert "112233" not in readme
    assert "112233" not in project_map
    assert "usr_houssin" not in source
