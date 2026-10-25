import os
import aiosqlite
import logging

logger = logging.getLogger("novotel.db")

DATA_DIR = os.getenv("DATA_DIR", "/data")
DB_PATH = os.path.join(DATA_DIR, "novotel.db")
UPLOADS_DIR = os.path.join(DATA_DIR, "uploads")

async def get_db():
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        await db.execute("PRAGMA foreign_keys = ON")
        await db.execute("PRAGMA journal_mode = WAL")
        yield db

async def init_db():
    os.makedirs(DATA_DIR, exist_ok=True)
    os.makedirs(UPLOADS_DIR, exist_ok=True)

    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("PRAGMA journal_mode = WAL")
        await db.execute("PRAGMA foreign_keys = ON")

        await db.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            username TEXT UNIQUE NOT NULL,
            first_name TEXT NOT NULL DEFAULT '',
            last_name TEXT NOT NULL DEFAULT '',
            title TEXT NOT NULL DEFAULT '',
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'staff',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """)

        await db.execute("""
        CREATE TABLE IF NOT EXISTS reports (
            date TEXT PRIMARY KEY,
            status TEXT NOT NULL DEFAULT 'draft',
            submitted_at TEXT,
            submitted_by TEXT,
            shift_start TEXT DEFAULT '',
            shift_end TEXT DEFAULT '',
            occupancy TEXT DEFAULT '',
            arrivals TEXT DEFAULT '',
            departures TEXT DEFAULT '',
            in_house TEXT DEFAULT '',
            all_members TEXT DEFAULT '',
            cafeteria_meal_time TEXT DEFAULT '',
            cafeteria_time TEXT DEFAULT '',
            checklists_json TEXT DEFAULT '{}',
            cafeteria_items_json TEXT DEFAULT '[]',
            rooms_inspection_json TEXT DEFAULT '[]',
            courtesy_calls_json TEXT DEFAULT '[]',
            trust_you_json TEXT DEFAULT '{}',
            complaints_json TEXT DEFAULT '[]',
            incidents_json TEXT DEFAULT '[]',
            general_comments_json TEXT DEFAULT '[]',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """)

        await db.execute("""
        CREATE TABLE IF NOT EXISTS notes (
            id TEXT PRIMARY KEY,
            report_date TEXT NOT NULL,
            department TEXT NOT NULL,
            priority TEXT NOT NULL DEFAULT 'normal',
            text TEXT NOT NULL,
            photo_url TEXT,
            manager TEXT NOT NULL,
            time TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'open',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (report_date) REFERENCES reports(date) ON DELETE CASCADE
        )
        """)

        await db.execute("""
        CREATE TABLE IF NOT EXISTS note_events (
            id TEXT PRIMARY KEY,
            note_id TEXT NOT NULL,
            status TEXT NOT NULL,
            actor TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
        )
        """)

        await db.execute("""
        CREATE TABLE IF NOT EXISTS uploads (
            id TEXT PRIMARY KEY,
            filename TEXT NOT NULL,
            original_name TEXT,
            url TEXT NOT NULL,
            mime_type TEXT,
            size_bytes INTEGER,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """)

        await db.execute("""
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )
        """)
        await db.execute(
            "INSERT INTO settings (key, value) SELECT 'hotel_rooms', '394' WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'hotel_rooms')"
        )
        await db.execute("""
        CREATE TABLE IF NOT EXISTS night_reports (
            date TEXT PRIMARY KEY,
            status TEXT NOT NULL DEFAULT 'draft',
            submitted_at TEXT,
            submitted_by TEXT,
            rooms_available INTEGER NOT NULL,
            rooms_occupied REAL NOT NULL DEFAULT 0,
            rooms_revenue REAL NOT NULL DEFAULT 0,
            fb_revenue REAL NOT NULL DEFAULT 0,
            me_revenue REAL NOT NULL DEFAULT 0,
            ood_revenue REAL NOT NULL DEFAULT 0,
            other_revenue REAL NOT NULL DEFAULT 0,
            segments_json TEXT NOT NULL DEFAULT '[]',
            forecast_json TEXT NOT NULL DEFAULT '[]',
            groups_json TEXT NOT NULL DEFAULT '[]',
            vip_json TEXT NOT NULL DEFAULT '[]',
            checklist_json TEXT NOT NULL DEFAULT '[]',
            comments_json TEXT NOT NULL DEFAULT '[]',
            inspection_json TEXT NOT NULL DEFAULT '{}',
            shift_start TEXT NOT NULL DEFAULT '',
            shift_end TEXT NOT NULL DEFAULT '',
            arrivals TEXT NOT NULL DEFAULT '',
            departures TEXT NOT NULL DEFAULT '',
            in_house TEXT NOT NULL DEFAULT '',
            all_members TEXT NOT NULL DEFAULT '',
            overview_occupancy TEXT NOT NULL DEFAULT '',
            created_at TEXT,
            updated_at TEXT
        )
        """)

        # Migration: add new user columns if the DB was created with the older schema
        cols = [r[1] for r in await (await db.execute("PRAGMA table_info(users)")).fetchall()]
        if 'first_name' not in cols:
            await db.execute("ALTER TABLE users ADD COLUMN first_name TEXT NOT NULL DEFAULT ''")
            await db.execute("ALTER TABLE users ADD COLUMN last_name TEXT NOT NULL DEFAULT ''")
            await db.execute("ALTER TABLE users ADD COLUMN title TEXT NOT NULL DEFAULT ''")
        if 'email' not in cols:
            await db.execute("ALTER TABLE users ADD COLUMN email TEXT NOT NULL DEFAULT ''")
        if 'phone' not in cols:
            await db.execute("ALTER TABLE users ADD COLUMN phone TEXT NOT NULL DEFAULT ''")
        if 'session_version' not in cols:
            await db.execute("ALTER TABLE users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0")
            await db.commit()

        report_cols = [r[1] for r in await (await db.execute("PRAGMA table_info(reports)")).fetchall()]
        if "cafeteria_time" not in report_cols:
            await db.execute("ALTER TABLE reports ADD COLUMN cafeteria_time TEXT DEFAULT ''")
        if "general_comments_json" not in report_cols:
            await db.execute("ALTER TABLE reports ADD COLUMN general_comments_json TEXT DEFAULT '[]'")

        night_cols = [r[1] for r in await (await db.execute("PRAGMA table_info(night_reports)")).fetchall()]
        for name in ("shift_start", "shift_end", "arrivals", "departures", "in_house", "all_members", "overview_occupancy"):
            if name not in night_cols:
                await db.execute(f"ALTER TABLE night_reports ADD COLUMN {name} TEXT NOT NULL DEFAULT ''")
        if "inspection_json" not in night_cols:
            await db.execute("ALTER TABLE night_reports ADD COLUMN inspection_json TEXT NOT NULL DEFAULT '{}'")

        await db.execute("""
        CREATE TABLE IF NOT EXISTS guest_reports (
            date TEXT PRIMARY KEY,
            status TEXT NOT NULL DEFAULT 'draft',
            submitted_at TEXT,
            submitted_by TEXT,
            body_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT,
            updated_at TEXT
        )
        """)

        await db.execute("""
        CREATE TABLE IF NOT EXISTS parking_spots (
            id TEXT PRIMARY KEY,
            floor TEXT NOT NULL,
            number INTEGER NOT NULL,
            size TEXT NOT NULL DEFAULT 'L',
            is_handicap INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'available',
            room TEXT NOT NULL DEFAULT '',
            is_visitor INTEGER NOT NULL DEFAULT 0,
            date_out TEXT NOT NULL DEFAULT '',
            time_out TEXT NOT NULL DEFAULT ''
        )
        """)
        await db.execute("""
        CREATE TABLE IF NOT EXISTS parking_logs (
            id TEXT PRIMARY KEY,
            actor TEXT NOT NULL,
            action TEXT NOT NULL,
            spot_id TEXT NOT NULL DEFAULT '-',
            date TEXT NOT NULL,
            time TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
        """)
        spot_cols = [r[1] for r in await (await db.execute("PRAGMA table_info(parking_spots)")).fetchall()]
        for name in ("guest_name", "plate", "car_model", "car_colour", "oos_from", "oos_to", "position"):
            if name not in spot_cols:
                await db.execute(f"ALTER TABLE parking_spots ADD COLUMN {name} TEXT NOT NULL DEFAULT ''")
        if "is_hod" not in spot_cols:
            await db.execute("ALTER TABLE parking_spots ADD COLUMN is_hod INTEGER NOT NULL DEFAULT 0")
        log_cols = [r[1] for r in await (await db.execute("PRAGMA table_info(parking_logs)")).fetchall()]
        if "details_json" not in log_cols:
            await db.execute("ALTER TABLE parking_logs ADD COLUMN details_json TEXT NOT NULL DEFAULT '{}'")
        await db.execute("CREATE INDEX IF NOT EXISTS idx_parking_logs_created ON parking_logs(created_at)")
        for floor, count, handicap, small in (("B2", 22, 15, (7, 11)), ("B3", 21, 12, (7, 11))):
            await db.executemany(
                "INSERT OR IGNORE INTO parking_spots (id, floor, number, size, is_handicap) VALUES (?, ?, ?, ?, ?)",
                [(f"{floor}-{n}", floor, n, "S" if n in small else "L", int(n == handicap)) for n in range(1, count + 1)],
            )

        await db.commit()
