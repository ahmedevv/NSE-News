"""Price context from Yahoo Finance (yfinance): day change, 5-day change,
20-day realised volatility, volume spike. Optional - the app works without it."""
import logging
import math

from . import db
from .rules import SECTORS

log = logging.getLogger("market")


def yf_ticker(symbol: str) -> str:
    return symbol if symbol.startswith("^") else f"{symbol}.NS"


def refresh(symbols: list[str]):
    try:
        import yfinance as yf
    except ImportError:
        db.set_source_status("Yahoo Finance prices", False, 0, "yfinance not installed")
        return
    indices = [t for t, _ in SECTORS.values() if t]
    tickers = sorted({yf_ticker(s) for s in symbols} | set(indices))
    try:
        data = yf.download(tickers, period="3mo", interval="1d", group_by="ticker",
                           progress=False, auto_adjust=True, threads=8)
    except Exception as ex:
        db.set_source_status("Yahoo Finance prices", False, 0, str(ex))
        return
    ok = 0
    for t in tickers:
        try:
            df = data[t].dropna(subset=["Close"]) if len(tickers) > 1 else data.dropna(subset=["Close"])
            if len(df) < 6:
                continue
            close = df["Close"]
            rets = close.pct_change().dropna()
            vol20 = float(rets.tail(20).std() * math.sqrt(252) * 100)
            vol60 = float(rets.tail(60).std() * math.sqrt(252) * 100)
            v = df["Volume"]
            vol_ratio = float(v.iloc[-1] / v.tail(21).iloc[:-1].mean()) if v.tail(21).iloc[:-1].mean() else None
            sym = t[:-3] if t.endswith(".NS") else t
            db.save_market(sym, {
                "price": round(float(close.iloc[-1]), 2),
                "chg_1d": round(float(close.iloc[-1] / close.iloc[-2] - 1) * 100, 2),
                "chg_5d": round(float(close.iloc[-1] / close.iloc[-6] - 1) * 100, 2),
                "rv20": round(vol20, 1), "rv60": round(vol60, 1),
                "vol_regime": round(vol20 / vol60, 2) if vol60 else None,   # >1.2 = volatility expanding
                "volume_x": round(vol_ratio, 2) if vol_ratio else None,
                "spark": [round(float(x), 2) for x in close.tail(30)],
            })
            ok += 1
        except Exception:
            continue
    db.set_source_status("Yahoo Finance prices", ok > 0, ok, "" if ok else "no price data returned")
