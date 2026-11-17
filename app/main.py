"""FastAPI app + background refresh scheduler.

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
from datetime import datetime, timezone

from fastapi import Body, FastAPI, Request
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

from . import aggregate, alerts, analyzer, db, earnings, market, sentiment, sources
from .config import BASE_DIR, EARNINGS_REFRESH_HOURS, MACRO_TICKERS, MIN_IMPACT, REFRESH_MINUTES
from .rules import COMPANIES

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
log = logging.getLogger("main")
for _noisy in ("urllib3.connectionpool", "yfinance", "peewee", "httpx", "httpx2"):
    logging.getLogger(_noisy).setLevel(logging.CRITICAL)  # failures still show on the System page
_refresh_lock = threading.Lock()
_stop = threading.Event()


def refresh_all():
    if not _refresh_lock.acquire(blocking=False):
        return {"status": "already running"}
    try:
        db.set_meta("refreshing", "1")
        t0 = time.time()
        items = sources.fetch_all()
        fresh = [it for it in items if not db.article_exists(it["id"])]
        mls = sentiment.score([it["title"] for it in fresh])  # FinBERT, if installed
        analysed = []
        for it, ml in zip(fresh, mls):
            a = analyzer.analyze(it["title"], it["summary"], it["kind"], ml)
            db.save_article(it | {"impact": a["score"], "analysis": a, "ml": ml})
            analysed.append((it, a))
        log.info("fetched %d articles (%d new)", len(items), len(fresh))
        try:
            alerts.from_articles(analysed)
        except Exception as ex:
            log.exception("news alerts failed: %s", ex)
        last_e = db.get_meta("last_earnings_refresh")
        if not last_e or (datetime.now(timezone.utc) - datetime.fromisoformat(last_e)).total_seconds() > EARNINGS_REFRESH_HOURS * 3600:
            earnings.refresh()
            db.set_meta("last_earnings_refresh", datetime.now(timezone.utc).isoformat())
        watch = db.get_watchlist()
        news_syms = {r["symbol"] for r in aggregate.volatility(24, 60)}
        syms = news_syms | set(watch) | {r["symbol"] for r in aggregate.upcoming_earnings(7) if r["tracked"]}
        market.refresh(sorted(syms))
        try:
            alerts.from_prices(sorted(set(watch) | {r["symbol"] for r in aggregate.volatility(24, 25)}))
        except Exception as ex:
            log.exception("price alerts failed: %s", ex)
        db.set_meta("last_refresh", datetime.now(timezone.utc).isoformat())
        log.info("refresh done in %.1fs", time.time() - t0)
        return {"status": "ok", "fetched": len(items), "new": len(fresh)}
    finally:
        db.set_meta("refreshing", "0")
        _refresh_lock.release()


def reanalyze_all():
    """Re-score stored articles with the current rules (so edits to rules.py apply retroactively),
    and run FinBERT on stored articles that were saved before it was installed/enabled."""
    import json
    arts = db.all_articles_raw()
    missing = [a for a in arts if not a["ml"]]
    if missing and sentiment.available():
        mls = sentiment.score([a["title"] for a in missing])
        db.set_ml([(json.dumps(m), a["id"]) for a, m in zip(missing, mls) if m])
        for a, m in zip(missing, mls):
            if m:
                a["ml"] = json.dumps(m)
        log.info("FinBERT back-filled %d stored articles", sum(1 for m in mls if m))
    rows = []
    for a in arts:
        ml = json.loads(a["ml"]) if a["ml"] else None
        r = analyzer.analyze(a["title"], a["summary"] or "", a["kind"], ml)
        rows.append((r["score"], json.dumps(r), a["id"]))
    db.update_analysis(rows)
    log.info("re-analysed %d stored articles", len(rows))


def _scheduler():
    try:  # runs here (not at startup) so the web page is available while the model loads
        reanalyze_all()
    except Exception as ex:
        log.exception("re-analysis failed: %s", ex)
    while not _stop.is_set():
        try:
            refresh_all()
        except Exception as ex:
            log.exception("refresh failed: %s", ex)
        _stop.wait(REFRESH_MINUTES * 60)


@asynccontextmanager
async def lifespan(_app):
    db.init()
    threading.Thread(target=_scheduler, daemon=True).start()
    yield
    _stop.set()


app = FastAPI(title="NSE News Impact", lifespan=lifespan)
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
                            headers={"WWW-Authenticate": 'Basic realm="NSE News Impact"'})
    return await call_next(request)


@app.get("/")
def index():
    return FileResponse(BASE_DIR / "static" / "index.html")


@app.get("/api/dashboard")
def dashboard(hours: int = 24):
    mk = db.get_market()
    return {
        "server_time": datetime.now(timezone.utc).isoformat(),
        "last_refresh": db.get_meta("last_refresh"),
        "refresh_minutes": REFRESH_MINUTES,
        "refreshing": db.get_meta("refreshing") == "1",
        "finbert_enabled": sentiment.available(),
        "telegram_enabled": alerts.telegram_configured(),
        "macro": [{"symbol": k, "name": v, **(mk.get(k) or {})} for k, v in MACRO_TICKERS.items()],
        "watchlist": db.get_watchlist(),
        "latest_alert_id": db.latest_alert_id(),
        "mood": aggregate.mood(hours),
        "sectors": aggregate.sectors(hours),
        "volatility": aggregate.volatility(hours, 30),
        "top_news": aggregate.news(hours, max(MIN_IMPACT, 4))[:12],
        "earnings": aggregate.upcoming_earnings(14),
        "reported": aggregate.recently_reported(48),
        "sources": db.get_source_status(),
    }


@app.get("/api/news")
def news(hours: int = 24, min_impact: float = MIN_IMPACT, category: str = "", q: str = "", kind: str = "",
         sort: str = "time", watchlist: bool = False, limit: int = 300):
    return aggregate.news(hours, min_impact, category, q, kind, sort,
                          db.get_watchlist() if watchlist else None)[:limit]


@app.get("/api/alerts")
def get_alerts(since: int = 0, limit: int = 100):
    return db.get_alerts(since, limit)


@app.post("/api/alerts/test")
def test_alert():
    return alerts.test_alert()


@app.get("/api/watchlist")
def get_watchlist():
    return {"symbols": db.get_watchlist(), "known": sorted({c[0] for c in COMPANIES})}


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


@app.get("/api/volatility")
def volatility(hours: int = 24, limit: int = 40):
    return aggregate.volatility(hours, limit)


@app.get("/api/sectors")
def sectors(hours: int = 24):
    return aggregate.sectors(hours)


@app.get("/api/earnings")
def get_earnings(days: int = 14):
    return {"upcoming": aggregate.upcoming_earnings(days), "reported": aggregate.recently_reported(48)}


@app.get("/api/sources")
def get_sources():
    return db.get_source_status()


@app.post("/api/refresh")
def refresh():
    threading.Thread(target=refresh_all, daemon=True).start()
    return {"status": "started"}


@app.get("/api/analyze")
def analyze_text(text: str):
    """Paste any headline and see how the rule engine (+ FinBERT if installed) reads it."""
    return analyzer.analyze(text, "", "market", sentiment.score([text])[0])
