"""template_importer.py — Turn a PPTX or PDF template into a design-only template.

import_template(file_bytes, filename, store_media, ...) returns a template dict (see
templates/template.schema.json):
  - theme      colors and fonts of the template
  - designs    title / content / thankyou: the decor elements only (backgrounds, shapes,
               pictures, logos), locked and below the content (zIndex 1..99)
  - zones      where the template had its title, subtitle and body texts
  - stats, warnings

Every text of the template is removed: text boxes, text inside shapes and groups, tables,
cards, bullets, placeholders, notes. The agents' content takes the place of the removed
texts. After filtering, a proof step checks that no string of the original file remains
anywhere in the result (including SVG assets); if one does, the import fails.

The geometry, media and theme come from pptx_extractor.extract_theme (imported, not edited).
"""
import hashlib
import io
import json
import re
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

CANVAS_W, CANVAS_H = 1920, 1080
TEXT_TYPES = {"text", "bullets", "table", "card", "video"}
MAX_SLIDES = 30
# Real brand templates are heavy (the OliveSoft PFE book is 27 MB); other uploads keep 25 MB
MAX_BYTES = 60 * 1024 * 1024


class TemplateImportError(Exception):
    pass


# ── helpers ────────────────────────────────────────────────────────────
def make_template_id(name: str, existing: Optional[set] = None) -> str:
    """'OliveSoft Commercial.pptx' -> 'olivesoft-commercial'; duplicates get -2, -3..."""
    base = Path(name).stem.lower()
    base = re.sub(r"[^a-z0-9_]+", "-", base)
    base = re.sub(r"-{2,}", "-", base).strip("-_")[:40].strip("-_") or "template"
    tid, n = base, 2
    existing = existing or set()
    while tid in existing:
        suffix = f"-{n}"
        tid = base[:40 - len(suffix)] + suffix
        n += 1
    return tid


def _luminance(hex_color: str) -> float:
    h = hex_color.lstrip("#")
    if len(h) != 6:
        return 0.0
    def ch(v):
        c = int(v, 16) / 255
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    return 0.2126 * ch(h[0:2]) + 0.7152 * ch(h[2:4]) + 0.0722 * ch(h[4:6])


def contrast(c1: str, c2: str) -> float:
    a, b = sorted((_luminance(c1), _luminance(c2)), reverse=True)
    return (a + 0.05) / (b + 0.05)


def readable_text_color(bg: str, preferred: Optional[str]) -> str:
    """The preferred color when its contrast with bg is at least 4.5, else white or near-black."""
    if preferred and re.fullmatch(r"#[0-9a-fA-F]{6}", preferred) and contrast(preferred, bg) >= 4.5:
        return preferred
    return "#FFFFFF" if contrast("#FFFFFF", bg) >= contrast("#0F172A", bg) else "#0F172A"


def _box(el) -> Dict[str, int]:
    return {"x": int(el.get("x", 0)), "y": int(el.get("y", 0)), "w": int(el.get("width", 0)), "h": int(el.get("height", 0))}


def _union(boxes: List[Dict[str, int]]) -> Optional[Dict[str, int]]:
    if not boxes:
        return None
    x1 = min(b["x"] for b in boxes)
    y1 = min(b["y"] for b in boxes)
    x2 = max(b["x"] + b["w"] for b in boxes)
    y2 = max(b["y"] + b["h"] for b in boxes)
    return {"x": x1, "y": y1, "w": x2 - x1, "h": y2 - y1}


def _overlaps(a, b) -> bool:
    return not (a["x"] + a["w"] <= b["x"] or b["x"] + b["w"] <= a["x"] or
                a["y"] + a["h"] <= b["y"] or b["y"] + b["h"] <= a["y"])


def _sane(box: Optional[Dict[str, int]], min_w=400, min_h=40) -> Optional[Dict[str, int]]:
    """A zone inside the canvas and big enough to hold text, else None."""
    if not box:
        return None
    x = max(0, box["x"]); y = max(0, box["y"])
    w = min(CANVAS_W - x, box["w"] - (x - box["x"])); h = min(CANVAS_H - y, box["h"] - (y - box["y"]))
    if w < min_w or h < min_h:
        return None
    return {"x": x, "y": y, "w": w, "h": h}


def _font_size(el) -> float:
    return float(el.get("fontSize") or 0)


