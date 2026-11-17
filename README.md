# NSE Wire

A live news terminal for Indian equities. It watches Indian market news and world/geopolitical news, works out how each story is likely to move NSE sectors and stocks, and alerts you when something important happens.

**The Monitor screen (key 1)** has:
- **Top bar**: Nifty 50, Bank Nifty, India VIX, USD/INR, Brent, Gold and the S&P 500, plus the NSE session clock in IST and a live indicator showing when the sources were last checked. Colours show the effect on Indian equities, so a rising VIX, dollar or Brent shows in red.
- **News wire**: every story as it arrives, newest first, with its time in IST, impact score (0 to 10), lean for Indian equities, and the sectors and stocks it touches (▲ positive, ▼ negative, two arrows means strong). A bar on the left edge marks high-impact (dark amber) and critical (bright amber) stories. Click any story for the full read: what to expect, why, the sector effects, and stocks with prices.
- **Latest alerts**, **Volatility watch** (stocks under the most news pressure), **Sector pressure** (net good or bad news per sector) and **Results this week**.

Other screens: News (2, every story with filters), Volatility (3), Sectors (4), Earnings (5), Alerts and watchlist (6), System (7, source health and a headline tester).

**Keyboard:** `1` to `7` switch screens, `/` searches the wire, `j` / `k` step through stories, `Esc` closes the detail pane or the alert banner.

## Alerts

News and prices are checked every 5 minutes (`REFRESH_MINUTES`). New alerts reach an open page within about 15 seconds.

| Alert | When |
|---|---|
| Critical | A new story with impact 8 or more, such as an RBI surprise, war escalation or a crude shock |
| High | A new story with impact 7 or more |
| Move | A stock in the news or on your watchlist moves 3% or more today (market hours) |
| Volatility | India VIX jumps 8% or more |
| Watchlist | Any new story naming a stock on your watchlist |

If 20 outlets cover the same driver, it alerts once, then at most every 90 minutes. Thresholds live in `settings.bat`.

### Notification centre

Alerts are delivered inside the website while it is open in a browser tab:

- **Notifications button** (top right): shows the unread count. Click it for a panel with the latest notifications. Unread ones are marked with a blue dot. Use **Mark all as read** to clear them, or click a notification to open the story behind it.
- **Pop-ups**: a card in the bottom-right corner for each new alert. Critical and volatility alerts also show an amber banner across the top of the page. Click either one to open the story.
- **Sound**: a short tone, with a distinct pattern for critical alerts. The **Sound on/off** button in the top bar mutes everything. Browsers only play sound after you have clicked anywhere on the page once.
- **Desktop notifications**: system pop-ups that appear even when the tab is in the background. Allow them on the **Notifications and watchlist** page. Browsers only permit this on `https` or `localhost`, so it works when you open the dashboard on the VPS itself, not over `http://VPS-IP`.
- **Tab title**: shows the unread count, e.g. `(3) NSE Wire`.

On **Notifications and watchlist** (key `6`), choose pop-up, sound and desktop separately for each alert level. Use **Send test notification** to check that everything works. Read state and settings are saved in your browser.

## Install on a Windows VPS

1. Install **Python 3.11 or newer** from python.org. In the installer, tick **"Add python.exe to PATH"** and choose **"Install for all users"**.
2. Extract this folder to a path without spaces, e.g. `C:\nse-news`.
3. Double-click **`setup.bat`**. It creates `.venv`, installs dependencies including FinBERT, and creates `settings.bat`. On a small VPS with 2 GB of RAM or less, run `setup.bat nofinbert` from a command prompt instead.
4. Edit **`settings.bat`**: choose `HOST`, set a password, and turn FinBERT on or off.
5. Test with **`start-server.bat`**. Open http://localhost:8000 in the VPS browser. Press Ctrl+C to stop.
6. To run permanently, right-click **`install-autostart.bat` → Run as administrator**. This creates a scheduled task that starts the server at boot without anyone logged in, restarts it if it crashes, and opens the firewall port if `HOST=0.0.0.0`.

Logs are in `data\server.log`. To stop and remove auto-start, run `uninstall-autostart.bat` as administrator. After changing `settings.bat`, restart the VPS or run `install-autostart.bat` again.

News and prices refresh every 5 minutes (`REFRESH_MINUTES` in `settings.bat`). You can also click **Check now**. Earnings calendars refresh every 6 hours.

## FinBERT sentiment model (optional, runs locally)

[`ProsusAI/finbert`](https://huggingface.co/ProsusAI/finbert) is a Hugging Face model trained on financial news. It runs on the VPS's CPU: no API key, no cost, and nothing is sent anywhere. The model (about 440 MB) downloads into `data\hf-cache` on the first refresh. It then scores a few hundred headlines in seconds and uses about 1 GB of RAM.

It has **one specific job: company tone.** For example, "Zomato shares sink after Q2 loss widens" means negative for ETERNAL. A keyword list misses many such phrasings; FinBERT reads them well.

It does **not** set macro direction. FinBERT calls "crude oil prices surge" *positive* because prices went up, but for India that is negative (higher import bill, squeezed OMC margins). Macro and geopolitical news therefore keeps the India-specific logic in `rules.py`.

When FinBERT is confident (≥ 0.70), it decides company tone and the sentiment of company-only stories. Its reading shows at the bottom of a story's detail pane. Set `USE_FINBERT=0` in `settings.bat` to turn it off.

## How it works

| File | Role |
|---|---|
| `app/sources.py` | Fetches RSS feeds in parallel and removes duplicate stories across feeds |
| `app/rules.py` | **The knowledge base**: sectors, about 100 NSE company aliases, and about 35 event→sector impact rules (crude, RBI, Fed, rupee, war, tariffs, sanctions, monsoon, SEBI and more). Edit it freely; stored articles are re-scored on the next start. |
| `app/analyzer.py` | Rule engine: finds events, reads the direction of each driver (e.g. "crude **slips**" vs "crude **jumps**") within its own clause, aims tariff effects at the sector a headline names, and gauges tone for each company |
| `app/sentiment.py` | Optional FinBERT headline sentiment, used for company tone only |
| `app/earnings.py` | NSE / BSE result calendars, plus `data/earnings_manual.csv` |
| `app/market.py` | Yahoo Finance prices: 1D/5D change, 20-day realised volatility, volatility regime, volume spike |
| `app/alerts.py` | Alert rules and noise control (cooldown per driver) |
| `app/aggregate.py` | Builds the dashboard views. Weights fade with a 12-hour half-life, and repeat coverage of the same driver counts for progressively less. |

Try the rule engine on any headline at `/api/analyze?text=...` or on the System screen.

## Known limitations

- NSE and BSE often block automated requests with a 403. If earnings come up empty, add rows to `data/earnings_manual.csv` (`symbol,company,date,purpose`).
- Prices come from Yahoo Finance, which is unofficial and may be delayed. If it returns nothing, prices show "–".
- The session clock does not know NSE holidays, so on a holiday it shows "Market open" during normal hours.
- The rule engine reads headlines only. It cannot tell whether news was already expected or priced in. This is not investment advice.
