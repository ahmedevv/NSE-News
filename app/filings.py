"""Corporate filings from NSE and BSE: the first place company news appears, usually before any media outlet.

Only filings by tracked stocks (rules.COMPANIES) are kept. Each one gets a plain label
(Results, Order / contract, M&A ...) and an importance:
  high    - can move the stock today
  normal  - worth a glance
  routine - compliance paperwork (hidden by default on the dashboard)
Both exchanges block some server IPs. Each source's status is shown on the System page.
"""
import logging
import re
from datetime import datetime, timedelta, timezone

import requests

from . import db
from .config import USER_AGENT
from .universe import TRACKED, symbols_in

log = logging.getLogger("filings")
IST = timezone(timedelta(hours=5, minutes=30))

# (label, importance, pattern) - first match wins, so specific labels come first
LABELS = [
    ("Routine", "routine", r"newspaper (publication|advertisement)|trading window|reg(ulation)?\.? ?74 ?\(5\)|certificate under|"
                           r"loss of share certificate|duplicate share|transfer of shares|esop|esos|allotment of (equity )?shares? under|"
                           r"compliance certificate|statement of investor complaints|record date for interest|closure of trading|"
                           r"\bsast\b|insider trading|regulation 7|reg(ulation)? 29|regulation 31|change in address|"
                           r"\bkyc\b|postal ballot|e-voting|scrutini[sz]er|voting results|book closure|intimation of (agm|egm)"),
    ("Investor meet", "routine", r"analysts?/institutional investor|investor meet|analyst meet|conference call|earnings call|"
                                 r"transcript|audio recording|investor presentation|schedule of analyst"),
    ("Results date", "normal", r"board meeting.{0,60}(to consider|intimation).{0,80}result|prior intimation.{0,60}result"),
    ("Results", "high", r"financial results|outcome of board meeting.{0,80}result|\bresults? for the (quarter|period|half|year)|"
                        r"unaudited|audited (standalone|consolidated)"),
    ("Regulatory / legal", "high", r"penalty|show cause|tax demand|demand order|\bgst\b.{0,40}(order|demand|notice)|income tax|"
                                   r"litigation|court|tribunal|\bnclt\b|\bsat\b order|\bsebi\b.{0,40}(order|notice)|"
                                   r"search (and|&) seizure|\braid\b|investigation|enforcement directorate|\bcbi\b|"
                                   r"usfda|warning letter|import alert|form 483|establishment inspection|observations"),
    ("Order / contract", "high", r"\b(order|orders|contract|letter of award|\bloa\b|letter of intent|work order|purchase order)\b|"
                                 r"(bags|wins|secures|receipt of|awarded)\b"),
    ("M&A", "high", r"acqui|merger|amalgamation|demerger|scheme of arrangement|takeover|open offer|"
                    r"joint venture|\bjv\b|divest|stake (sale|purchase)|slump sale|disinvest"),
    ("Capital raise / buyback", "high", r"buy-?back|bonus|stock split|sub-division|\bqip\b|qualified institutions|rights issue|"
                                        r"preferential (issue|allotment)|fund ?rais|raising of funds|ipo of (subsidiary|unit)"),
    ("Management change", "high", r"resign|cessation|(appointment|re-appointment) of (the )?(managing director|md|ceo|cfo|chief)"),
    ("Business update", "high", r"business update|operational update|sales (figures|volume|update)|production (update|volume|numbers)|"
                                r"monthly (sales|business|update)|provisional (figures|numbers)|quarterly update|deposits?.{0,20}advances"),
    ("Rating", "normal", r"credit rating|rating (action|agency)|\b(crisil|icra|care ratings|india ratings|moody|fitch|s&p)\b"),
    ("Dividend", "normal", r"dividend"),
    ("Pledge", "normal", r"pledge|encumbrance"),
    ("Appointment", "routine", r"appointment|re-appointment|change in (director|auditor|key managerial|kmp)"),
    ("Press release", "normal", r"press release|media release"),
    ("Launch / capacity", "normal", r"launch|commission|capacity|new plant|expansion|commercial production|capex"),
]
_LABELS = [(l, imp, re.compile(p, re.I)) for l, imp, p in LABELS]


# A press release or "other" filing that carries one of these is a catalyst, not paperwork
MATERIAL = re.compile(r"tariff|price (hike|revision|increase|cut)|\border|contract|acqui|stake|approval|usfda|"
                      r"record (high|sales|profit)|guidance|agreement|partnership|commission(ed|ing)|capacity|"
                      r"\bdeal\b|launch|ipo|listing|subsidiary.{0,40}(incorporat|sale)", re.I)


def classify(*texts: str) -> tuple[str, str]:
    text = " | ".join(t for t in texts if t)
    for label, importance, rx in _LABELS:
        if rx.search(text):
            if importance == "normal" and label in ("Press release", "Launch / capacity") and MATERIAL.search(text):
                importance = "high"
            return label, importance
    return "Other", "high" if MATERIAL.search(text) else "normal"


def _utc_from_ist(s: str, fmts: tuple[str, ...]) -> str | None:
    s = (s or "").strip()
    for fmt in fmts:
        try:
            return datetime.strptime(s[:26], fmt).replace(tzinfo=IST).astimezone(timezone.utc).isoformat()
        except ValueError:
            continue
    return None


# ----------------------------------------------------------------------------- BSE
_BSE_HEADERS = {"User-Agent": USER_AGENT, "Referer": "https://www.bseindia.com/", "Origin": "https://www.bseindia.com",
                "Accept": "application/json, text/plain, */*"}
