"""pptx_exporter.py — Export slide decks to native editable PowerPoint (.pptx) objects.

Uses python-pptx to generate true editable PowerPoint presentations:
- 16:9 widescreen layout (13.333 x 7.5 in)
- Proportional canvas mapping from 1920x1080 to PowerPoint coordinates
- Native textboxes with word wrap, font families, colors, weights, line spacing
- Native bullet points with symbols and formatting
- Native PowerPoint tables with styled headers, alternating rows, borders, and column widths
- Native cards: rounded rectangle auto-shape + title/body textboxes + optional picture
- Native auto-shapes (rectangles, rounded rectangles, circles/ellipses)
- Pictures from disk/data URLs; SVG rasterized at 2x via Playwright headless screenshot
- Video poster card with hyperlink to video URL
- Legacy split containers rendered as styled background shapes
- Speaker notes attached to slide.notes
- Fallback: only per element as an image when unsupported, or per slide on fatal error
"""

import io
import os
import re
import base64
import html
from pathlib import Path
from typing import Optional, Dict, Any, List, Tuple

from pptx import Presentation
from pptx.util import Inches, Pt
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
from pptx.enum.shapes import MSO_SHAPE


# 1920x1080 canvas mapping to 13.333 x 7.5 in
SLIDE_WIDTH_IN = 13.333333
SLIDE_HEIGHT_IN = 7.5
CANVAS_WIDTH = 1920.0
CANVAS_HEIGHT = 1080.0
SCALE_X = SLIDE_WIDTH_IN / CANVAS_WIDTH
SCALE_Y = SLIDE_HEIGHT_IN / CANVAS_HEIGHT


def apply_gradient_text(paragraph, stops) -> bool:
    """Gradient text fill (template key figures) on every run of the paragraph. False if not applicable."""
    if not isinstance(stops, list) or len(stops) < 2:
        return False
    from pptx.oxml.ns import qn
    from lxml import etree
    colours = [str(parse_color_hex_or_rgb(c)) for c in stops]
    for run in paragraph.runs:
        r_pr = run._r.get_or_add_rPr()
        for old in r_pr.findall(qn("a:solidFill")) + r_pr.findall(qn("a:gradFill")):
            r_pr.remove(old)
        grad = etree.SubElement(r_pr, qn("a:gradFill"))
        gs_lst = etree.SubElement(grad, qn("a:gsLst"))
        for i, c in enumerate(colours):
            gs = etree.SubElement(gs_lst, qn("a:gs"), pos=str(round(i * 100000 / (len(colours) - 1))))
            etree.SubElement(gs, qn("a:srgbClr"), val=c)
        etree.SubElement(grad, qn("a:lin"), ang="0", scaled="0")
        # fill must come before the font elements in rPr
        r_pr.remove(grad)
        r_pr.insert(0 if r_pr.find(qn("a:ln")) is None else 1, grad)
    return True


def px_to_inches(px: float) -> Inches:
    return Inches(px * SCALE_X)

def px_y_to_inches(py: float) -> Inches:
    return Inches(py * SCALE_Y)

def parse_color_hex_or_rgb(col: Optional[str], default_rgb=(255, 255, 255)) -> RGBColor:
    if not col or not isinstance(col, str):
        return RGBColor(*default_rgb)
    col = col.strip().lower()
    if col.startswith("#"):
        hex_str = col.lstrip("#")
        if len(hex_str) == 3:
            hex_str = "".join(c * 2 for c in hex_str)
        if len(hex_str) == 6:
            try:
                r = int(hex_str[0:2], 16)
                g = int(hex_str[2:4], 16)
                b = int(hex_str[4:6], 16)
                return RGBColor(r, g, b)
            except ValueError:
                pass
    elif col.startswith("rgb"):
        m = re.search(r"rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)", col)
        if m:
            try:
                return RGBColor(int(m.group(1)), int(m.group(2)), int(m.group(3)))
            except ValueError:
                pass
    return RGBColor(*default_rgb)


