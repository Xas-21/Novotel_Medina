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
