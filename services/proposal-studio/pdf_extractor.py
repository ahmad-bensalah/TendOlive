"""pdf_extractor.py — Extract theme info (colors, fonts, background) from a PDF file.

Uses pymupdf (PyMuPDF) to analyze up to the first 5 pages of a PDF:
- Renders page 1 (and 2 if present) at low resolution
- Estimates dominant background color from page corners and edges
- Clusters pixel colors deterministically to find 3-5 accent colors
- Reads embedded font list, strips subset prefixes ('ABCDEF+Arial' -> 'Arial'),
  ignores symbol/icon fonts, and maps to font fallback table
- Returns identical theme shape as PPTX extractor, plus 'approximate': True
- Handles encrypted, corrupt, scan-only, or oversized files cleanly with informative messages
"""

import re
import math
from typing import Dict, Any, List, Tuple, Optional
from collections import Counter
from PIL import Image

_FONT_FALLBACKS = {
    "calibri":           ("'Carlito', 'Calibri', sans-serif", 400),
    "arial":             ("'Arial', 'Helvetica', sans-serif", 400),
    "arial black":       ("'Arial Black', 'Gadget', sans-serif", 900),
    "times new roman":   ("'Times New Roman', 'Times', serif", 400),
    "georgia":           ("'Georgia', serif", 400),
    "verdana":           ("'Verdana', 'Geneva', sans-serif", 400),
    "tahoma":            ("'Tahoma', 'Geneva', sans-serif", 400),
    "trebuchet ms":      ("'Trebuchet MS', 'Lucida Grande', sans-serif", 400),
    "century gothic":    ("'Century Gothic', 'CenturyGothic', sans-serif", 400),
    "segoe ui":          ("'Segoe UI', 'Roboto', sans-serif", 400),
    "tt norms pro":      ("'Montserrat', 'Plus Jakarta Sans', sans-serif", 700),
    "montserrat":        ("'Montserrat', sans-serif", 600),
    "poppins":           ("'Poppins', sans-serif", 400),
    "roboto":            ("'Roboto', sans-serif", 400),
    "inter":             ("'Inter', sans-serif", 400),
    "open sans":         ("'Open Sans', sans-serif", 400),
    "lato":              ("'Lato', sans-serif", 400),
    "raleway":           ("'Raleway', sans-serif", 400),
    "plus jakarta sans": ("'Plus Jakarta Sans', sans-serif", 600),
    "outfit":            ("'Outfit', sans-serif", 400),
}

_IGNORED_FONT_KEYWORDS = [
    "symbol", "wingding", "dingbat", "icon", "glyph", "marlett", "webdings", "zapf"
]


def _resolve_font(name: str) -> Tuple[str, int]:
    if not name:
        return ("sans-serif", 400)
    key = name.strip().lower()
    if key in _FONT_FALLBACKS:
        return _FONT_FALLBACKS[key]
    for k, v in _FONT_FALLBACKS.items():
        if k in key or key in k:
            return v
    return (f"'{name}', sans-serif", 400)


def clean_font_name(raw_name: str) -> Optional[str]:
    """Clean subset prefix like ABCDEF+Arial -> Arial, and filter symbol fonts."""
    if not raw_name:
        return None
    # Strip subset tag like "ABCDEF+" or "X+"
    name = re.sub(r'^[A-Z]{6}\+', '', raw_name).strip()
    name = re.sub(r'^[A-Z0-9]{2,7}\+', '', name).strip()
    # Strip style suffixes often found in PostScript font names
    base_name = name.split(",")[0].split("-")[0].strip()
    if not base_name:
        return None
    lower = base_name.lower()
    for kw in _IGNORED_FONT_KEYWORDS:
        if kw in lower:
            return None
    return base_name


def rgb_to_hex(r: int, g: int, b: int) -> str:
    return f"#{r:02x}{g:02x}{b:02x}"


def color_distance(c1: Tuple[int, int, int], c2: Tuple[int, int, int]) -> float:
    return math.sqrt((c1[0] - c2[0])**2 + (c1[1] - c2[1])**2 + (c1[2] - c2[2])**2)


