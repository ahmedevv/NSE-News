"""Prices from Yahoo Finance (yfinance): last price and change on the day.
Used for the top bar, global cues, and "has it already moved?" next to each stock in the feed.
Yahoo's NSE quotes can be delayed by up to 15 minutes."""
import logging

from . import db
from .config import GLOBAL_TICKERS, INDIA_TICKERS

log = logging.getLogger("market")


def yf_ticker(symbol: str) -> str:
    return symbol if symbol.startswith("^") or "=" in symbol or "." in symbol else f"{symbol}.NS"


def refresh(symbols: list[str]):
    try:
        import yfinance as yf
    except ImportError:
        db.set_source_status("Yahoo Finance prices", False, 0, "yfinance not installed")
        return
    tickers = sorted({yf_ticker(s) for s in symbols} | set(INDIA_TICKERS) | set(GLOBAL_TICKERS))
    try:
        data = yf.download(tickers, period="5d", interval="1d", group_by="ticker",
                           progress=False, auto_adjust=False, threads=8)
    except Exception as ex:
        db.set_source_status("Yahoo Finance prices", False, 0, str(ex))
        return
    ok = 0
    for t in tickers:
        try:
            df = data[t].dropna(subset=["Close"]) if len(tickers) > 1 else data.dropna(subset=["Close"])
            if len(df) < 2:
                continue
            close = df["Close"]
            sym = t[:-3] if t.endswith(".NS") else t
            db.save_market(sym, {
                "price": round(float(close.iloc[-1]), 2),
                "prev": round(float(close.iloc[-2]), 2),
                "chg_1d": round(float(close.iloc[-1] / close.iloc[-2] - 1) * 100, 2),
                "asof": str(df.index[-1].date()),
            })
            ok += 1
        except Exception:
            continue
    db.set_source_status("Yahoo Finance prices", ok > 0, ok, "" if ok else "no price data returned")
