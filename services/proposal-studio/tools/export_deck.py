#!/usr/bin/env python3
"""tools/export_deck.py — Export a saved deck to PDF or PPTX from the command line.

POST /api/export needs the slide HTML that the editor builds (static/render.js), so this
script opens the deck in headless Chromium, builds the HTML exactly like the editor's
export button, calls /api/export and downloads the result.

It applies the same gate as the editor: if "[TO FILL: ...]" placeholders remain or a
pricing slide is not approved, it stops unless you pass --force.

Usage:
    python3 tools/export_deck.py <deck_id> pdf|pptx [--base-url http://localhost:8091] [--out FILE] [--force]

The server must be running (./start.sh). Exit code 0 on success, 1 on error, 2 when gated.
"""
import argparse
import sys
import urllib.request
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description="Export a saved deck to PDF or PPTX.")
    parser.add_argument("deck_id", help="Deck id returned by POST /api/decks (or a saved project id)")
    parser.add_argument("format", choices=["pdf", "pptx"])
    parser.add_argument("--base-url", default="http://localhost:8091", help="Server address (default: %(default)s)")
    parser.add_argument("--out", help="Output file (default: <deck_id>.<format> in the current folder)")
    parser.add_argument("--force", action="store_true", help="Export even if placeholders or approvals are pending")
    args = parser.parse_args()

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("ERROR: playwright is not installed. Run: pip install -r requirements.txt && playwright install chromium")
        return 1

    base = args.base_url.rstrip("/")
    out = Path(args.out or f"{args.deck_id}.{args.format}")

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1920, "height": 1080})
        try:
            page.goto(f"{base}/editor.html?id={args.deck_id}")
            page.wait_for_function("typeof buildExportHTML === 'function' && project.id === %r" % args.deck_id,
                                   timeout=15000)
        except Exception:
            print(f"ERROR: could not open deck '{args.deck_id}' at {base}. Is the server running and the id correct?")
            browser.close()
            return 1

        gate = page.evaluate("""() => ({
            placeholders: countAllPlaceholders(),
            needsApproval: project.slides.some(s => s.requiresApproval === true),
            approved: !!(project.approvals && project.approvals.pricing)
        })""")
        problems = []
        if gate["placeholders"]:
            problems.append(f"{gate['placeholders']} [TO FILL: ...] placeholder(s) remain")
        if gate["needsApproval"] and not gate["approved"]:
            problems.append("pricing is not approved (tick \"J'approuve les tarifs et hypothèses budgétaires\" in the editor's export dialog)")
        if problems and not args.force:
            print("GATED: " + "; ".join(problems) + ". Fix them in the editor or pass --force.")
            browser.close()
            return 2
        for p in problems:
            print(f"WARNING: {p} (exporting anyway because of --force)")

        result = page.evaluate("""async (format) => {
            saveCurrentSlideElements();
            const res = await fetch('/api/export', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({format, html: buildExportHTML(), slideCount: project.slides.length, project})
            });
            return await res.json();
        }""", args.format)
        browser.close()

    if result.get("status") != "ok":
        print(f"ERROR: export failed: {result.get('message', result)}")
        return 1

    with urllib.request.urlopen(f"{base}{result['url']}", timeout=60) as resp:
        out.write_bytes(resp.read())
    print(f"OK: {out} ({out.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
