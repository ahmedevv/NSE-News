"""Central configuration. Override anything with environment variables (settings.bat)."""
import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
DATA_DIR.mkdir(exist_ok=True)
DB_PATH = DATA_DIR / "news.db"

# ---- refresh cadence
FILINGS_SECONDS = max(30, int(os.getenv("FILINGS_SECONDS", "60")))   # exchange filings, 08:00-17:00 IST on weekdays
NEWS_MINUTES = max(1, int(os.getenv("NEWS_MINUTES", "3")))           # RSS headlines
PRICE_MINUTES = max(1, int(os.getenv("PRICE_MINUTES", "3")))         # Yahoo prices
CALENDAR_HOURS = float(os.getenv("CALENDAR_HOURS", "3"))            # economic calendar, results, F&O ban list

# Weekday of the weekly Nifty expiry (MON..FRI). The monthly Nifty / Bank Nifty expiry is the last one in the month.
EXPIRY_WEEKDAY = os.getenv("EXPIRY_WEEKDAY", "TUE").strip().upper()[:3]

# ---- alerts
ALERT_MACRO_IMPACT = float(os.getenv("ALERT_MACRO_IMPACT", "7"))       # market-wide headline -> "high" alert
ALERT_CRITICAL_IMPACT = float(os.getenv("ALERT_CRITICAL_IMPACT", "8"))  # market-wide headline -> "critical"
ALERT_MAX_AGE_MINUTES = int(os.getenv("ALERT_MAX_AGE_MINUTES", "60"))   # never alert on older items
ALERT_COOLDOWN_MINUTES = int(os.getenv("ALERT_COOLDOWN_MINUTES", "60")) # same driver / stock re-alerts at most this often
EVENT_ALERT_MINUTES = int(os.getenv("EVENT_ALERT_MINUTES", "15"))       # warn this long before a high-impact data release
VIX_ALERT_PCT = float(os.getenv("VIX_ALERT_PCT", "8"))                  # India VIX up >= this % on the day

# Top bar (Yahoo Finance symbol -> name)
INDIA_TICKERS = {
    "^NSEI": "Nifty 50", "^NSEBANK": "Bank Nifty", "^INDIAVIX": "India VIX", "USDINR=X": "USD/INR", "BZ=F": "Brent",
}
# Global cues for the pre-market read
GLOBAL_TICKERS = {
    "ES=F": "S&P 500 futures", "NQ=F": "Nasdaq futures", "^N225": "Nikkei 225", "^HSI": "Hang Seng",
    "^TNX": "US 10Y yield", "DX-Y.NYB": "Dollar index", "GC=F": "Gold",
}

# Headlines older than this are ignored
MAX_AGE_HOURS = int(os.getenv("MAX_AGE_HOURS", "48"))

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/130.0 Safari/537.36"
)

# (name, url, kind)  kind = "market" (Indian market news) | "geo" (world / geopolitics)
FEEDS = [
    ("Economic Times - Markets", "https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms", "market"),
    ("Economic Times - Stocks", "https://economictimes.indiatimes.com/markets/stocks/news/rssfeeds/2146842.cms", "market"),
    ("Economic Times - Economy", "https://economictimes.indiatimes.com/news/economy/rssfeeds/1373380680.cms", "market"),
    ("Moneycontrol - Latest", "https://www.moneycontrol.com/rss/latestnews.xml", "market"),
    ("Moneycontrol - Buzzing stocks", "https://www.moneycontrol.com/rss/buzzingstocks.xml", "market"),
    ("Moneycontrol - Business", "https://www.moneycontrol.com/rss/business.xml", "market"),
    ("LiveMint - Markets", "https://www.livemint.com/rss/markets", "market"),
    ("LiveMint - Companies", "https://www.livemint.com/rss/companies", "market"),
    ("Business Standard - Markets", "https://www.business-standard.com/rss/markets-106.rss", "market"),
    ("Business Standard - Companies", "https://www.business-standard.com/rss/companies-101.rss", "market"),
    ("BusinessLine - Markets", "https://www.thehindubusinessline.com/markets/feeder/default.rss", "market"),
    ("Google News - Indian stocks", "https://news.google.com/rss/search?q=(shares+OR+stock)+(NSE+OR+Nifty+OR+Sensex)+when:1d&hl=en-IN&gl=IN&ceid=IN:en", "market"),
    # Catalyst searches: catch stock news that the outlet feeds above miss (needed when exchange filings are blocked)
    ("Google News - Orders and deals", "https://news.google.com/rss/search?q=(bags+OR+wins+OR+secures+OR+receives)+(order+OR+contract+OR+deal)+(crore+OR+NSE+OR+shares)+when:1d&hl=en-IN&gl=IN&ceid=IN:en", "market"),
    ("Google News - Results", "https://news.google.com/rss/search?q=(Q1+OR+Q2+OR+Q3+OR+Q4)+results+(profit+OR+revenue+OR+margin)+(shares+OR+NSE)+when:1d&hl=en-IN&gl=IN&ceid=IN:en", "market"),
    ("Google News - Corporate actions", "https://news.google.com/rss/search?q=(acquisition+OR+stake+OR+buyback+OR+merger+OR+%22block+deal%22+OR+resigns+OR+SEBI+OR+USFDA)+(shares+OR+NSE+OR+crore)+when:1d&hl=en-IN&gl=IN&ceid=IN:en", "market"),
    ("Google News - Geopolitics and macro", "https://news.google.com/rss/search?q=(war+OR+sanctions+OR+tariffs+OR+%22crude+oil%22+OR+OPEC+OR+%22Federal+Reserve%22+OR+RBI)+when:1d&hl=en-IN&gl=IN&ceid=IN:en", "geo"),
    ("Reuters (via Google News)", "https://news.google.com/rss/search?q=site:reuters.com+(markets+OR+india+OR+oil+OR+fed)+when:1d&hl=en-US&gl=US&ceid=US:en", "geo"),
    ("BBC - Business", "https://feeds.bbci.co.uk/news/business/rss.xml", "geo"),
]
