"""Builds the desk: one live feed of exchange filings + relevant headlines, and the story detail.

A headline is kept only if it
  * names a tracked stock, or
  * is a market-wide trigger (RBI, Fed, crude, war, rupee, tariffs ...) in the headline itself,
and it is not a market wrap / listicle ("Sensex ends 300 pts lower", "Stocks to watch", "Top gainers").
Nothing is scored or hidden behind a threshold beyond that.
"""
import re
from datetime import date, datetime, timedelta, timezone

from . import db
from .config import ALERT_MACRO_IMPACT
from .rules import SECTORS
from .universe import SYMBOL_SECTOR, TRACKED

IST = timezone(timedelta(hours=5, minutes=30))

# Reports of what the market already did, previews, listicles and tips: no new information for a trade
WRAP = re.compile(
    r"^\W*(stock market today\W*|markets? (today|live)\W*|closing bell\W*|opening bell\W*)?"
    r"(sensex|nifty( 50| bank| it| auto| realty| metal| pharma| fmcg)?|bank nifty|nifty|stock markets?|markets?|"
    r"indian (stock |equity |share )?markets?|equities|equity markets?|d-street|dalal street|benchmarks?|"
    r"benchmark indices|indices|sensex,? (and )?nifty( 50)?|nifty,? (and )?sensex)\b"
    r"|\b(sensex|nifty( 50| bank)?|bank nifty|markets?|stock market|dalal street|indices|equities|benchmarks?)\b.{0,70}"
    r"\b(ends?|ended|closes?|closed|closing|settles?|settled|opens?|opened|opening|snaps?|extends?|recovers?|pares|"
    r"trades? (flat|higher|lower)|trading (flat|higher|lower)|\d[\d,.]* ?(pts|points))\b"
    r"|\b(stock market (today|live|holiday|update)|market (live|highlights|wrap|outlook|ahead)|stocks? to (buy|watch|sell)|"
    r"stocks? in (news|focus)|buzzing stocks|top (gainers|losers)|buy or sell|trade setup|technical (view|picks|outlook)|"
    r"share price (today|live)|shares? today|multibagger|penny stocks?|stock recommendations?|stock (picks?|ideas?)|should you (buy|sell|hold)|"
    r"ahead of market|pre-?market|gift nifty|(nifty|sensex|market) outlook|gold rates?|silver rates?|"
    r"week ahead|what to expect|key things|\d+ things|live updates?|live blog|explained|opinion)\b", re.I)

# Features, commentary and entertainment that happen to contain trigger words ("God of War star", "Why X is a buy")
FEATURE = re.compile(
    r"^(what|why|how|when|where|who|is|are|should|could|can|do|does|if|here'?s|inside|the business of|analysis|opinion|"
    r"explainer|review|watch|listen|photos?|in pictures|quiz|newsletter|commentary|editorial|column|view|after the)\b"
    r"|\b(star|stars in|movie|film|series|album|songs?|tunes|masterpiece|video game|novel|podcast|briefing|recap|"
    r"years later|anniversary|book|documentary|tv show|netflix|celebrity|actor|actress|fashion|recipe|editorial|"
    r"eps growth|undervalued|overvalued|intrinsic value|fair value|returns on capital|insiders? (bought|sold)|"
    r"is it time|a closer look|investors should|dividend investors|stock analysis|valuation check|\d+-dma|"
    r"moving average|is it a (rebound|buy|sell))\b", re.I)
LOW_SOURCES = re.compile(r"simply wall|motley fool|zacks|marketbeat|benzinga|stocktitan|seeking alpha|yahoo finance|marketsmojo|"
                         r"chartmill|gurufocus|investing\.com|globenewswire|business wire|pr newswire|accesswire", re.I)
# Stories about US / foreign listings ("IRIDEX (NASDAQ:IRIX) shares fall ...") say nothing about Indian stocks
FOREIGN_TICKER = re.compile(r"\((nasdaq|nyse|nyse american|amex|otc\w*|lse|tsx|asx|hkex)\s*:\s*[a-z.]+\)", re.I)

