# NSE Wire

An intraday desk for Indian equity and index options traders. It shows, in one live feed, what can move a stock or the index **today**:

- **Exchange filings** (NSE and BSE corporate announcements) for about 120 of the most traded stocks across sectors. Companies file here first, often before any news site. Each filing gets a plain label (Results, Order / contract, M&A, Capital raise / buyback, Management change, Regulatory / legal, Business update ...). Routine paperwork (trading window, newspaper ads, investor meets) is hidden unless you tick *Routine filings*.
- **Headlines**, but only two kinds: news naming a tracked stock, and market-wide triggers (RBI, Fed, crude, war or escalation in the Gulf, rupee, FII flows, tariffs involving India, SEBI rules). Market wraps ("Sensex ends 300 pts lower"), listicles ("Stocks to watch"), tips, features and opinion pieces are dropped. When many outlets carry the same driver, it shows once with "+N similar stories".
- **Today**: scheduled releases with IST times and a countdown (US CPI, jobs, Fed, ECB, China data ...), the weekly / monthly expiry, results due today or tomorrow, and the F&O ban list.
- **Global cues** for the pre-market read: S&P 500 and Nasdaq futures, Nikkei, Hang Seng, US 10-year yield, dollar index, gold.

The default window is **Since last close** (15:30 IST of the previous session), so at 08:45 the desk is your overnight brief.

Click any row for the detail: the filing text and PDF link, or for a market-wide headline, why it matters and which sectors and stocks are exposed, with their move today.

**Keyboard:** `1` Desk, `2` Notifications and watchlist, `3` System, `/` search, `j` / `k` step through the feed, `Esc` closes the detail or the alert banner.

## Alerts

| Alert | When |
|---|---|
| Critical | A market-wide shock in a headline: RBI surprise, war escalation, crude spike |
| Market-wide | Other big macro or geopolitical headlines: Fed, rupee, tariffs, FII flows |
| Filing | A tracked stock files results, an order, M&A, a buyback, a management exit, legal action or a material press release |
| Stock news | A headline about a tracked stock with a clear catalyst |
| Scheduled | A high-impact data release or expiry is 15 minutes away |
| Volatility | India VIX up 8% or more on the day |
| Watchlist | Anything new on a watchlist stock |

Only items from the last hour alert, and the same driver or stock alerts at most once an hour. Alerts appear in the notification centre (bell, top right) with pop-ups, sound and optional desktop notifications. Choose pop-up, sound and desktop for each level on the Notifications page. Desktop notifications need `https` or `localhost`.

## How often things update

| Source | Market days 07:30-20:00 IST | Otherwise |
|---|---|---|
| NSE and BSE filings | every 60 s | every 10 min |
| Headlines | every 3 min | every 10 min |
| Prices (Yahoo Finance, may be 15 min delayed) | every 3 min | every 30 min |
| Calendar, results dates, F&O ban list | every 3 h | every 3 h |

The browser checks for new items every 15-30 seconds.

## Install on a Windows VPS

1. Install **Python 3.11 or newer** from python.org. Tick **"Add python.exe to PATH"** and **"Install for all users"**.
2. Put this folder somewhere, e.g. `C:\nse-news`.
3. Double-click **`setup.bat`**. It creates `.venv`, installs dependencies and creates `settings.bat`.
4. Edit **`settings.bat`**: `HOST`, password, expiry weekday.
5. Test with **`start-server.bat`** and open http://localhost:8000 in the VPS browser. Ctrl+C stops it.
6. To run permanently, right-click **`install-autostart.bat` → Run as administrator**.

Logs are in `data\server.log`. After changing `settings.bat`, run `install-autostart.bat` again or restart the VPS.

### Updating from GitHub

```
cd "C:\path\to\nse-news"
git pull
```

Then run `uninstall-autostart.bat` and `install-autostart.bat` as administrator (or restart the VPS), and press Ctrl+F5 in the browser.

## Indian events and holidays

The economic calendar covers the US, Euro area, China, Japan and UK. Add Indian events to `data\events_manual.csv` (created on first run), one per line:

```
2026-12-04,10:00,RBI policy decision,high
2026-12-12,16:00,India CPI inflation,high
```

Exchange holidays are not known, so in a holiday week check the expiry date against the NSE circular. `EXPIRY_WEEKDAY` in `settings.bat` sets the weekly expiry day.

## How it works

| File | Role |
|---|---|
| `app/filings.py` | NSE and BSE announcements, labels and importance |
| `app/sources.py` | RSS headlines, fetched in parallel and de-duplicated |
| `app/rules.py` | Tracked stocks and their name variants, and the market-wide trigger rules |
| `app/analyzer.py` | Reads a headline: which triggers, which direction, which stocks |
| `app/feed.py` | Decides what is shown: drops wraps and features, gates world news, groups repeats |
| `app/calendar_today.py` | Economic calendar, expiries, manual events, F&O ban list |
| `app/earnings.py` | Results dates from NSE / BSE, plus `data/earnings_manual.csv` |
| `app/market.py` | Prices from Yahoo Finance |
| `app/alerts.py` | Alert rules and noise control |

The System page shows whether each source is working, and lets you test any headline to see whether the desk would show it.

## Known limitations

- **NSE and BSE block some server IP addresses.** If both show as failing on the System page, filings are missing and the desk shows only headlines. A VPS in India (or one whose IP the exchanges accept) fixes this.
- Headlines from RSS feeds arrive minutes after the event. Filings are the fastest free source; a paid wire (Bloomberg, Reuters) is faster still.
- Yahoo Finance prices are unofficial and can lag by up to 15 minutes.
- The rules read headlines only. They cannot tell whether news was already expected or priced in. This is not investment advice.