def clean_font_name(font_str: Optional[str], default_font: str = "Calibri") -> str:
    if not font_str or not isinstance(font_str, str):
        return default_font
    # Extract first font in comma-separated list and strip quotes
    first = font_str.split(",")[0].strip().strip("'\"")
    return first if first else default_font


class _SvgRasterizer:
    """Renders SVGs to PNG at 2x with ONE headless Chromium for a whole export, with a cache:
    decks imported from templates can hold hundreds of small SVGs (icons, freeform shapes)."""

    def __init__(self):
        self._pw = None
        self._browser = None
        self._cache: Dict[str, Optional[bytes]] = {}

    def render(self, svg: str) -> Optional[bytes]:
        if svg in self._cache:
            return self._cache[svg]
        png = None
        try:
            if self._browser is None:
                from playwright.sync_api import sync_playwright
                self._pw = sync_playwright().start()
                self._browser = self._pw.chromium.launch()
            w, h = _svg_size(svg)
            page = self._browser.new_page(viewport={"width": w, "height": h}, device_scale_factor=2)
            try:
                page.set_content("<!doctype html><html><body style='margin:0;background:transparent;'>"
                                 f"<img id='i' style='display:block;width:{w}px;height:{h}px' "
                                 f"src='data:image/svg+xml;base64,{base64.b64encode(svg.encode('utf-8')).decode()}'>"
                                 "</body></html>")
                page.wait_for_function("document.getElementById('i').complete", timeout=5000)
                png = page.query_selector("#i").screenshot(omit_background=True)
            finally:
                page.close()
        except Exception:
            png = None
        self._cache[svg] = png
        return png

    def close(self):
        try:
            if self._browser is not None:
                self._browser.close()
            if self._pw is not None:
                self._pw.stop()
        except Exception:
            pass
        self._browser = self._pw = None


def _svg_size(svg: str) -> Tuple[int, int]:
    """Pixel size of an SVG from its width/height (or viewBox), clamped to 1..4000."""
    start = svg.find("<svg")
    root = svg[start:svg.find(">", start) + 1] if start >= 0 else ""

    def num(attr):
        m = re.search(r'(?<![-\w])' + attr + r'\s*=\s*["\']\s*([0-9.]+)', root)
        return float(m.group(1)) if m else None
    w, h = num("width"), num("height")
    if not (w and h):
        m = re.search(r'viewBox\s*=\s*["\']\s*[-0-9.]+[ ,]+[-0-9.]+[ ,]+([0-9.]+)[ ,]+([0-9.]+)', root)
        if m:
            w, h = float(m.group(1)), float(m.group(2))
    w, h = w or 800, h or 800
    return max(1, min(4000, round(w))), max(1, min(4000, round(h)))


_rasterizer: Optional[_SvgRasterizer] = None


def rasterize_svg_with_playwright(svg_bytes_or_str: str) -> Optional[bytes]:
    """Rasterize SVG text to PNG at 2x (shared browser during an export).
    PowerPoint pictures cannot be SVG: without this, diagrams and SVG template decor are lost."""
    if _rasterizer is not None:
        return _rasterizer.render(svg_bytes_or_str)
    one_off = _SvgRasterizer()
    try:
        return one_off.render(svg_bytes_or_str)
    finally:
        one_off.close()


# Folders used to resolve local image URLs. The server sets UPLOADS_DIR / TEMPLATES_DIR to the
# folders it really serves (they can be moved by SAVES_DIR-style settings and in tests).
PROJECT_ROOT = Path(__file__).resolve().parent
UPLOADS_DIR: Optional[Path] = None
TEMPLATES_DIR: Optional[Path] = None


