"""
layout_engine.py — Server-side layout and overflow engine for RFP Slide Deck Studio.

Converts structured deck specifications (JSON blocks) into 1920x1080 canvas elements,
strictly adhering to:
- Auto-generation of title slide and thank-you + QR slide.
- Margin boundaries: x in [100, 1820], y in [100, 980].
- Block positioning: stacked vertically or 2-column layout when 2-3 short blocks.
- Overflow rules: shrinks font sizes down to minimums (bullets 24px, table 20px),
  splits into continuation slides ("Title (1/2)", "Title (2/2)"),
  and splits long tables repeating the header row.
- Non-overlapping element coordinates.
"""

import math
import re
import uuid
from typing import Dict, Any, List, Tuple


def _uuid_id(prefix="el"):
    return f"{prefix}_{uuid.uuid4().hex[:8]}"


def _normalize_theme(raw_theme: Dict[str, Any]) -> Dict[str, Any]:
    t = raw_theme or {}
    bg = t.get("background")
    bg_color = bg if isinstance(bg, str) else (bg.get("color") if isinstance(bg, dict) else "#0f172a")
    if not bg_color:
        bg_color = "#0f172a"
    return {
        "bg": bg_color,
        "primary": t.get("primary", "#6366f1"),
        "secondary": t.get("secondary", "#10b981"),
        "accent": t.get("accent", "#06b6d4"),
        "text": t.get("text", "#ffffff"),
        "textMuted": t.get("textMuted", "#94a3b8"),
        "fontHeading": t.get("fontHeading", "'Plus Jakarta Sans', sans-serif"),
        "fontBody": t.get("fontBody", "'Inter', sans-serif"),
        "background": {"type": "solid", "color": bg_color} if not isinstance(bg, dict) else bg
    }


def create_title_slide(deck_spec: Dict[str, Any], theme: Dict[str, Any]) -> Dict[str, Any]:
    name = deck_spec.get("name", "Proposition Commerciale RFP")
    client = deck_spec.get("client", "Réponse à Appel d'Offres — Dossier Technique & Financier")
    date_str = deck_spec.get("date", "2026")
    primary = theme.get("primary", "#6366f1")
    text_color = theme.get("text", "#ffffff")
    muted_color = theme.get("textMuted", "#94a3b8")

    elements = [
        {
            "id": _uuid_id("el_card"),
            "type": "shape",
            "shapeType": "rectangle",
            "fill": "rgba(255, 255, 255, 0.03)",
            "stroke": primary,
            "strokeWidth": 2,
            "strokeStyle": "solid",
            "borderRadius": 20,
            "x": 200, "y": 200,
            "width": 1520, "height": 680,
            "zIndex": 1
        },
        {
            "id": _uuid_id("el_title"),
            "type": "text",
            "content": name,
            "x": 260, "y": 300,
            "width": 1400, "height": 180,
            "fontFamily": theme.get("fontHeading", "'Plus Jakarta Sans', sans-serif"),
            "fontSize": 64,
            "fontWeight": 800,
            "color": text_color,
            "textAlign": "center",
            "zIndex": 2
        },
        {
            "id": _uuid_id("el_client"),
            "type": "text",
            "content": client,
            "x": 360, "y": 520,
            "width": 1200, "height": 80,
            "fontFamily": theme.get("fontBody", "'Inter', sans-serif"),
            "fontSize": 32,
            "fontWeight": 600,
            "color": primary,
            "textAlign": "center",
            "zIndex": 3
        },
        {
            "id": _uuid_id("el_date"),
            "type": "text",
            "content": date_str,
            "x": 560, "y": 680,
            "width": 800, "height": 60,
            "fontFamily": theme.get("fontBody", "'Inter', sans-serif"),
            "fontSize": 22,
            "fontWeight": 400,
            "color": muted_color,
            "textAlign": "center",
            "zIndex": 4
        }
    ]
    return {
        "type": "title",
        "label": "Titre & Couverture",
        "elements": elements
    }


def create_thank_you_slide(deck_spec: Dict[str, Any], theme: Dict[str, Any], qr_dataurl: str = "") -> Dict[str, Any]:
    text_color = theme.get("text", "#ffffff")
    primary = theme.get("primary", "#6366f1")
    elements = [
        {
            "id": _uuid_id("el_msg"),
            "type": "text",
            "content": "Merci pour votre confiance",
            "x": 360, "y": 240,
            "width": 1200, "height": 120,
            "fontFamily": theme.get("fontHeading", "'Plus Jakarta Sans', sans-serif"),
            "fontSize": 64,
            "fontWeight": 800,
            "color": text_color,
            "textAlign": "center",
            "zIndex": 2
        },
        {
            "id": _uuid_id("el_sub"),
            "type": "text",
            "content": "Scannez pour accéder au dossier digitalisé complet",
            "x": 460, "y": 400,
            "width": 1000, "height": 60,
            "fontFamily": theme.get("fontBody", "'Inter', sans-serif"),
            "fontSize": 26,
            "fontWeight": 500,
            "color": primary,
            "textAlign": "center",
            "zIndex": 3
        },
        {
            "id": _uuid_id("el_qr"),
            "type": "image",
            "src": qr_dataurl,
            "alt": "QR Code Dossier",
            "x": 810, "y": 500,
            "width": 300, "height": 300,
            "zIndex": 4
        }
    ]
    return {
        "type": "thankyou",
        "label": "Conclusion & Contact",
        "elements": elements
    }


