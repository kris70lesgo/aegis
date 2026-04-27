import sqlite3
import os

DB_PATH = os.path.join(os.path.dirname(__file__), "aegis.db")


def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = get_conn()
    cursor = conn.cursor()

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS satellites (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            norad_id    TEXT UNIQUE NOT NULL,
            name        TEXT NOT NULL,
            tle1        TEXT NOT NULL,
            tle2        TEXT NOT NULL,
            last_updated TEXT,
            category    TEXT
        )
    """)

    # Migration: add category column to existing DBs that predate this schema
    try:
        cursor.execute("ALTER TABLE satellites ADD COLUMN category TEXT")
        print("Migration: added 'category' column to satellites table.")
    except Exception:
        # Column already exists — this is expected on any run after the first
        pass

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS conjunctions (
            id       INTEGER PRIMARY KEY AUTOINCREMENT,
            sat1     TEXT NOT NULL,
            sat2     TEXT NOT NULL,
            tca      TEXT NOT NULL,
            distance REAL NOT NULL,
            velocity REAL,
            risk     TEXT
        )
    """)

    # Indexes for frequently queried columns
    cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_satellites_category ON satellites(category)
    """)
    cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_satellites_name ON satellites(name)
    """)
    cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_conjunctions_risk ON conjunctions(risk)
    """)
    cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_conjunctions_distance ON conjunctions(distance)
    """)

    conn.commit()
    conn.close()
    print(f"Database initialised at {DB_PATH}")


if __name__ == "__main__":
    init_db()
