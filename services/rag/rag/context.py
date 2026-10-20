"""Request-local retrieval scopes. No application request mutates config globals."""
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from . import config

DataMode = Literal["company", "demo"]


@dataclass(frozen=True)
class RetrievalContext:
    mode: str
    data_dir: Path
    db_dir: Path
    folders: tuple[str, ...] = ()


_active = ContextVar("retrieval_context", default=None)


def current() -> RetrievalContext:
    scoped = _active.get()
    if scoped is not None:
        return scoped
    # Benchmark CLI compatibility: its private process selects CVs only.
    if config.FOLDERS == ["authoritative_cvs"]:
        return RetrievalContext("cv_only", config.DATA_DIR, config.DB_DIR, tuple(config.FOLDERS))
    return for_mode("company")


def for_mode(mode: DataMode) -> RetrievalContext:
    if mode not in ("company", "demo"):
        raise ValueError("Unknown data mode")
    return RetrievalContext(mode, config.DATA_DIR, config.DB_DIR / mode, tuple(config.FOLDERS))


@contextmanager
def retrieval_scope(context: RetrievalContext):
    token = _active.set(context)
    try:
        yield context
    finally:
        _active.reset(token)
