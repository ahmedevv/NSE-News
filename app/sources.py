"""News scraping from RSS feeds. Every source is optional; failures are recorded, never fatal."""
import hashlib
import html
import logging
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime

import feedparser
import requests

from . import db
from .config import FEEDS, MAX_AGE_HOURS, USER_AGENT

log = logging.getLogger("sources")
_TAG = re.compile(r"<[^>]+>")


def _clean(s: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(_TAG.sub(" ", s or ""))).strip()


def _norm_title(t: str) -> str:
    # Google News appends " - Publisher"; strip it so the same story dedupes across feeds
    t = re.sub(r"\s+-\s+[^-]{2,40}$", "", t)
    return re.sub(r"[^a-z0-9 ]", "", t.lower()).strip()


def article_id(title: str) -> str:
    return hashlib.sha1(_norm_title(title).encode()).hexdigest()[:16]


def _published(entry) -> datetime:
    for key in ("published_parsed", "updated_parsed"):
        tp = entry.get(key)
        if tp:
            return datetime(*tp[:6], tzinfo=timezone.utc)
    for key in ("published", "updated"):
        if entry.get(key):
            try:
                return parsedate_to_datetime(entry[key]).astimezone(timezone.utc)
            except Exception:
                pass
    return datetime.now(timezone.utc)


def fetch_feed(name: str, url: str, kind: str) -> list[dict]:
    try:
        r = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=20)
        r.raise_for_status()
        parsed = feedparser.parse(r.content)
        cutoff = datetime.now(timezone.utc) - timedelta(hours=MAX_AGE_HOURS)
        items = []
        for e in parsed.entries:
            title = _clean(e.get("title", ""))
            if not title:
                continue
            src = name
            if "news.google.com" in url:
                m = re.match(r"^(.*?)\s*-\s+([^-]{2,60})$", title) or re.match(r"^(.*?\S)-\s*([A-Za-z][\w .]{1,40}\.(?:com|in|net|org))$", title)
                if m:
                    title, src = m.group(1).strip(), f"{m.group(2).strip()} (Google News)"
            pub = _published(e)
            if pub < cutoff:
                continue
            items.append({
                "id": article_id(title), "title": title, "link": e.get("link", ""),
                "summary": "" if "news.google.com" in url else _clean(e.get("summary", ""))[:600],
                "source": src, "kind": kind,
                "published": pub.isoformat(),
            })
        db.set_source_status(name, True, len(items))
        return items
    except Exception as ex:  # network errors, 403s, bad XML ...
        log.warning("feed %s failed: %s", name, ex)
        db.set_source_status(name, False, 0, str(ex))
        return []


def fetch_all() -> list[dict]:
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = pool.map(lambda f: fetch_feed(*f), FEEDS)
    seen, out = set(), []
    for items in results:
        for it in items:
            if it["id"] not in seen:
                seen.add(it["id"])
                out.append(it)
    return out
