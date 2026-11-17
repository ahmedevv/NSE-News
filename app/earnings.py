"""Upcoming earnings / board meetings.

Sources, in order (all optional):
  1. NSE event calendar API (needs cookie warm-up; NSE sometimes blocks non-browser clients)
  2. BSE forthcoming results API
  3. data/earnings_manual.csv  (symbol,company,date YYYY-MM-DD,purpose)  - your own fallback
"""
import csv
import logging
from datetime import datetime

import requests

from . import db
from .config import DATA_DIR, USER_AGENT

log = logging.getLogger("earnings")
MANUAL_CSV = DATA_DIR / "earnings_manual.csv"


def _date(s: str) -> str | None:
    for fmt in ("%d-%b-%Y", "%d %b %Y", "%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y", "%Y-%m-%dT%H:%M:%S"):
        try:
            return datetime.strptime(s.strip()[:19], fmt).date().isoformat()
        except Exception:
            continue
    return None


def fetch_nse() -> list[dict]:
    s = requests.Session()
    s.headers.update({"User-Agent": USER_AGENT, "Accept": "application/json, text/plain, */*",
                      "Accept-Language": "en-US,en;q=0.9", "Referer": "https://www.nseindia.com/companies-listing/corporate-filings-event-calendar"})
    s.get("https://www.nseindia.com/", timeout=20)  # sets the cookies the API requires
    r = s.get("https://www.nseindia.com/api/event-calendar", timeout=20)
    r.raise_for_status()
    out = []
    for e in r.json():
        purpose = f"{e.get('purpose', '')} {e.get('bm_desc', '')}"
        if "result" not in purpose.lower():
            continue
        d = _date(e.get("date", ""))
        if d:
            out.append({"symbol": e.get("symbol", ""), "company": e.get("company", ""), "date": d,
                        "purpose": "Financial Results", "details": (e.get("bm_desc") or "")[:300]})
    return out


def fetch_bse() -> list[dict]:
    r = requests.get("https://api.bseindia.com/BseIndiaAPI/api/Corpforthresults/w",
                     headers={"User-Agent": USER_AGENT, "Referer": "https://www.bseindia.com/",
                              "Origin": "https://www.bseindia.com", "Accept": "application/json"}, timeout=20)
    r.raise_for_status()
    out = []
    for e in r.json():
        d = _date(e.get("meeting_date", ""))
        sym = (e.get("short_name") or "").strip().upper()
        if d and sym:
            out.append({"symbol": sym, "company": e.get("Long_Name", sym), "date": d,
                        "purpose": "Financial Results"})
    return out


def load_manual() -> list[dict]:
    if not MANUAL_CSV.exists():
        MANUAL_CSV.write_text("symbol,company,date,purpose\n", encoding="utf-8")
        return []
    with MANUAL_CSV.open(encoding="utf-8") as f:
        return [
            {"symbol": r["symbol"].strip().upper(), "company": r.get("company", ""), "date": _date(r["date"]),
             "purpose": r.get("purpose") or "Financial Results"}
            for r in csv.DictReader(f) if r.get("symbol") and _date(r.get("date", ""))
        ]


def refresh():
    for name, fn in (("NSE event calendar", fetch_nse), ("BSE forthcoming results", fetch_bse),
                     ("Manual earnings CSV", load_manual)):
        try:
            rows = fn()
            db.replace_earnings(rows, name)
            db.set_source_status(name, True, len(rows))
        except Exception as ex:
            log.warning("%s failed: %s", name, ex)
            db.set_source_status(name, False, 0, str(ex))
