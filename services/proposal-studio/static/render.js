// Gradient text (template key figures): stop colours left to right
function gradientTextCss(stops) {
  const safe = stops.filter(c => /^(#[0-9a-fA-F]{3,8}|rgba?\([\d\s.,]+\))$/.test(c));
  return `background:linear-gradient(90deg, ${safe.join(', ')});-webkit-background-clip:text;background-clip:text;color:transparent;-webkit-text-fill-color:transparent;`;
}

/* ═══════════════════════════════════════════════════════════════════
   render.js — Unified renderer for RFP Slide Deck Studio
   
   Renders elements for both Editor (mode: 'edit') and Export (mode: 'export')
   ensuring identical visual presentation, escaping, and layout.
   ═══════════════════════════════════════════════════════════════════ */

(function (global) {
  'use strict';

  function escHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatTextWithPlaceholders(rawText, mode) {
    const safe = escHtml(rawText);
    if (mode === 'export') {
      return safe;
    }
    // Highlight [TO FILL: ...] in editor mode only
    return safe.replace(/\[TO FILL:[^\]]*\]/gi, (match) => {
      return `<mark class="placeholder-highlight">${match}</mark>`;
    });
  }

  function toEmbedUrl(url) {
    if (!url) return '';
    const ytMatch = String(url).match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]+)/);
    if (ytMatch) return `https://www.youtube.com/embed/${ytMatch[1]}`;
    const vimeoMatch = String(url).match(/vimeo\.com\/(\d+)/);
    if (vimeoMatch) return `https://player.vimeo.com/video/${vimeoMatch[1]}`;
    return url;
  }

  /**
   * Renders the inner visual content of an element.
   * @param {Object} el - Element model
   * @param {Object} [theme] - Active project theme (optional, fallback defaults provided)
   * @param {'edit'|'export'} [mode='edit'] - Target rendering mode
   * @returns {string} Escaped HTML string of the element's visual content
   */
  function renderElementHTML(el, theme = {}, mode = 'edit') {
    if (!el || !el.type) {
      return '<div style="width:100%;height:100%;background:rgba(255,255,255,0.05);"></div>';
    }

    const t = theme || {};
    const fontBody = t.fontBody || "'Inter', sans-serif";
    const fontDisplay = t.fontHeading || "'Plus Jakarta Sans', sans-serif";
    const textColor = t.text || '#ffffff';
    const primaryColor = t.primary || '#6366f1';

    switch (el.type) {
      case 'text': {
        const raw = el.content !== undefined ? el.content : 'Texte';
        let formatted = formatTextWithPlaceholders(raw, mode);
        if (Array.isArray(el.colorGradient) && el.colorGradient.length > 1) {
          formatted = `<span style="${gradientTextCss(el.colorGradient)}">${formatted}</span>`;
        }
        const linkUrl = typeof el.link === 'string' && /^(https?:\/\/|mailto:)\S+$/i.test(el.link) ? el.link : '';
        if (linkUrl) {
          // Clickable in PDF exports; in the editor a link only shows as a tooltip (clicks edit the slide)
          formatted = mode === 'export'
            ? `<a href="${escHtml(linkUrl)}" style="color:inherit;text-decoration:inherit;">${formatted}</a>`
            : `<span title="${escHtml(linkUrl)}">${formatted}</span>`;
        }
        const padding = 'padding:8px 12px;';
        const whiteSpace = 'white-space:pre-wrap;';
        return `<div class="text-content" contenteditable="false"
                     style="width:100%;height:100%;box-sizing:border-box;${padding}${whiteSpace}
                            font-family:${el.fontFamily || fontBody};
                            font-size:${el.fontSize || 24}px;
                            font-weight:${el.fontWeight || 400};
                            font-style:${el.fontStyle || 'normal'};
                            text-decoration:${el.textDecoration || 'none'};
                            text-align:${el.textAlign || 'left'};
                            color:${el.color || textColor};
                            line-height:${el.lineHeight || 1.4};">${formatted}</div>`;
      }

      case 'image': {
        const src = escHtml(el.src || '');
        const alt = escHtml(el.alt || '');
        return `<img src="${src}" alt="${alt}" draggable="false" style="width:100%;height:100%;object-fit:contain;display:block;">`;
      }

      case 'video': {
        if (mode === 'export') {
          // Poster/link card for exports
          const rawUrl = el.src || '';
          const safeUrl = escHtml(rawUrl);
          const displayUrl = rawUrl.length > 55 ? escHtml(rawUrl.substring(0, 52) + '...') : safeUrl;
          return `<div class="export-video-poster" style="width:100%;height:100%;background:linear-gradient(135deg, #0b101c 0%, #1e293b 100%);border:1px solid rgba(255,255,255,0.12);border-radius:8px;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#ffffff;box-sizing:border-box;padding:16px;text-align:center;position:relative;overflow:hidden;">
                    <div style="width:54px;height:54px;border-radius:50%;background:rgba(99, 102, 241, 0.9);display:flex;align-items:center;justify-content:center;box-shadow:0 4px 14px rgba(0,0,0,0.4);margin-bottom:12px;">
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="white" style="margin-left:3px;">
                        <polygon points="5 3 19 12 5 21 5 3"></polygon>
                      </svg>
                    </div>
                    <div style="font-family:${fontDisplay};font-size:16px;font-weight:700;letter-spacing:-0.01em;margin-bottom:4px;">Vidéo RFP</div>
                    <div style="font-family:${fontBody};font-size:12px;color:rgba(255,255,255,0.7);max-width:90%;word-break:break-all;overflow:hidden;">${displayUrl || 'Aucune URL spécifiée'}</div>
                  </div>`;
        }

        // Editor mode: interactive iframe or HTML5 video
        if (el.videoType === 'link') {
          const embedUrl = toEmbedUrl(el.src);
          return `<iframe src="${escHtml(embedUrl)}" style="width:100%;height:100%;border:none;" allowfullscreen></iframe>`;
        }
        return `<video src="${escHtml(el.src || '')}" controls muted style="width:100%;height:100%;object-fit:contain;display:block;"></video>`;
      }

      case 'shape': {
        const bg = el.fill || 'transparent';
        const stroke = el.stroke || primaryColor;
        const sw = el.strokeWidth !== undefined ? el.strokeWidth : 2;
        const sstyle = el.strokeStyle || 'solid';
        if (el.shapeType === 'path' && Array.isArray(el.pathData)) {
          const pathW = Math.max(1, Number(el.pathWidth) || Number(el.width) || 1);
          const pathH = Math.max(1, Number(el.pathHeight) || Number(el.height) || 1);
          const radius = Math.max(0, Math.min(Number(el.borderRadius) || 0, pathW / 2, pathH / 2));
          const dash = sstyle === 'dashed' ? `${sw * 4} ${sw * 3}` : (sstyle === 'dotted' ? `${sw} ${sw * 2}` : '');
          const tx = el.pathFlipH ? pathW : 0;
          const ty = el.pathFlipV ? pathH : 0;
          const transform = (el.pathFlipH || el.pathFlipV)
            ? ` transform="translate(${tx} ${ty}) scale(${el.pathFlipH ? -1 : 1} ${el.pathFlipV ? -1 : 1})"` : '';
          const paths = el.pathData.map(path => {
            const fill = path.noFill && !el.pathStyleOverride ? 'none' : bg;
            const line = (path.noStroke && !el.pathStyleOverride) || sw <= 0 ? 'none' : stroke;
            return `<path d="${escHtml(path.d)}" fill="${escHtml(fill)}" stroke="${escHtml(line)}" stroke-width="${sw}" stroke-linejoin="round"${dash && line !== 'none' ? ` stroke-dasharray="${dash}"` : ''}/>`;
          }).join('');
          const clip = radius ? `<defs><clipPath id="shape-clip"><rect width="${pathW}" height="${pathH}" rx="${radius}" ry="${radius}"/></clipPath></defs>` : '';
          const clipAttr = radius ? ' clip-path="url(#shape-clip)"' : '';
          return `<svg class="shape-vector shape-visual" width="100%" height="100%" viewBox="0 0 ${pathW} ${pathH}" preserveAspectRatio="none" style="display:block;overflow:visible;">` +
            `${clip}<g${transform}${clipAttr}>${paths}</g></svg>`;
        }
        const br = el.shapeType === 'circle' ? '50%' : `${el.borderRadius || 0}px`;
        const borderCss = sw > 0 ? `${sw}px ${sstyle} ${stroke}` : 'none';
        return `<div class="shape-inner shape-visual" style="width:100%;height:100%;background:${bg};border:${borderCss};border-radius:${br};box-sizing:border-box;"></div>`;
      }

      case 'bullets': {
        const items = Array.isArray(el.items) ? el.items : ['Premier point clé', 'Deuxième argument à l\'appui', 'Troisième élément de synthèse'];
        const bStyle = el.bulletStyle || 'disc';
        const listTag = bStyle === 'number' ? 'ol' : 'ul';
        const overflowStyle = el.autoHeight ? 'overflow:visible;' : 'overflow:hidden;';
        let listItems = '';
        items.forEach((item) => {
          const formattedItem = formatTextWithPlaceholders(item, mode);
          let marker = '';
          if (bStyle === 'check') {
            marker = '<span class="bullet-check-icon" style="color:#10b981;font-weight:700;margin-right:8px;">✓</span>';
          }
          listItems += `<li style="margin-bottom:6px;">${marker}${formattedItem}</li>`;
        });
        const listClass = bStyle === 'check' ? 'bullets-content bullets-check' : 'bullets-content';
        return `<div class="bullets-wrapper" style="width:100%;height:100%;${overflowStyle}box-sizing:border-box;">
                  <${listTag} class="${listClass}" style="margin:0;padding-left:${bStyle === 'check' ? '4px' : '28px'};list-style-type:${bStyle === 'disc' ? 'disc' : (bStyle === 'number' ? 'decimal' : 'none')};font-family:${el.fontFamily || fontBody};font-size:${el.fontSize || 24}px;color:${el.color || textColor};line-height:${el.lineHeight || 1.5};">
                    ${listItems}
                  </${listTag}>
                </div>`;
      }

      case 'table': {
        const cols = Array.isArray(el.columns) && el.columns.length > 0 ? el.columns : ['Critère', 'Exigence RFP', 'Réponse & Conformité'];
        const rows = Array.isArray(el.rows) && el.rows.length > 0 ? el.rows : [
          ['Architecture', 'Cloud souverain SecNumCloud', '100% Conforme'],
          ['Disponibilité', 'Garantie SLA 99.9%', '99.95% garanti'],
          ['Support', 'Support 24/7 en français', 'Inclus avec astreinte'],
        ];
        const hFill = el.headerFill || '#4338ca';
        const hColor = el.headerColor || '#ffffff';
        const rFill = el.rowFill || '#1e293b';
        const altFill = el.altRowFill || '#0f172a';
        const bColor = el.borderColor || '#334155';
        const fSize = el.fontSize || 18;
        const colWidths = Array.isArray(el.colWidths) && el.colWidths.length === cols.length ? el.colWidths : null;

        let ths = '';
        cols.forEach((col, cIdx) => {
          const wStyle = colWidths ? `width:${colWidths[cIdx]}%;` : '';
          const formatted = formatTextWithPlaceholders(col, mode);
          const dataAttrs = mode === 'edit' ? `data-col-idx="${cIdx}"` : '';
          ths += `<th ${dataAttrs} style="padding:10px 14px;background:${hFill};color:${hColor};border:1px solid ${bColor};text-align:left;font-weight:700;${wStyle}user-select:none;">${formatted}</th>`;
        });

        let trs = '';
        rows.forEach((row, rIdx) => {
          const bg = rIdx % 2 === 0 ? rFill : altFill;
          let tds = '';
          cols.forEach((_, cIdx) => {
            const cellVal = (row && row[cIdx] !== undefined) ? row[cIdx] : '';
            const formatted = formatTextWithPlaceholders(cellVal, mode);
            const dataAttrs = mode === 'edit' ? `data-row-idx="${rIdx}" data-col-idx="${cIdx}"` : '';
            tds += `<td ${dataAttrs} style="padding:10px 14px;border:1px solid ${bColor};color:#ffffff;text-align:left;">${formatted}</td>`;
          });
          trs += `<tr style="background:${bg};">${tds}</tr>`;
        });

        return `<div class="table-wrapper" style="width:100%;height:100%;overflow:visible;box-sizing:border-box;">
                  <table class="rfp-table" style="width:100%;border-collapse:collapse;font-family:${el.fontFamily || fontBody};font-size:${fSize}px;line-height:1.4;">
                    <thead><tr>${ths}</tr></thead>
                    <tbody>${trs}</tbody>
                  </table>
                </div>`;
      }

      case 'card': {
        const titleFormatted = formatTextWithPlaceholders(el.title || 'Titre de la carte', mode);
        const textFormatted = formatTextWithPlaceholders(el.text || 'Description de la référence client ou présentation de l\'expert dédié.', mode);
        const fill = el.fill || '#1e293b';
        const titleColor = el.titleColor || '#ffffff';
        const titleColorCss = Array.isArray(el.titleGradient) && el.titleGradient.length > 1
          ? gradientTextCss(el.titleGradient) : `color:${titleColor};`;
        const textColor = el.textColor || 'rgba(255,255,255,0.75)';
        const titleSize = el.titleSize || 22;
        const textSize = el.textSize || 16;
        const radius = el.radius !== undefined ? el.radius : 12;
        const imgHtml = el.image ? `<div class="card-img-container" style="width:100%;height:140px;background:#0f172a;overflow:hidden;"><img src="${escHtml(el.image)}" alt="${escHtml(el.title || '')}" style="width:100%;height:100%;object-fit:cover;" draggable="false"></div>` : '';
        const overflowMarker = mode === 'edit'
          ? `<div class="card-overflow-marker" title="Attention: le texte dépasse la hauteur de la carte !" style="display:none;position:absolute;bottom:8px;right:8px;background:#ef4444;color:#ffffff;font-size:12px;font-weight:bold;width:20px;height:20px;border-radius:50%;align-items:center;justify-content:center;box-shadow:0 2px 4px rgba(0,0,0,0.5);pointer-events:none;">!</div>`
          : '';
        const editableAttr = mode === 'edit' ? 'contenteditable="true" data-editable="title"' : '';
        const editableAttr2 = mode === 'edit' ? 'contenteditable="true" data-editable="text"' : '';

        return `<div class="card-wrapper" style="width:100%;height:100%;background:${fill};border-radius:${radius}px;border:1px solid rgba(255,255,255,0.08);overflow:hidden;display:flex;flex-direction:column;box-sizing:border-box;position:relative;">
                  ${imgHtml}
                  <div class="card-body" style="padding:16px 20px;flex:1;overflow:hidden;display:flex;flex-direction:column;position:relative;">
                    <div class="card-title" ${editableAttr} style="font-family:${fontDisplay};font-size:${titleSize}px;font-weight:700;${titleColorCss}margin-bottom:8px;line-height:1.3;outline:none;cursor:text;">${titleFormatted}</div>
                    <div class="card-text" ${editableAttr2} style="font-family:${fontBody};font-size:${textSize}px;color:${textColor};line-height:1.45;flex:1;overflow:hidden;outline:none;cursor:text;">${textFormatted}</div>
                    ${overflowMarker}
                  </div>
                </div>`;
      }

      case 'split': {
        return `<div class="split-container horizontal" style="width:100%;height:100%;display:flex;">
                  <div class="split-pane" data-split="left" style="flex:1;background:rgba(255,255,255,0.02);"></div>
                  <div class="split-divider" style="width:2px;background:rgba(255,255,255,0.1);"></div>
                  <div class="split-pane" data-split="right" style="flex:1;background:rgba(255,255,255,0.02);"></div>
                </div>`;
      }

      default:
        return `<div style="width:100%;height:100%;background:rgba(255,255,255,0.05);"></div>`;
    }
  }

  // Export functions to global scope (browser window)
  global.escHtml = escHtml;
  global.toEmbedUrl = toEmbedUrl;
  global.renderElementHTML = renderElementHTML;

})(typeof window !== 'undefined' ? window : globalThis);
