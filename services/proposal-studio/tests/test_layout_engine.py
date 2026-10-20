"""tests/test_layout_engine.py — Unit tests for layout_engine.py (no server, no browser).

Covers: title and thank-you slides, 4 cards side by side, the 10-row table split with a
repeated header, long bullet lists, overflow into continuation slides, font size
minimums, flags carried to continuation slides, and canvas bounds.
"""
import sys
import unittest
from pathlib import Path

STUDIO_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(STUDIO_DIR))

import layout_engine as L

TEXT_TYPES = ("text", "bullets", "table", "card")


def deck(*slides, **top):
    spec = {"name": "Test deck", "slides": list(slides)}
    spec.update(top)
    return spec


def content(title, *blocks, **extra):
    s = {"type": "content", "title": title, "blocks": list(blocks)}
    s.update(extra)
    return s


def content_slides(project):
    """Content slides only (drop the generated title and thank-you slides)."""
    return project["slides"][1:-1]


def table_rows(n):
    return [[f"R{i}", f"Requirement {i}", "Yes"] for i in range(n)]


class TestDeckFrame(unittest.TestCase):
    def test_title_and_thank_you_slides_are_generated(self):
        project, _ = L.layout_deck(deck(content("Only slide", {"kind": "text", "text": "Hello"}),
                                        client="Client X", date="2026-10-18"))
        self.assertEqual(len(project["slides"]), 3)
        title_text = " ".join(e.get("content", "") for e in project["slides"][0]["elements"])
        self.assertIn("Test deck", title_text)
        self.assertIn("Client X", title_text)
        self.assertEqual(project["slides"][1]["elements"][0]["content"], "Only slide")

    def test_deck_warnings_are_returned_flat(self):
        _, warnings = L.layout_deck(deck(content("A", {"kind": "text", "text": "x"}, warnings=["w1"]),
                                         content("B", {"kind": "text", "text": "y"}, warnings=["w2"])))
        self.assertEqual(warnings, ["w1", "w2"])


class TestCardsAndTables(unittest.TestCase):
    def test_four_cards_side_by_side_and_fifth_dropped(self):
        cards = [{"title": f"Card {i}", "text": "Short text"} for i in range(5)]
        project, _ = L.layout_deck(deck(content("Cards", {"kind": "cards", "cards": cards})))
        card_els = [e for e in content_slides(project)[0]["elements"] if e["type"] == "card"]
        self.assertEqual(len(card_els), 4)
        self.assertEqual(len({e["y"] for e in card_els}), 1, "cards share one row")
        xs = [e["x"] for e in card_els]
        self.assertEqual(xs, sorted(xs))
        for a, b in zip(card_els, card_els[1:]):
            self.assertLessEqual(a["x"] + a["width"], b["x"], "cards must not overlap")
        self.assertLessEqual(card_els[-1]["x"] + card_els[-1]["width"], 1920)

    def test_ten_row_table_stays_on_one_slide(self):
        project, _ = L.layout_deck(deck(content("Matrix", {"kind": "table", "columns": ["A", "B", "C"],
                                                            "rows": table_rows(10)})))
        slides = content_slides(project)
        self.assertEqual(len(slides), 1)
        self.assertEqual(slides[0]["elements"][0]["content"], "Matrix")

    def test_eleven_row_table_splits_with_repeated_header(self):
        cols = ["Ref", "Requirement", "Compliant"]
        project, _ = L.layout_deck(deck(content("Matrix", {"kind": "table", "columns": cols,
                                                            "rows": table_rows(11)})))
        slides = content_slides(project)
        self.assertEqual(len(slides), 2)
        self.assertEqual([s["elements"][0]["content"] for s in slides], ["Matrix (1/2)", "Matrix (2/2)"])
        tables = [next(e for e in s["elements"] if e["type"] == "table") for s in slides]
        self.assertEqual([len(t["rows"]) for t in tables], [10, 1])
        for t in tables:
            self.assertEqual(t["columns"], cols)

    def test_25_row_table_keeps_row_order_across_slides(self):
        rows = table_rows(25)
        project, _ = L.layout_deck(deck(content("Big", {"kind": "table", "columns": ["A", "B", "C"], "rows": rows})))
        got = []
        for s in content_slides(project):
            t = next(e for e in s["elements"] if e["type"] == "table")
            self.assertLessEqual(len(t["rows"]), 10)
            got.extend(t["rows"])
        self.assertEqual(got, rows)


