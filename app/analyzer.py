"""Rule-based impact analysis. Fast, free, offline, explainable.

For every article it works out:
  * which market-moving events it describes (rules.RULES)
  * the direction of the driver (e.g. crude UP vs DOWN) and therefore the sign of each sector effect
  * which NSE companies are named, and whether the tone for them is positive / negative
  * an overall impact score 0-10
"""
import re
from functools import lru_cache

from .rules import (COMPANIES, DOWN_WORDS, NEGATIVE_WORDS, POSITIVE_WORDS, PRICE_DOWN, PRICE_UP, RULES,
                    SECTOR_KEYWORDS, SECTORS,
                    UP_WORDS)

_UP = re.compile(UP_WORDS, re.I)
_DOWN = re.compile(DOWN_WORDS, re.I)
_POS = re.compile(POSITIVE_WORDS, re.I)
_PRICE_UP = re.compile(PRICE_UP, re.I)
_PRICE_DOWN = re.compile(PRICE_DOWN, re.I)
_NEG = re.compile(NEGATIVE_WORDS, re.I)

# Words that make an article relevant to India even if it's from a world feed
# Features / history / opinion pieces mention big themes but rarely move prices today
NOISE = re.compile(r"\b(1[89]\d\d|19[0-9]\d|history|historic(al)?|anniversary|explained|explainer|opinion|column|"
                   r"what would|could end|book|film|movie|magazines?|podcast|quiz|recipe|true stories|approval rating|"
                   r"stress(es)?|urges?|calls? for|vows?|pledges?|preparedness|self-reliance|lessons from|interview|archaeolog\w*|secret war|long arm)\b", re.I)
INDIA_HINT = re.compile(r"\b(india|indian|nifty|sensex|nse|bse|rupee|rbi|sebi|dalal street|mumbai)\b", re.I)


@lru_cache(maxsize=1)
def _compiled_rules():
    return [(r, [re.compile(p, re.I) for p in r["patterns"]]) for r in RULES]


@lru_cache(maxsize=1)
def _compiled_companies():
    out = []
    for sym, sector, aliases in COMPANIES:
        pats = []
        for a in aliases:
            # aliases that are already regex (contain \b) keep their case sensitivity for acronyms
            if "\\b" in a:
                pats.append(re.compile(a))
            else:
                pats.append(re.compile(r"\b" + re.escape(a) + r"\b", re.I))
        out.append((sym, sector, pats))
    return out


_CLAUSE_SPLIT = re.compile(r"[,;:|.!?]|\s(?:as|amid|while|after|but|despite|even as|and)\s", re.I)
_SECTOR_KW = {sec: re.compile(p, re.I) for sec, p in SECTOR_KEYWORDS.items()}


def _direction(text: str, span: tuple[int, int]) -> str:
    """Direction of the driver = the up/down word NEAREST to the match, inside the same clause.
    ("GIFT Nifty flat as Nasdaq plunges, crude rises" -> crude is 'up', not 'down')."""
    lo = 0
    hi = len(text)
    for b in _CLAUSE_SPLIT.finditer(text):
        if b.end() <= span[0]:
            lo = b.end()
        elif b.start() >= span[1]:
            hi = b.start()
            break
    clause = text[lo:hi]
    # an adjective directly before the driver wins: "lower crude", "softer crude", "higher yields"
    before = text[max(lo, span[0] - 12):span[0]]
    for rx, label in ((_UP, "up"), (_DOWN, "down")):
        if re.search(rx.pattern + r"\w*\s*$", before, re.I):
            return label
    mid = (span[0] + span[1]) / 2 - lo
    best, best_d = "unclear", 10**9
    for rx, label in ((_UP, "up"), (_DOWN, "down")):
        for w in rx.finditer(clause):
            d = abs((w.start() + w.end()) / 2 - mid)
            if d < best_d:
                best, best_d = label, d
    return best


def _tone(text: str) -> int:
    up, down = bool(_PRICE_UP.search(text)), bool(_PRICE_DOWN.search(text))
    if up != down:  # the reported share-price move wins over other keywords
        return 1 if up else -1
    pos, neg = len(_POS.findall(text)), len(_NEG.findall(text))
    return (pos > neg) - (neg > pos)