def export_deck_to_pptx(project: Dict[str, Any], output_path: Path) -> Tuple[bool, List[str]]:
    """Export an entire project dictionary to a native PowerPoint presentation (.pptx).
    Returns (success_bool, warnings_list)."""
    prs = Presentation()
    prs.slide_width = Inches(SLIDE_WIDTH_IN)
    prs.slide_height = Inches(SLIDE_HEIGHT_IN)

    theme = project.get("theme", {})
    slides_data = project.get("slides", [])
    warnings: List[str] = []

    global _rasterizer
    _rasterizer = _SvgRasterizer()
    try:
        _export_slides(prs, slides_data, theme, warnings)
    finally:
        _rasterizer.close()
        _rasterizer = None

    output_path.parent.mkdir(parents=True, exist_ok=True)
    prs.save(str(output_path))
    return True, warnings


def _export_slides(prs, slides_data, theme, warnings: List[str]):
    blank_layout = prs.slide_layouts[6]  # Blank slide
    for s_idx, slide in enumerate(slides_data):
        slide_obj = prs.slides.add_slide(blank_layout)

        # 1. Slide Background
        apply_slide_background(slide_obj, slide, theme)

        # 2. Speaker notes
        notes_text = slide.get("notes")
        if notes_text:
            notes_slide = slide_obj.notes_slide
            tf = notes_slide.notes_text_frame
            tf.text = str(notes_text)

        # 3. Slide Elements (sort by zIndex if present)
        elements = list(slide.get("elements", []))
        elements.sort(key=lambda el: el.get("zIndex", 0))

        for el in elements:
            try:
                before = len(slide_obj.shapes)
                render_native_element(slide_obj, el, theme)
                apply_rotation(slide_obj, before, el)
            except Exception as e:
                warnings.append(f"Slide #{s_idx + 1} élément {el.get('type')}: rendu alternatif ({e})")
                try:
                    # Fallback single element as shape/box
                    render_fallback_box(slide_obj, el, theme)
                except Exception:
                    pass


def apply_rotation(slide_obj, first_new_index: int, el: Dict[str, Any]):
    """Rotate the shapes just created for an element (each around its own center)."""
    rot = float(el.get("rotation") or 0) % 360
    if not rot:
        return
    for shape in list(slide_obj.shapes)[first_new_index:]:
        try:
            shape.rotation = rot
        except Exception:
            pass  # e.g. tables cannot be rotated in PowerPoint


def apply_slide_background(slide_obj, slide: Dict[str, Any], theme: Dict[str, Any]):
    bg_info = theme.get("background") or {}
    bg_color_hex = theme.get("bg") or "#0f172a"

    if isinstance(bg_info, dict) and bg_info.get("type") == "solid":
        bg_color_hex = bg_info.get("color") or bg_color_hex

    # PowerPoint slide background fill
    bg = slide_obj.background
    fill = bg.fill
    fill.solid()
    fill.fore_color.rgb = parse_color_hex_or_rgb(bg_color_hex, (15, 23, 42))

    # If background image is present, add full-slide image
    if isinstance(bg_info, dict) and bg_info.get("type") == "image" and bg_info.get("dataurl"):
        try:
            dataurl = bg_info.get("dataurl", "")
            img_bytes = decode_data_url(dataurl)
            if img_bytes:
                img_stream = io.BytesIO(img_bytes)
                slide_obj.shapes.add_picture(img_stream, Inches(0), Inches(0), Inches(SLIDE_WIDTH_IN), Inches(SLIDE_HEIGHT_IN))
        except Exception:
            pass


def decode_data_url(dataurl: str) -> Optional[bytes]:
    if not dataurl or not isinstance(dataurl, str):
        return None
    if "," in dataurl:
        b64_part = dataurl.split(",", 1)[1]
        try:
            return base64.b64decode(b64_part)
        except Exception:
            return None
    return None


