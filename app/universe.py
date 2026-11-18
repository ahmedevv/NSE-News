"""The stocks this desk tracks (rules.COMPANIES) and name -> symbol matching."""
import re
from functools import lru_cache

from .rules import COMPANIES

SYMBOL_SECTOR = {sym: sector for sym, sector, _ in COMPANIES}
TRACKED = set(SYMBOL_SECTOR)


@lru_cache(maxsize=1)
def _patterns():
    out = []
    for sym, _sector, aliases in COMPANIES:
        pats = []
        for a in aliases:
            # aliases written as regex (containing \b) keep their own case rules, plain ones are case-insensitive
            pats.append(re.compile(a) if "\\b" in a else re.compile(r"\b" + re.escape(a) + r"\b", re.I))
        out.append((sym, pats))
    return out


def symbols_in(text: str) -> list[str]:
    return [sym for sym, pats in _patterns() if any(p.search(text or "") for p in pats)]