def analyze(title: str, summary: str = "", kind: str = "market") -> dict:
    text = f"{title}. {summary or ''}"
    title_l = title or ""
    events, sector_fx = [], {}

    suppressed: set[str] = set()
    for rule, pats in _compiled_rules():
        if rule["id"] in suppressed:
            continue
        m = None
        for p in pats:
            m = p.search(text)
            if m:
                break
        if not m:
            continue
        suppressed.update(rule.get("suppresses", []))
        in_title = any(p.search(title_l) for p in pats)
        direction = _direction(text, m.span()) if rule["directional"] else "n/a"
        sign = 1
        if rule["directional"]:
            if direction == "down":
                sign = -1
            if rule.get("inverted") and direction != "unclear":
                sign = -sign
        why = rule["why"]
        if rule["directional"] and sign == -1:  # rule text describes the "up" case; this story is the opposite
            why = "This story is the opposite move, so the usual effects reverse. Usual case: " + why
        events.append({
            "id": rule["id"], "name": rule["name"], "category": rule["category"],
            "direction": direction, "why": why, "severity": rule["severity"],
            "in_title": in_title,
        })
        impacts = rule["impacts"]
        if rule.get("targeted"):
            hit = [sec for sec, rx in _SECTOR_KW.items() if rx.search(text)]
            if hit:  # headline names specific sectors -> aim the effect at them
                impacts = {sec: rule["targeted"] for sec in hit}
                if "Broad Market" in rule["impacts"]:
                    impacts["Broad Market"] = rule["impacts"]["Broad Market"]
        for sector, w in impacts.items():
            eff = w * sign
            uncertain = rule["directional"] and direction == "unclear"
            prev = sector_fx.get(sector)
            reason = f"{rule['name']}" + (f" ({direction})" if rule["directional"] else "")
            if prev is None or abs(eff) > abs(prev["effect"]):
                sector_fx[sector] = {"sector": sector, "effect": eff, "uncertain": uncertain, "reason": reason}

    # company mentions
    stocks = []
    tone, strength = _tone(text), 2
    for sym, sector, pats in _compiled_companies():
        if any(p.search(text) for p in pats):
            sfx = sector_fx.get(sector, {}).get("effect", 0)
            effect = tone * strength if tone else (1 if sfx > 0 else -1 if sfx < 0 else 0)
            reason = ("Positive news flow" if effect > 0 else "Negative news flow" if effect < 0
                      else "In the news - direction unclear")
            stocks.append({"symbol": sym, "sector": sector, "effect": effect, "direct": True, "reason": reason})
            sector_fx.setdefault(sector, {"sector": sector, "effect": 0, "uncertain": True,
                                          "reason": f"{sym} in the news"})

    # ---------- score
    india_relevant = kind == "market" or bool(INDIA_HINT.search(text)) or bool(stocks)
    score = 0.0
    if events:
        top = max(events, key=lambda e: e["severity"])
        score = top["severity"] * (1.0 if top["in_title"] else 0.6)
        score += 0.5 * (len(events) - 1)
    if stocks:
        score = max(score, 3.5) + min(len(stocks), 3) * 0.5
    if events and not india_relevant:
        score *= 0.75  # world news with no explicit India angle
    if not events and not stocks:
        score = 0.5 if india_relevant else 0.0
    if NOISE.search(title_l):
        score *= 0.45
    score = round(min(score, 10.0), 1)

    broad = [v["effect"] for v in sector_fx.values() if v["sector"] == "Broad Market"]
    if broad and broad[0]:
        net = broad[0]
    else:  # no explicit index view: net of sector + stock effects
        net = sum(v["effect"] for v in sector_fx.values()) + sum(s["effect"] for s in stocks)
    sentiment = "bullish" if net > 0 else "bearish" if net < 0 else "mixed"
    macro = any(e["category"] != "Corporate" for e in events)
    if not macro and sentiment == "mixed" and tone:  # e.g. unlisted company "shares crash 12%"
        sentiment = "bullish" if tone > 0 else "bearish"

    sectors = sorted(sector_fx.values(), key=lambda s: -abs(s["effect"]))
    return {
        "score": score,
        "sentiment": sentiment,
        "category": events[0]["category"] if events else ("Corporate" if stocks else "General"),
        "events": events,
        "sectors": sectors,
        "stocks": stocks,
        "expected_impact": _explain(events, sectors, stocks),
        "horizon": "intraday-to-days" if any(e["category"] in ("Corporate",) for e in events) else "days-to-weeks",
    }


def _explain(events, sectors, stocks) -> str:
    if not events and not stocks:
        return "No clear market-moving driver detected."
    parts = []
    for e in events[:2]:
        d = f" ({e['direction']})" if e["direction"] not in ("n/a", "unclear") else ""
        parts.append(f"{e['name']}{d}: {e['why']}")
    gains = [s["sector"] for s in sectors if s["effect"] > 0 and s["sector"] != "Broad Market"][:4]
    hits = [s["sector"] for s in sectors if s["effect"] < 0 and s["sector"] != "Broad Market"][:4]
    if gains:
        parts.append("Likely beneficiaries: " + ", ".join(gains) + ".")
    if hits:
        parts.append("Likely under pressure: " + ", ".join(hits) + ".")
    if stocks:
        parts.append("Stocks in focus: " + ", ".join(s["symbol"] for s in stocks[:6]) + ".")
    return " ".join(parts)


def sector_symbols(sector: str) -> list[str]:
    return SECTORS.get(sector, (None, []))[1]