def _local_image_path(src: str) -> Optional[Path]:
    """/uploads/<file> and /templates/assets/<id>/<file> (as served by server.py) to a file on disk."""
    clean = src.split("?", 1)[0].lstrip("/")
    name = Path(clean).name
    candidates = []
    if clean.startswith("uploads/"):
        candidates.append((UPLOADS_DIR or PROJECT_ROOT / "uploads") / clean[len("uploads/"):])
    parts = clean.split("/")
    if len(parts) == 4 and parts[0] == "templates" and parts[1] == "assets":
        base = TEMPLATES_DIR or Path(os.environ.get("TEMPLATES_DIR", str(PROJECT_ROOT / "templates")))
        candidates.append(base / "library" / parts[2] / "assets" / parts[3])
    candidates += [PROJECT_ROOT / clean, Path(src), Path(clean)]
    for c in candidates:
        try:
            if c.is_file() and name and ".." not in Path(clean).parts:
                return c
        except OSError:
            continue
    return None


def _as_picture(data: bytes, is_svg: bool) -> Optional[io.BytesIO]:
    if is_svg:
        png = rasterize_svg_with_playwright(data.decode("utf-8", errors="ignore"))
        return io.BytesIO(png) if png else None
    return io.BytesIO(data)


def get_image_stream(src: str) -> Optional[io.BytesIO]:
    """Image bytes for a picture: data URL, http(s) URL or local /uploads, /templates/assets path.
    SVGs are rasterized to PNG (PowerPoint pictures cannot be SVG)."""
    if not src:
        return None
    try:
        if src.startswith("data:"):
            raw = decode_data_url(src)
            return _as_picture(raw, "image/svg+xml" in src[:40]) if raw else None
        if src.startswith(("http://", "https://")):
            import urllib.request
            req = urllib.request.Request(src, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=10) as resp:
                return _as_picture(resp.read(), src.lower().split("?")[0].endswith(".svg"))
        p = _local_image_path(src)
        if p:
            return _as_picture(p.read_bytes(), p.suffix.lower() == ".svg")
    except Exception:
        return None
    return None


def render_native_element(slide_obj, el: Dict[str, Any], theme: Dict[str, Any]):
    el_type = el.get("type", "text")
    x = px_to_inches(float(el.get("x", 0)))
    y = px_y_to_inches(float(el.get("y", 0)))
    w = px_to_inches(float(el.get("width", 200)))
    h = px_y_to_inches(float(el.get("height", 100)))

    if el_type == "text":
        render_native_text(slide_obj, el, theme, x, y, w, h)
    elif el_type == "bullets":
        render_native_bullets(slide_obj, el, theme, x, y, w, h)
    elif el_type == "table":
        render_native_table(slide_obj, el, theme, x, y, w, h)
    elif el_type == "card":
        render_native_card(slide_obj, el, theme, x, y, w, h)
    elif el_type == "shape":
        render_native_shape(slide_obj, el, theme, x, y, w, h)
    elif el_type == "image":
        render_native_image(slide_obj, el, theme, x, y, w, h)
    elif el_type == "video":
        render_native_video(slide_obj, el, theme, x, y, w, h)
    elif el_type == "split":
        render_native_split(slide_obj, el, theme, x, y, w, h)
    else:
        render_fallback_box(slide_obj, el, theme)