# Maximum usable vertical canvas coordinates for content
CONTENT_TOP = 220
CONTENT_BOTTOM = 980
MAX_CONTENT_HEIGHT = CONTENT_BOTTOM - CONTENT_TOP  # 760px
MAX_CONTENT_WIDTH = 1720
CONTENT_LEFT = 100
CONTENT_RIGHT = CONTENT_LEFT + MAX_CONTENT_WIDTH


def estimate_block_height(block: Dict[str, Any]) -> int:
    kind = block.get("kind")
    if kind == "text":
        text = str(block.get("text", ""))
        lines = max(1, math.ceil(len(text) / 100))
        return min(260, 40 + lines * 36)
    elif kind == "note":
        return 90
    elif kind == "kpis":
        return 140
    elif kind == "bullets":
        items = block.get("items", [])
        return max(80, 20 + len(items) * 44)
    elif kind == "table":
        rows = block.get("rows", [])
        # header 50px + 45px per row
        return 60 + len(rows) * 48
    elif kind == "image":
        return 380
    elif kind == "cards":
        return 320
    return 100


def block_to_elements(block: Dict[str, Any], x: int, y: int, width: int, theme: Dict[str, Any], font_scale: float = 1.0) -> List[Dict[str, Any]]:
    kind = block.get("kind")
    primary = theme.get("primary", "#6366f1")
    text_color = theme.get("text", "#ffffff")
    font_body = theme.get("fontBody", "'Inter', sans-serif")

    if kind == "text":
        fsize = max(18, int(24 * font_scale))
        h = estimate_block_height(block)
        return [{
            "id": _uuid_id("el_text"),
            "type": "text",
            "content": block.get("text", ""),
            "x": x, "y": y,
            "width": width, "height": h,
            "fontFamily": font_body,
            "fontSize": fsize,
            "fontWeight": 400,
            "color": text_color,
            "lineHeight": 1.45,
            "zIndex": 2
        }]

    elif kind == "note":
        h = 80
        return [
            {
                "id": _uuid_id("el_note_bg"),
                "type": "shape",
                "shapeType": "rectangle",
                "fill": "rgba(99, 102, 241, 0.12)",
                "stroke": primary,
                "strokeWidth": 2,
                "strokeStyle": "solid",
                "borderRadius": 8,
                "x": x, "y": y,
                "width": width, "height": h,
                "zIndex": 1
            },
            {
                "id": _uuid_id("el_note_txt"),
                "type": "text",
                "content": f"ℹ️  {block.get('text', '')}",
                "x": x + 16, "y": y + 14,
                "width": width - 32, "height": h - 28,
                "fontFamily": font_body,
                "fontSize": 18,
                "fontWeight": 500,
                "color": text_color,
                "zIndex": 2
            }
        ]

    elif kind == "kpis":
        items = block.get("items", [])
        if not items:
            return []
        count = min(len(items), 4)
        col_w = int((width - (count - 1) * 20) / count)
        res = []
        for i, kpi in enumerate(items[:count]):
            bx = x + i * (col_w + 20)
            res.append({
                "id": _uuid_id("el_kpi_card"),
                "type": "card",
                "title": str(kpi.get("value", "")),
                "text": str(kpi.get("label", "")),
                "fill": theme.get("kpiFill") or "#182238",
                "radius": 10,
                "x": bx, "y": y,
                "width": col_w, "height": 130,
                "zIndex": 2
            })
            solid = theme.get("kpiColors")
            grads = theme.get("kpiGradients")
            if solid:
                # Solid key-figure colours chosen by hand for this template
                res[-1]["titleColor"] = solid[i % len(solid)]
                res[-1]["titleSize"] = 44
            elif grads:
                # Template key-figure colours (gradient text), in the template's order
                res[-1]["titleGradient"] = grads[i % len(grads)]
                res[-1]["titleSize"] = 44
        return res

    elif kind == "bullets":
        items = block.get("items", [])
        b_style = block.get("bulletStyle", "disc")
        # bullets minimum font size rule: 24px minimum
        fsize = max(24, int(28 * font_scale))
        h = max(80, 20 + len(items) * int(fsize * 1.6))
        return [{
            "id": _uuid_id("el_bullets"),
            "type": "bullets",
            "items": items,
            "bulletStyle": b_style,
            "fontFamily": font_body,
            "fontSize": fsize,
            "color": text_color,
            "lineHeight": 1.5,
            "autoHeight": True,
            "x": x, "y": y,
            "width": width, "height": h,
            "zIndex": 2
        }]

    elif kind == "table":
        cols = block.get("columns", [])
        rows = block.get("rows", [])
        # table minimum font size rule: 20px minimum
        fsize = max(20, int(22 * font_scale))
        h = 60 + len(rows) * int(fsize * 2.2)
        return [{
            "id": _uuid_id("el_table"),
            "type": "table",
            "columns": cols,
            "rows": rows,
            "headerFill": primary,
            "headerColor": "#ffffff",
            "rowFill": "#1e293b",
            "altRowFill": "#0f172a",
            "borderColor": "#334155",
            "fontSize": fsize,
            "x": x, "y": y,
            "width": width, "height": h,
            "zIndex": 2
        }]

    elif kind == "image":
        src = block.get("src", "")
        caption = block.get("caption")
        img_h = 320 if caption else 360
        res = [{
            "id": _uuid_id("el_img"),
            "type": "image",
            "src": src,
            "alt": caption or "Image illustration",
            "x": x, "y": y,
            "width": width, "height": img_h,
            "zIndex": 2
        }]
        if caption:
            res.append({
                "id": _uuid_id("el_cap"),
                "type": "text",
                "content": caption,
                "x": x, "y": y + img_h + 10,
                "width": width, "height": 40,
                "fontFamily": font_body,
                "fontSize": 16,
                "fontWeight": 400,
                "color": theme.get("textMuted", "#94a3b8"),
                "textAlign": "center",
                "zIndex": 3
            })
        return res

    elif kind == "cards":
        card_items = block.get("cards", [])
        if not card_items:
            return []
        count = min(len(card_items), 4)
        col_w = int((width - (count - 1) * 20) / count)
        card_h = 320
        res = []
        for i, c in enumerate(card_items[:count]):
            cx = x + i * (col_w + 20)
            res.append({
                "id": _uuid_id("el_card"),
                "type": "card",
                "title": str(c.get("title", "")),
                "text": str(c.get("text", "")),
                "image": c.get("image"),
                "fill": "#1e293b",
                "radius": 12,
                "x": cx, "y": y,
                "width": col_w, "height": card_h,
                "zIndex": 2
            })
        return res

    return []


