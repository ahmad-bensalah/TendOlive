"""tests/test_schema_validation.py — Every validation error of the deck spec (layout_engine.py).

Also checks that deck.schema.json declares exactly the fields the validator accepts,
so the published schema and the server never drift apart.
"""
import json
import sys
import unittest
from pathlib import Path

STUDIO_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(STUDIO_DIR))

import layout_engine as L


def deck_with(slide):
    return {"name": "Deck", "slides": [slide]}


def slide_with(*blocks, **extra):
    s = {"type": "content", "title": "T", "blocks": list(blocks)}
    s.update(extra)
    return s


class TestDeckLevelErrors(unittest.TestCase):
    def test_valid_samples_have_no_errors(self):
        for name in ("software.json", "non_software.json", "thin.json"):
            spec = json.loads((STUDIO_DIR / "samples" / name).read_text(encoding="utf-8"))
            self.assertEqual(L.validate_deck_spec(spec), [], name)

    def test_root_must_be_object(self):
        self.assertEqual(L.validate_deck_spec([]), ["Root payload must be an object"])

    def test_unknown_top_level_field_lists_allowed_fields(self):
        errs = L.validate_deck_spec({"name": "D", "slides": [slide_with()], "author": "x", "color": "y"})
        self.assertEqual(len(errs), 1)
        self.assertIn("Root: unknown field(s) 'author, color'", errs[0])
        for field in L.ALLOWED_DECK_FIELDS:
            self.assertIn(field, errs[0])

    def test_name_required_and_non_empty(self):
        for bad in ({"slides": [slide_with()]}, {"name": "  ", "slides": [slide_with()]}, {"name": 3, "slides": [slide_with()]}):
            self.assertIn("Root property 'name' is required and must be a non-empty string", L.validate_deck_spec(bad))

    def test_slides_required_array(self):
        self.assertIn("Root property 'slides' is required and must be an array",
                      L.validate_deck_spec({"name": "D", "slides": "nope"}))

    def test_slides_not_empty(self):
        self.assertEqual(L.validate_deck_spec({"name": "D", "slides": []}),
                         ["Deck must contain at least one slide in 'slides'"])


class TestSlideLevelErrors(unittest.TestCase):
    def errs(self, slide):
        return L.validate_deck_spec(deck_with(slide))

    def test_slide_must_be_object(self):
        self.assertEqual(self.errs("x"), ["slides[0]: must be an object"])

    def test_unknown_slide_field_lists_allowed_fields(self):
        errs = self.errs(slide_with(layout="two-col"))
        self.assertEqual(len(errs), 1)
        self.assertIn("slides[0]: unknown field(s) 'layout'", errs[0])
        for field in L.ALLOWED_SLIDE_FIELDS:
            self.assertIn(field, errs[0])

    def test_field_type_errors(self):
        cases = [
            ({"type": "title", "title": "T", "blocks": []}, "slides[0].type: must be 'content'"),
            ({"type": "content", "blocks": []}, "slides[0].title: required string"),
            (slide_with(requiresApproval="yes"), "slides[0].requiresApproval: must be a boolean"),
            (slide_with(assumptions="one"), "slides[0].assumptions: must be an array of strings"),
            (slide_with(assumptions=[1]), "slides[0].assumptions: must be an array of strings"),
            (slide_with(catalogDate=20261001), "slides[0].catalogDate: must be a string"),
            (slide_with(warnings=[None]), "slides[0].warnings: must be an array of strings"),
            ({"type": "content", "title": "T"}, "slides[0].blocks: required array"),
        ]
        for slide, msg in cases:
            with self.subTest(msg=msg):
                self.assertIn(msg, self.errs(slide))


class TestBlockErrors(unittest.TestCase):
    def errs(self, block):
        return L.validate_deck_spec(deck_with(slide_with(block)))

    def test_block_errors(self):
        p = "slides[0].blocks[0]"
        cases = [
            ("str", f"{p}: must be an object"),
            ({"text": "x"}, f"{p}.kind: missing block kind"),
            ({"kind": "text"}, f"{p}.text: required string"),
            ({"kind": "note", "text": 1}, f"{p}.text: required string"),
            ({"kind": "bullets", "items": "a"}, f"{p}.items: required array of strings"),
            ({"kind": "bullets", "items": ["a"], "bulletStyle": "star"}, f"{p}.bulletStyle: must be one of disc, number, check"),
            ({"kind": "table", "columns": "A", "rows": []}, f"{p}.columns: required array of strings"),
            ({"kind": "table", "columns": ["A"], "rows": [["1", 2]]}, f"{p}.rows: required 2D array of strings"),
            ({"kind": "image", "src": ""}, f"{p}.src: required string"),
            ({"kind": "cards", "cards": {}}, f"{p}.cards: required array"),
            ({"kind": "cards", "cards": [{"title": "T"}]}, f"{p}.cards[0]: requires title and text strings"),
            ({"kind": "kpis", "items": "x"}, f"{p}.items: required array of KPI objects"),
            ({"kind": "kpis", "items": [{"label": "L"}]}, f"{p}.items[0]: requires label and value"),
        ]
        for block, msg in cases:
            with self.subTest(msg=msg):
                self.assertIn(msg, self.errs(block))

    def test_unknown_block_kind_lists_allowed_kinds(self):
        errs = self.errs({"kind": "chart", "data": []})
        self.assertEqual(len(errs), 1)
        self.assertIn("unknown block kind 'chart'", errs[0])
        for kind in ("text", "bullets", "table", "image", "cards", "note", "kpis"):
            self.assertIn(kind, errs[0])

    def test_errors_from_several_slides_are_all_reported(self):
        spec = {"name": "D", "slides": [slide_with({"kind": "text"}), slide_with({"kind": "image"})]}
        errs = L.validate_deck_spec(spec)
        self.assertIn("slides[0].blocks[0].text: required string", errs)
        self.assertIn("slides[1].blocks[0].src: required string", errs)


class TestSchemaFileMatchesValidator(unittest.TestCase):
    def test_schema_declares_the_validator_fields(self):
        schema = json.loads((STUDIO_DIR / "deck.schema.json").read_text(encoding="utf-8"))
        self.assertEqual(set(schema["properties"]), L.ALLOWED_DECK_FIELDS)
        self.assertIs(schema.get("additionalProperties"), False)
        slide_schema = schema["properties"]["slides"]["items"]
        self.assertEqual(set(slide_schema["properties"]), L.ALLOWED_SLIDE_FIELDS)
        self.assertIs(slide_schema.get("additionalProperties"), False)


if __name__ == "__main__":
    unittest.main()