# ---- gates that decide whether a world / macro headline is market-wide for an Indian intraday trader
_R = lambda p: re.compile(p, re.I)
OIL_REGION = _R(r"\b(iran\w*|israel\w*|tehran|hormuz|red sea|houthis?|hezbollah|gaza|lebanon|saudi\w*|gulf|qatar|uae|"
                r"oman|iraq\w*|yemen|opec\+?|oil|crude|tankers?|shipping|pakistan\w*|india\w*|china|chinese|taiwan|beijing)\b")
RU_UA = _R(r"\b(russia\w*|ukrain\w*|moscow|kyiv|putin|zelensky\w*)\b")
ENERGY = _R(r"\b(oil|crude|refiner\w*|energy|gas|lng|pipelines?|ports?|nuclear|grain|fertili[sz]er)\b")
GEO_ACTION = _R(r"\b(strikes?|struck|attack\w*|missiles?|air ?strikes?|invade[sd]?|invasion|troops|bomb\w*|shell\w*|"
                r"launch(es|ed)?|retaliat\w*|escalat\w*|drones?|warships?|ceasefire|truce|peace (deal|talks|agreement)|"
                r"blockade|seiz\w*|mobili[sz]\w*|declares? war|killed|clash\w*|border|embargo|closes?|closure|mines?)\b")
SANCTION_TARGET = _R(r"\b(oil|crude|energy|(?<!west )banks?|tankers?|shadow fleet|refiner\w*|lng|gas|india\w*|exports?|imports?)\b")
INDIA = _R(r"\b(india\w*|new delhi|modi|goyal)\b")
CHINA = _R(r"\b(china|chinese|beijing|xi)\b")
USA = _R(r"\b(u\.?s\.?|united states|america\w*|washington|trump)\b")
PCT = _R(r"\d+ ?(%|percent|per cent)")
TRADE_ACTION = _R(r"\b(impose[sd]?|announce[sd]?|hikes?|raise[sd]?|slaps?|lev(y|ies|ied)|cuts?|slash\w*|sets?|"
                  r"exempt\w*|retaliat\w*|\d+ ?(%|percent|per cent)|deal|pact|agreement|signs?|pause[sd]?|suspend\w*|"
                  r"threat\w*|warns?|extends?|lifts?|scraps?|talks)\b")
TRADE_SOFT = _R(r"\b(could|should|would|might|getting rid|rein in|refunds?|bonuses|amicus|lawsuit|court|affordability)\b")
HOME = _R(r"\b(india\w*|rbi|sebi|rupee|nifty|sensex|u\.?s\.?|united states|american|fed|federal reserve|fomc|"
          r"treasury|china|chinese)\b")
OIL_MARKET = _R(r"\b(brent|wti|opec\+?|output|supply|supplies|production|inventor\w*|barrel)\b")
DATA = _R(r"\d|\b(cpi|wpi|pce|ppi|gdp|pmi|data|print|reading)\b")
FED_ACT = _R(r"\b(rates?|hikes?|cuts?|holds?|keeps?|pause[sd]?|yields?|minutes|fomc|bets|decision|policy|signals?|"
             r"inflation|dollar|hawkish|dovish|powell)\b")


def _event_ok(e: dict, title: str) -> bool:
    eid = e["id"]
    if eid == "russia_ukraine":
        return bool(ENERGY.search(title) and GEO_ACTION.search(title))
    if eid in ("war_conflict", "middle_east_shipping", "india_pak_china", "ceasefire", "disaster"):
        if OIL_REGION.search(title) and GEO_ACTION.search(title):
            return True
        return bool(RU_UA.search(title) and ENERGY.search(title) and GEO_ACTION.search(title))
    if eid == "sanctions":
        return bool(SANCTION_TARGET.search(title))
    if eid in ("tariffs_trade", "trade_deal"):
        # matters for India when India is a party, the US and China are at it, or the US sets a big new tariff
        who = INDIA.search(title) or (USA.search(title) and CHINA.search(title)) or (USA.search(title) and PCT.search(title))
        return bool(who and TRADE_ACTION.search(title) and not TRADE_SOFT.search(title))
    if eid in ("inflation", "gdp"):
        return bool(HOME.search(title) and DATA.search(title))
    if eid == "elections":
        return bool(HOME.search(title))
    if eid == "fed":
        return bool(FED_ACT.search(title))
    if eid in ("crude", "opec_cut", "natgas", "gold", "metals"):
        return e.get("direction") in ("up", "down") or bool(OIL_MARKET.search(title))
    return True  # RBI, Fed, rupee, FII flows, budget, GST, SEBI, monsoon, sector events ...