def _is_full_bleed(el) -> bool:
    return el.get("x", 0) <= 25 and el.get("y", 0) <= 25 and el.get("width", 0) >= CANVAS_W - 90 and el.get("height", 0) >= CANVAS_H - 50


# ── text zones ─────────────────────────────────────────────────────────
def _text_zones(text_elements: List[dict]) -> Dict[str, Optional[Dict[str, int]]]:
    """title = biggest font in the upper 45 % of the slide (ties: the highest);
    subtitle = next text just below the title; body = union of the remaining texts below the title."""
    texts = [e for e in text_elements if e.get("type") in ("text", "bullets", "table", "card")]
    if not texts:
        return {"title": None, "subtitle": None, "body": None}
    upper = [e for e in texts if e.get("y", 0) < CANVAS_H * 0.45] or texts
    title = max(upper, key=lambda e: (_font_size(e), -e.get("y", 0), e.get("width", 0)))
    tb = _box(title)
    below = [e for e in texts if e is not title and e.get("y", 0) >= tb["y"] + tb["h"] * 0.5]
    below.sort(key=lambda e: e.get("y", 0))
    subtitle = None
    if below and below[0].get("y", 0) - (tb["y"] + tb["h"]) < 160 and _font_size(below[0]) >= _font_size(title) * 0.35:
        subtitle = _box(below[0])
    # Body: texts in the main area (ignore tiny footers / page numbers in the bottom 8 %)
    body_elems = [e for e in below if e.get("y", 0) < CANVAS_H * 0.92 and e.get("height", 0) >= 30]
    body = _union([_box(e) for e in body_elems])
    return {"title": tb, "subtitle": subtitle, "body": body}


# ── design filter ──────────────────────────────────────────────────────
def _in_margin_bands(el, body: Optional[Dict[str, int]]) -> bool:
    """Decor that frames the content: header band, footer band, side bands, or outside the body zone."""
    b = _box(el)
    cy = b["y"] + b["h"] / 2
    cx = b["x"] + b["w"] / 2
    if b["y"] + b["h"] <= CANVAS_H * 0.20 or b["y"] >= CANVAS_H * 0.86:
        return True
    if cx <= CANVAS_W * 0.06 or cx >= CANVAS_W * 0.94:
        return True
    if body and not _overlaps(b, body):
        return True
    return cy < 0 or cy > CANVAS_H


def _looks_like_text_picture(el) -> bool:
    """Exporters such as Canva turn headings into pictures: a wide, short image is a line of text,
    not decor (logos are closer to square; frames and lines are shapes)."""
    if el.get("type") != "image":
        return False
    w, h = el.get("width", 0), el.get("height", 0)
    return h > 0 and h <= 160 and w / h >= 3.2 and w < CANVAS_W * 0.9


def _filter_design(elements: List[dict], role: str, body_zone: Optional[Dict[str, int]],
                   brand_srcs: Optional[set] = None) -> List[dict]:
    """Keep only decor. On the content and thank-you designs, decor in the middle of the slide
    (diagram boxes, illustrations of the template's own content) is dropped: only frames, logos and
    backgrounds stay."""
    kept = []
    for el in elements:
        if el.get("type") in TEXT_TYPES:
            continue
        if any(isinstance(el.get(k), str) and el.get(k).strip() for k in ("content", "text", "title")):
            continue
        corner_logo = (el.get("y", 0) + el.get("height", 0) <= CANVAS_H * 0.22 and
                       (el.get("x", 0) <= CANVAS_W * 0.25 or el.get("x", 0) + el.get("width", 0) >= CANVAS_W * 0.75))
        if _looks_like_text_picture(el) and el.get("src") not in (brand_srcs or set()) and not corner_logo:
            continue
        if role in ("content", "thankyou") and not _is_full_bleed(el):
            small_logo = el.get("type") == "image" and el.get("width", 0) * el.get("height", 0) < CANVAS_W * CANVAS_H * 0.05
            if not (_in_margin_bands(el, body_zone) or (small_logo and _in_margin_bands(el, None))):
                continue
        el = dict(el)
        el["locked"] = True
        el["alt"] = ""
        el.pop("content", None)
        kept.append(el)
    for z, el in enumerate(kept, start=1):
        el["zIndex"] = min(z, 99)
        el["id"] = f"tpl_{role}_{z}"
    return kept