def render_native_text(slide_obj, el: Dict[str, Any], theme: Dict[str, Any], x, y, w, h):
    tx_box = slide_obj.shapes.add_textbox(x, y, w, h)
    tf = tx_box.text_frame
    tf.word_wrap = True
    tf.margin_left = Inches(0.05)
    tf.margin_right = Inches(0.05)
    tf.margin_top = Inches(0.05)
    tf.margin_bottom = Inches(0.05)

    content = str(el.get("content", ""))
    lines = content.split("\n") if content else [""]
    font_name = clean_font_name(el.get("fontFamily") or theme.get("fontBody"), "Calibri")
    font_size_pt = float(el.get("fontSize", 24)) * 0.75  # 1px approx 0.75pt
    color_rgb = parse_color_hex_or_rgb(el.get("color") or theme.get("text", "#ffffff"))
    align_str = el.get("textAlign", "left")

    align_map = {
        "left": PP_ALIGN.LEFT,
        "center": PP_ALIGN.CENTER,
        "right": PP_ALIGN.RIGHT,
        "justify": PP_ALIGN.JUSTIFY,
    }
    pp_align = align_map.get(align_str, PP_ALIGN.LEFT)

    is_bold = (str(el.get("fontWeight", "normal")) in ("bold", "700", "800", "900") or
               int(el.get("fontWeight", 400) if str(el.get("fontWeight", "")).isdigit() else 400) >= 700)
    is_italic = el.get("fontStyle") == "italic"
    is_underline = el.get("textDecoration") == "underline"

    for i, line_text in enumerate(lines):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.alignment = pp_align
        p.text = line_text
        p.font.name = font_name
        p.font.size = Pt(font_size_pt)
        p.font.color.rgb = color_rgb
        p.font.bold = is_bold
        p.font.italic = is_italic
        p.font.underline = is_underline
        apply_gradient_text(p, el.get("colorGradient"))
        link = el.get("link")
        if isinstance(link, str) and re.match(r"^(https?://|mailto:)\S+$", link, re.I):
            for run in p.runs:
                run.hyperlink.address = link
        if el.get("lineHeight"):
            try:
                p.line_spacing = float(el.get("lineHeight"))
            except Exception:
                pass


def render_native_bullets(slide_obj, el: Dict[str, Any], theme: Dict[str, Any], x, y, w, h):
    tx_box = slide_obj.shapes.add_textbox(x, y, w, h)
    tf = tx_box.text_frame
    tf.word_wrap = True
    tf.margin_left = Inches(0.05)
    tf.margin_right = Inches(0.05)
    tf.margin_top = Inches(0.05)
    tf.margin_bottom = Inches(0.05)

    items = el.get("items", [])
    bullet_style = el.get("bulletStyle", "disc")
    font_name = clean_font_name(el.get("fontFamily") or theme.get("fontBody"), "Calibri")
    font_size_pt = float(el.get("fontSize", 24)) * 0.75
    color_rgb = parse_color_hex_or_rgb(el.get("color") or theme.get("text", "#ffffff"))

    for i, item_text in enumerate(items):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        prefix = "• " if bullet_style == "disc" else (f"{i+1}. " if bullet_style == "number" else "✓ ")
        p.text = prefix + str(item_text)
        p.font.name = font_name
        p.font.size = Pt(font_size_pt)
        p.font.color.rgb = color_rgb
        if el.get("lineHeight"):
            try:
                p.line_spacing = float(el.get("lineHeight"))
            except Exception:
                pass


def render_native_table(slide_obj, el: Dict[str, Any], theme: Dict[str, Any], x, y, w, h):
    cols = el.get("columns", ["Col 1", "Col 2"])
    rows = el.get("rows", [["A", "B"]])
    num_cols = max(len(cols), 1)
    num_rows = len(rows) + 1  # Header + rows

    table_shape = slide_obj.shapes.add_table(num_rows, num_cols, x, y, w, h)
    tbl = table_shape.table

    # Fills & colors
    header_fill_rgb = parse_color_hex_or_rgb(el.get("headerFill") or theme.get("primary", "#6366f1"))
    header_color_rgb = parse_color_hex_or_rgb(el.get("headerColor", "#ffffff"))
    row_fill_rgb = parse_color_hex_or_rgb(el.get("rowFill") or "rgba(255,255,255,0.03)", (30, 41, 59))
    alt_row_fill_rgb = parse_color_hex_or_rgb(el.get("altRowFill") or "rgba(255,255,255,0.06)", (51, 65, 85))
    text_color_rgb = parse_color_hex_or_rgb(theme.get("text", "#ffffff"))
    font_name = clean_font_name(theme.get("fontBody"), "Calibri")
    font_size_pt = float(el.get("fontSize", 18)) * 0.75

    # Column widths
    col_widths = el.get("colWidths")
    if col_widths and len(col_widths) == num_cols:
        total_cw = sum(col_widths)
        for c_idx, cw in enumerate(col_widths):
            tbl.columns[c_idx].width = Inches(float(w) * (cw / total_cw))

    # Header Row
    for c_idx, col_name in enumerate(cols):
        cell = tbl.cell(0, c_idx)
        cell.fill.solid()
        cell.fill.fore_color.rgb = header_fill_rgb
        cell.vertical_anchor = MSO_ANCHOR.MIDDLE
        p = cell.text_frame.paragraphs[0]
        p.text = str(col_name)
        p.alignment = PP_ALIGN.LEFT
        p.font.name = font_name
        p.font.size = Pt(font_size_pt)
        p.font.bold = True
        p.font.color.rgb = header_color_rgb

    # Data Rows
    for r_idx, row_data in enumerate(rows):
        fill_rgb = alt_row_fill_rgb if (r_idx % 2 == 1) else row_fill_rgb
        for c_idx in range(num_cols):
            cell = tbl.cell(r_idx + 1, c_idx)
            cell.fill.solid()
            cell.fill.fore_color.rgb = fill_rgb
            cell.vertical_anchor = MSO_ANCHOR.MIDDLE
            val = str(row_data[c_idx]) if c_idx < len(row_data) else ""
            p = cell.text_frame.paragraphs[0]
            p.text = val
            p.alignment = PP_ALIGN.LEFT
            p.font.name = font_name
            p.font.size = Pt(font_size_pt)
            p.font.color.rgb = text_color_rgb