def split_slide_blocks(slide_spec: Dict[str, Any], max_height: int = None) -> List[Dict[str, Any]]:
    """
    Analyzes slide blocks and splits into multiple slide block lists if content overflows.
    Long tables are split across multiple slides repeating header row.
    """
    capacity = max_height or MAX_CONTENT_HEIGHT
    blocks = slide_spec.get("blocks", [])
    if not blocks:
        return [{"title": slide_spec.get("title", ""), "blocks": []}]

    # First, handle long tables: split a table block that exceeds 10 rows into chunks of 10 rows
    expanded_blocks = []
    for b in blocks:
        per = b.get("rowsPerSlide") if b.get("kind") == "table" else None
        chunk_size = per if isinstance(per, int) and 1 <= per <= 10 else 10
        if b.get("kind") == "table" and len(b.get("rows", [])) > chunk_size:
            rows = b.get("rows", [])
            cols = b.get("columns", [])
            for start in range(0, len(rows), chunk_size):
                expanded_blocks.append({
                    "kind": "table",
                    "columns": cols,
                    "rows": rows[start:start + chunk_size],
                    "_is_split_table": True,
                    "_continuation": start > 0
                })
        elif b.get("kind") == "bullets" and len(b.get("items", [])) > 12:
            # A single long bullet list would run off the canvas: split it into chunks of 12 items
            items = b.get("items", [])
            for start in range(0, len(items), 12):
                chunk = dict(b)
                chunk["items"] = items[start:start + 12]
                expanded_blocks.append(chunk)
        else:
            expanded_blocks.append(b)

    # Now group blocks into slides that fit within MAX_CONTENT_HEIGHT (760px)
    slide_chunks = []
    current_chunk = []
    current_h = 0

    for b in expanded_blocks:
        bh = estimate_block_height(b)
        # Flush the current chunk if adding b exceeds capacity, or if b continues a split table
        # (a continuation always starts a new "Title (n/m)" slide)
        if current_chunk and (current_h + bh + 30 > capacity or b.get("_continuation")):
            slide_chunks.append(current_chunk)
            current_chunk = [b]
            current_h = bh
        else:
            current_chunk.append(b)
            current_h += bh + 30

    if current_chunk:
        slide_chunks.append(current_chunk)

    total_slides = len(slide_chunks)
    base_title = slide_spec.get("title", "")
    result = []
    for idx, chunk in enumerate(slide_chunks):
        if total_slides > 1:
            slide_title = f"{base_title} ({idx + 1}/{total_slides})"
        else:
            slide_title = base_title
        slide_dict = {
            "title": slide_title,
            "blocks": chunk,
            "notes": slide_spec.get("notes", ""),
            "requiresApproval": bool(slide_spec.get("requiresApproval", False)),
            "warnings": list(slide_spec.get("warnings", [])),
            "sources": slide_spec.get("sources", {})
        }
        if "assumptions" in slide_spec:
            slide_dict["assumptions"] = list(slide_spec["assumptions"])
        if "catalogDate" in slide_spec:
            slide_dict["catalogDate"] = str(slide_spec["catalogDate"])
        result.append(slide_dict)
    return result


