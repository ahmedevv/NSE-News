"""Alert engine.

Creates an alert when:
  * critical / high  - a NEW story scores >= ALERT_CRITICAL_IMPACT / ALERT_MIN_IMPACT
  * watch            - a new story names a stock on your watchlist
  * move             - a watched or in-the-news stock moves >= MOVE_ALERT_PCT today (market hours only)
  * vix              - India VIX jumps >= VIX_ALERT_PCT

Noise control: only stories published in the last ALERT_MAX_AGE_MINUTES, and the same driver
(e.g. "crude oil") alerts at most once per ALERT_COOLDOWN_MINUTES however many outlets cover it.
Alerts are delivered by the website's notification centre (pop-up, sound, desktop notification).
"""
import logging
from datetime import datetime, timedelta, timezone


from . import db
from .config import (ALERT_COOLDOWN_MINUTES, ALERT_CRITICAL_IMPACT, ALERT_MAX_AGE_MINUTES, ALERT_MIN_IMPACT,
                     MOVE_ALERT_PCT, VIX_ALERT_PCT)

log = logging.getLogger("alerts")
RANK = {"watch": 1, "move": 2, "high": 2, "vix": 3, "critical": 3}
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


def _summary(a: dict) -> tuple[str, list, list]:
    ups = [s["sector"] for s in a["sectors"] if s["effect"] > 0 and s["sector"] != "Broad Market"][:3]
    downs = [s["sector"] for s in a["sectors"] if s["effect"] < 0 and s["sector"] != "Broad Market"][:3]
    parts = []
    if downs:
        parts.append("Pressure: " + ", ".join(downs))
    if ups:
        parts.append("Support: " + ", ".join(ups))
    stocks = [s["symbol"] for s in a["stocks"]][:6]
    if stocks:
        parts.append("Stocks: " + ", ".join(stocks))
    sectors = [{"sector": s["sector"], "effect": s["effect"]} for s in a["sectors"] if s["effect"]][:6]
    return ". ".join(parts), stocks, sectors


def from_articles(fresh: list[tuple[dict, dict]]):
    """fresh = [(article_item, analysis)] for articles first seen in this refresh."""
    watch = set(db.get_watchlist())
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=ALERT_MAX_AGE_MINUTES)
    # strongest first, so the best headline for a driver is the one that alerts
    for it, a in sorted(fresh, key=lambda x: -x[1]["score"]):
        try:
            if datetime.fromisoformat(it["published"]) < cutoff:
                continue
        except Exception:
            continue
        score = a["score"]
        syms = {s["symbol"] for s in a["stocks"]}
        level = "critical" if score >= ALERT_CRITICAL_IMPACT else "high" if score >= ALERT_MIN_IMPACT else None
        hit_watch = sorted(watch & syms)
        if not level and hit_watch and score >= 3:
            level = "watch"
        if not level:
            continue
        if level == "watch":
            key = "watch:" + ",".join(hit_watch)
        elif a["events"]:
            key = "event:" + a["events"][0]["id"] + ":" + a["sentiment"]
        else:
            key = ("stocks:" + ",".join(sorted(syms))) if syms else "article:" + it["id"]
        if db.alert_key_since(key, _ago(ALERT_COOLDOWN_MINUTES)):
            continue
        body, stocks, sectors = _summary(a)
        _emit(level, "news", it["title"], body, stocks, sectors, it["link"], key, it["id"], a.get("sentiment", ""))


def from_prices(candidates: list[str]):
    if not market_open_ist():
        return
    market = db.get_market()
    today = datetime.now(IST).date().isoformat()
    vix = market.get("^INDIAVIX")
    if vix and vix.get("chg_1d") is not None and vix["chg_1d"] >= VIX_ALERT_PCT:
        key = f"vix:{today}"
        if not db.alert_key_since(key, _ago(24 * 60)):
            _emit("vix", "price", f"India VIX up {vix['chg_1d']:+.1f}% to {vix['price']}",
                  "Expected volatility is rising sharply - expect wider intraday swings and costlier options.",
                  [], [], "", key)
    for sym in candidates:
        m = market.get(sym)
        if not m or m.get("chg_1d") is None or abs(m["chg_1d"]) < MOVE_ALERT_PCT:
            continue
        key = f"move:{sym}:{today}"
        if db.alert_key_since(key, _ago(24 * 60)):
            continue
        direction = "up" if m["chg_1d"] > 0 else "down"
        vol = f" on {m['volume_x']}x normal volume" if m.get("volume_x") and m["volume_x"] >= 1.5 else ""
        _emit("move", "price", f"{sym} {direction} {m['chg_1d']:+.2f}% at {m['price']:,}",
              f"Large move{vol}. Check the news wire for the driver.", [sym], [], "", key)


def _emit(level, kind, title, body, symbols, sectors, link, key, article_id="", sentiment=""):
    aid = db.add_alert(level, kind, title, body, symbols, sectors, link, key, article_id)
    log.info("ALERT %s: %s", level, title)
    return aid


def test_alert() -> dict:
    title = "Test notification: alerts are working"
    body = "Real alerts show the story, the sectors under pressure or support, and the stocks involved."
    aid = db.add_alert("high", "test", title, body, [], [], "", f"test:{datetime.now(timezone.utc).isoformat()}")
    return {"id": aid}