# ── original strings (for the text-free proof) ─────────────────────────
def original_strings_pptx(data: bytes) -> List[str]:
    """Every text of the file (slides, layouts, masters, notes, tables, groups): <a:t> runs and
    whole paragraphs, 4 characters or more."""
    out = set()
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        for name in zf.namelist():
            if not (name.endswith(".xml") and name.startswith("ppt/")):
                continue
            xml = zf.read(name).decode("utf-8", errors="ignore")
            for para in re.findall(r"<a:p>.*?</a:p>|<a:p .*?</a:p>", xml, re.S):
                runs = re.findall(r"<a:t>([^<]*)</a:t>", para)
                for r in runs:
                    r = _unescape(r).strip()
                    if len(r) >= 4:
                        out.add(r)
                joined = _unescape("".join(runs)).strip()
                if len(joined) >= 4:
                    out.add(joined)
    return sorted(out)


def _unescape(s: str) -> str:
    return (s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"')
             .replace("&apos;", "'").replace("&amp;", "&"))


def _strings_worth_checking(strings: List[str]) -> List[str]:
    """Skip strings that are only digits, punctuation or dots (page numbers, '……')."""
    return [s for s in strings if re.search(r"[A-Za-zÀ-ÿ]{3,}", s)]


def _string_values(obj, out):
    """Every string VALUE of a JSON structure (keys such as "pathData" are not template text)."""
    if isinstance(obj, dict):
        for v in obj.values():
            _string_values(v, out)
    elif isinstance(obj, list):
        for v in obj:
            _string_values(v, out)
    elif isinstance(obj, str):
        out.append(obj)
    return out


def assert_text_free(template: dict, original: List[str], asset_texts: List[str]) -> None:
    blob = "\n".join(_string_values(template, []) + asset_texts)
    leaked = [s for s in _strings_worth_checking(original)
              if re.search(r"(?<![A-Za-zÀ-ÿ0-9])" + re.escape(s) + r"(?![A-Za-zÀ-ÿ0-9])", blob)]
    if leaked:
        raise TemplateImportError(f"design-only check failed: {len(leaked)} template text(s) remain, e.g. {leaked[0][:60]!r}")
    for role, els in template["designs"].items():
        for el in els:
            if el.get("type") in TEXT_TYPES:
                raise TemplateImportError(f"design-only check failed: a {el.get('type')} element remains in {role}")


# ── slide roles ────────────────────────────────────────────────────────
def pick_roles(n: int, content_index: Optional[int] = None) -> Dict[str, int]:
    if n <= 1:
        return {"title": 0, "content": 0, "thankyou": 0}
    if n == 2:
        return {"title": 0, "content": 1, "thankyou": 1}
    if content_index is None or not (0 <= content_index < n):
        content_index = 2 if n >= 4 else 1   # slide 2 is often a table of contents
    return {"title": 0, "content": content_index, "thankyou": n - 1}


# ── PDF ────────────────────────────────────────────────────────────────
def _import_pdf(data: bytes, store_media) -> Tuple[List[List[dict]], dict, List[str], List[dict]]:
    import pymupdf
    doc = pymupdf.open(stream=data, filetype="pdf")
    if doc.is_encrypted:
        raise TemplateImportError("encrypted PDF")
    pages, originals, text_zones = [], [], []
    for page in list(doc)[:MAX_SLIDES]:
        sx, sy = CANVAS_W / page.rect.width, CANVAS_H / page.rect.height
        texts = []
        for b in page.get_text("dict")["blocks"]:
            if b.get("type") != 0:
                continue
            spans = [s for l in b["lines"] for s in l["spans"] if s["text"].strip()]
            if not spans:
                continue
            originals.append(" ".join(s["text"] for s in spans).strip())
            originals.extend(s["text"].strip() for s in spans if len(s["text"].strip()) >= 4)
            x0, y0, x1, y1 = b["bbox"]
            texts.append({"type": "text", "x": x0 * sx, "y": y0 * sy, "width": (x1 - x0) * sx, "height": (y1 - y0) * sy,
                          "fontSize": max(s["size"] for s in spans) * sy})
            page.add_redact_annot(pymupdf.Rect(b["bbox"]))
        page.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_NONE)
        pix = page.get_pixmap(matrix=pymupdf.Matrix(sx, sy), alpha=False)
        url = store_media(pix.tobytes("png"), "png")
        pages.append([{"type": "image", "src": url, "x": 0, "y": 0, "width": CANVAS_W, "height": CANVAS_H, "rotation": 0}])
        text_zones.append(texts)
    bg_hex = "#FFFFFF"
    theme = {"palette": {"bg": bg_hex, "primary": "#1F4E79", "secondary": "#3b82f6", "text": "#0F172A"},
             "fonts": {}, "background": {"type": "solid", "color": bg_hex}}
    try:
        import pdf_extractor
        t = pdf_extractor.extract_pdf_theme(data)
        if t.get("status") != "error":
            theme = t
    except Exception:
        pass
    return pages, theme, originals, text_zones