class TestOverflow(unittest.TestCase):
    def assert_inside_canvas(self, project):
        for s_idx, s in enumerate(project["slides"]):
            for e in s["elements"]:
                self.assertGreaterEqual(e["x"], 0)
                self.assertGreaterEqual(e["y"], 0)
                self.assertLessEqual(e["x"] + e["width"], 1920, f"slide {s_idx} {e['type']} too wide")
                self.assertLessEqual(e["y"] + e["height"], 1080, f"slide {s_idx} {e['type']} below canvas")

    def assert_no_text_overlap(self, project):
        for s in project["slides"]:
            boxes = [e for e in s["elements"] if e["type"] in TEXT_TYPES]
            for i, a in enumerate(boxes):
                for b in boxes[i + 1:]:
                    overlap = (a["x"] < b["x"] + b["width"] and b["x"] < a["x"] + a["width"] and
                               a["y"] < b["y"] + b["height"] and b["y"] < a["y"] + a["height"])
                    self.assertFalse(overlap, f"{a['type']} overlaps {b['type']} on '{s['label']}'")

    def test_long_bullet_list_splits_and_stays_on_canvas(self):
        items = [f"Point {i}" for i in range(30)]
        project, _ = L.layout_deck(deck(content("Many points", {"kind": "bullets", "items": items})))
        slides = content_slides(project)
        self.assertGreater(len(slides), 1)
        got = []
        for s in slides:
            b = next(e for e in s["elements"] if e["type"] == "bullets")
            self.assertLessEqual(len(b["items"]), 12)
            got.extend(b["items"])
        self.assertEqual(got, items)
        self.assert_inside_canvas(project)

    def test_many_blocks_overflow_into_continuation_slides(self):
        blocks = [{"kind": "bullets", "items": [f"Item {i}.{j}" for j in range(6)]} for i in range(5)]
        project, _ = L.layout_deck(deck(content("Stack", *blocks)))
        slides = content_slides(project)
        self.assertGreater(len(slides), 1)
        titles = [s["elements"][0]["content"] for s in slides]
        self.assertEqual(titles[0], f"Stack (1/{len(slides)})")
        self.assert_inside_canvas(project)
        self.assert_no_text_overlap(project)

    def test_samples_stay_on_canvas_without_overlap(self):
        import json
        for name in ("software.json", "non_software.json", "thin.json"):
            spec = json.loads((STUDIO_DIR / "samples" / name).read_text(encoding="utf-8"))
            project, _ = L.layout_deck(spec)
            with self.subTest(sample=name):
                self.assert_inside_canvas(project)
                self.assert_no_text_overlap(project)

    def test_flags_carry_over_to_every_continuation_slide(self):
        slide = content("Pricing", {"kind": "table", "columns": ["Item", "Cost"],
                                    "rows": [[f"L{i}", "1"] for i in range(25)]},
                        requiresApproval=True, warnings=["check rates"],
                        assumptions=["5 days per sprint"], catalogDate="2026-10-01",
                        notes="speaker", sources={"mermaid": "graph TD; A-->B;"})
        project, _ = L.layout_deck(deck(slide))
        slides = content_slides(project)
        self.assertEqual(len(slides), 3)
        for s in slides:
            self.assertTrue(s["requiresApproval"])
            self.assertEqual(s["warnings"], ["check rates"])
            self.assertEqual(s["assumptions"], ["5 days per sprint"])
            self.assertEqual(s["catalogDate"], "2026-10-01")
            self.assertEqual(s["notes"], "speaker")
            self.assertEqual(s["sources"], {"mermaid": "graph TD; A-->B;"})


class TestFontSizes(unittest.TestCase):
    THEME = L._normalize_theme({})

    def test_default_sizes(self):
        b = L.block_to_elements({"kind": "bullets", "items": ["a"]}, 100, 220, 1720, self.THEME)[0]
        t = L.block_to_elements({"kind": "table", "columns": ["A"], "rows": [["1"]]}, 100, 220, 1720, self.THEME)[0]
        self.assertEqual(b["fontSize"], 28)
        self.assertEqual(t["fontSize"], 22)

    def test_shrinking_never_goes_below_minimums(self):
        for scale in (0.9, 0.5, 0.1):
            b = L.block_to_elements({"kind": "bullets", "items": ["a"]}, 100, 220, 1720, self.THEME, font_scale=scale)[0]
            t = L.block_to_elements({"kind": "table", "columns": ["A"], "rows": [["1"]]}, 100, 220, 1720, self.THEME,
                                    font_scale=scale)[0]
            self.assertGreaterEqual(b["fontSize"], 24)
            self.assertGreaterEqual(t["fontSize"], 20)
        self.assertEqual(b["fontSize"], 24)
        self.assertEqual(t["fontSize"], 20)

    def test_every_block_kind_produces_elements(self):
        blocks = [
            {"kind": "text", "text": "t"},
            {"kind": "bullets", "items": ["a"]},
            {"kind": "table", "columns": ["A"], "rows": [["1"]]},
            {"kind": "image", "src": "/uploads/x.svg", "caption": "c"},
            {"kind": "cards", "cards": [{"title": "T", "text": "x"}]},
            {"kind": "note", "text": "n"},
            {"kind": "kpis", "items": [{"label": "L", "value": "1"}]},
        ]
        for b in blocks:
            with self.subTest(kind=b["kind"]):
                self.assertTrue(L.block_to_elements(b, 100, 220, 1720, self.THEME))


if __name__ == "__main__":
    unittest.main()