def layout_content_slide(slide_info: Dict[str, Any], theme: Dict[str, Any], area: Dict[str, Any] = None) -> Dict[str, Any]:
    """
    Arranges blocks for a single content slide.
    Positions title at (100, 100), then places blocks vertically or in 2 columns.
    """
    title_text = slide_info.get("title", "Diapositive RFP")
    blocks = slide_info.get("blocks", [])
    # area (from a template): title box, body box and z offset; without it the defaults below
    a = area or {}
    tb = a.get("title") or {"x": CONTENT_LEFT, "y": 90, "w": MAX_CONTENT_WIDTH, "h": 90}
    body = a.get("body") or {"x": CONTENT_LEFT, "y": CONTENT_TOP, "w": MAX_CONTENT_WIDTH, "h": MAX_CONTENT_HEIGHT}
    content_left, content_top, content_width = body["x"], body["y"], body["w"]

    elements = []
    # 1. Slide Title at top
    elements.append({
        "id": _uuid_id("el_title"),
        "type": "text",
        "content": title_text,
        "x": tb["x"], "y": tb["y"],
        "width": tb["w"], "height": max(tb["h"], 60),
        "fontFamily": theme.get("fontHeading", "'Plus Jakarta Sans', sans-serif"),
        "fontSize": a.get("titleSize", 48),
        "fontWeight": 700,
        "color": theme.get("text", "#ffffff"),
        "textAlign": "left",
        "zIndex": 10
    })

    req_appr = bool(slide_info.get("requiresApproval", False))
    warns = list(slide_info.get("warnings", []))

    slide_res = {
        "type": "content",
        "label": title_text[:35],
        "elements": elements,
        "notes": slide_info.get("notes", ""),
        "requiresApproval": req_appr,
        "warnings": warns,
        "sources": slide_info.get("sources", {})
    }
    if "assumptions" in slide_info:
        slide_res["assumptions"] = list(slide_info["assumptions"])
    if "catalogDate" in slide_info:
        slide_res["catalogDate"] = str(slide_info["catalogDate"])

    if not blocks:
        return slide_res

    # Decide layout mode: 2 columns if 2 short blocks (or 3 short blocks), otherwise vertical stack
    use_2col = False
    if len(blocks) == 2:
        # If both are short, 2 columns looks great
        b1_kind = blocks[0].get("kind")
        b2_kind = blocks[1].get("kind")
        if b1_kind in ("text", "bullets", "image") and b2_kind in ("text", "bullets", "image", "cards"):
            use_2col = True

    current_y = content_top

    if use_2col:
        gap = 40
        col_w = int((content_width - gap) / 2)
        # Left column
        left_els = block_to_elements(blocks[0], content_left, current_y, col_w, theme)
        elements.extend(left_els)
        # Right column
        right_els = block_to_elements(blocks[1], content_left + col_w + gap, current_y, col_w, theme)
        elements.extend(right_els)
    else:
        # Vertical stacking with gap
        for idx, block in enumerate(blocks):
            b_height = estimate_block_height(block)
            block_els = block_to_elements(block, content_left, current_y, content_width, theme)
            elements.extend(block_els)
            current_y += b_height + 25

    if a.get("decor"):
        _apply_template_decor(slide_res, a["decor"])
    return slide_res


# ── Templates (design-only, see template_importer.py) ────────────────────
TEMPLATE_Z_OFFSET = 100   # content sits above the template decor (zIndex 1..99)
MIN_BODY_W, MIN_BODY_H = 1200, 500


def _contrast(c1: str, c2: str) -> float:
    def lum(h):
        h = str(h).lstrip("#")
        if len(h) != 6 or any(c not in "0123456789abcdefABCDEF" for c in h):
            return None
        def ch(v):
            c = int(v, 16) / 255
            return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
        return 0.2126 * ch(h[0:2]) + 0.7152 * ch(h[2:4]) + 0.0722 * ch(h[4:6])
    a, b = lum(c1), lum(c2)
    if a is None or b is None:
        return 21.0
    hi, lo = max(a, b), min(a, b)
    return (hi + 0.05) / (lo + 0.05)


def merge_template_theme(template: Dict[str, Any], deck_theme: Dict[str, Any], warnings: List[str]) -> Dict[str, Any]:
    """Template theme as the base; keys of the deck's own theme override it; text readable on bg."""
    base = dict(template.get("theme") or {})
    for k, v in (deck_theme or {}).items():
        if v:
            base[k] = v
    bg = base.get("background")
    if isinstance(bg, dict) and bg.get("type") == "image" and bg.get("url") and not bg.get("dataurl"):
        base["background"] = {"type": "image", "dataurl": bg["url"]}
    theme = _normalize_theme(base)
    for k in ("text", "textMuted", "kpiGradients", "kpiFill", "kpiColors"):
        if k in base:
            theme[k] = base[k]
    if _contrast(theme["text"], theme["bg"]) < 4.5:
        new = "#FFFFFF" if _contrast("#FFFFFF", theme["bg"]) >= _contrast("#0F172A", theme["bg"]) else "#0F172A"
        warnings.append(f"Template: couleur de texte {theme['text']} remplacée par {new} (contraste insuffisant)")
        theme["text"] = new
    return theme