def is_wrap(title: str) -> bool:
    return bool(WRAP.search(title or "")) or bool(FEATURE.search(title or ""))


def _short_driver(e: dict) -> str:
    arrow = {"up": " ▲", "down": " ▼"}.get(e.get("direction"), "")
    return e["name"].split(" / ")[0].split(" (")[0] + arrow


# A company headline that reports a catalyst or a real move is worth acting on; the rest is background
CATALYST = _R(r"\b(results?|q[1-4]|profit|loss|revenue|margins?|ebitda|guidance|outlook|forecast|order|contract|deal|"
              r"stake|acqui\w*|merger|demerger|ipo|qip|buy-?back|bonus|split|dividend|block deal|bulk deal|approval|"
              r"approves?|usfda|ban(s|ned)?|penalty|fine[sd]?|raid|probe|sebi|rbi|resign\w*|ceo|md|downgrade\w*|"
              r"upgrade\w*|target|launch\w*|plant|capacity|tariff|price hike|strike|shutdown|fire|default|rating)\b")
BIG_MOVE = _R(r"\b(\d+(\.\d+)?)\s?(%|per ?cent)")


def news_item(a: dict) -> dict | None:
    an = a["analysis"] or {}
    title = a["title"]
    if is_wrap(title) or LOW_SOURCES.search(a.get("source") or "") or FOREIGN_TICKER.search(title):
        return None
    syms = [s["symbol"] for s in an.get("stocks", []) if s["symbol"] in TRACKED]
    if len(syms) > 4:  # a list of many stocks is a round-up, not news about one of them
        return None
    in_title = [e for e in an.get("events", []) if e.get("in_title")]
    macro = [e for e in in_title if e["category"] != "Corporate"]
    # Sector events (telecom tariffs, USFDA ...) about a named company are that company's news, not market-wide
    broad = [e for e in macro if (e["category"] != "Sector" or not syms) and _event_ok(e, title)]
    market_wide = bool(broad) and an.get("score", 0) >= 4
    if not syms and not market_wide:
        return None
    stock_events = [e for e in in_title if e["category"] in ("Corporate", "Sector")]
    driver = ""
    if market_wide:
        top = max(broad, key=lambda e: e["severity"])
        label = _short_driver(top)
        driver = f"{top['id']}:{top.get('direction', '')}"
        high = an.get("score", 0) >= ALERT_MACRO_IMPACT
    else:
        label = _short_driver(stock_events[0]) if stock_events else "Company news"
        moves = [float(m.group(1)) for m in BIG_MOVE.finditer(title)]
        high = (any(e["id"] != "ratings" for e in stock_events) or bool(CATALYST.search(title))
                or any(m >= 3 for m in moves))
    return {
        "type": "news", "id": a["id"], "ts": a["published"], "title": title, "source": a["source"], "link": a["link"],
        "symbols": syms, "label": label, "importance": "high" if high else "normal", "market_wide": market_wide,
        "driver": driver,
    }


def filing_item(f: dict) -> dict:
    return {
        "type": "filing", "id": f["id"], "ts": f["ts"], "title": f["headline"] or f["category"] or f["label"],
        "source": f["source"], "link": f["link"], "symbols": [f["symbol"]], "label": f["label"],
        "importance": f["importance"], "market_wide": False, "company": f["company"],
        # BSE subjects are often just the category ("Bagging/Receiving of orders"); the detail says what happened
        "snippet": (f["detail"] or "")[:260] if (f["detail"] or "").strip() not in ("", f["headline"]) else "",
    }


