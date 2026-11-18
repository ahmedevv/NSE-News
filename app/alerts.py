"""Alert engine. Alerts are shown by the website's notification centre (pop-up, sound, desktop).

Levels:
  critical - market-wide headline with impact >= ALERT_CRITICAL_IMPACT (RBI surprise, war escalation, crude shock)
  high     - market-wide headline with impact >= ALERT_MACRO_IMPACT
  filing   - a tracked stock files something that can move it today (results, order, M&A, buyback, legal ...)
  stock    - a headline about a tracked stock with a clear catalyst (results, deal, order, regulatory action)
  watch    - anything new on a watchlist stock
  event    - a high-impact data release or expiry is EVENT_ALERT_MINUTES away
  vix      - India VIX up >= VIX_ALERT_PCT on the day

Only items from the last ALERT_MAX_AGE_MINUTES alert. The same driver or stock alerts at most once
per ALERT_COOLDOWN_MINUTES however many outlets cover it.
"""
import logging
from datetime import datetime, timedelta, timezone

from . import calendar_today, db
from .config import (ALERT_COOLDOWN_MINUTES, ALERT_CRITICAL_IMPACT, ALERT_MAX_AGE_MINUTES, ALERT_MACRO_IMPACT,
                     EVENT_ALERT_MINUTES, VIX_ALERT_PCT)
from .feed import is_wrap, news_item

log = logging.getLogger("alerts")
IST = timezone(timedelta(hours=5, minutes=30))


def market_open_ist(now: datetime | None = None) -> bool:
    """NSE cash session 09:15-15:30 IST, Mon-Fri (exchange holidays are not tracked)."""
    n = (now or datetime.now(timezone.utc)).astimezone(IST)
    if n.weekday() >= 5:
        return False
    minutes = n.hour * 60 + n.minute
    return 9 * 60 + 15 <= minutes <= 15 * 60 + 30


def _ago(minutes: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(minutes=minutes)).isoformat()


def _fresh(ts: str) -> bool:
    try:
        return datetime.fromisoformat(ts) >= datetime.now(timezone.utc) - timedelta(minutes=ALERT_MAX_AGE_MINUTES)
    except Exception:
        return False


def _cool(key: str) -> bool:
    return not db.alert_key_since(key, _ago(ALERT_COOLDOWN_MINUTES))


def from_filings(new: list[dict]):
    watch = set(db.get_watchlist())
    for f in sorted(new, key=lambda f: f["ts"]):
        if not _fresh(f["ts"]) or f["importance"] == "routine":
            continue
        sym = f["symbol"]
        if f["importance"] == "high":
            level = "filing"
        elif sym in watch:
            level = "watch"
        else:
            continue
        key = f"filing:{sym}:{f['label']}"  # NSE and BSE copies of the same filing alert once
        if _cool(key):
            title = f"{sym}: {f['label']} - {f['headline']}"[:220]
            _emit(level, "filing", title, (f["detail"] or f["category"])[:300], [sym], f["link"], key, f["id"])


def from_articles(fresh: list[dict]):
    """fresh = stored article rows (with analysis) first seen in this refresh."""
    watch = set(db.get_watchlist())
    for a in sorted(fresh, key=lambda a: -(a["analysis"] or {}).get("score", 0)):
        if not _fresh(a["published"]) or is_wrap(a["title"]):
            continue
        it = news_item(a)
        if not it:
            continue
        an = a["analysis"]
        score = an.get("score", 0)
        syms = it["symbols"]
        if it["market_wide"] and score >= ALERT_MACRO_IMPACT:
            level = "critical" if score >= ALERT_CRITICAL_IMPACT else "high"
            ev = max((e for e in an["events"] if e["category"] != "Corporate"), key=lambda e: e["severity"])
            key = f"event:{ev['id']}:{ev['direction']}"
            body = _exposure_line(an)
        elif watch & set(syms):
            level, key, body = "watch", "watch:" + ",".join(sorted(watch & set(syms))), it["label"]
        elif syms and it["importance"] == "high":
            level, key, body = "stock", "stock:" + ",".join(sorted(syms)), it["label"]
        else:
            continue
        if _cool(key):
            _emit(level, "news", a["title"], body, syms, a["link"], key, a["id"])


def _exposure_line(an: dict) -> str:
    ups = [s["sector"] for s in an["sectors"] if s["effect"] > 0 and s["sector"] != "Broad Market" and not s.get("uncertain")][:3]
    downs = [s["sector"] for s in an["sectors"] if s["effect"] < 0 and s["sector"] != "Broad Market" and not s.get("uncertain")][:3]
    parts = []
    if downs:
        parts.append("Pressure: " + ", ".join(downs))
    if ups:
        parts.append("Support: " + ", ".join(ups))
    return ". ".join(parts)


def from_calendar():
    now = datetime.now(timezone.utc)
    for e in calendar_today.upcoming(0, EVENT_ALERT_MINUTES / 60):
        if e["impact"] != "high":
            continue
        mins = round((datetime.fromisoformat(e["ts"]) - now).total_seconds() / 60)
        if mins < 0:
            continue
        key = f"cal:{e['id']}"
        if not db.alert_key_since(key, _ago(24 * 60)):
            at = datetime.fromisoformat(e["ts"]).astimezone(IST).strftime("%H:%M")
            fc = f"Forecast {e['forecast']}, previous {e['previous']}. " if e.get("forecast") else ""
            _emit("event", "calendar", f"In {mins} min ({at} IST): {e['title']}",
                  fc + "Expect a volatility spike around the release; option premiums usually deflate after it.",
                  [], "", key)


def from_prices():
    if not market_open_ist():
        return
    vix = db.get_market().get("^INDIAVIX")
    if vix and vix.get("chg_1d") is not None and vix["chg_1d"] >= VIX_ALERT_PCT:
        key = f"vix:{datetime.now(IST).date()}"
        if not db.alert_key_since(key, _ago(24 * 60)):
            _emit("vix", "price", f"India VIX up {vix['chg_1d']:+.1f}% to {vix['price']}",
                  "Implied volatility is jumping: option premiums are getting expensive and intraday swings wider.",
                  [], "", key)


def _emit(level, kind, title, body, symbols, link, key, ref_id=""):
    aid = db.add_alert(level, kind, title, body, symbols, [], link, key, ref_id)
    log.info("ALERT %s: %s", level, title)
    return aid


def test_alert() -> dict:
    aid = db.add_alert("high", "test", "Test notification: alerts are working",
                       "Real alerts show the headline or filing and the stocks involved.", [], [], "",
                       f"test:{datetime.now(timezone.utc).isoformat()}")
    return {"id": aid}