def _apply_template_decor(slide: Dict[str, Any], decor: List[Dict[str, Any]]) -> None:
    """Template decor first (locked, zIndex 1..99), the slide's own elements above it."""
    for el in slide["elements"]:
        el["zIndex"] = TEMPLATE_Z_OFFSET + int(el.get("zIndex", 1))
    copies = []
    for i, d in enumerate(decor, start=1):
        c = dict(d)
        c["id"] = _uuid_id("el_tpl")
        c["locked"] = True
        c["zIndex"] = min(int(d.get("zIndex", i)), TEMPLATE_Z_OFFSET - 1)
        copies.append(c)
    slide["elements"] = copies + slide["elements"]


def _zone(z: Any) -> Any:
    return z if isinstance(z, dict) and all(k in z for k in ("x", "y", "w", "h")) else None


def _template_title_slide(deck_spec, theme, template):
    slide = create_title_slide(deck_spec, theme)
    zones = (template.get("zones") or {}).get("title") or {}
    els = [e for e in slide["elements"] if e.get("type") != "shape"]   # the template brings its own frame
    title_z, sub_z = _zone(zones.get("title")), _zone(zones.get("subtitle"))
    by_id = {e["id"].split("_")[1]: e for e in els}
    t, c, d = by_id.get("title"), by_id.get("client"), by_id.get("date")
    if title_z and t:
        t.update({"x": title_z["x"], "y": title_z["y"], "width": max(title_z["w"], 600),
                  "height": max(title_z["h"], 120), "textAlign": "left"})
        below = title_z["y"] + max(title_z["h"], 120) + 20
        if c:
            box = sub_z or {"x": title_z["x"], "y": below, "w": max(title_z["w"], 600), "h": 80}
            c.update({"x": box["x"], "y": box["y"], "width": max(box["w"], 600), "height": max(box["h"], 60), "textAlign": "left"})
            below = c["y"] + c["height"] + 20
        if d:
            d.update({"x": title_z["x"], "y": min(below, 1000), "width": 800, "textAlign": "left"})
    slide["elements"] = els
    _apply_template_decor(slide, (template.get("designs") or {}).get("title", []))
    return slide


def _template_thank_you_slide(deck_spec, theme, qr_dataurl, template):
    slide = create_thank_you_slide(deck_spec, theme, qr_dataurl)
    zones = (template.get("zones") or {}).get("thankyou") or {}
    title_z, qr_z = _zone(zones.get("title")), _zone(zones.get("qr"))
    for el in slide["elements"]:
        if el["id"].startswith("el_msg") and title_z:
            el.update({"x": title_z["x"], "y": title_z["y"], "width": max(title_z["w"], 800)})
        if el["id"].startswith("el_qr") and qr_z:
            side = min(qr_z["w"], qr_z["h"])
            el.update({"x": qr_z["x"], "y": qr_z["y"], "width": side, "height": side})
    _apply_template_decor(slide, (template.get("designs") or {}).get("thankyou", []))
    return slide


def template_content_area(template: Dict[str, Any], warnings: List[str]) -> Dict[str, Any]:
    zones = (template.get("zones") or {}).get("content") or {}
    body = _zone(zones.get("body"))
    if body and (body["w"] < MIN_BODY_W or body["h"] < MIN_BODY_H):
        warnings.append("Template: zone de contenu trop petite, zone par défaut utilisée")
        body = None
    if body:
        # keep the body inside the canvas with a small margin
        body = dict(body)
        body["w"] = min(body["w"], 1920 - 40 - body["x"])
        body["h"] = min(body["h"], 1080 - 40 - body["y"])
    title = _zone(zones.get("title"))
    if title:
        # The template's own header may be short ("1. VPN"): give agent titles the full body width
        width = (body["x"] + body["w"] - title["x"]) if body else (1920 - 100 - title["x"])
        title = dict(title, w=max(title["w"], width), h=max(title["h"], 64))
    return {"title": title, "body": body, "titleSize": 40,
            "decor": (template.get("designs") or {}).get("content", [])}


# ── Structured templates: cover, agenda, fixed pages, content layout, closing ───
def _copy_els(els):
    out = []
    for e in els:
        c = dict(e)
        c["id"] = _uuid_id("el_tpl")
        out.append(c)
    return out


def _fit_text(el, text, max_width, max_lines=2, min_size=20):
    """Put text in a template text box: widen up to max_width, shrink the font if needed, grow height."""
    el["content"] = text
    size = float(el.get("fontSize") or 32)
    width = max(int(el.get("width", 0)), int(max_width))
    el["width"] = width
    # 0.6 em per character: wide fonts (Montserrat, Poppins) must not overflow the estimate
    chars_per_line = lambda sz: max(1, int((width - 24) / (sz * 0.68)))
    while size > min_size and math.ceil(len(text) / chars_per_line(size)) > max_lines:
        size -= 2
    lines = max(1, math.ceil(len(text) / chars_per_line(size)))
    el["fontSize"] = int(size)
    el["height"] = max(int(el.get("height", 0)), int(lines * size * 1.25 + 16))
    return el