def render_native_card(slide_obj, el: Dict[str, Any], theme: Dict[str, Any], x, y, w, h):
    # Rounded rectangle background
    bg_shape = slide_obj.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, x, y, w, h)
    bg_fill_rgb = parse_color_hex_or_rgb(el.get("fill") or "rgba(255,255,255,0.05)", (30, 41, 59))
    bg_shape.fill.solid()
    bg_shape.fill.fore_color.rgb = bg_fill_rgb
    border_color = parse_color_hex_or_rgb(theme.get("primary", "#6366f1"))
    bg_shape.line.color.rgb = border_color
    bg_shape.line.width = Pt(1)

    cur_y = y + Inches(0.15)
    card_img = el.get("image")
    if card_img:
        img_stream = get_image_stream(card_img)
        if img_stream:
            try:
                img_h = Inches(1.2)
                img_w = w - Inches(0.3)
                slide_obj.shapes.add_picture(img_stream, x + Inches(0.15), cur_y, img_w, img_h)
                cur_y += img_h + Inches(0.1)
            except Exception:
                pass

    # Card Title
    title = str(el.get("title", ""))
    if title:
        tx_title = slide_obj.shapes.add_textbox(x + Inches(0.15), cur_y, w - Inches(0.3), Inches(0.4))
        tf_t = tx_title.text_frame
        tf_t.word_wrap = True
        p_t = tf_t.paragraphs[0]
        p_t.text = title
        p_t.font.name = clean_font_name(theme.get("fontHeading"), "Calibri")
        p_t.font.size = Pt(float(el.get("titleSize") or 22) * 0.75)
        p_t.font.bold = True
        p_t.font.color.rgb = parse_color_hex_or_rgb(el.get("titleColor") or theme.get("primary", "#6366f1"))
        apply_gradient_text(p_t, el.get("titleGradient"))
        cur_y += Inches(max(0.4, float(el.get("titleSize") or 22) * 1.3 * SCALE_Y))

    # Card Body text
    body = str(el.get("text", ""))
    if body:
        tx_body = slide_obj.shapes.add_textbox(x + Inches(0.15), cur_y, w - Inches(0.3), h - (cur_y - y) - Inches(0.1))
        tf_b = tx_body.text_frame
        tf_b.word_wrap = True
        p_b = tf_b.paragraphs[0]
        p_b.text = body
        p_b.font.name = clean_font_name(theme.get("fontBody"), "Calibri")
        p_b.font.size = Pt(13)
        p_b.font.color.rgb = parse_color_hex_or_rgb(theme.get("text", "#cbd5e1"))


