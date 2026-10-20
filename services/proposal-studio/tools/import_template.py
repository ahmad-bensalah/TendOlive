#!/usr/bin/env python3
"""Import one template file into templates/library/ (design only), like the "Ajouter un modèle" button.

usage: python3 tools/import_template.py <file.pptx|file.pdf> [--id ID] [--name NAME] [--content-slide N] [--force]
"""
import argparse
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import template_importer  # noqa: E402


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("file")
    ap.add_argument("--id")
    ap.add_argument("--name")
    ap.add_argument("--content-slide", type=int, help="0-based index of the slide used as content design")
    ap.add_argument("--force", action="store_true", help="replace an existing template with the same id")
    a = ap.parse_args()
    lib = template_importer.TemplateLibrary(Path(os.environ.get("TEMPLATES_DIR", ROOT / "templates")))
    path = Path(a.file)
    try:
        t = lib.import_bytes(path.read_bytes(), path.name, tid=a.id, name=a.name, force=a.force, content_slide=a.content_slide)
    except Exception as e:
        print(f"ERROR: {e}")
        return 1
    if not lib.get_default():
        lib.set_default(t["id"])
    print(f"OK: {t['id']} — decor kept {t['stats']}, zones {list(k for k, v in t['zones'].items() if any(v.values()))}")
    for w in t["warnings"]:
        print(f"  warning: {w}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