def _agenda_items(deck_spec, slots):
    """Agenda entries: the deck's own 'agenda', else its distinct slide titles (grouped to fit)."""
    items = [str(a).strip() for a in (deck_spec.get("agenda") or []) if str(a).strip()]
    if not items:
        for s in deck_spec.get("slides", []):
            t = re.sub(r"\s*\(\d+/\d+\)$", "", str(s.get("title", ""))).strip()
            if t and t not in items:
                items.append(t)
    if len(items) > slots and slots > 0:
        # keep the order: merge consecutive entries into the available slots
        size = math.ceil(len(items) / slots)
        items = [" · ".join(items[i:i + size]) if size > 1 and len(items[i:i + size]) == 2 else items[i]
                 for i in range(0, len(items), size)]
    return items[:slots]


def _set_page_number(els, number):
    """Real page numbers; the template's box was drawn for one digit, so it is widened to the
    left (same right edge) and right-aligned to keep "10".."99" on one line."""
    for e in els:
        if e.get("role") == "page-number":
            e["content"] = str(number)
            right = e["x"] + e.get("width", 0)
            width = max(int(e.get("width", 0)), int(float(e.get("fontSize") or 30) * 1.6) + 24)
            e.update({"x": right - width, "width": width, "textAlign": "right"})


def layout_structured(deck_spec: Dict[str, Any], qr_dataurl: str, template: Dict[str, Any], warnings: List[str]):
    st = template["structured"]
    theme = merge_template_theme(template, deck_spec.get("theme", {}), warnings)
    slides: List[Dict[str, Any]] = []

    # 1. Cover: the template's own Titre / Client / Date boxes, filled
    cover = _copy_els(st["cover"])
    values = {"ph-title": deck_spec.get("name", ""), "ph-client": deck_spec.get("client", ""), "ph-date": deck_spec.get("date", "")}
    for e in list(cover):
        role = e.get("role")
        if role in values:
            if not values[role]:
                cover.remove(e)
                continue
            _fit_text(e, values[role], min(1500, 1920 - e["x"] - 80), max_lines=3 if role == "ph-title" else 2)
    slides.append({"type": "title", "label": "Titre & Couverture", "elements": cover})

    # 2. Agenda: labels filled with the deck's sections, unused slots removed
    if st.get("agenda"):
        agenda = _copy_els(st["agenda"])
        labels = sorted([e for e in agenda if e.get("role") == "slot-label"], key=lambda e: e["slot"])
        ys = sorted({round(e["y"]) for e in labels})
        row_gap = min((b - a for a, b in zip(ys, ys[1:]) if b - a > 20), default=140)
        items = _agenda_items(deck_spec, len(labels))
        unused = {e["slot"] for e in labels if e["slot"] >= len(items)}
        agenda = [e for e in agenda if e.get("slot") not in unused]
        for e in agenda:
            if e.get("role") == "slot-label":
                # right limit: the next column's first element (its number circle), else the slide edge
                right = [o["x"] for o in agenda if "slot" in o and o["x"] > e["x"] + 50 and abs(o["y"] - e["y"]) < 400]
                bound = (min(right) - 30) if right else 1920 - 80
                # Two lines at most, and never taller than the space to the next agenda row
                size0 = float(e.get("fontSize") or 30)
                fit_size = min(size0, (row_gap - 12) / (2 * 1.25))
                e["fontSize"] = int(fit_size)
                _fit_text(e, items[e["slot"]], bound - e["x"], max_lines=2, min_size=16)
                e["height"] = min(e["height"], int(row_gap - 8))
                e["lineHeight"] = 1.15
        slides.append({"type": "blank", "label": "Sommaire", "elements": agenda})

    # 3. Fixed pages (e.g. "À propos"), as they are
    for page in st.get("fixed", []):
        slides.append({"type": "blank", "label": "À propos", "elements": _copy_els(page)})

    # 4. Content slides in the template's content layout
    title_ph = next((e for e in st["content"] if e.get("role") == "ph-slide-title"), None)
    body_ph = next((e for e in st["content"] if e.get("role") == "ph-body"), None)
    page_ph = next((e for e in st["content"] if e.get("role") == "page-number"), None)
    decor = [e for e in st["content"] if not e.get("role")]
    bottom = min(950, (page_ph["y"] - 20) if page_ph else 950)
    body = None
    if body_ph:
        bx, by = body_ph["x"], body_ph["y"]
        body = {"x": bx, "y": by, "w": 1920 - bx - max(bx, 60), "h": bottom - by}
        if body["w"] < 900 or body["h"] < 300:
            warnings.append("Template: zone « Contenu » trop petite, zone par défaut utilisée")
            body = None
    title_zone = None
    if title_ph:
        title_zone = {"x": title_ph["x"], "y": title_ph["y"], "w": min(title_ph["width"], 1920 - title_ph["x"] - 60),
                      "h": max(title_ph["height"], 64)}
    area = {"title": title_zone, "body": body, "decor": decor,
            "titleSize": int(title_ph.get("fontSize", 48)) if title_ph else 48}
    capacity = body["h"] if body else None
    for s in deck_spec.get("slides", []):
        if s.get("warnings"):
            warnings.extend(s["warnings"])
        for sub in split_slide_blocks(s, capacity):
            slide = layout_content_slide(sub, theme, area)
            for el in slide["elements"]:
                if el.get("id", "").startswith("el_title") and title_ph:
                    for k in ("fontFamily", "color", "fontWeight", "fontStyle", "textAlign"):
                        if title_ph.get(k):
                            el[k] = title_ph[k]
            if page_ph:
                pn = dict(page_ph)
                pn["id"] = _uuid_id("el_page")
                pn["zIndex"] = TEMPLATE_Z_OFFSET + 50
                slide["elements"].append(pn)
            slides.append(slide)

    # 5. Closing page, as it is
    slides.append({"type": "thankyou", "label": "Conclusion & Contact", "elements": _copy_els(st["closing"])})

    for number, slide in enumerate(slides, start=1):
        _set_page_number(slide["elements"], number)
    return theme, slides