def render_native_shape(slide_obj, el: Dict[str, Any], theme: Dict[str, Any], x, y, w, h):
    st = el.get("shapeType", "rectangle")
    if st == "path" and isinstance(el.get("pathData"), list):
        # The editor keeps imported freeforms/preset paths editable as vectors.
        # PowerPoint has no one-to-one native API for every DrawingML preset, so
        # export the currently edited fill/stroke as a high-fidelity SVG picture.
        svg = editable_path_svg(el)
        png = rasterize_svg_with_playwright(svg)
        if png:
            slide_obj.shapes.add_picture(io.BytesIO(png), x, y, w, h)
            return
    shape_type = MSO_SHAPE.OVAL if st == "circle" else MSO_SHAPE.RECTANGLE
    corner_radius = max(0.0, float(el.get("borderRadius", 0) or 0))
    if st == "rectangle" and corner_radius > 0:
        shape_type = MSO_SHAPE.ROUNDED_RECTANGLE

    shape = slide_obj.shapes.add_shape(shape_type, x, y, w, h)
    if shape_type == MSO_SHAPE.ROUNDED_RECTANGLE:
        # DrawingML represents a rounded rectangle's corner as a fraction of
        # its shortest side.  The canvas stores an intuitive pixel radius.
        # Preserve it instead of using PowerPoint's fixed default rounding.
        # `w` and `h` are PowerPoint EMUs while `borderRadius` is a 1920×1080
        # canvas pixel value.  Calculate from the source element dimensions so
        # the units remain comparable.
        shortest_side = min(float(el.get("width", 0) or 0), float(el.get("height", 0) or 0))
        if shortest_side > 0:
            adjustment = min(0.5, corner_radius / shortest_side)
            try:
                shape.adjustments[0] = adjustment
            except (AttributeError, IndexError, TypeError, ValueError):
                # Older python-pptx versions still export a valid rounded rect,
                # albeit at PowerPoint's default radius.
                pass
    fill_col = el.get("fill")
    if fill_col and fill_col != "transparent":
        shape.fill.solid()
        shape.fill.fore_color.rgb = parse_color_hex_or_rgb(fill_col, (99, 102, 241))
    else:
        shape.fill.background()

    stroke_col = el.get("stroke")
    if stroke_col and stroke_col != "transparent":
        shape.line.color.rgb = parse_color_hex_or_rgb(stroke_col, (255, 255, 255))
        shape.line.width = Pt(float(el.get("strokeWidth", 2)))
    else:
        shape.line.fill.background()


def editable_path_svg(el: Dict[str, Any]) -> str:
    """Create SVG for an editable imported path using its current style values."""
    width = max(1.0, float(el.get("pathWidth") or el.get("width") or 1))
    height = max(1.0, float(el.get("pathHeight") or el.get("height") or 1))
    radius = max(0.0, min(float(el.get("borderRadius", 0) or 0), width / 2, height / 2))
    fill = html.escape(str(el.get("fill") or "transparent"), quote=True)
    stroke = html.escape(str(el.get("stroke") or "transparent"), quote=True)
    stroke_width = max(0.0, float(el.get("strokeWidth", 0) or 0))
    stroke_style = el.get("strokeStyle", "solid")
    dash = ""
    if stroke_width and stroke_style == "dashed":
        dash = f' stroke-dasharray="{stroke_width * 4:g} {stroke_width * 3:g}"'
    elif stroke_width and stroke_style == "dotted":
        dash = f' stroke-dasharray="{stroke_width:g} {stroke_width * 2:g}"'
    flip_h, flip_v = bool(el.get("pathFlipH")), bool(el.get("pathFlipV"))
    transform = ""
    if flip_h or flip_v:
        transform = f' transform="translate({width if flip_h else 0:g} {height if flip_v else 0:g}) scale({-1 if flip_h else 1} {-1 if flip_v else 1})"'
    paths = []
    for path in el.get("pathData", []):
        if not isinstance(path, dict) or not path.get("d"):
            continue
        d = html.escape(str(path["d"]), quote=True)
        path_fill = "none" if path.get("noFill") and not el.get("pathStyleOverride") else fill
        path_stroke = "none" if (path.get("noStroke") and not el.get("pathStyleOverride")) or not stroke_width else stroke
        paths.append(f'<path d="{d}" fill="{path_fill}" stroke="{path_stroke}" stroke-width="{stroke_width:g}" '
                     f'stroke-linejoin="round"{dash if path_stroke != "none" else ""}/>')
    defs = f'<defs><clipPath id="shape-clip"><rect width="{width:g}" height="{height:g}" rx="{radius:g}" ry="{radius:g}"/></clipPath></defs>' if radius else ""
    clip = ' clip-path="url(#shape-clip)"' if radius else ""
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{width:g}" height="{height:g}" '
            f'viewBox="0 0 {width:g} {height:g}" preserveAspectRatio="none">{defs}<g{transform}{clip}>'
            f'{"".join(paths)}</g></svg>')


