"""FastAPI app + background scheduler.

Run:  start-server.bat   (after setup.bat)
Open: http://localhost:8000
"""
import base64
import logging
import os
import secrets
import threading
import time
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone

from fastapi import Body, FastAPI, Request
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

from . import alerts, analyzer, calendar_today, db, earnings, feed, filings, market, sources
from .config import (BASE_DIR, CALENDAR_HOURS, FILINGS_SECONDS, GLOBAL_TICKERS, INDIA_TICKERS, NEWS_MINUTES,
                     PRICE_MINUTES)
from .universe import TRACKED

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
log = logging.getLogger("main")
for _noisy in ("urllib3.connectionpool", "yfinance", "peewee", "httpx"):
    logging.getLogger(_noisy).setLevel(logging.CRITICAL)  # failures still show on the System page
IST = timezone(timedelta(hours=5, minutes=30))
_stop = threading.Event()
_force = threading.Event()
_last: dict[str, float] = {}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _due(name: str, seconds: float, force: bool) -> bool:
    if force or time.time() - _last.get(name, 0) >= seconds:
        _last[name] = time.time()
        return True
    return False


def _busy_hours() -> bool:
    """Weekdays 07:30-20:00 IST: when filings and news actually matter for the next session."""
    n = datetime.now(IST)
    return n.weekday() < 5 and (7 * 60 + 30) <= n.hour * 60 + n.minute <= 20 * 60


def refresh_filings():
    new = filings.refresh()
    if new:
        log.info("%d new filings", len(new))
    alerts.from_filings(new)
    db.set_meta("last_filings", _now())


def refresh_news():
    items = sources.fetch_all()
    fresh = []
    for it in items:
        if db.article_exists(it["id"]):
            continue
        a = analyzer.analyze(it["title"], it["summary"], it["kind"])
        row = it | {"impact": a["score"], "analysis": a}
        db.save_article(row)
        fresh.append(row)
    log.info("fetched %d headlines (%d new)", len(items), len(fresh))
    alerts.from_articles(fresh)
    db.set_meta("last_news", _now())


def refresh_prices():
    syms = feed.symbols_in_feed(calendar_today.last_close_utc()) | set(db.get_watchlist())
    syms |= {r["symbol"] for r in feed.results(2)}
    market.refresh(sorted(syms))
    alerts.from_prices()
    db.set_meta("last_prices", _now())


def refresh_calendar():
    calendar_today.refresh()
    earnings.refresh()
    db.set_meta("last_calendar", _now())


def cycle(force: bool = False):
    busy = _busy_hours()
    jobs = [
        ("filings", FILINGS_SECONDS if busy else 600, refresh_filings),
        ("news", NEWS_MINUTES * 60 if busy else 600, refresh_news),
        ("prices", PRICE_MINUTES * 60 if busy else 1800, refresh_prices),
        ("calendar", CALENDAR_HOURS * 3600, refresh_calendar),
    ]
    for name, every, fn in jobs:
        if _due(name, every, force):
            try:
                fn()
            except Exception as ex:
                log.exception("%s refresh failed: %s", name, ex)
    try:
        alerts.from_calendar()
    except Exception as ex:
        log.exception("calendar alerts failed: %s", ex)


def reanalyze_all():
    """Re-score stored headlines with the current rules, so edits to rules.py apply to old stories too."""
    import json
    rows = []
    for a in db.all_articles_raw():
        r = analyzer.analyze(a["title"], a["summary"] or "", a["kind"])
        rows.append((r["score"], json.dumps(r), a["id"]))
    db.update_analysis(rows)
    log.info("re-analysed %d stored headlines", len(rows))


def _scheduler():
    try:
        reanalyze_all()
    except Exception as ex:
        log.exception("re-analysis failed: %s", ex)
    while not _stop.is_set():
        force = _force.is_set()
        _force.clear()
        db.set_meta("refreshing", "1")
        try:
            cycle(force)
        finally:
            db.set_meta("refreshing", "0")
        _force.wait(min(FILINGS_SECONDS, 60))


@asynccontextmanager
async def lifespan(_app):
    db.init()
    threading.Thread(target=_scheduler, daemon=True).start()
    yield
    _stop.set()
    _force.set()


