#!/usr/bin/env python3
"""Copy demo tenders (tests/inputs: software, non_software, thin) into tenders/inbox/ (never overwrites)."""
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
inbox = ROOT / "tenders" / "inbox"
inbox.mkdir(parents=True, exist_ok=True)
for name in ("software", "non_software", "thin"):
    target = inbox / f"demo_{name}.json"
    if target.exists():
        print(f"exists, kept: {target.name}")
    else:
        shutil.copy(ROOT / "tests" / "inputs" / f"{name}.json", target)
        print(f"added: {target.name}")
