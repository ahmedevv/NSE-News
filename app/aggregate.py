"""Turns per-article analysis into dashboard views: market mood, sector heatmap,
volatility watchlist and earnings calendar."""
import re
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone

from . import db
from .config import MIN_IMPACT
from .rules import COMPANIES, SECTORS

SYMBOL_SECTOR = {sym: sector for sym, sector, _ in COMPANIES}
for _sec, (_idx, _syms) in SECTORS.items():
    for _s in _syms:
        SYMBOL_SECTOR.setdefault(_s, _sec)

HALF_LIFE_HOURS = 12.0


def effective(a: dict) -> dict:
    r = a["analysis"]
    return r | {"engine": "rules+finbert" if r.get("finbert") else "rules",
                "confidence": "medium" if r.get("events") else "low"}


def _decay(published: str) -> float:
    try:
        age = (datetime.now(timezone.utc) - datetime.fromisoformat(published)).total_seconds() / 3600
    except Exception:
        age = 24
    return 0.5 ** (max(age, 0) / HALF_LIFE_HOURS)


def _weighted(hours: int):
    """Yield (article, effective_analysis, weight). weight = impact x recency, with diminishing
    returns when many articles cover the same driver (the 30th story on the same war adds little)."""
    since = (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()
    arts = [(a, effective(a)) for a in db.recent_articles(since, MIN_IMPACT)]
    arts.sort(key=lambda x: -x[1]["score"])
    seen = defaultdict(int)
    for a, e in arts:
        key = e["events"][0]["id"] if e.get("events") else ("|".join(s["symbol"] for s in e["stocks"][:2]) or a["id"])
        seen[key] += 1
        yield a, e, _decay(a["published"]) * e["score"] / seen[key] ** 0.5


def news(hours: int = 24, min_impact: float = MIN_IMPACT, category: str = "", q: str = "", kind: str = "",
         sort: str = "impact", symbols: list[str] | None = None) -> list[dict]:
    since = (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()
    out, seen = [], set()
    for a in db.recent_articles(since, min_impact):
        e = effective(a)
        if category and e["category"] != category:
            continue
        if kind and a["kind"] != kind:
            continue
        if q and q.lower() not in (a["title"] + " " + (a["summary"] or "")).lower():
            continue
        if symbols is not None and not {s["symbol"] for s in e["stocks"]} & set(symbols):
            continue
        key = re.sub(r"[^a-z0-9]", "", a["title"].lower())[:60]
        if key in seen:
            continue
        seen.add(key)
        out.append({k: a[k] for k in ("id", "title", "link", "source", "kind", "published", "summary")} | {"a": e})
    if sort == "time":
        out.sort(key=lambda x: x["published"], reverse=True)
    else:
        out.sort(key=lambda x: (x["a"]["score"], x["published"]), reverse=True)
    return out


def upcoming_earnings(days: int = 14) -> list[dict]:
    today = date.today()
    rows = db.get_earnings(today.isoformat(), (today + timedelta(days=days)).isoformat())
    seen, out = set(), []
    market = db.get_market()
    for r in rows:
        if r["symbol"] in seen:
            continue
        seen.add(r["symbol"])
        r["days_away"] = (date.fromisoformat(r["date"]) - today).days
        r["sector"] = SYMBOL_SECTOR.get(r["symbol"], "")
        r["tracked"] = r["symbol"] in SYMBOL_SECTOR
        r["market"] = market.get(r["symbol"])
        out.append(r)
    out.sort(key=lambda r: (r["date"], not r["tracked"], r["symbol"]))
    return out


def recently_reported(hours: int = 48) -> list[dict]:
    """Companies whose results are being discussed in the news right now."""
    since = (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()
    out = {}
    for a in db.recent_articles(since, 0):
        if not any(ev["id"] == "earnings" for ev in a["analysis"].get("events", [])):
            continue
        e = effective(a)
        for s in e["stocks"]:
            out.setdefault(s["symbol"], {"symbol": s["symbol"], "sector": s.get("sector", ""), "effect": s["effect"],
                                         "title": a["title"], "link": a["link"], "published": a["published"]})
    return sorted(out.values(), key=lambda x: x["published"], reverse=True)


def volatility(hours: int = 24, limit: int = 40) -> list[dict]:
    acc = defaultdict(lambda: {"attention": 0.0, "bias": 0.0, "news": [], "drivers": set(), "direct": 0})
    for a, e, d in _weighted(hours):
        touched = set()
        for s in e["stocks"]:
            x = acc[s["symbol"]]
            x["attention"] += d
            x["bias"] += d * s["effect"] / 2
            x["direct"] += 1
            x["news"].append((d, a["title"], a["link"], s.get("reason", "")))
            touched.add(s["symbol"])
        for sec in e["sectors"]:
            if sec["sector"] == "Broad Market" or not sec["effect"]:
                continue
            w = 0.15 * abs(sec["effect"])  # spillover to sector peers is weaker than a direct mention
            for sym in SECTORS.get(sec["sector"], (None, []))[1]:
                if sym in touched:
                    continue
                x = acc[sym]
                x["attention"] += d * w
                x["bias"] += d * w * sec["effect"] / 2
                x["drivers"].add(f"{sec['sector']}: {sec.get('reason', '')}")
                x["news"].append((d * w, a["title"], a["link"], sec.get("reason", "")))

    for r in upcoming_earnings(7):
        x = acc[r["symbol"]]
        if r["tracked"] or x["attention"] > 0:
            x["attention"] += 6 if r["days_away"] <= 2 else 3.5
            x["earnings"] = r["date"]

    market = db.get_market()
    rows = []
    for sym, x in acc.items():
        m = market.get(sym)
        att = x["attention"]
        if m and m.get("vol_regime") and m["vol_regime"] > 1.2:
            att *= 1.15  # realised volatility already expanding
        ratio = x["bias"] / x["attention"] if x["attention"] else 0
        rows.append({
            "symbol": sym, "sector": SYMBOL_SECTOR.get(sym, "Other"), "score": att,
            "bias": "bullish" if ratio > 0.25 else "bearish" if ratio < -0.25 else "two-way",
            "bias_strength": round(ratio, 2), "direct_mentions": x["direct"],
            "earnings": x.get("earnings"), "drivers": sorted(x["drivers"])[:3],
            "headlines": [{"title": t, "link": l, "reason": rs} for _, t, l, rs in sorted(x["news"], reverse=True)[:3]],
            "market": m,
        })
    rows.sort(key=lambda r: -r["score"])
    top = rows[0]["score"] if rows else 1
    for r in rows:
        r["score"] = round(100 * r["score"] / top)
    return rows[:limit]


def sectors(hours: int = 24) -> list[dict]:
    acc = {s: {"sector": s, "net": 0.0, "attention": 0.0, "count": 0, "reasons": defaultdict(float)} for s in SECTORS}
    for a, e, d in _weighted(hours):
        for sec in e["sectors"]:
            x = acc.get(sec["sector"])
            if not x:
                continue
            x["net"] += d * sec["effect"]
            x["attention"] += d * max(abs(sec["effect"]), 0.5)
            x["count"] += 1
            x["reasons"][sec.get("reason", "")] += d
    market = db.get_market()
    out = []
    for s, x in acc.items():
        idx = SECTORS[s][0]
        out.append({
            "sector": s, "net": round(x["net"], 1), "attention": round(x["attention"], 1), "count": x["count"],
            "outlook": "positive" if x["net"] > 2 else "negative" if x["net"] < -2 else "neutral",
            "top_reasons": [r for r, _ in sorted(x["reasons"].items(), key=lambda kv: -kv[1])[:3] if r],
            "index": idx, "index_market": market.get(idx) if idx else None,
        })
    out.sort(key=lambda r: -r["attention"])
    return out


def mood(hours: int = 24) -> dict:
    num = den = 0.0
    counts = defaultdict(int)
    for a, e, d in _weighted(hours):
        s = {"bullish": 1, "bearish": -1}.get(e["sentiment"], 0)
        num += s * d
        den += d
        counts[e["category"]] += 1
    val = round(100 * num / den) if den else 0
    label = "Risk-on" if val > 15 else "Risk-off" if val < -15 else "Neutral / mixed"
    return {"value": val, "label": label, "categories": dict(counts), "nifty": db.get_market().get("^NSEI")}