def extract_pdf_theme(pdf_bytes: bytes, max_pages: int = 5) -> Dict[str, Any]:
    """Extract theme from PDF bytes.
    Returns:
        {
            "status": "ok" | "error",
            "message": str (optional),
            "approximate": True,
            "colors": { ... },
            "fonts": { "heading": ..., "body": ... },
            "background": { "type": "solid", "color": "#..." },
            "palette": { ... },
            "notes": str
        }
    """
    try:
        import pymupdf
    except ImportError:
        try:
            import fitz as pymupdf
        except ImportError:
            return {
                "status": "error",
                "message": "La bibliothèque PyMuPDF (pymupdf) n'est pas installée sur le serveur.",
                "approximate": True,
                "background": {"type": "solid", "color": "#0f172a"},
                "fonts": {"heading": {"name": "Plus Jakarta Sans"}, "body": {"name": "Inter"}},
                "palette": {"primary": "#3b82f6", "secondary": "#10b981", "bg": "#0f172a", "text": "#ffffff"}
            }

    # Security: check size limit (25 MB)
    if len(pdf_bytes) > 25 * 1024 * 1024:
        return {
            "status": "error",
            "message": "Fichier PDF trop volumineux (limite 25 Mo dépassée).",
            "approximate": True,
        }

    try:
        doc = pymupdf.open(stream=pdf_bytes, filetype="pdf")
    except Exception as e:
        return {
            "status": "error",
            "message": f"Fichier PDF invalide ou corrompu : {e}",
            "approximate": True,
        }

    if doc.is_encrypted:
        doc.close()
        return {
            "status": "error",
            "message": "Le fichier PDF est protégé par mot de passe ou chiffré.",
            "approximate": True,
        }

    total_pages = len(doc)
    if total_pages == 0:
        doc.close()
        return {
            "status": "error",
            "message": "Le document PDF ne contient aucune page.",
            "approximate": True,
        }

    notes = []
    if total_pages > max_pages:
        notes.append(f"Seules les {max_pages} premières pages ont été analysées (sur {total_pages}).")

    pages_to_inspect = min(total_pages, max_pages)

    # 1. Render pages 1 and 2 at low resolution (dpi ~72 or scale ~0.5)
    rendered_images: List[Image.Image] = []
    font_names_found: List[str] = []

    for p_idx in range(pages_to_inspect):
        page = doc[p_idx]
        # Extract fonts
        try:
            page_fonts = page.get_fonts()
            for f in page_fonts:
                # f is a tuple: (xref, ext, type, basefont, name, encoding)
                basefont = f[3] if len(f) > 3 else ""
                clean_f = clean_font_name(basefont)
                if clean_f and clean_f not in font_names_found:
                    font_names_found.append(clean_f)
        except Exception:
            pass

        # Render first 2 pages for color analysis
        if p_idx < 2:
            try:
                pix = page.get_pixmap(dpi=72)
                img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
                # Resize to small thumbnail for fast deterministic pixel scanning
                img_small = img.resize((160, 90), Image.Resampling.LANCZOS)
                rendered_images.append(img_small)
            except Exception as e:
                notes.append(f"Impossible de rendre la page {p_idx + 1} : {e}")

    doc.close()

    if not rendered_images:
        return {
            "status": "error",
            "message": "Impossible d'extraire des images du PDF.",
            "approximate": True,
        }

    # 2. Estimate dominant background color from page corners and edges
    edge_pixels: List[Tuple[int, int, int]] = []
    for img in rendered_images:
        w, h = img.size
        # Sample corners
        corners = [
            (0, 0), (1, 0), (0, 1), (w - 1, 0), (w - 2, 0), (w - 1, 1),
            (0, h - 1), (1, h - 1), (0, h - 2), (w - 1, h - 1), (w - 2, h - 1)
        ]
        for pt in corners:
            edge_pixels.append(img.getpixel(pt))
        # Sample top and bottom edge borders
        for x in range(0, w, 5):
            edge_pixels.append(img.getpixel((x, 0)))
            edge_pixels.append(img.getpixel((x, h - 1)))
        for y in range(0, h, 5):
            edge_pixels.append(img.getpixel((0, y)))
            edge_pixels.append(img.getpixel((w - 1, y)))

    # Quantize edge pixels to 16-level buckets to find dominant mode
    def quantize_color(c: Tuple[int, int, int], step=16) -> Tuple[int, int, int]:
        return (c[0] // step * step, c[1] // step * step, c[2] // step * step)

    quantized_edges = [quantize_color(c, 16) for c in edge_pixels]
    edge_counter = Counter(quantized_edges)
    dominant_bucket, count = edge_counter.most_common(1)[0]

    # Find the average exact RGB within that dominant bucket
    matching_pixels = [c for c in edge_pixels if quantize_color(c, 16) == dominant_bucket]
    avg_r = int(sum(c[0] for c in matching_pixels) / len(matching_pixels))
    avg_g = int(sum(c[1] for c in matching_pixels) / len(matching_pixels))
    avg_b = int(sum(c[2] for c in matching_pixels) / len(matching_pixels))
    bg_rgb = (avg_r, avg_g, avg_b)
    bg_hex = rgb_to_hex(*bg_rgb)

    # Check if background is dark or light
    bg_lum = (0.299 * avg_r + 0.587 * avg_g + 0.114 * avg_b)
    is_dark_bg = bg_lum < 128

    # 3. Cluster colors from pages to find 3-5 accent colors
    all_pixels: List[Tuple[int, int, int]] = []
    for img in rendered_images:
        # Sample every 2nd pixel
        w, h = img.size
        for y in range(0, h, 2):
            for x in range(0, w, 2):
                all_pixels.append(img.getpixel((x, y)))

    # Filter pixels: ignore colors too close to background or text extremes
    filtered_pixels: List[Tuple[int, int, int]] = []
    for p in all_pixels:
        lum = 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2]
        # Ignore distance to background
        if color_distance(p, bg_rgb) < 30:
            continue
        # If light background, ignore near-black text (lum < 35) and near-white (lum > 240)
        if not is_dark_bg:
            if lum < 35 or lum > 240:
                continue
        else:
            # If dark background, ignore near-white text (lum > 225) and near-black (lum < 25)
            if lum < 25 or lum > 225:
                continue
        # Ignore very low saturation grays
        max_c, min_c = max(p), min(p)
        sat = (max_c - min_c) / max(max_c, 1)
        if sat < 0.15:
            continue
        filtered_pixels.append(p)

    # Cluster filtered pixels into distinct buckets
    clusters: List[Dict[str, Any]] = []
    if filtered_pixels:
        quantized_body = [quantize_color(c, 24) for c in filtered_pixels]
        body_counter = Counter(quantized_body)
        for bucket, freq in body_counter.most_common(20):
            bucket_pxs = [c for c in filtered_pixels if quantize_color(c, 24) == bucket]
            cr = int(sum(c[0] for c in bucket_pxs) / len(bucket_pxs))
            cg = int(sum(c[1] for c in bucket_pxs) / len(bucket_pxs))
            cb = int(sum(c[2] for c in bucket_pxs) / len(bucket_pxs))
            cand = (cr, cg, cb)
            # Ensure at least 45 color distance from already selected clusters
            if all(color_distance(cand, cl["rgb"]) > 45 for cl in clusters):
                clusters.append({"rgb": cand, "count": freq})
            if len(clusters) >= 5:
                break

    # Default fallback accents if not enough distinct colors found
    default_accents = [
        (59, 130, 246) if is_dark_bg else (29, 78, 216),    # Blue
        (16, 185, 129) if is_dark_bg else (21, 128, 61),   # Green
        (139, 92, 246) if is_dark_bg else (109, 40, 217),  # Purple
        (244, 63, 94) if is_dark_bg else (190, 18, 60),    # Rose
        (6, 182, 212) if is_dark_bg else (14, 116, 144)    # Cyan
    ]

    selected_accents: List[str] = []
    for cl in clusters:
        selected_accents.append(rgb_to_hex(*cl["rgb"]))

    # Fill up to at least 3 accents deterministically
    for def_acc in default_accents:
        if len(selected_accents) >= 5:
            break
        def_hex = rgb_to_hex(*def_acc)
        if all(color_distance(def_acc, parse_hex_to_rgb(a)) > 40 for a in selected_accents) and color_distance(def_acc, bg_rgb) > 40:
            selected_accents.append(def_hex)

    primary_color = selected_accents[0] if selected_accents else ("#3b82f6" if is_dark_bg else "#1d4ed8")
    secondary_color = selected_accents[1] if len(selected_accents) > 1 else ("#10b981" if is_dark_bg else "#15803d")
    accent_color = selected_accents[2] if len(selected_accents) > 2 else "#8b5cf6"

    text_color = "#ffffff" if is_dark_bg else "#0f172a"
    text_muted = "#94a3b8" if is_dark_bg else "#64748b"
    surface_color = "#1e293b" if is_dark_bg else "#f8fafc"

    # 4. Fonts mapping
    if not font_names_found:
        notes.append("Aucune police vectorielle détectée (document scanné ou texte vectorisé). Polices par défaut appliquées.")
        heading_font_name = "Plus Jakarta Sans"
        body_font_name = "Inter"
    elif len(font_names_found) == 1:
        heading_font_name = font_names_found[0]
        body_font_name = font_names_found[0]
    else:
        heading_font_name = font_names_found[0]
        body_font_name = font_names_found[1]

    h_stack, h_weight = _resolve_font(heading_font_name)
    b_stack, b_weight = _resolve_font(body_font_name)

    # 5. Build final standardized theme dictionary
    palette = {
        "bg": bg_hex,
        "surface": surface_color,
        "text": text_color,
        "text_muted": text_muted,
        "primary": primary_color,
        "secondary": secondary_color,
        "accent": accent_color,
    }
    if len(selected_accents) > 3:
        palette["accent_2"] = selected_accents[3]
    if len(selected_accents) > 4:
        palette["accent_3"] = selected_accents[4]

    colors = {
        "dark1": bg_hex if is_dark_bg else text_color,
        "light1": text_color if is_dark_bg else bg_hex,
        "accent1": primary_color,
        "accent2": secondary_color,
        "accent3": accent_color,
    }

    return {
        "status": "ok",
        "approximate": True,
        "notes": "; ".join(notes) if notes else "Thème extrait du PDF, approximatif.",
        "colors": colors,
        "fonts": {
            "heading": {
                "name": heading_font_name,
                "stack": h_stack,
                "weight": h_weight or 700
            },
            "body": {
                "name": body_font_name,
                "stack": b_stack,
                "weight": b_weight or 400
            }
        },
        "background": {
            "type": "solid",
            "color": bg_hex
        },
        "palette": palette
    }


def parse_hex_to_rgb(hex_str: str) -> Tuple[int, int, int]:
    h = hex_str.lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    try:
        return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))
    except Exception:
        return (0, 0, 0)
