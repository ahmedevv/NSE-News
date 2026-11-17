"""Central configuration. Override anything with environment variables."""
import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
DATA_DIR.mkdir(exist_ok=True)
DB_PATH = DATA_DIR / "news.db"

# How often news + prices are refreshed (minutes). Earnings calendars refresh every EARNINGS_REFRESH_HOURS.
REFRESH_MINUTES = max(2, int(os.getenv("REFRESH_MINUTES", "5")))
EARNINGS_REFRESH_HOURS = float(os.getenv("EARNINGS_REFRESH_HOURS", "6"))

# ---- alerts
ALERT_MIN_IMPACT = float(os.getenv("ALERT_MIN_IMPACT", "7"))        # impact >= this -> "high" alert
ALERT_CRITICAL_IMPACT = float(os.getenv("ALERT_CRITICAL_IMPACT", "8"))  # impact >= this -> "critical"
ALERT_MAX_AGE_MINUTES = int(os.getenv("ALERT_MAX_AGE_MINUTES", "90"))   # don't alert on old stories
ALERT_COOLDOWN_MINUTES = int(os.getenv("ALERT_COOLDOWN_MINUTES", "90"))  # same driver re-alerts at most this often
MOVE_ALERT_PCT = float(os.getenv("MOVE_ALERT_PCT", "3"))            # stock moves >= this % in a day -> alert
VIX_ALERT_PCT = float(os.getenv("VIX_ALERT_PCT", "8"))              # India VIX jumps >= this % -> alert

# Macro instruments shown in the top bar (Yahoo Finance symbols -> display name)
MACRO_TICKERS = {
    "^NSEI": "Nifty 50", "^NSEBANK": "Bank Nifty", "^INDIAVIX": "India VIX", "USDINR=X": "USD/INR",
    "BZ=F": "Brent", "GC=F": "Gold", "^GSPC": "S&P 500",
}

# Ignore articles older than this many hours
MAX_AGE_HOURS = int(os.getenv("MAX_AGE_HOURS", "48"))
# Drop articles whose rule-based impact score is below this (0-10)
MIN_IMPACT = float(os.getenv("MIN_IMPACT", "1.5"))

# FinBERT sentiment settings live in app/sentiment.py (USE_FINBERT, FINBERT_MODEL)

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/130.0 Safari/537.36"
)

# (name, url, kind)  kind = "market" (Indian market news) | "geo" (world / geopolitics)
FEEDS = [
    ("Economic Times - Markets", "https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms", "market"),
    ("Economic Times - Stocks", "https://economictimes.indiatimes.com/markets/stocks/news/rssfeeds/2146842.cms", "market"),
    ("Economic Times - Economy", "https://economictimes.indiatimes.com/news/economy/rssfeeds/1373380680.cms", "market"),
    ("Moneycontrol - Markets", "https://www.moneycontrol.com/rss/marketreports.xml", "market"),
    ("Moneycontrol - Business", "https://www.moneycontrol.com/rss/business.xml", "market"),
    ("LiveMint - Markets", "https://www.livemint.com/rss/markets", "market"),
    ("Business Standard - Markets", "https://www.business-standard.com/rss/markets-106.rss", "market"),
    ("BusinessLine - Markets", "https://www.thehindubusinessline.com/markets/feeder/default.rss", "market"),
    ("BusinessLine - Economy", "https://www.thehindubusinessline.com/economy/feeder/default.rss", "market"),
    ("Google News - NSE/Nifty", "https://news.google.com/rss/search?q=NSE+OR+Nifty+OR+Sensex+when:1d&hl=en-IN&gl=IN&ceid=IN:en", "market"),
    ("Google News - Geopolitics", "https://news.google.com/rss/search?q=(war+OR+sanctions+OR+tariffs+OR+%22crude+oil%22+OR+OPEC+OR+%22Federal+Reserve%22)+when:1d&hl=en-IN&gl=IN&ceid=IN:en", "geo"),
    ("BBC - World", "https://feeds.bbci.co.uk/news/world/rss.xml", "geo"),
    ("BBC - Business", "https://feeds.bbci.co.uk/news/business/rss.xml", "geo"),
    ("Al Jazeera", "https://www.aljazeera.com/xml/rss/all.xml", "geo"),
    ("Reuters (via Google News)", "https://news.google.com/rss/search?q=site:reuters.com+(markets+OR+geopolitics)+when:1d&hl=en-US&gl=US&ceid=US:en", "geo"),
]
