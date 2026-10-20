"""Atomic persistence for tender metadata and its latest RAG analysis."""
import json
from pathlib import Path
from threading import Lock

from . import config

_lock = Lock()


def _path() -> Path:
    return Path(config.TENDERS_FILE)


def _read() -> dict[str, dict]:
    path = _path()
    if not path.exists():
        return {}
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("Tender store must contain an object")
    return data


def _write(items: dict[str, dict]) -> None:
    """Replace the whole store at once: write a temporary file, then rename it over the store.
    A reader never sees a half-written file. Call it while holding _lock."""
    path = _path()
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(items, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    temporary.replace(path)


def save(tender: dict) -> dict:
    tender_id = tender.get("tender_id")
    if not tender_id:
        return tender
    with _lock:
        items = _read()
        items[tender_id] = tender
        _write(items)
    return tender


def list_all() -> list[dict]:
    with _lock:
        return list(_read().values())


def get(tender_id: str) -> dict | None:
    with _lock:
        return _read().get(tender_id)


def delete(tender_id: str) -> bool:
    """Remove one tender and its analysis. Returns False when no tender has this ID."""
    with _lock:
        items = _read()
        if tender_id not in items:
            return False
        del items[tender_id]
        _write(items)
    return True


def clear() -> int:
    """Remove every stored tender and return how many were removed.

    A store that cannot be read (damaged JSON) is replaced by an empty one too: clearing the inbox
    is the way out of that state, and its tenders could not be listed anyway (they count as 0).
    """
    with _lock:
        if not _path().exists():
            return 0
        try:
            removed = len(_read())
        except ValueError:  # json.JSONDecodeError is a ValueError
            removed = 0
        _write({})
    return removed
