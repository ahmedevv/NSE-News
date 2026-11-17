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

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

from . import aggregate, analyzer, db, earnings, market, sentiment, sources
from .config import BASE_DIR, MIN_IMPACT, REFRESH_MINUTES

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
log = logging.getLogger("main")
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
        for it, ml in zip(fresh, mls):
            a = analyzer.analyze(it["title"], it["summary"], it["kind"], ml)
            db.save_article(it | {"impact": a["score"], "analysis": a, "ml": ml})
        log.info("fetched %d articles (%d new)", len(items), len(fresh))
        earnings.refresh()
        syms = {r["symbol"] for r in aggregate.volatility(24, 60)}
        syms |= {r["symbol"] for r in aggregate.upcoming_earnings(7) if r["tracked"]}
        market.refresh(sorted(syms))
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
    return {
        "last_refresh": db.get_meta("last_refresh"),
        "refreshing": db.get_meta("refreshing") == "1",
        "finbert_enabled": sentiment.available(),
        "mood": aggregate.mood(hours),
        "sectors": aggregate.sectors(hours),
        "volatility": aggregate.volatility(hours, 30),
        "top_news": aggregate.news(hours, max(MIN_IMPACT, 4))[:12],
        "earnings": aggregate.upcoming_earnings(14),
        "reported": aggregate.recently_reported(48),
        "sources": db.get_source_status(),
    }


@app.get("/api/news")
def news(hours: int = 24, min_impact: float = MIN_IMPACT, category: str = "", q: str = "", kind: str = ""):
    return aggregate.news(hours, min_impact, category, q, kind)


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
