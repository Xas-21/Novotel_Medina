import os
import aiosqlite
import logging
import bcrypt

logger = logging.getLogger("novotel.db")

DATA_DIR = os.getenv("DATA_DIR", "/data")
DB_PATH = os.path.join(DATA_DIR, "novotel.db")
UPLOADS_DIR = os.path.join(DATA_DIR, "uploads")

def get_password_hash(password: str) -> str:
    return bcrypt.hashpw(password.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')

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
            checklists_json TEXT DEFAULT '{}',
            cafeteria_items_json TEXT DEFAULT '[]',
            rooms_inspection_json TEXT DEFAULT '[]',
            courtesy_calls_json TEXT DEFAULT '[]',
            trust_you_json TEXT DEFAULT '{}',
            complaints_json TEXT DEFAULT '[]',
            incidents_json TEXT DEFAULT '[]',
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

        # Migration: add new user columns if the DB was created with the older schema
        cols = [r[1] for r in await (await db.execute("PRAGMA table_info(users)")).fetchall()]
        if 'first_name' not in cols:
            await db.execute("ALTER TABLE users ADD COLUMN first_name TEXT NOT NULL DEFAULT ''")
            await db.execute("ALTER TABLE users ADD COLUMN last_name TEXT NOT NULL DEFAULT ''")
            await db.execute("ALTER TABLE users ADD COLUMN title TEXT NOT NULL DEFAULT ''")
            await db.commit()

        await db.commit()

        # Seed the single admin account (idempotent)
        cursor = await db.execute("SELECT COUNT(*) FROM users WHERE username = ?", ("Houssin",))
        if (await cursor.fetchone())[0] == 0:
            await db.execute(
                "INSERT INTO users (id, username, first_name, last_name, title, password_hash, role) VALUES (?, ?, ?, ?, ?, ?, ?)",
                ("usr_houssin", "Houssin", "Houssin", "Fayraq", "Duty Manager", get_password_hash("112233"), "admin")
            )
            await db.commit()
            logger.info("Seeded admin user Houssin.")