# ── structured templates (placeholder words) ───────────────────────────
# A template whose slides carry placeholder words is "structured": the cover has "Titre",
# "Client", "Date"; the agenda has "place1" labels next to numbers; the content layout has
# "Titre de la diapositive" and "Contenu"; every other slide (e.g. "À propos") and the last slide
# are fixed pages copied as they are. Placeholders keep their own font, size and colour.

import unicodedata


def _norm(text: str) -> str:
    t = unicodedata.normalize("NFD", str(text or "")).encode("ascii", "ignore").decode().lower()
    return re.sub(r"\s+", " ", t).strip()


PH_COVER = {"titre": "ph-title", "title": "ph-title", "client": "ph-client", "date": "ph-date"}
PH_CONTENT = {"titre de la diapositive": "ph-slide-title", "slide title": "ph-slide-title",
              "contenu": "ph-body", "content": "ph-body"}
SLOT_LABEL = re.compile(r"^(place|section|item)\s*\d*$")


def _texts(els):
    return [e for e in els if e.get("type") == "text" and str(e.get("content", "")).strip()]


def _is_agenda(els):
    return sum(1 for e in _texts(els) if SLOT_LABEL.match(_norm(e["content"]))) >= 2


def _is_content_layout(els):
    return any(_norm(e["content"]) in ("contenu", "content") for e in _texts(els))


def _center(e):
    return e["x"] + e.get("width", 0) / 2, e["y"] + e.get("height", 0) / 2


def _page_number(e) -> bool:
    return (e.get("type") == "text" and re.fullmatch(r"\d{1,3}", str(e.get("content", "")).strip())
            and e["x"] > CANVAS_W * 0.8 and e["y"] > CANVAS_H * 0.8)


def _tag_all(els, fn):
    out = []
    for i, e in enumerate(els, start=1):
        e = dict(e)
        e["id"] = f"tpl_{i}"
        e["zIndex"] = i
        role = fn(e)
        if role is False:
            continue
        if role:
            e["role"] = role
        else:
            e["locked"] = True
        out.append(e)
    return out


def detect_structure(slides):
    """Indexes of the structured roles, or None when the template has no placeholder words."""
    n = len(slides)
    if n < 3:
        return None
    content = next((i for i in range(1, n - 1) if _is_content_layout(slides[i])), None)
    if content is None:
        return None
    agenda = next((i for i in range(1, n - 1) if i != content and _is_agenda(slides[i])), None)
    fixed = [i for i in range(1, n - 1) if i not in (content, agenda)]
    return {"title": 0, "agenda": agenda, "fixed": fixed, "content": content, "closing": n - 1}