app = FastAPI(title="NSE Wire", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")

# Optional login (set DASH_PASS in settings.bat when the dashboard is reachable from the internet)
_DASH_USER = os.getenv("DASH_USER", "admin")
_DASH_PASS = os.getenv("DASH_PASS", "")


@app.middleware("http")
async def basic_auth(request: Request, call_next):
    if _DASH_PASS:
        ok = False
        header = request.headers.get("authorization", "")
        if header.startswith("Basic "):
            try:
                user, _, pw = base64.b64decode(header[6:]).decode("utf-8").partition(":")
                ok = (secrets.compare_digest(user.encode(), _DASH_USER.encode())
                      and secrets.compare_digest(pw.encode(), _DASH_PASS.encode()))
            except Exception:
                ok = False
        if not ok:
            return Response("Login required", status_code=401,
                            headers={"WWW-Authenticate": 'Basic realm="NSE Wire"'})
    return await call_next(request)


@app.get("/")
def index():
    return FileResponse(BASE_DIR / "static" / "index.html")


def _since(window: str) -> datetime:
    if window in ("24", "48"):
        return datetime.now(timezone.utc) - timedelta(hours=int(window))
    return calendar_today.last_close_utc()


@app.get("/api/desk")
def desk():
    mk = db.get_market()
    ban_today = db.get_meta("fo_ban_date") == datetime.now(IST).date().isoformat()
    return {
        "server_time": _now(),
        "last": {k: db.get_meta(f"last_{k}") or None for k in ("filings", "news", "prices", "calendar")},
        "refreshing": db.get_meta("refreshing") == "1",
        "last_close": calendar_today.last_close_utc().isoformat(),
        "quotes": [{"symbol": k, "name": v, **(mk.get(k) or {})} for k, v in INDIA_TICKERS.items()],
        "global": [{"symbol": k, "name": v, **(mk.get(k) or {})} for k, v in GLOBAL_TICKERS.items()],
        "events": calendar_today.upcoming(2, 36),
        "results": feed.results(2),
        "ban": [s for s in (db.get_meta("fo_ban") or "").split(",") if s] if ban_today else None,
        "watchlist": db.get_watchlist(),
        "latest_alert_id": db.latest_alert_id(),
        "sources": db.get_source_status(),
    }


@app.get("/api/feed")
def get_feed(window: str = "close", kind: str = "", q: str = "", routine: bool = False, limit: int = 400):
    watch = db.get_watchlist() if kind == "watch" else None
    return feed.build(_since(window), kind, q, watch, routine, limit)


@app.get("/api/item")
def item(kind: str, id: str):
    d = feed.detail(kind, id)
    return d if d else Response("Not found", status_code=404)


@app.get("/api/alerts")
def get_alerts(since: int = 0, limit: int = 100):
    return db.get_alerts(since, limit)


@app.post("/api/alerts/test")
def test_alert():
    return alerts.test_alert()


@app.get("/api/watchlist")
def get_watchlist():
    return {"symbols": db.get_watchlist(), "known": sorted(TRACKED)}


@app.post("/api/watchlist")
def set_watchlist(payload: dict = Body(...)):
    db.set_watchlist([str(s) for s in payload.get("symbols", [])])
    threading.Thread(target=_prices_for_watchlist, daemon=True).start()
    return {"symbols": db.get_watchlist()}


def _prices_for_watchlist():
    try:
        market.refresh(db.get_watchlist())
    except Exception as ex:
        log.warning("watchlist price refresh failed: %s", ex)


@app.get("/api/sources")
def get_sources():
    return db.get_source_status()


@app.post("/api/refresh")
def refresh():
    _force.set()
    return {"status": "started"}


@app.get("/api/analyze")
def analyze_text(text: str):
    """Paste any headline and see how the desk reads it."""
    a = analyzer.analyze(text, "", "market")
    row = {"id": "test", "title": text, "published": _now(), "source": "", "link": "", "analysis": a}
    shown = feed.news_item(row)
    return {"shown": bool(shown), "wrap": feed.is_wrap(text), "item": shown,
            "drivers": [{"name": e["name"], "direction": e["direction"], "why": e["why"]} for e in a["events"]],
            "stocks": [s["symbol"] for s in a["stocks"]]}