def render_native_image(slide_obj, el: Dict[str, Any], theme: Dict[str, Any], x, y, w, h):
    src = el.get("src", "")
    stream = get_image_stream(src)
    if stream:
        slide_obj.shapes.add_picture(stream, x, y, w, h)
    else:
        render_fallback_box(slide_obj, el, theme)


def render_native_video(slide_obj, el: Dict[str, Any], theme: Dict[str, Any], x, y, w, h):
    # Video poster card with clickable link
    shape = slide_obj.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, x, y, w, h)
    shape.fill.solid()
    shape.fill.fore_color.rgb = RGBColor(15, 23, 42)
    shape.line.color.rgb = parse_color_hex_or_rgb(theme.get("primary", "#6366f1"))
    shape.line.width = Pt(1)

    tf = shape.text_frame
    tf.word_wrap = True
    p = tf.paragraphs[0]
    p.alignment = PP_ALIGN.CENTER
    p.text = "▶ Lecteur Vidéo"
    p.font.size = Pt(18)
    p.font.bold = True
    p.font.color.rgb = RGBColor(255, 255, 255)

    src = el.get("src", "")
    if src:
        p2 = tf.add_paragraph()
        p2.alignment = PP_ALIGN.CENTER
        p2.text = f"Cliquez pour visionner la vidéo ({src[:40]}...)"
        p2.font.size = Pt(12)
        p2.font.color.rgb = parse_color_hex_or_rgb(theme.get("secondary", "#a855f7"))
        if src.startswith("http://") or src.startswith("https://"):
            p2.hyperlink.address = src


def render_native_split(slide_obj, el: Dict[str, Any], theme: Dict[str, Any], x, y, w, h):
    shape = slide_obj.shapes.add_shape(MSO_SHAPE.RECTANGLE, x, y, w, h)
    shape.fill.solid()
    shape.fill.fore_color.rgb = RGBColor(20, 25, 40)
    shape.line.color.rgb = parse_color_hex_or_rgb(theme.get("primary", "#6366f1"))
    shape.line.width = Pt(1)


def render_fallback_box(slide_obj, el: Dict[str, Any], theme: Dict[str, Any]):
    x = px_to_inches(float(el.get("x", 0)))
    y = px_y_to_inches(float(el.get("y", 0)))
    w = px_to_inches(float(el.get("width", 200)))
    h = px_y_to_inches(float(el.get("height", 100)))
    shape = slide_obj.shapes.add_shape(MSO_SHAPE.RECTANGLE, x, y, w, h)
    shape.fill.solid()
    shape.fill.fore_color.rgb = RGBColor(30, 41, 59)
    shape.line.color.rgb = RGBColor(100, 116, 139)
    tf = shape.text_frame
    p = tf.paragraphs[0]
    p.text = f"[{el.get('type', 'element')}]"
    p.font.size = Pt(12)
    p.font.color.rgb = RGBColor(148, 163, 184)