def build_structured(slides, idx):
    """The structured parts of template.json from the slides (elements with their text)."""
    def cover_role(e):
        if e.get("type") == "text":
            return PH_COVER.get(_norm(e["content"]))        # other texts (e.g. an e-mail) stay as they are
        return None

    numbers = []

    def agenda_role(e):
        if e.get("type") == "text":
            t = _norm(e["content"])
            if SLOT_LABEL.match(t):
                return "slot-label"
            if _page_number(e):
                return "page-number"
            if re.fullmatch(r"\d{1,2}", t):
                numbers.append(e)
                return "slot-number"
        return None

    def content_role(e):
        if e.get("type") == "text":
            t = _norm(e["content"])
            if t in PH_CONTENT:
                return PH_CONTENT[t]
            if _page_number(e):
                return "page-number"
            return False                                      # stray texts of the layout are dropped
        return None

    def fixed_role(e):
        return "page-number" if _page_number(e) else None

    agenda = None
    if idx["agenda"] is not None:
        agenda = _tag_all(slides[idx["agenda"]], agenda_role)
        labels = sorted([e for e in agenda if e.get("role") == "slot-label"], key=lambda e: (e["x"] // 300, e["y"]))
        nums = [e for e in agenda if e.get("role") == "slot-number"]
        # Slot k = k-th label in reading order (columns, then top to bottom); its number is the
        # number text on the same line, its marker the small shape or picture under that number
        for k, lab in enumerate(labels):
            lab["slot"] = k
            ly = _center(lab)[1]
            same_line = [e for e in nums if abs(_center(e)[1] - ly) < 60 and e["x"] < lab["x"]]
            if same_line:
                num = max(same_line, key=lambda e: e["x"])
                num["slot"] = k
                nx, ny = _center(num)
                for d in agenda:
                    if d.get("type") != "text" and d.get("width", 0) < 220 and d.get("height", 0) < 220:
                        if d["x"] <= nx <= d["x"] + d["width"] and d["y"] <= ny <= d["y"] + d["height"]:
                            d["slot"] = k
    return {
        "cover": _tag_all(slides[idx["title"]], cover_role),
        "agenda": agenda,
        "fixed": [_tag_all(slides[i], fixed_role) for i in idx["fixed"]],
        "content": _tag_all(slides[idx["content"]], content_role),
        "closing": _tag_all(slides[idx["closing"]], fixed_role),
    }


# ── main ───────────────────────────────────────────────────────────────
def _measured_background(design: List[dict], read_raster) -> Optional[str]:
    """Average color of the full-bleed picture at the bottom of a design (None if there is none)."""
    if not read_raster:
        return None
    for el in design:
        if el.get("type") == "image" and _is_full_bleed(el):
            data = read_raster(el.get("src", ""))
            if not data:
                return None
            try:
                from PIL import Image
                img = Image.open(io.BytesIO(data)).convert("RGB").resize((1, 1))
                r, g, b = img.getpixel((0, 0))
                return f"#{r:02x}{g:02x}{b:02x}"
            except Exception:
                return None
    return None


def import_template(file_bytes: bytes, filename: str, store_media: Callable[[bytes, str], str],
                    template_id: Optional[str] = None, name: Optional[str] = None,
                    content_slide: Optional[int] = None, read_asset: Optional[Callable[[str], Optional[str]]] = None,
                    read_raster: Optional[Callable[[str], Optional[bytes]]] = None) -> dict:
    """Design-only import. read_asset(url) returns the text of a stored SVG asset (for the proof)."""
    if len(file_bytes) > MAX_BYTES:
        raise TemplateImportError("file too large (60 MB limit)")
    ext = Path(filename).suffix.lower()
    if ext not in (".pptx", ".pdf"):
        raise TemplateImportError("only .pptx and .pdf templates are supported")
    warnings: List[str] = []
    approximate = False

    if ext == ".pptx":
        try:
            zipfile.ZipFile(io.BytesIO(file_bytes))
        except zipfile.BadZipFile:
            raise TemplateImportError("not a valid .pptx file")
        import pptx_extractor
        res = pptx_extractor.extract_theme(file_bytes, store_media=store_media)
        slides = [s["elements"] for s in res.get("slides", [])][:MAX_SLIDES]
        if not slides:
            raise TemplateImportError("the presentation has no slides")
        warnings += res.get("warnings", [])
        originals = original_strings_pptx(file_bytes)
        palette, fonts, background = res.get("palette", {}), res.get("fonts", {}), res.get("background", {})
        slide_texts = [[e for e in els if e.get("type") in TEXT_TYPES] for els in slides]
        source_type = "pptx"
    else:
        pages, theme_res, originals, slide_texts = _import_pdf(file_bytes, store_media)
        if not pages:
            raise TemplateImportError("the PDF has no pages")
        slides = pages
        palette = theme_res.get("palette", {})
        fonts = theme_res.get("fonts", {})
        background = theme_res.get("background", {"type": "solid", "color": palette.get("bg", "#FFFFFF")})
        approximate = True
        source_type = "pdf"
        warnings.append("PDF template: the design is a flat picture of each page and cannot be edited")

    structure = detect_structure(slides) if source_type == "pptx" else None
    roles = pick_roles(len(slides), content_slide)
    if structure:
        roles = {"title": structure["title"], "content": structure["content"], "thankyou": structure["closing"]}
    # Pictures repeated on 3 or more slides are brand marks (logos), even when wide like a text line
    from collections import Counter
    src_slides = Counter(src for els in slides for src in {e.get("src") for e in els if e.get("type") == "image"})
    brand_srcs = {src for src, n in src_slides.items() if src and n >= 3}
    designs, zones, removed = {}, {}, 0
    for role, idx in roles.items():
        tz = _text_zones(slide_texts[idx])
        body = _sane(tz["body"], 600, 200)
        designs[role] = _filter_design(slides[idx], role, body, brand_srcs)
        removed += len(slide_texts[idx])
        title_zone = _sane(tz["title"])
        if role == "title":
            zones[role] = {"title": title_zone, "subtitle": _sane(tz["subtitle"])}
        elif role == "content":
            if body and title_zone and _overlaps(body, title_zone):
                body = None
            zones[role] = {"title": title_zone, "body": body}
        else:
            zones[role] = {"title": title_zone, "qr": None}

    bg = palette.get("bg") or (background.get("color") if isinstance(background, dict) else None) or "#FFFFFF"
    measured = _measured_background(designs.get("content", []), read_raster)
    if measured:
        # The real background is a full-slide picture (kept as decor): text must contrast with it
        bg = measured
        background = {"type": "solid", "color": measured}
    text = readable_text_color(bg, palette.get("text"))
    if palette.get("text") and text != palette.get("text"):
        warnings.append(f"text color {palette.get('text')} replaced by {text} for contrast")
    heading = (fonts.get("heading") or {}).get("stack") or "'Inter', sans-serif"
    body_font = (fonts.get("body") or {}).get("stack") or heading
    bg_info = background if isinstance(background, dict) and background.get("type") else {"type": "solid", "color": bg}
    if bg_info.get("type") == "image" and bg_info.get("dataurl", "").startswith("data:"):
        # A big inline background would be copied into every deck: store it as a file instead
        try:
            import base64
            mime, b64 = bg_info["dataurl"][5:].split(";base64,", 1)
            bg_ext = {"image/jpeg": "jpg", "image/svg+xml": "svg"}.get(mime, mime.split("/")[-1])
            bg_info = {"type": "image", "url": store_media(base64.b64decode(b64), bg_ext)}
        except Exception:
            bg_info = {"type": "solid", "color": bg}
            warnings.append("template background image could not be stored; a solid color is used")

    keep_images = sum(1 for els in designs.values() for e in els if e.get("type") == "image")
    template = {
        "id": template_id or make_template_id(filename),
        "name": name or Path(filename).stem,
        "version": 1,
        "approximate": approximate,
        "source": {"filename": Path(filename).name, "type": source_type,
                   "sha256": hashlib.sha256(file_bytes).hexdigest(), "slideCount": len(slides)},
        "importedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "warnings": warnings,
        "theme": {
            "bg": bg,
            "primary": palette.get("primary") or "#1F4E79",
            "secondary": palette.get("secondary") or "#3b82f6",
            "accent": palette.get("accent") or palette.get("secondary") or "#06b6d4",
            "text": text,
            "textMuted": palette.get("text_muted") or text,
            "fontHeading": heading,
            "fontBody": body_font,
            "background": bg_info,
        },
        "designs": designs,
        "zones": zones,
        "slideRoles": roles,
        "stats": {"removedText": removed,
                  "keptShapes": sum(len(els) for els in designs.values()) - keep_images,
                  "keptImages": keep_images},
    }
    asset_texts = []
    if read_asset:
        for els in designs.values():
            for el in els:
                src = el.get("src") or ""
                if src.endswith(".svg"):
                    t = read_asset(src)
                    if t:
                        asset_texts.append(t)
    assert_text_free(template, originals, asset_texts)   # the design parts carry no template text
    if structure:
        # Structured template: placeholders filled by the deck, fixed pages copied with their text
        template["structured"] = build_structured(slides, structure)
        template["slideRoles"] = structure
        body = next((e for e in template["structured"]["content"] if e.get("role") == "ph-body"), None)
        if body and body.get("color"):
            template["theme"]["text"] = body["color"]        # the template's own body text colour
        # Gradient key figures of the fixed pages (À propos "En chiffres"): reused for the deck's KPIs
        grads = []
        for page in template["structured"].get("fixed", []):
            for e in sorted(page, key=lambda e: (e.get("y", 0), e.get("x", 0))):
                g = e.get("colorGradient")
                if e.get("type") == "text" and g and g not in grads:
                    grads.append(g)
        if grads:
            template["theme"]["kpiGradients"] = grads
    return template


# ── Library on disk: templates/{inbox,library,trash,settings.json} ──────
class TemplateLibrary:
    """Persistent template store. base defaults to <project>/templates (TEMPLATES_DIR overrides)."""

    def __init__(self, base: Path):
        self.base = Path(base)
        self.inbox = self.base / "inbox"
        self.library = self.base / "library"
        self.trash = self.base / "trash"
        self.settings_file = self.base / "settings.json"
        self.errors: Dict[str, str] = {}   # inbox file name -> import error
        for d in (self.inbox, self.library, self.trash):
            d.mkdir(parents=True, exist_ok=True)

    # settings
    def _settings(self) -> dict:
        try:
            return json.loads(self.settings_file.read_text(encoding="utf-8"))
        except Exception:
            return {"defaultTemplate": None}

    def _theme_overrides(self) -> dict:
        """templates/theme_overrides.json (versioned) then settings.json "themeOverrides" (local)."""
        out = {}
        try:
            out.update(json.loads((self.base / "theme_overrides.json").read_text(encoding="utf-8")))
        except Exception:
            pass
        for tid, over in (self._settings().get("themeOverrides") or {}).items():
            out[tid] = {**out.get(tid, {}), **over}
        return out

    def get_default(self) -> Optional[str]:
        tid = self._settings().get("defaultTemplate")
        if tid and not (self.library / tid / "template.json").exists():
            self.set_default(None)   # the default template was removed
            return None
        return tid

    def set_default(self, tid: Optional[str]) -> None:
        if tid is not None and not (self.library / tid / "template.json").exists():
            raise TemplateImportError(f"unknown template '{tid}'")
        s = self._settings()
        s["defaultTemplate"] = tid
        self.settings_file.write_text(json.dumps(s, indent=2), encoding="utf-8")

    # read
    def ids(self) -> List[str]:
        return sorted(p.name for p in self.library.iterdir() if (p / "template.json").exists())

    def get(self, tid: str) -> Optional[dict]:
        if not re.fullmatch(r"[a-z0-9_-]{1,40}", tid or ""):
            return None
        f = self.library / tid / "template.json"
        try:
            t = json.loads(f.read_text(encoding="utf-8")) if f.exists() else None
        except Exception:
            return None
        # Manual theme choices (settings.json "themeOverrides"), kept when the template is re-imported
        over = self._theme_overrides().get(tid)
        if t is not None and isinstance(over, dict):
            fixed_colors = over.get("fixedTextColors") or {}
            t["theme"] = {**(t.get("theme") or {}), **{k: v for k, v in over.items() if k != "fixedTextColors"}}
            # Solid colours chosen by hand for given texts of the fixed pages (replace the gradient)
            for page in ((t.get("structured") or {}).get("fixed") or []):
                for el in (page if isinstance(page, list) else (page.get("elements") or [])):
                    c = fixed_colors.get(str(el.get("content", "")).strip())
                    if c:
                        el["color"] = c
                        el.pop("colorGradient", None)
        return t

    def summaries(self) -> List[dict]:
        default = self.get_default()
        out = []
        for tid in self.ids():
            t = self.get(tid) or {}
            th = t.get("theme", {})
            previews = {r: f"/templates/previews/{tid}/{r}.png" for r in ("title", "content", "thankyou")
                        if (self.library / tid / f"preview_{r}.png").exists()}
            out.append({"id": tid, "name": t.get("name", tid), "approximate": bool(t.get("approximate")),
                        "warnings": t.get("warnings", []), "importedAt": t.get("importedAt"),
                        "source": (t.get("source") or {}).get("filename"), "stats": t.get("stats", {}),
                        "previews": previews, "isDefault": tid == default,
                        "theme": {"primary": th.get("primary"), "secondary": th.get("secondary"), "bg": th.get("bg")}})
        return out

    # write
    def import_bytes(self, data: bytes, filename: str, tid: Optional[str] = None, name: Optional[str] = None,
                     force: bool = False, content_slide: Optional[int] = None) -> dict:
        tid = tid or make_template_id(filename, set() if force else set(self.ids()))
        if not re.fullmatch(r"[a-z0-9_-]{1,40}", tid):
            raise TemplateImportError("template id: letters, digits, - and _, 1 to 40 characters")
        folder = self.library / tid
        tmp = self.library / f".{tid}.importing"
        if tmp.exists():
            import shutil
            shutil.rmtree(tmp, ignore_errors=True)
        (tmp / "assets").mkdir(parents=True)

        def store(blob: bytes, ext: str) -> str:
            ext = ext.lower().lstrip(".")
            if ext not in ("png", "jpg", "jpeg", "gif", "webp", "svg"):
                raise ValueError(f"unsupported media type: {ext}")
            if ext == "svg" and re.search(rb"<\s*script|on(load|click|error)\s*=|javascript:", blob, re.I):
                raise ValueError("unsafe SVG")
            fname = f"{hashlib.sha1(blob).hexdigest()[:16]}.{ext}"
            (tmp / "assets" / fname).write_bytes(blob)
            return f"/templates/assets/{tid}/{fname}"

        def read_asset(url: str) -> Optional[str]:
            p = tmp / "assets" / url.rsplit("/", 1)[-1]
            return p.read_text(encoding="utf-8", errors="ignore") if p.exists() else None

        def read_raster(url: str) -> Optional[bytes]:
            p = tmp / "assets" / url.rsplit("/", 1)[-1]
            return p.read_bytes() if p.exists() and p.suffix.lower() in (".png", ".jpg", ".jpeg", ".webp", ".gif") else None

        try:
            meta = {}
            meta_file = self.inbox / (Path(filename).stem + ".meta.json")
            if meta_file.exists():
                meta = json.loads(meta_file.read_text(encoding="utf-8"))
            t = import_template(data, filename, store, template_id=tid, name=name or meta.get("name"),
                                content_slide=content_slide if content_slide is not None else meta.get("contentSlideIndex"),
                                read_asset=read_asset, read_raster=read_raster)
            (tmp / f"source{Path(filename).suffix.lower()}").write_bytes(data)
            (tmp / "template.json").write_text(json.dumps(t, indent=2, ensure_ascii=False), encoding="utf-8")
        except Exception:
            import shutil
            shutil.rmtree(tmp, ignore_errors=True)
            raise
        import shutil
        if folder.exists():
            shutil.rmtree(folder)
        tmp.rename(folder)
        return t

    def rescan(self) -> dict:
        """Import every inbox file that has no library entry yet (matched by sha256)."""
        known = {(self.get(t) or {}).get("source", {}).get("sha256") for t in self.ids()}
        imported, self.errors = [], {}
        for f in sorted(self.inbox.iterdir()):
            if f.name.startswith(".") or f.suffix.lower() not in (".pptx", ".pdf"):
                continue
            data = f.read_bytes()
            if hashlib.sha256(data).hexdigest() in known:
                continue
            try:
                t = self.import_bytes(data, f.name)
                imported.append(t["id"])
                known.add(t["source"]["sha256"])
            except Exception as e:
                self.errors[f.name] = str(e)
        if imported and not self.get_default():
            self.set_default(sorted(self.ids())[0])
        return {"imported": imported, "errors": self.errors}

    def delete(self, tid: str) -> bool:
        folder = self.library / tid
        if not re.fullmatch(r"[a-z0-9_-]{1,40}", tid or "") or not folder.exists():
            return False
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
        folder.rename(self.trash / f"{tid}-{stamp}")
        if self._settings().get("defaultTemplate") == tid:
            self.set_default(None)
        return True

    def asset_path(self, tid: str, fname: str) -> Optional[Path]:
        if not re.fullmatch(r"[a-z0-9_-]{1,40}", tid or "") or not re.fullmatch(r"[A-Za-z0-9_.-]{1,80}", fname or ""):
            return None
        p = (self.library / tid / "assets" / fname).resolve()
        base = (self.library / tid / "assets").resolve()
        return p if base in p.parents and p.is_file() else None

    def preview_path(self, tid: str, role: str) -> Optional[Path]:
        if role not in ("title", "content", "thankyou") or not re.fullmatch(r"[a-z0-9_-]{1,40}", tid or ""):
            return None
        p = self.library / tid / f"preview_{role}.png"
        return p if p.is_file() else None