def layout_deck(deck_spec: Dict[str, Any], qr_dataurl: str = "", template: Dict[str, Any] = None) -> Tuple[Dict[str, Any], List[str]]:
    """
    Converts complete deck_spec into project JSON format.
    Returns (project_dict, warnings_list).
    With a template (dict from templates/library/<id>/template.json): template theme and decor,
    content placed in the template's text zones.
    """
    warnings = []
    if template and template.get("structured"):
        theme, slides = layout_structured(deck_spec, qr_dataurl, template, warnings)
        project = {"name": deck_spec.get("name", "Mon RFP Commercial"), "client": deck_spec.get("client", ""),
                   "date": deck_spec.get("date", ""), "language": deck_spec.get("language", "fr"),
                   "qr_url": deck_spec.get("qr_url", ""), "theme": theme, "slides": slides,
                   "activeSlideIndex": 0, "_canvasSize": 1920, "template": template.get("id")}
        return project, warnings
    if template:
        theme = merge_template_theme(template, deck_spec.get("theme", {}), warnings)
        area = template_content_area(template, warnings)
    else:
        theme = _normalize_theme(deck_spec.get("theme", {}))
        area = None
    capacity = area["body"]["h"] if area and area.get("body") else None

    slides = []
    # 1. Title slide
    slides.append(_template_title_slide(deck_spec, theme, template) if template else create_title_slide(deck_spec, theme))

    # 2. Process content slides
    raw_slides = deck_spec.get("slides", [])
    for slide_idx, s in enumerate(raw_slides):
        sw = s.get("warnings", [])
        if sw:
            warnings.extend(sw)

        # Split if needed
        sub_slides = split_slide_blocks(s, capacity)
        for sub in sub_slides:
            content_slide = layout_content_slide(sub, theme, area)
            slides.append(content_slide)

    # 3. Thank-you + QR slide
    slides.append(_template_thank_you_slide(deck_spec, theme, qr_dataurl, template) if template
                  else create_thank_you_slide(deck_spec, theme, qr_dataurl))

    project = {
        "name": deck_spec.get("name", "Mon RFP Commercial"),
        "client": deck_spec.get("client", ""),
        "date": deck_spec.get("date", ""),
        "language": deck_spec.get("language", "fr"),
        "qr_url": deck_spec.get("qr_url", ""),
        "theme": theme,
        "slides": slides,
        "activeSlideIndex": 0,
        "_canvasSize": 1920
    }
    if template:
        project["template"] = template.get("id")
    return project, warnings


ALLOWED_DECK_FIELDS = {"name", "client", "date", "language", "qr_url", "theme", "slides", "template", "agenda"}
ALLOWED_SLIDE_FIELDS = {"type", "title", "blocks", "notes", "warnings", "requiresApproval", "sources", "assumptions", "catalogDate"}


