"""Optional FinBERT sentiment (Hugging Face model ProsusAI/finbert), run locally on CPU.

What it is used for - and what it is NOT used for:
  * USED for company-specific tone: "Zomato shares sink after Q2 loss widens" -> negative for ETERNAL.
    FinBERT is trained on financial news and reads these far better than a keyword list.
  * NOT used for macro direction: FinBERT calls "crude oil prices surge" positive (prices up),
    but for India that is negative (import bill, OMC margins). Macro events keep the rule engine's
    India-specific logic in rules.py.

If torch/transformers are not installed (setup.bat nofinbert) or USE_FINBERT=0, everything still
works with the rule engine alone.
"""
import logging
import os
import threading

from . import db
from .config import DATA_DIR

log = logging.getLogger("sentiment")

USE_FINBERT = os.getenv("USE_FINBERT", "1") not in ("0", "off", "false", "no")
MODEL = os.getenv("FINBERT_MODEL", "ProsusAI/finbert")
# keep the downloaded model (~440 MB) next to the app instead of the service account's profile
os.environ.setdefault("HF_HOME", str(DATA_DIR / "hf-cache"))

_pipe = None
_failed = False
_lock = threading.Lock()


def available() -> bool:
    if not USE_FINBERT or _failed:
        return False
    try:
        import transformers  # noqa: F401
        import torch  # noqa: F401
        return True
    except ImportError:
        return False


def _load():
    global _pipe, _failed
    with _lock:
        if _pipe is not None or _failed:
            return _pipe
        try:
            import torch
            from transformers import pipeline
            torch.set_num_threads(max(1, (os.cpu_count() or 2) - 1))  # leave a core for the web server
            log.info("loading %s (first run downloads ~440 MB)...", MODEL)
            _pipe = pipeline("text-classification", model=MODEL, tokenizer=MODEL, device=-1, truncation=True,
                             max_length=96)
            db.set_source_status("FinBERT sentiment model", True, 0)
        except Exception as ex:
            _failed = True
            log.warning("FinBERT unavailable: %s", ex)
            db.set_source_status("FinBERT sentiment model", False, 0, str(ex))
        return _pipe


def score(titles: list[str]) -> list[dict | None]:
    """Returns one {"label": positive|negative|neutral, "score": 0-1} per title (None if unavailable)."""
    if not titles or not available():
        return [None] * len(titles)
    pipe = _load()
    if pipe is None:
        return [None] * len(titles)
    try:
        out = pipe(titles, batch_size=16)
        db.set_source_status("FinBERT sentiment model", True, len(titles))
        return [{"label": o["label"].lower(), "score": round(float(o["score"]), 3)} for o in out]
    except Exception as ex:
        log.warning("FinBERT scoring failed: %s", ex)
        db.set_source_status("FinBERT sentiment model", False, 0, str(ex))
        return [None] * len(titles)
