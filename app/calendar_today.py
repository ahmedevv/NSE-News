"""What is scheduled: data releases (with IST times), option expiries, results of tracked stocks, F&O ban list.

Sources (all optional):
  * Forex Factory weekly calendar (US data, Fed, ECB, China, Japan...) - high and medium impact
  * Option expiry computed from EXPIRY_WEEKDAY (exchange holidays are not known: check the NSE circular)
  * data/events_manual.csv for Indian events (RBI policy, CPI, GDP ...): date,time_ist,title,impact
  * NSE F&O ban list (nsearchives.nseindia.com)
"""
import csv
import logging
from datetime import date, datetime, time, timedelta, timezone

import requests

from . import db
from .config import DATA_DIR, EXPIRY_WEEKDAY, USER_AGENT

log = logging.getLogger("calendar")
IST = timezone(timedelta(hours=5, minutes=30))
MANUAL_CSV = DATA_DIR / "events_manual.csv"
MANUAL_TEMPLATE = """date,time_ist,title,impact
# One event per line. date = YYYY-MM-DD, time_ist = HH:MM (24h, India time), impact = high or medium.
# Lines starting with # are ignored. Examples (delete or edit them):
# 2026-12-04,10:00,RBI policy decision,high
# 2026-12-12,16:00,India CPI inflation,high
"""

FF_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json"
COUNTRY = {"USD": "US", "EUR": "Euro area", "CNY": "China", "JPY": "Japan", "GBP": "UK"}
WEEKDAYS = ["MON", "TUE", "WED", "THU", "FRI"]


def fetch_ff() -> list[dict]:
    r = requests.get(FF_URL, headers={"User-Agent": USER_AGENT}, timeout=20)
    r.raise_for_status()
    out = []
    for e in r.json():
        cur, imp = e.get("country"), (e.get("impact") or "").lower()
        if cur not in COUNTRY:
            continue
        if not (imp == "high" or (cur == "USD" and imp == "medium")):
            continue
        try:
            ts = datetime.fromisoformat(e["date"]).astimezone(timezone.utc)
        except Exception:
            continue
        title = e.get("title", "").strip()
        out.append({"id": f"ff:{cur}:{title}:{ts.isoformat()}", "ts": ts.isoformat(), "title": f"{COUNTRY[cur]}: {title}",
                    "impact": imp, "forecast": e.get("forecast") or "", "previous": e.get("previous") or "",
                    "kind": "data", "source": "Forex Factory"})
    return out


def load_manual() -> list[dict]:
    if not MANUAL_CSV.exists():
        MANUAL_CSV.write_text(MANUAL_TEMPLATE, encoding="utf-8")
        return []
    out = []
    with MANUAL_CSV.open(encoding="utf-8") as f:
        lines = [ln for ln in f if ln.strip() and not ln.lstrip().startswith("#")]
    for r in csv.DictReader(lines):
        try:
            d = date.fromisoformat((r.get("date") or "").strip())
            hh, mm = ((r.get("time_ist") or "09:15").strip() or "09:15").split(":")
            ts = datetime.combine(d, time(int(hh), int(mm)), IST).astimezone(timezone.utc)
        except Exception:
            continue
        title = (r.get("title") or "").strip()
        if title:
            out.append({"id": f"manual:{ts.isoformat()}:{title}", "ts": ts.isoformat(), "title": title,
                        "impact": (r.get("impact") or "high").strip().lower(), "forecast": "", "previous": "",
                        "kind": "india", "source": "Manual"})
    return out


def expiries(days: int = 10) -> list[dict]:
    """Weekly Nifty expiry on EXPIRY_WEEKDAY; the last one in the month is also the monthly Nifty / Bank Nifty expiry."""
    wd = WEEKDAYS.index(EXPIRY_WEEKDAY) if EXPIRY_WEEKDAY in WEEKDAYS else 1
    today = datetime.now(IST).date()
    out = []
    for i in range(days):
        d = today + timedelta(days=i)
        if d.weekday() != wd:
            continue
        monthly = (d + timedelta(days=7)).month != d.month
        title = "Monthly expiry: Nifty, Bank Nifty and stock F&O" if monthly else "Weekly expiry: Nifty"
        ts = datetime.combine(d, time(15, 30), IST).astimezone(timezone.utc)
        out.append({"id": f"expiry:{d}", "ts": ts.isoformat(), "title": title, "impact": "high",
                    "forecast": "", "previous": "", "kind": "expiry", "source": "Computed"})
    return out


def fetch_ban_list() -> list[str]:
    r = requests.get("https://nsearchives.nseindia.com/content/fo/fo_secban.csv",
                     headers={"User-Agent": USER_AGENT, "Referer": "https://www.nseindia.com/"}, timeout=20)
    r.raise_for_status()
    syms = []
    for line in r.text.splitlines()[1:]:
        parts = [p.strip() for p in line.split(",")]
        if len(parts) >= 2 and parts[1] and parts[1].isupper():
            syms.append(parts[1])
    return syms


def refresh():
    rows: list[dict] = []
    for name, fn in (("Economic calendar (Forex Factory)", fetch_ff), ("Manual events CSV", load_manual)):
        try:
            got = fn()
            rows.extend(got)
            db.set_source_status(name, True, len(got))
        except Exception as ex:
            log.warning("%s failed: %s", name, ex)
            db.set_source_status(name, False, 0, str(ex))
    if rows:
        db.replace_events(rows)
    try:
        bans = fetch_ban_list()
        db.set_meta("fo_ban", ",".join(bans))
        db.set_meta("fo_ban_date", datetime.now(IST).date().isoformat())
        db.set_source_status("NSE F&O ban list", True, len(bans))
    except Exception as ex:
        db.set_source_status("NSE F&O ban list", False, 0, str(ex))


def upcoming(hours_back: float = 2, hours_ahead: float = 36) -> list[dict]:
    now = datetime.now(timezone.utc)
    lo, hi = (now - timedelta(hours=hours_back)).isoformat(), (now + timedelta(hours=hours_ahead)).isoformat()
    rows = [e for e in db.get_events(lo, hi)] + [e for e in expiries() if lo <= e["ts"] <= hi]
    return sorted(rows, key=lambda e: e["ts"])


def last_close_utc() -> datetime:
    """15:30 IST on the most recent weekday before now's session (the 'since last close' cut-off)."""
    n = datetime.now(IST)
    d = n.date()
    if n.time() < time(15, 30) or d.weekday() >= 5:
        d -= timedelta(days=1)
    while d.weekday() >= 5:
        d -= timedelta(days=1)
    return datetime.combine(d, time(15, 30), IST).astimezone(timezone.utc)

