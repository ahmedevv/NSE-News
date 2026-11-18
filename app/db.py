"""Tiny SQLite persistence layer (stdlib only)."""
import json
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timezone

from .config import DB_PATH

_lock = threading.Lock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS articles (
    id TEXT PRIMARY KEY,
    title TEXT, link TEXT, source TEXT, kind TEXT,
    published TEXT, summary TEXT,
    impact REAL, analysis TEXT, ml TEXT,
    fetched_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_articles_pub ON articles(published);
CREATE TABLE IF NOT EXISTS earnings (
    symbol TEXT, company TEXT, date TEXT, purpose TEXT, source TEXT, details TEXT,
    PRIMARY KEY (symbol, date)
);
CREATE TABLE IF NOT EXISTS source_status (
    name TEXT PRIMARY KEY, ok INTEGER, count INTEGER, error TEXT, checked_at TEXT
);
CREATE TABLE IF NOT EXISTS market (
    symbol TEXT PRIMARY KEY, data TEXT, updated TEXT
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS filings (
    id TEXT PRIMARY KEY, ts TEXT, symbol TEXT, company TEXT, label TEXT, importance TEXT,
    headline TEXT, detail TEXT, category TEXT, link TEXT, source TEXT, fetched_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_filings_ts ON filings(ts);
CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY, ts TEXT, title TEXT, impact TEXT, forecast TEXT, previous TEXT, kind TEXT, source TEXT
);
"""


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@contextmanager
def conn():
    with _lock:
        c = sqlite3.connect(DB_PATH)
        c.row_factory = sqlite3.Row
        try:
            yield c
            c.commit()
        finally:
            c.close()


def init():
    with conn() as c:
        c.executescript(SCHEMA)
        cols = {r["name"] for r in c.execute("PRAGMA table_info(articles)")}
        if "ml" not in cols:  # databases created by older versions
            c.execute("ALTER TABLE articles ADD COLUMN ml TEXT")


def article_exists(aid: str) -> bool:
    with conn() as c:
        return c.execute("SELECT 1 FROM articles WHERE id=?", (aid,)).fetchone() is not None


def save_article(a: dict):
    with conn() as c:
        c.execute(
            """INSERT OR REPLACE INTO articles
               (id,title,link,source,kind,published,summary,impact,analysis,ml,fetched_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
            (a["id"], a["title"], a["link"], a["source"], a["kind"], a["published"],
             a.get("summary", ""), a["impact"], json.dumps(a["analysis"]),
             None, now_iso()),
        )


def get_article(aid: str) -> dict | None:
    with conn() as c:
        r = c.execute("SELECT * FROM articles WHERE id=?", (aid,)).fetchone()
    if not r:
        return None
    d = dict(r)
    d["analysis"] = json.loads(d["analysis"]) if d["analysis"] else {}
    return d


def recent_articles(since_iso: str, min_impact: float = 0, limit: int = 500) -> list[dict]:
    with conn() as c:
        rows = c.execute(
            "SELECT * FROM articles WHERE published>=? AND impact>=? ORDER BY published DESC LIMIT ?",
            (since_iso, min_impact, limit),
        ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["analysis"] = json.loads(d["analysis"]) if d["analysis"] else {}
        out.append(d)
    return out


def replace_earnings(rows: list[dict], source: str):
    with conn() as c:
        c.execute("DELETE FROM earnings WHERE source=?", (source,))
        c.executemany(
            "INSERT OR REPLACE INTO earnings (symbol,company,date,purpose,source,details) VALUES (?,?,?,?,?,?)",
            [(r["symbol"], r["company"], r["date"], r["purpose"], source, r.get("details", "")) for r in rows],
        )


def upsert_earnings(rows: list[dict], source: str):
    with conn() as c:
        c.executemany(
            "INSERT OR IGNORE INTO earnings (symbol,company,date,purpose,source,details) VALUES (?,?,?,?,?,?)",
            [(r["symbol"], r["company"], r["date"], r["purpose"], source, r.get("details", "")) for r in rows],
        )


def get_earnings(from_date: str, to_date: str) -> list[dict]:
    with conn() as c:
        rows = c.execute(
            "SELECT * FROM earnings WHERE date>=? AND date<=? ORDER BY date, symbol", (from_date, to_date)
        ).fetchall()
    return [dict(r) for r in rows]


def set_source_status(name: str, ok: bool, count: int, error: str = ""):
    with conn() as c:
        c.execute(
            "INSERT OR REPLACE INTO source_status (name,ok,count,error,checked_at) VALUES (?,?,?,?,?)",
            (name, int(ok), count, error[:300], now_iso()),
        )


def get_source_status() -> list[dict]:
    with conn() as c:
        return [dict(r) for r in c.execute("SELECT * FROM source_status ORDER BY ok, name").fetchall()]


def save_market(symbol: str, data: dict):
    with conn() as c:
        c.execute("INSERT OR REPLACE INTO market (symbol,data,updated) VALUES (?,?,?)",
                  (symbol, json.dumps(data), now_iso()))


def get_market() -> dict:
    with conn() as c:
        return {r["symbol"]: json.loads(r["data"]) for r in c.execute("SELECT * FROM market").fetchall()}


def set_meta(key: str, value: str):
    with conn() as c:
        c.execute("INSERT OR REPLACE INTO meta (key,value) VALUES (?,?)", (key, value))


def get_meta(key: str, default: str = "") -> str:
    with conn() as c:
        r = c.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
    return r["value"] if r else default


def all_articles_raw() -> list[dict]:
    with conn() as c:
        return [dict(r) for r in c.execute("SELECT id,title,summary,kind FROM articles").fetchall()]


def update_analysis(rows: list[tuple]):
    """rows: (impact, analysis_json, id)"""
    with conn() as c:
        c.executemany("UPDATE articles SET impact=?, analysis=? WHERE id=?", rows)


# ----------------------------------------------------------------------------- alerts
def _alerts_schema(c):
    c.execute("""CREATE TABLE IF NOT EXISTS alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, level TEXT, kind TEXT, title TEXT, body TEXT,
        symbols TEXT, sectors TEXT, link TEXT, akey TEXT, article_id TEXT)""")
    c.execute("CREATE INDEX IF NOT EXISTS idx_alerts_key ON alerts(akey, ts)")


def add_alert(level: str, kind: str, title: str, body: str, symbols: list, sectors: list,
              link: str, akey: str, article_id: str = "") -> int:
    with conn() as c:
        _alerts_schema(c)
        cur = c.execute(
            "INSERT INTO alerts (ts,level,kind,title,body,symbols,sectors,link,akey,article_id) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (now_iso(), level, kind, title, body, json.dumps(symbols), json.dumps(sectors), link, akey, article_id))
        return cur.lastrowid


def alert_key_since(akey: str, since_iso: str) -> bool:
    with conn() as c:
        _alerts_schema(c)
        return c.execute("SELECT 1 FROM alerts WHERE akey=? AND ts>=?", (akey, since_iso)).fetchone() is not None


def get_alerts(since_id: int = 0, limit: int = 100) -> list[dict]:
    with conn() as c:
        _alerts_schema(c)
        rows = c.execute("SELECT * FROM alerts WHERE id>? ORDER BY id DESC LIMIT ?", (since_id, limit)).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["symbols"] = json.loads(d["symbols"] or "[]")
        d["sectors"] = json.loads(d["sectors"] or "[]")
        out.append(d)
    return out


def latest_alert_id() -> int:
    with conn() as c:
        _alerts_schema(c)
        r = c.execute("SELECT MAX(id) AS m FROM alerts").fetchone()
    return r["m"] or 0


# ----------------------------------------------------------------------------- watchlist
def get_watchlist() -> list[str]:
    try:
        return json.loads(get_meta("watchlist", "[]"))
    except Exception:
        return []


def set_watchlist(symbols: list[str]):
    set_meta("watchlist", json.dumps(sorted({s.strip().upper() for s in symbols if s.strip()})[:100]))


# ----------------------------------------------------------------------------- filings
def known_filing_ids(source: str) -> set[str]:
    since = datetime.fromtimestamp(datetime.now(timezone.utc).timestamp() - 3 * 86400, timezone.utc).isoformat()
    with conn() as c:
        return {r["id"] for r in c.execute("SELECT id FROM filings WHERE source=? AND ts>=?", (source, since))}


def save_filings(rows: list[dict]):
    with conn() as c:
        c.executemany(
            """INSERT OR IGNORE INTO filings (id,ts,symbol,company,label,importance,headline,detail,category,link,source,fetched_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
            [(r["id"], r["ts"], r["symbol"], r["company"], r["label"], r["importance"], r["headline"], r["detail"],
              r.get("category", ""), r["link"], r["source"], now_iso()) for r in rows])


def recent_filings(since_iso: str, limit: int = 600) -> list[dict]:
    with conn() as c:
        return [dict(r) for r in c.execute(
            "SELECT * FROM filings WHERE ts>=? ORDER BY ts DESC LIMIT ?", (since_iso, limit)).fetchall()]


def get_filing(fid: str) -> dict | None:
    with conn() as c:
        r = c.execute("SELECT * FROM filings WHERE id=?", (fid,)).fetchone()
    return dict(r) if r else None


# ----------------------------------------------------------------------------- scheduled events
def replace_events(rows: list[dict]):
    with conn() as c:
        c.execute("DELETE FROM events")
        c.executemany(
            "INSERT OR REPLACE INTO events (id,ts,title,impact,forecast,previous,kind,source) VALUES (?,?,?,?,?,?,?,?)",
            [(r["id"], r["ts"], r["title"], r["impact"], r["forecast"], r["previous"], r["kind"], r["source"]) for r in rows])


def get_events(from_iso: str, to_iso: str) -> list[dict]:
    with conn() as c:
        return [dict(r) for r in c.execute(
            "SELECT * FROM events WHERE ts>=? AND ts<=? ORDER BY ts", (from_iso, to_iso)).fetchall()]