def validate_slide_spec(slide: Any, path: str = "slide") -> List[str]:
    errors = []
    if not isinstance(slide, dict):
        return [f"{path}: must be an object"]

    # Reject unknown fields on slide
    unknown_fields = set(slide.keys()) - ALLOWED_SLIDE_FIELDS
    if unknown_fields:
        allowed_list = ", ".join(sorted(list(ALLOWED_SLIDE_FIELDS)))
        unknown_list = ", ".join(sorted(list(unknown_fields)))
        errors.append(f"{path}: unknown field(s) '{unknown_list}'. Allowed slide fields are: {allowed_list}")

    if slide.get("type") != "content":
        errors.append(f"{path}.type: must be 'content'")
    if not isinstance(slide.get("title"), str):
        errors.append(f"{path}.title: required string")
    if "requiresApproval" in slide and not isinstance(slide.get("requiresApproval"), bool):
        errors.append(f"{path}.requiresApproval: must be a boolean")
    if "assumptions" in slide:
        a = slide.get("assumptions")
        if not isinstance(a, list) or not all(isinstance(x, str) for x in a):
            errors.append(f"{path}.assumptions: must be an array of strings")
    if "catalogDate" in slide and not isinstance(slide.get("catalogDate"), str):
        errors.append(f"{path}.catalogDate: must be a string")
    if "warnings" in slide:
        w = slide.get("warnings")
        if not isinstance(w, list) or not all(isinstance(x, str) for x in w):
            errors.append(f"{path}.warnings: must be an array of strings")

    blocks = slide.get("blocks")
    if not isinstance(blocks, list):
        errors.append(f"{path}.blocks: required array")
        return errors

    allowed_kinds = {"text", "bullets", "table", "image", "cards", "note", "kpis"}
    for b_idx, block in enumerate(blocks):
        b_path = f"{path}.blocks[{b_idx}]"
        if not isinstance(block, dict):
            errors.append(f"{b_path}: must be an object")
            continue
        kind = block.get("kind")
        if not kind:
            errors.append(f"{b_path}.kind: missing block kind")
            continue
        if kind not in allowed_kinds:
            errors.append(f"{b_path}.kind: unknown block kind '{kind}'. Allowed: {sorted(list(allowed_kinds))}")
            continue

        if kind == "text":
            if not isinstance(block.get("text"), str):
                errors.append(f"{b_path}.text: required string")
        elif kind == "note":
            if not isinstance(block.get("text"), str):
                errors.append(f"{b_path}.text: required string")
        elif kind == "bullets":
            items = block.get("items")
            if not isinstance(items, list) or not all(isinstance(x, str) for x in items):
                errors.append(f"{b_path}.items: required array of strings")
            if "bulletStyle" in block and block["bulletStyle"] not in ("disc", "number", "check"):
                errors.append(f"{b_path}.bulletStyle: must be one of disc, number, check")
        elif kind == "table":
            cols = block.get("columns")
            rows = block.get("rows")
            if not isinstance(cols, list) or not all(isinstance(x, str) for x in cols):
                errors.append(f"{b_path}.columns: required array of strings")
            if not isinstance(rows, list) or not all(isinstance(r, list) and all(isinstance(c, str) for c in r) for r in rows):
                errors.append(f"{b_path}.rows: required 2D array of strings")
            if "rowsPerSlide" in block and not (isinstance(block["rowsPerSlide"], int) and not isinstance(block["rowsPerSlide"], bool) and 1 <= block["rowsPerSlide"] <= 10):
                errors.append(f"{b_path}.rowsPerSlide: must be an integer from 1 to 10")
        elif kind == "image":
            if not isinstance(block.get("src"), str) or not block.get("src"):
                errors.append(f"{b_path}.src: required string")
        elif kind == "cards":
            cards = block.get("cards")
            if not isinstance(cards, list):
                errors.append(f"{b_path}.cards: required array")
            else:
                for c_idx, c in enumerate(cards):
                    if not isinstance(c, dict) or not isinstance(c.get("title"), str) or not isinstance(c.get("text"), str):
                        errors.append(f"{b_path}.cards[{c_idx}]: requires title and text strings")
        elif kind == "kpis":
            kpis = block.get("items")
            if not isinstance(kpis, list):
                errors.append(f"{b_path}.items: required array of KPI objects")
            else:
                for k_idx, k in enumerate(kpis):
                    if not isinstance(k, dict) or "label" not in k or "value" not in k:
                        errors.append(f"{b_path}.items[{k_idx}]: requires label and value")

    return errors


def validate_deck_spec(data: Any) -> List[str]:
    errors = []
    if not isinstance(data, dict):
        return ["Root payload must be an object"]

    # Reject unknown fields on deck top-level
    unknown_fields = set(data.keys()) - ALLOWED_DECK_FIELDS
    if unknown_fields:
        allowed_list = ", ".join(sorted(list(ALLOWED_DECK_FIELDS)))
        unknown_list = ", ".join(sorted(list(unknown_fields)))
        errors.append(f"Root: unknown field(s) '{unknown_list}'. Allowed deck fields are: {allowed_list}")

    if not isinstance(data.get("name"), str) or not data.get("name").strip():
        errors.append("Root property 'name' is required and must be a non-empty string")
    slides = data.get("slides")
    if not isinstance(slides, list):
        errors.append("Root property 'slides' is required and must be an array")
        return errors
    if len(slides) == 0:
        errors.append("Deck must contain at least one slide in 'slides'")
    if "agenda" in data and (not isinstance(data["agenda"], list) or len(data["agenda"]) > 8
                             or not all(isinstance(a, str) and 0 < len(a) <= 80 for a in data["agenda"])):
        errors.append("Root property 'agenda' must be an array of at most 8 strings (1 to 80 characters)")
    if "template" in data and data["template"] is not None and (
            not isinstance(data["template"], str) or not re.fullmatch(r"[a-z0-9_-]{1,40}", data["template"])):
        errors.append("Root property 'template' must be a template id (letters, digits, - and _)")

    for s_idx, slide in enumerate(slides):
        errors.extend(validate_slide_spec(slide, f"slides[{s_idx}]"))

    return errors


