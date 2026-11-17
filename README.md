# NSE News Impact

A locally hosted dashboard. It scrapes Indian market news and world/geopolitical news, works out how each story is likely to move NSE sectors and stocks, and shows:

- **Overview**: a news-mood gauge, a sector heatmap, the most volatile assets, top market-moving stories, and this week's earnings.
- **Volatility watchlist**: stocks ranked by news intensity × impact × recency. It also adds weight for upcoming results and for realised volatility that is already rising. Each stock gets a bias (bullish / bearish / two-way) and the headlines behind it.
- **News feed**: every story with an impact score from 0 to 10, its direction, horizon, affected sectors and stocks (▲/▼), and a plain-English *expected impact*.
- **Sectors**: net news pressure and the main drivers for each NSE sector, with the sector index's 1-day move.
- **Earnings**: upcoming results from the NSE event calendar, BSE forthcoming results, or your own CSV, plus results currently in the news.
- **Sources**: a health check for every feed or API, so you can see when one is blocked.

## Install on a Windows VPS

1. Install **Python 3.11 or newer** from python.org. In the installer, tick **"Add python.exe to PATH"** and choose **"Install for all users"**.
2. Extract this folder to a path without spaces, e.g. `C:\nse-news`.
3. Double-click **`setup.bat`**. It creates `.venv`, installs dependencies including FinBERT, and creates `settings.bat`. On a small VPS with 2 GB of RAM or less, run `setup.bat nofinbert` from a command prompt instead.
4. Edit **`settings.bat`**: choose `HOST`, set a password, and turn FinBERT on or off.
5. Test with **`start-server.bat`**. Open http://localhost:8000 in the VPS browser. Press Ctrl+C to stop.
6. To run permanently, right-click **`install-autostart.bat` → Run as administrator**. This creates a scheduled task that starts the server at boot without anyone logged in, restarts it if it crashes, and opens the firewall port if `HOST=0.0.0.0`.

Logs are in `data\server.log`. To stop and remove auto-start, run `uninstall-autostart.bat` as administrator. After changing `settings.bat`, restart the VPS or run `install-autostart.bat` again.

The app refreshes every 30 minutes (`REFRESH_MINUTES` in `settings.bat`). You can also click **Refresh now**.

## FinBERT sentiment model (optional, runs locally)

[`ProsusAI/finbert`](https://huggingface.co/ProsusAI/finbert) is a Hugging Face model trained on financial news. It runs on the VPS's CPU: no API key, no cost, and nothing is sent anywhere. The model (about 440 MB) downloads into `data\hf-cache` on the first refresh. It then scores a few hundred headlines in seconds and uses about 1 GB of RAM.

It has **one specific job: company tone.** For example, "Zomato shares sink after Q2 loss widens" means negative for ETERNAL. A keyword list misses many such phrasings; FinBERT reads them well.

It does **not** set macro direction. FinBERT calls "crude oil prices surge" *positive* because prices went up, but for India that is negative (higher import bill, squeezed OMC margins). Macro and geopolitical news therefore keeps the India-specific logic in `rules.py`.

When FinBERT is confident (≥ 0.70), it decides company tone and the sentiment of company-only stories. Stories it has read show a **FinBERT · label score** badge. Set `USE_FINBERT=0` in `settings.bat` to turn it off.

## How it works

| File | Role |
|---|---|
| `app/sources.py` | Fetches RSS feeds in parallel and removes duplicate stories across feeds |
| `app/rules.py` | **The knowledge base**: sectors, about 100 NSE company aliases, and about 35 event→sector impact rules (crude, RBI, Fed, rupee, war, tariffs, sanctions, monsoon, SEBI and more). Edit it freely; stored articles are re-scored on the next start. |
| `app/analyzer.py` | Rule engine: finds events, reads the direction of each driver (e.g. "crude **slips**" vs "crude **jumps**") within its own clause, aims tariff effects at the sector a headline names, and gauges tone for each company |
| `app/sentiment.py` | Optional FinBERT headline sentiment, used for company tone only |
| `app/earnings.py` | NSE / BSE result calendars, plus `data/earnings_manual.csv` |
| `app/market.py` | Yahoo Finance prices: 1D/5D change, 20-day realised volatility, volatility regime, volume spike |
| `app/aggregate.py` | Builds the dashboard views. Weights fade with a 12-hour half-life, and repeat coverage of the same driver counts for progressively less. |

Try the rule engine on any headline at `/api/analyze?text=...` or in the box on the Overview tab.

## Known limitations

- NSE and BSE often block automated requests with a 403. If earnings come up empty, add rows to `data/earnings_manual.csv` (`symbol,company,date,purpose`).
- Yahoo Finance is unofficial and occasionally returns nothing. Price columns then show "–".
- The rule engine reads headlines only. It cannot tell whether news was already expected or priced in. This is not investment advice.