_BSE_URL = ("https://api.bseindia.com/BseIndiaAPI/api/AnnSubCategoryGetData/w?pageno={page}&strCat=-1"
            "&strPrevDate={d}&strScrip=&strSearch=P&strToDate={d}&strType=C&subcategory=-1")


def _bse_symbol(row: dict) -> str | None:
    # NSURL looks like https://www.bseindia.com/stock-share-price/reliance-industries-ltd/reliance/500325/
    parts = [p for p in (row.get("NSURL") or "").split("/") if p]
    if len(parts) >= 3:
        cand = parts[-2].upper()
        if cand in TRACKED:
            return cand
    hits = symbols_in(row.get("SLONGNAME") or "")
    return hits[0] if len(hits) == 1 else None


def fetch_bse(max_pages: int = 8) -> list[dict]:
    day = datetime.now(IST).strftime("%Y%m%d")
    out, s = [], requests.Session()
    known = db.known_filing_ids("BSE")
    for page in range(1, max_pages + 1):
        r = s.get(_BSE_URL.format(page=page, d=day), headers=_BSE_HEADERS, timeout=20)
        r.raise_for_status()
        rows = (r.json() or {}).get("Table") or []
        if not rows:
            break
        stop = False
        for row in rows:
            fid = f"BSE:{row.get('NEWSID')}"
            if fid in known:
                stop = True  # everything after this was fetched on an earlier poll
                continue
            sym = _bse_symbol(row)
            if not sym:
                continue
            ts = _utc_from_ist(row.get("DissemDT") or row.get("NEWS_DT") or "",
                               ("%Y-%m-%dT%H:%M:%S.%f", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S"))
            head = (row.get("NEWSSUB") or "").strip()
            detail = (row.get("HEADLINE") or "").strip()
            label, imp = classify(row.get("CATEGORYNAME") or "", row.get("SUBCATNAME") or "", head, detail)
            att = (row.get("ATTACHMENTNAME") or "").strip()
            out.append({
                "id": fid, "ts": ts or datetime.now(timezone.utc).isoformat(), "symbol": sym,
                "company": (row.get("SLONGNAME") or "").strip(), "label": label, "importance": imp,
                "headline": _tidy(head, row.get("SLONGNAME")), "detail": detail[:1500],
                "category": " / ".join(x for x in (row.get("CATEGORYNAME"), row.get("SUBCATNAME")) if x and x != "-"),
                "link": f"https://www.bseindia.com/xml-data/corpfiling/AttachLive/{att}" if att else "",
                "source": "BSE",
            })
        if stop:
            break
    return out


def _tidy(head: str, company: str | None) -> str:
    # BSE subjects often repeat the company name and scrip code: "Reliance Industries Ltd - 500325 - Announcement ..."
    h = re.sub(r"^.{0,80}?-\s*\d{6}\s*-\s*", "", head or "").strip()
    return h or (head or "").strip()


# ----------------------------------------------------------------------------- NSE
_nse = {"session": None, "warm": 0.0}


def _nse_session() -> requests.Session:
    import time
    if _nse["session"] is None or time.time() - _nse["warm"] > 15 * 60:
        s = requests.Session()
        s.headers.update({"User-Agent": USER_AGENT, "Accept": "application/json, text/plain, */*",
                          "Accept-Language": "en-US,en;q=0.9",
                          "Referer": "https://www.nseindia.com/companies-listing/corporate-filings-announcements"})
        s.get("https://www.nseindia.com/", timeout=20)  # sets the cookies the API needs
        _nse["session"], _nse["warm"] = s, time.time()
    return _nse["session"]


def fetch_nse() -> list[dict]:
    s = _nse_session()
    r = s.get("https://www.nseindia.com/api/corporate-announcements?index=equities", timeout=20)
    if r.status_code in (401, 403):
        _nse["session"] = None  # cookies expired: warm up again next time
    r.raise_for_status()
    rows = r.json()
    if isinstance(rows, dict):
        rows = rows.get("data") or []
    known = db.known_filing_ids("NSE")
    out = []
    for row in rows:
        sym = (row.get("symbol") or "").strip().upper()
        if sym not in TRACKED:
            continue
        fid = f"NSE:{row.get('seq_id') or row.get('an_dt')}:{sym}"
        if fid in known:
            continue
        ts = _utc_from_ist(row.get("sort_date") or row.get("an_dt") or "",
                           ("%Y-%m-%d %H:%M:%S", "%d-%b-%Y %H:%M:%S"))
        desc = (row.get("desc") or "").strip()
        detail = (row.get("attchmntText") or "").strip()
        label, imp = classify(desc, detail)
        out.append({
            "id": fid, "ts": ts or datetime.now(timezone.utc).isoformat(), "symbol": sym,
            "company": (row.get("sm_name") or "").strip(), "label": label, "importance": imp,
            "headline": desc, "detail": detail[:1500], "category": desc,
            "link": (row.get("attchmntFile") or "").strip(), "source": "NSE",
        })
    return out


# ----------------------------------------------------------------------------- refresh
def refresh() -> list[dict]:
    """Fetch new filings from both exchanges, save them and return the new ones."""
    new = []
    for name, fn in (("NSE filings", fetch_nse), ("BSE filings", fetch_bse)):
        try:
            rows = fn()
            db.save_filings(rows)
            db.set_source_status(name, True, len(rows))
            new.extend(rows)
        except Exception as ex:
            log.warning("%s failed: %s", name, ex)
            db.set_source_status(name, False, 0, _reason(ex))
    return new


def _reason(ex: Exception) -> str:
    code = getattr(getattr(ex, "response", None), "status_code", None)
    if code in (401, 403):
        return f"HTTP {code}: the exchange is blocking this server's IP address"
    return str(ex)