def build(since: datetime, kind: str = "", q: str = "", watch: list[str] | None = None,
          routine: bool = False, limit: int = 400) -> list[dict]:
    since_iso = since.isoformat()
    items: list[dict] = []
    if kind in ("", "filing", "watch", "high"):
        kept: list[dict] = []
        for f in db.recent_filings(since_iso):
            if f["importance"] == "routine" and not routine:
                continue
            # the same announcement filed on both exchanges: keep the first one seen
            t = datetime.fromisoformat(f["ts"])
            if any(k["symbol"] == f["symbol"] and k["label"] == f["label"] and k["source"] != f["source"]
                   and abs((datetime.fromisoformat(k["ts"]) - t).total_seconds()) <= 20 * 60 for k in kept):
                continue
            kept.append(f)
        items += [filing_item(f) for f in kept]
    if kind in ("", "news", "market", "watch", "high"):
        seen = set()
        for a in db.recent_articles(since_iso, 0, 1500):
            it = news_item(a)
            if not it:
                continue
            key = re.sub(r"[^a-z0-9]", "", it["title"].lower())[:70]
            if key in seen:
                continue
            seen.add(key)
            items.append(it)
    if kind == "market":
        items = [i for i in items if i["market_wide"]]
    elif kind == "high":
        items = [i for i in items if i["importance"] == "high"]
    if watch is not None:
        w = set(watch)
        items = [i for i in items if w & set(i["symbols"])]
    if q:
        ql = q.lower()
        items = [i for i in items if ql in (i["title"] + " " + " ".join(i["symbols"]) + " " + i.get("company", "")).lower()]
    items.sort(key=lambda i: i["ts"], reverse=True)
    return _with_prices(_group(items)[:limit])


def _group(items: list[dict]) -> list[dict]:
    """Twenty outlets on the same driver ("crude falls") show once, newest first, with a count of the others."""
    out, last = [], {}
    for it in items:
        d = it.get("driver")
        if d and d in last:
            head = last[d]
            if (datetime.fromisoformat(head["ts"]) - datetime.fromisoformat(it["ts"])).total_seconds() <= 3 * 3600:
                head["similar"] = head.get("similar", 0) + 1
                if it["importance"] == "high":
                    head["importance"] = "high"
                continue
        if d:
            last[d] = it
        out.append(it)
    return out


def _with_prices(items: list[dict]) -> list[dict]:
    mk = db.get_market()
    for it in items:
        it["moves"] = {s: (mk.get(s) or {}).get("chg_1d") for s in it["symbols"]}
    return items


def symbols_in_feed(since: datetime) -> set[str]:
    return {s for it in build(since, routine=False, limit=600) for s in it["symbols"]}


# ----------------------------------------------------------------------------- detail
def detail(kind: str, iid: str) -> dict | None:
    mk = db.get_market()
    px = lambda s: {"symbol": s, "price": (mk.get(s) or {}).get("price"), "chg": (mk.get(s) or {}).get("chg_1d")}
    if kind == "filing":
        f = db.get_filing(iid)
        if not f:
            return None
        return filing_item(f) | {"detail": f["detail"], "category": f["category"], "stocks": [px(f["symbol"])],
                                 "sector": SYMBOL_SECTOR.get(f["symbol"], "")}
    a = db.get_article(iid)
    if not a:
        return None
    an = a["analysis"] or {}
    base = news_item(a) or {"type": "news", "id": a["id"], "ts": a["published"], "title": a["title"],
                            "source": a["source"], "link": a["link"], "symbols": [], "label": "",
                            "importance": "normal", "market_wide": False}
    drivers = [{"name": e["name"], "direction": e["direction"], "why": e["why"]}
               for e in an.get("events", []) if e["category"] != "Corporate"][:2]
    exposure = []
    for s in an.get("sectors", []):
        if s["sector"] == "Broad Market" or not s["effect"] or s.get("uncertain"):
            continue
        reps = [x for x in SECTORS.get(s["sector"], (None, []))[1] if x in TRACKED][:5]
        exposure.append({"sector": s["sector"], "effect": s["effect"], "stocks": [px(x) for x in reps]})
    return base | {"summary": a.get("summary") or "", "drivers": drivers if base["market_wide"] else [],
                   "exposure": exposure[:5] if base["market_wide"] else [],
                   "stocks": [px(s) for s in base["symbols"]]}


# ----------------------------------------------------------------------------- results
def results(days: int = 2) -> list[dict]:
    today = datetime.now(IST).date()
    rows = db.get_earnings(today.isoformat(), (today + timedelta(days=days)).isoformat())
    out, seen = [], set()
    for r in rows:
        if r["symbol"] in TRACKED and (r["symbol"], r["date"]) not in seen:
            seen.add((r["symbol"], r["date"]))
            out.append({"symbol": r["symbol"], "date": r["date"],
                        "when": "Today" if r["date"] == today.isoformat() else
                                date.fromisoformat(r["date"]).strftime("%a %d %b")})
    return out
