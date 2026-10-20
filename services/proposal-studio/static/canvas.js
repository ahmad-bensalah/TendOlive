/* ═══════════════════════════════════════════════════════════════════
   canvas.js — Canva-style interactive canvas engine.

   Handles: element selection, drag-to-move, 8-handle resize,
   rotation, snap/alignment guides, layer ordering,
   keyboard shortcuts, and context menus.
   ═══════════════════════════════════════════════════════════════════ */

class CanvasEngine {
  constructor(canvasEl, opts = {}) {
    this.canvas = canvasEl;
    this.elements = [];          // Array of element data objects
    this.selectedId = null;
    this.zoom = 1;
    this.theme = opts.theme || {};
    this.onChanged = opts.onChanged || (() => {});
    this.onSelectionChanged = opts.onSelectionChanged || (() => {});

    this.SNAP_THRESHOLD = 5;
    this._guides = [];
    this._isDragging = false;
    this._isResizing = false;
    this._isRotating = false;

    this._bindEvents();
  }

  /* ────────────────────────────────────────────────────────────────
     Element Management
     ──────────────────────────────────────────────────────────────── */

  addElement(el) {
    el.id = el.id || ('el_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5));
    el.x = el.x ?? 100;
    el.y = el.y ?? 100;
    el.width = el.width ?? 300;
    el.height = el.height ?? 60;
    el.rotation = el.rotation ?? 0;
    el.zIndex = el.zIndex ?? (this.elements.length + 1);
    el.opacity = el.opacity ?? 1;
    this.elements.push(el);
    this._renderElement(el);
    this.selectElement(el.id);
    this.onChanged();
    return el;
  }

  removeElement(id) {
    this.elements = this.elements.filter(e => e.id !== id);
    const dom = this.canvas.querySelector(`[data-el-id="${id}"]`);
    if (dom) dom.remove();
    if (this.selectedId === id) {
      this.selectedId = null;
      this.onSelectionChanged(null);
    }
    this._clearGuides();
    this.onChanged();
  }

  duplicateElement(id) {
    const src = this.elements.find(e => e.id === id);
    if (!src) return;
    const dup = JSON.parse(JSON.stringify(src));
    dup.id = 'el_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
    dup.x += 20;
    dup.y += 20;
    dup.zIndex = this.elements.length + 1;
    // A copy is placed in a new location, so it should be immediately movable.
    dup.locked = false;
    this.elements.push(dup);
    this._renderElement(dup);
    this.selectElement(dup.id);
    this.onChanged();
  }

  bringToFront(id) {
    const maxZ = Math.max(...this.elements.map(e => e.zIndex), 0);
    const el = this.elements.find(e => e.id === id);
    if (el) { el.zIndex = maxZ + 1; this._syncDOM(el); this.onChanged(); }
  }

  sendToBack(id) {
    const minZ = Math.min(...this.elements.map(e => e.zIndex), 1);
    const el = this.elements.find(e => e.id === id);
    if (el) { el.zIndex = Math.max(minZ - 1, 0); this._syncDOM(el); this.onChanged(); }
  }

  /** Move an element one position toward the front (1) or back (-1). */
  moveLayer(id, direction) {
    const ordered = [...this.elements].sort((a, b) => (a.zIndex || 0) - (b.zIndex || 0));
    const index = ordered.findIndex(el => el.id === id);
    const targetIndex = index + (direction > 0 ? 1 : -1);
    if (index < 0 || targetIndex < 0 || targetIndex >= ordered.length) return false;

    [ordered[index], ordered[targetIndex]] = [ordered[targetIndex], ordered[index]];
    // Normalise stacking values so imported decks with duplicate/missing zIndex
    // values get a deterministic visual order too.
    ordered.forEach((el, i) => {
      el.zIndex = i + 1;
      this._syncDOM(el);
    });
    this.onChanged();
    return true;
  }

  nudgeElement(id, dx, dy) {
    const el = this.elements.find(e => e.id === id);
    if (!el || el.locked) return false;
    el.x = Math.round((el.x || 0) + dx);
    el.y = Math.round((el.y || 0) + dy);
    this._syncDOM(el);
    this.onChanged();
    return true;
  }

  updateElement(id, props) {
    const el = this.elements.find(e => e.id === id);
    if (!el) return;
    console.log('🔧 Canvas updateElement:', { id, props, before: { opacity: el.opacity } });
    Object.assign(el, props);
    console.log('🔧 After assign:', { opacity: el.opacity });
    this._syncDOM(el);
    this.onChanged();
  }

  selectElement(id) {
    // Deselect previous
    this.canvas.querySelectorAll('.canvas-element.selected').forEach(d => d.classList.remove('selected'));
    this.selectedId = id;
    if (id) {
      const dom = this.canvas.querySelector(`[data-el-id="${id}"]`);
      if (dom) dom.classList.add('selected');
    }
    this.onSelectionChanged(id ? this.elements.find(e => e.id === id) : null);
  }

  getSelected() {
    return this.elements.find(e => e.id === this.selectedId) || null;
  }

  clearAll() {
    this.elements = [];
    this.selectedId = null;
    // Remove all element DOMs but keep guides container etc.
    this.canvas.querySelectorAll('.canvas-element').forEach(d => d.remove());
    this._clearGuides();
  }

  /* ────────────────────────────────────────────────────────────────
     DOM Rendering
     ──────────────────────────────────────────────────────────────── */

  renderAll() {
    this.canvas.querySelectorAll('.canvas-element').forEach(d => d.remove());
    this.elements.forEach(el => this._renderElement(el));
  }

  _renderElement(el) {
    const div = document.createElement('div');
    div.className = 'canvas-element';
    div.dataset.elId = el.id;
    div.setAttribute('tabindex', '0');

    // Inner content
    div.innerHTML = this._innerHTML(el) + this._handlesHTML(el) +
      '<div class="element-lock-badge" aria-hidden="true">🔒</div>';

    this._applyStyles(div, el);
    this.canvas.appendChild(div);

    // Bind interactions
    this._bindElementEvents(div, el);
  }

  _innerHTML(el) {
    if (typeof window !== 'undefined' && typeof window.renderElementHTML === 'function') {
      return window.renderElementHTML(el, this.theme || {}, 'edit');
    }
    return `<div style="width:100%;height:100%;background:rgba(255,255,255,0.05);"></div>`;
  }

  _handlesHTML(el) {
    const isText = el && (el.type === 'text' || el.type === 'bullets');
    if (isText) {
      return `
        <div class="resize-handles text-handles">
          <div class="resize-handle corner nw" data-dir="nw" title="Ajuster la taille"></div>
          <div class="resize-handle corner ne" data-dir="ne" title="Ajuster la taille"></div>
          <div class="resize-handle pill e"  data-dir="e"  title="Ajuster la largeur de la boîte"></div>
          <div class="resize-handle corner se" data-dir="se" title="Ajuster la taille"></div>
          <div class="resize-handle corner sw" data-dir="sw" title="Ajuster la taille"></div>
          <div class="resize-handle pill w"  data-dir="w"  title="Ajuster la largeur de la boîte"></div>
        </div>
        <div class="rotate-handle"></div>`;
    }
    return `
      <div class="resize-handles">
        <div class="resize-handle nw" data-dir="nw"></div>
        <div class="resize-handle n"  data-dir="n"></div>
        <div class="resize-handle ne" data-dir="ne"></div>
        <div class="resize-handle e"  data-dir="e"></div>
        <div class="resize-handle se" data-dir="se"></div>
        <div class="resize-handle s"  data-dir="s"></div>
        <div class="resize-handle sw" data-dir="sw"></div>
        <div class="resize-handle w"  data-dir="w"></div>
      </div>
      <div class="rotate-handle"></div>`;
  }

  _applyStyles(dom, el) {
    dom.style.left = el.x + 'px';
    dom.style.top = el.y + 'px';
    dom.style.width = el.width + 'px';
    dom.style.height = el.height + 'px';
    dom.style.zIndex = el.zIndex;
    const finalOpacity = el.opacity !== undefined ? el.opacity : 1;
    console.log('🎨 _applyStyles setting opacity:', { elId: el.id, opacity: el.opacity, finalOpacity });
    dom.style.opacity = finalOpacity;
    dom.style.transform = `rotate(${el.rotation || 0}deg)`;
    dom.classList.toggle('locked', Boolean(el.locked));
    dom.setAttribute('aria-label', el.locked ? 'Élément verrouillé' : 'Élément');

    if (el.type === 'text') {
      const tc = dom.querySelector('.text-content');
      if (tc && el.fontSize) {
        tc.style.fontSize = el.fontSize + 'px';
      }
    } else if (el.type === 'bullets') {
      const bc = dom.querySelector('.bullets-content');
      if (bc && el.fontSize) {
        bc.style.fontSize = el.fontSize + 'px';
      }
    }
  }

  _syncDOM(el) {
    const dom = this.canvas.querySelector(`[data-el-id="${el.id}"]`);
    if (!dom) return;
    this._applyStyles(dom, el);
    // Re-render inner content for text changes
    if (el.type === 'text') {
      const tc = dom.querySelector('.text-content');
      if (tc) {
        tc.style.fontFamily = el.fontFamily || 'Inter, sans-serif';
        tc.style.fontSize = (el.fontSize || 24) + 'px';
        tc.style.fontWeight = el.fontWeight || 400;
        tc.style.fontStyle = el.fontStyle || 'normal';
        tc.style.textDecoration = el.textDecoration || 'none';
        tc.style.textAlign = el.textAlign || 'left';
        tc.style.color = el.color || '#ffffff';
        tc.style.lineHeight = el.lineHeight || 1.4;
      }
    } else if (el.type === 'bullets') {
      const bw = dom.querySelector('.bullets-wrapper');
      if (bw) {
        bw.outerHTML = this._innerHTML(el);
      }
    } else if (el.type === 'table') {
      const tw = dom.querySelector('.table-wrapper');
      if (tw) {
        tw.outerHTML = this._innerHTML(el);
        this._bindTableEvents(dom, el);
      }
    } else if (el.type === 'card') {
      const cw = dom.querySelector('.card-wrapper');
      if (cw) {
        cw.outerHTML = this._innerHTML(el);
        this._checkCardOverflow(dom);
      }
    } else if (el.type === 'shape') {
      const visual = dom.querySelector('.shape-visual');
      if (visual) visual.outerHTML = this._innerHTML(el);
    }
  }

  /* ────────────────────────────────────────────────────────────────
     Event Binding
     ──────────────────────────────────────────────────────────────── */

  _bindEvents() {
    // Click on canvas background to deselect
    this.canvas.addEventListener('mousedown', (e) => {
      if (e.target === this.canvas || e.target.classList.contains('slide-canvas-bg')) {
        this.selectElement(null);
      }
    });

    // The workspace around the slide is an explicit deselection area. Keep
    // toolbar interactions intact by listening only to the canvas viewport.
    const viewport = this.canvas.closest('.canvas-viewport');
    if (viewport) {
      viewport.addEventListener('mousedown', (e) => {
        if (e.target === viewport) this.selectElement(null);
      });
    }

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      // Only if canvas area is active and not typing in an input
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
      if (document.activeElement?.contentEditable === 'true') return;

      const sel = this.getSelected();

      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (sel) { e.preventDefault(); this.removeElement(sel.id); }
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'd') {
        if (sel) { e.preventDefault(); this.duplicateElement(sel.id); }
      }
      if (e.key === 'Escape') {
        this.selectElement(null);
      }
      // Arrow keys for nudge
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key) && sel) {
        e.preventDefault();
        if (sel.locked) return;
        const step = e.shiftKey ? 10 : 1;
        if (e.key === 'ArrowUp') sel.y -= step;
        if (e.key === 'ArrowDown') sel.y += step;
        if (e.key === 'ArrowLeft') sel.x -= step;
        if (e.key === 'ArrowRight') sel.x += step;
        this._syncDOM(sel);
        this.onChanged();
      }
    });

    // Context menu
    this.canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const elDom = e.target.closest('.canvas-element');
      if (elDom) {
        const id = elDom.dataset.elId;
        this.selectElement(id);
        this._showContextMenu(e.clientX, e.clientY, id);
      } else {
        this._hideContextMenu();
      }
    });

    document.addEventListener('click', () => this._hideContextMenu());
  }

  _bindElementEvents(dom, el) {
    // Selection on mousedown
    dom.addEventListener('mousedown', (e) => {
      if (e.target.classList.contains('resize-handle') || e.target.classList.contains('rotate-handle')) return;
      if (e.target.contentEditable === 'true') return;
      e.stopPropagation();
      this.selectElement(el.id);
      if (!el.locked) this._startDrag(e, el);
    });

    // Double-click for text editing
    if (el.type === 'text') {
      dom.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        const tc = dom.querySelector('.text-content');
        if (tc) {
          tc.contentEditable = 'true';
          tc.focus();
          // Select all text
          const range = document.createRange();
          range.selectNodeContents(tc);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        }
      });

      const tc = dom.querySelector('.text-content');
      if (tc) {
        tc.addEventListener('blur', () => {
          tc.contentEditable = 'false';
          el.content = tc.innerText;
          this.onChanged();
        });
        tc.addEventListener('input', () => {
          el.content = tc.innerText;
        });
      }
    }

    // Double-click for bullets editing
    if (el.type === 'bullets') {
      dom.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        this._openBulletsEditor(dom, el);
      });
    }

    // Table cell editing & events
    if (el.type === 'table') {
      this._bindTableEvents(dom, el);
    }

    // Card editing & overflow
    if (el.type === 'card') {
      // Double-click anywhere on card opens full editor
      dom.addEventListener('dblclick', (e) => {
        if (e.target.dataset.editable) return; // Let inline edit handle it
        e.stopPropagation();
        this._openCardEditor(dom, el);
      });

      // Inline editing for title and text
      const titleEl = dom.querySelector('[data-editable="title"]');
      const textEl = dom.querySelector('[data-editable="text"]');

      if (titleEl) {
        titleEl.addEventListener('blur', () => {
          el.title = titleEl.textContent.trim() || 'Titre de la carte';
          this.onChanged();
        });
        titleEl.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            titleEl.blur();
          }
        });
      }

      if (textEl) {
        textEl.addEventListener('blur', () => {
          el.text = textEl.textContent.trim() || 'Description';
          this.onChanged();
        });
      }

      setTimeout(() => this._checkCardOverflow(dom), 50);
    }

    // Resize handles
    dom.querySelectorAll('.resize-handle').forEach(handle => {
      handle.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        if (!el.locked) this._startResize(e, el, handle.dataset.dir);
      });
    });

    // Rotate handle
    const rotateHandle = dom.querySelector('.rotate-handle');
    if (rotateHandle) {
      rotateHandle.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        if (!el.locked) this._startRotate(e, el);
      });
    }
  }

  /* ────────────────────────────────────────────────────────────────
     Drag-to-Move
     ──────────────────────────────────────────────────────────────── */

  _startDrag(e, el) {
    if (el.locked) return;
    this._isDragging = true;
    const startX = e.clientX;
    const startY = e.clientY;
    const origX = el.x;
    const origY = el.y;
    const dom = this.canvas.querySelector(`[data-el-id="${el.id}"]`);

    const onMove = (me) => {
      const dx = (me.clientX - startX) / this.zoom;
      const dy = (me.clientY - startY) / this.zoom;
      let newX = origX + dx;
      let newY = origY + dy;

      // Snap to guides
      const snapped = this._snap(el, newX, newY);
      newX = snapped.x;
      newY = snapped.y;

      el.x = Math.round(newX);
      el.y = Math.round(newY);
      if (dom) this._applyStyles(dom, el);
    };

    const onUp = () => {
      this._isDragging = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      this._clearGuides();
      this.onChanged();
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  /* ────────────────────────────────────────────────────────────────
     Resize
     ──────────────────────────────────────────────────────────────── */

  _startResize(e, el, dir) {
    if (el.locked) return;
    this._isResizing = true;
    const startX = e.clientX;
    const startY = e.clientY;
    const origX = el.x, origY = el.y, origW = el.width, origH = el.height;
    const origFontSize = el.fontSize || 24;
    const isText = el.type === 'text';
    const isCorner = ['nw', 'ne', 'sw', 'se'].includes(dir);
    const dom = this.canvas.querySelector(`[data-el-id="${el.id}"]`);

    const onMove = (me) => {
      const dx = (me.clientX - startX) / this.zoom;
      const dy = (me.clientY - startY) / this.zoom;
      let newX = origX, newY = origY, newW = origW, newH = origH;

      // When resizing text from corners (or any element with Shift held), resize proportionally and scale font-size
      const proportional = (isText && isCorner) || (me.shiftKey && isCorner);
      const aspect = origW / Math.max(1, origH);

      if (isText && isCorner) {
        // Canva-style: corner drag scales font-size proportionally!
        let scale = 1;
        if (dir === 'se') {
          scale = Math.max(0.1, (origW + dx) / origW);
        } else if (dir === 'sw') {
          scale = Math.max(0.1, (origW - dx) / origW);
        } else if (dir === 'ne') {
          scale = Math.max(0.1, (origW + dx) / origW);
        } else if (dir === 'nw') {
          scale = Math.max(0.1, (origW - dx) / origW);
        }

        // Clamp font size between 8px and 400px
        const newFontSize = Math.max(8, Math.min(400, Math.round(origFontSize * scale)));
        const actualScale = newFontSize / origFontSize;

        newW = Math.max(30, Math.round(origW * actualScale));
        newH = Math.max(20, Math.round(origH * actualScale));

        if (dir.includes('w')) newX = origX + (origW - newW);
        if (dir.includes('n')) newY = origY + (origH - newH);

        el.fontSize = newFontSize;
      } else {
        if (dir.includes('e')) newW = Math.max(30, origW + dx);
        if (dir.includes('w')) { newW = Math.max(30, origW - dx); newX = origX + origW - newW; }
        if (dir.includes('s')) newH = Math.max(20, origH + dy);
        if (dir.includes('n')) { newH = Math.max(20, origH - dy); newY = origY + origH - newH; }

        if (proportional) {
          if (Math.abs(dx) > Math.abs(dy)) {
            newH = newW / aspect;
            if (dir.includes('n')) newY = origY + origH - newH;
          } else {
            newW = newH * aspect;
            if (dir.includes('w')) newX = origX + origW - newW;
          }
        }
      }

      el.x = Math.round(newX);
      el.y = Math.round(newY);
      el.width = Math.round(newW);
      el.height = Math.round(newH);
      if (dom) this._applyStyles(dom, el);
      if (this.onSelectionChanged) this.onSelectionChanged(el);
    };

    const onUp = () => {
      this._isResizing = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      this.onChanged();
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  /* ────────────────────────────────────────────────────────────────
     Rotate
     ──────────────────────────────────────────────────────────────── */

  _startRotate(e, el) {
    if (el.locked) return;
    this._isRotating = true;
    const rect = this.canvas.getBoundingClientRect();
    const centerX = el.x + el.width / 2;
    const centerY = el.y + el.height / 2;

    const onMove = (me) => {
      const mx = (me.clientX - rect.left) / this.zoom;
      const my = (me.clientY - rect.top) / this.zoom;
      let angle = Math.atan2(my - centerY, mx - centerX) * (180 / Math.PI) + 90;

      // Snap to 15° increments when shift is held
      if (me.shiftKey) {
        angle = Math.round(angle / 15) * 15;
      }

      el.rotation = Math.round(angle);
      const dom = this.canvas.querySelector(`[data-el-id="${el.id}"]`);
      if (dom) dom.style.transform = `rotate(${el.rotation}deg)`;
    };

    const onUp = () => {
      this._isRotating = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      this.onChanged();
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  /* ────────────────────────────────────────────────────────────────
     Snap / Alignment Guides
     ──────────────────────────────────────────────────────────────── */

  _snap(movingEl, x, y) {
    this._clearGuides();
    const T = this.SNAP_THRESHOLD;
    const cw = 1920, ch = 1080; // Canvas dimensions
    const w = movingEl.width, h = movingEl.height;

    // Points to snap: left, center, right for x; top, center, bottom for y
    const myEdges = {
      left: x, centerX: x + w/2, right: x + w,
      top: y, centerY: y + h/2, bottom: y + h,
    };

    // Canvas guides
    const xGuides = [0, cw/2, cw];
    const yGuides = [0, ch/2, ch];

    // Other element guides
    this.elements.forEach(el => {
      if (el.id === movingEl.id) return;
      xGuides.push(el.x, el.x + el.width/2, el.x + el.width);
      yGuides.push(el.y, el.y + el.height/2, el.y + el.height);
    });

    let snappedX = x, snappedY = y;
    let snapXLine = null, snapYLine = null;

    // Snap X
    for (const gx of xGuides) {
      if (Math.abs(myEdges.left - gx) < T) { snappedX = gx; snapXLine = gx; break; }
      if (Math.abs(myEdges.centerX - gx) < T) { snappedX = gx - w/2; snapXLine = gx; break; }
      if (Math.abs(myEdges.right - gx) < T) { snappedX = gx - w; snapXLine = gx; break; }
    }

    // Snap Y
    for (const gy of yGuides) {
      if (Math.abs(myEdges.top - gy) < T) { snappedY = gy; snapYLine = gy; break; }
      if (Math.abs(myEdges.centerY - gy) < T) { snappedY = gy - h/2; snapYLine = gy; break; }
      if (Math.abs(myEdges.bottom - gy) < T) { snappedY = gy - h; snapYLine = gy; break; }
    }

    // Show guides
    if (snapXLine !== null) this._showGuide('vertical', snapXLine);
    if (snapYLine !== null) this._showGuide('horizontal', snapYLine);

    return { x: snappedX, y: snappedY };
  }

  _showGuide(orientation, pos) {
    const guide = document.createElement('div');
    guide.className = `snap-guide ${orientation}`;
    if (orientation === 'vertical') guide.style.left = pos + 'px';
    else guide.style.top = pos + 'px';
    this.canvas.appendChild(guide);
    this._guides.push(guide);
  }

  _clearGuides() {
    this._guides.forEach(g => g.remove());
    this._guides = [];
  }

  /* ────────────────────────────────────────────────────────────────
     Context Menu
     ──────────────────────────────────────────────────────────────── */

  _showContextMenu(x, y, id) {
    this._hideContextMenu();
    const menu = document.createElement('div');
    menu.className = 'context-menu visible';
    menu.id = 'canvas-context-menu';
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';

    const selected = this.elements.find(el => el.id === id);
    const isLocked = Boolean(selected && selected.locked);
    const items = [
      {
        icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="11" width="14" height="10" rx="2"></rect><path d="M8 11V7a4 4 0 0 1 8 0v4"></path></svg>',
        label: isLocked ? 'Déverrouiller la position' : 'Verrouiller la position',
        action: () => {
          this.updateElement(id, { locked: !isLocked });
          this.onSelectionChanged(this.getSelected());
        }
      },
      null,
      {
        icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>',
        label: 'Dupliquer',
        shortcut: 'Ctrl+D',
        action: () => this.duplicateElement(id)
      },
      {
        icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="18 15 12 9 6 15"></polyline></svg>',
        label: 'Premier plan',
        shortcut: 'Ctrl+]',
        action: () => this.bringToFront(id)
      },
      {
        icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>',
        label: 'Arrière-plan',
        shortcut: 'Ctrl+[',
        action: () => this.sendToBack(id)
      },
      null, // divider
      {
        icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>',
        label: 'Supprimer',
        shortcut: 'Suppr',
        action: () => this.removeElement(id),
        danger: true
      },
    ];

    items.forEach(item => {
      if (!item) {
        const div = document.createElement('div');
        div.className = 'context-menu-divider';
        menu.appendChild(div);
        return;
      }
      const el = document.createElement('div');
      el.className = 'context-menu-item';
      if (item.danger) el.style.color = 'var(--accent-rose)';
      el.innerHTML = `<span class="menu-icon" style="display:inline-flex;align-items:center;">${item.icon}</span>${item.label}${item.shortcut ? `<span class="menu-shortcut">${item.shortcut}</span>` : ''}`;
      el.addEventListener('click', (e) => { e.stopPropagation(); item.action(); this._hideContextMenu(); });
      menu.appendChild(el);
    });

    document.body.appendChild(menu);

    // Keep in viewport
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = (x - rect.width) + 'px';
    if (rect.bottom > window.innerHeight) menu.style.top = (y - rect.height) + 'px';
  }

  _hideContextMenu() {
    const menu = document.getElementById('canvas-context-menu');
    if (menu) menu.remove();
  }

  _openBulletsEditor(dom, el) {
    // Avoid double editors
    if (dom.querySelector('.inline-bullets-editor')) return;
    const items = Array.isArray(el.items) ? el.items : [];
    const textVal = items.join('\n');

    const wrapper = dom.querySelector('.bullets-wrapper');
    if (wrapper) wrapper.style.display = 'none';

    const editor = document.createElement('textarea');
    editor.className = 'inline-bullets-editor';
    editor.value = textVal;
    editor.style.cssText = `
      width: 100%;
      height: 100%;
      box-sizing: border-box;
      background: rgba(15, 23, 42, 0.95);
      color: ${el.color || '#ffffff'};
      font-family: ${el.fontFamily || 'Inter, sans-serif'};
      font-size: ${el.fontSize || 24}px;
      line-height: ${el.lineHeight || 1.5};
      border: 1px dashed var(--accent-indigo, #6366f1);
      border-radius: 4px;
      padding: 10px 14px;
      resize: none;
      outline: none;
      white-space: pre;
    `;

    dom.appendChild(editor);
    editor.focus();

    const commitChanges = () => {
      const rawLines = editor.value.split('\n');
      const filtered = rawLines.map(l => l.trim()).filter(l => l.length > 0);
      el.items = filtered.length > 0 ? filtered : ['Point clé'];
      
      editor.remove();
      if (wrapper) {
        wrapper.remove();
      }
      // Re-insert inner content
      const handles = dom.querySelector('.resize-handles');
      const rotateHandle = dom.querySelector('.rotate-handle');
      const temp = document.createElement('div');
      temp.innerHTML = this._innerHTML(el);
      const newWrapper = temp.firstElementChild;
      dom.insertBefore(newWrapper, handles);

      if (el.autoHeight) {
        // Measure natural height of list
        const bc = newWrapper.querySelector('.bullets-content');
        if (bc) {
          const naturalHeight = bc.scrollHeight + 16;
          if (naturalHeight > el.height) {
            el.height = naturalHeight;
            dom.style.height = el.height + 'px';
          }
        }
      }

      this.onChanged();
    };

    editor.addEventListener('blur', commitChanges, { once: true });
    editor.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        commitChanges();
      }
    });
  }

  _bindTableEvents(dom, el) {
    const table = dom.querySelector('.rfp-table');
    if (!table) return;

    const cells = table.querySelectorAll('th, td');
    cells.forEach(cell => {
      cell.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        this._editTableCell(dom, el, cell);
      });
    });

    // Auto-adapt element height to table's natural height
    setTimeout(() => {
      const naturalH = table.offsetHeight + 10;
      if (naturalH > 0 && Math.abs(el.height - naturalH) > 4) {
        el.height = naturalH;
        dom.style.height = naturalH + 'px';
      }
    }, 10);
  }

  _editTableCell(dom, el, cell) {
    if (cell.querySelector('input')) return;
    const isHeader = cell.tagName.toLowerCase() === 'th';
    const cIdx = parseInt(cell.dataset.colIdx);
    const rIdx = isHeader ? null : parseInt(cell.dataset.rowIdx);

    const initialVal = isHeader ? (el.columns[cIdx] || '') : (el.rows[rIdx] ? el.rows[rIdx][cIdx] || '' : '');
    const oldText = cell.innerText;
    cell.innerHTML = '';

    const input = document.createElement('input');
    input.type = 'text';
    input.value = initialVal;
    input.style.cssText = `
      width: 100%;
      box-sizing: border-box;
      background: rgba(15, 23, 42, 0.95);
      color: #ffffff;
      border: 1px solid var(--accent-indigo, #6366f1);
      border-radius: 2px;
      padding: 4px 6px;
      font-size: ${el.fontSize || 18}px;
      outline: none;
    `;
    cell.appendChild(input);
    input.focus();
    input.select();

    const commit = (moveToNext = false) => {
      const newVal = input.value;
      if (isHeader) {
        if (!Array.isArray(el.columns)) el.columns = [];
        el.columns[cIdx] = newVal;
      } else {
        if (!Array.isArray(el.rows)) el.rows = [];
        if (!Array.isArray(el.rows[rIdx])) el.rows[rIdx] = [];
        el.rows[rIdx][cIdx] = newVal;
      }
      this._syncDOM(el);
      this.onChanged();

      if (moveToNext) {
        setTimeout(() => {
          const freshDom = this.canvas.querySelector(`[data-el-id="${el.id}"]`);
          if (!freshDom) return;
          let nextCell = null;
          if (isHeader) {
            if (cIdx + 1 < el.columns.length) {
              nextCell = freshDom.querySelector(`th[data-col-idx="${cIdx + 1}"]`);
            } else if (el.rows.length > 0) {
              nextCell = freshDom.querySelector(`td[data-row-idx="0"][data-col-idx="0"]`);
            }
          } else {
            if (cIdx + 1 < el.columns.length) {
              nextCell = freshDom.querySelector(`td[data-row-idx="${rIdx}"][data-col-idx="${cIdx + 1}"]`);
            } else if (rIdx + 1 < el.rows.length) {
              nextCell = freshDom.querySelector(`td[data-row-idx="${rIdx + 1}"][data-col-idx="0"]`);
            }
          }
          if (nextCell) this._editTableCell(freshDom, el, nextCell);
        }, 20);
      }
    };

    input.addEventListener('blur', () => commit(false), { once: true });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        input.blur();
      } else if (e.key === 'Tab') {
        e.preventDefault();
        input.removeEventListener('blur', () => commit(false));
        commit(true);
      } else if (e.key === 'Escape') {
        cell.innerText = oldText;
      }
    });
  }

  _checkCardOverflow(dom) {
    const body = dom.querySelector('.card-body');
    const marker = dom.querySelector('.card-overflow-marker');
    if (!body || !marker) return;

    const title = body.querySelector('.card-title');
    const text = body.querySelector('.card-text');
    if (!title || !text) return;

    const isOverflowing = (title.scrollHeight + text.scrollHeight) > (body.clientHeight + 4);
    marker.style.display = isOverflowing ? 'flex' : 'none';
  }

  _openCardEditor(dom, el) {
    if (dom.querySelector('.inline-card-editor')) return;
    const body = dom.querySelector('.card-body');
    if (!body) return;

    body.style.display = 'none';

    const editor = document.createElement('div');
    editor.className = 'inline-card-editor';
    editor.style.cssText = `
      padding: 12px 16px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      width: 100%;
      height: 100%;
      box-sizing: border-box;
      background: rgba(15, 23, 42, 0.98);
      position: absolute;
      top: 0;
      left: 0;
      z-index: 1002;
    `;

    const titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.placeholder = 'Titre de la carte';
    titleInput.value = el.title || '';
    titleInput.style.cssText = `
      background: #0f172a;
      border: 1px solid var(--accent-indigo, #6366f1);
      border-radius: 4px;
      color: #ffffff;
      font-size: 18px;
      font-weight: 700;
      padding: 6px 10px;
      outline: none;
    `;

    const textArea = document.createElement('textarea');
    textArea.placeholder = 'Texte descriptif...';
    textArea.value = el.text || '';
    textArea.style.cssText = `
      flex: 1;
      background: #0f172a;
      border: 1px solid rgba(255, 255, 255, 0.2);
      border-radius: 4px;
      color: #ffffff;
      font-size: 14px;
      line-height: 1.4;
      padding: 8px 10px;
      resize: none;
      outline: none;
    `;

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;';
    const okBtn = document.createElement('button');
    okBtn.className = 'btn btn-primary btn-xs';
    okBtn.textContent = 'Valider';

    btnRow.appendChild(okBtn);
    editor.appendChild(titleInput);
    editor.appendChild(textArea);
    editor.appendChild(btnRow);
    dom.appendChild(editor);

    titleInput.focus();

    const commit = () => {
      el.title = titleInput.value.trim() || 'Titre de la carte';
      el.text = textArea.value.trim() || 'Description';
      editor.remove();
      this._syncDOM(el);
      this.onChanged();
    };

    okBtn.addEventListener('click', commit);
    editor.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.ctrlKey) {
        commit();
      } else if (e.key === 'Escape') {
        editor.remove();
        body.style.display = 'flex';
      }
    });
  }

  /* ────────────────────────────────────────────────────────────────
     Zoom
     ──────────────────────────────────────────────────────────────── */

  setZoom(z) {
    this.zoom = Math.max(0.2, Math.min(2, z));
    this.canvas.style.transform = `scale(${this.zoom})`;
    return this.zoom;
  }

  /* ────────────────────────────────────────────────────────────────
     Serialization
     ──────────────────────────────────────────────────────────────── */

  getState() {
    return JSON.parse(JSON.stringify(this.elements));
  }

  setState(elements) {
    this.clearAll();
    this.elements = elements || [];
    this.renderAll();
  }
}

window.CanvasEngine = CanvasEngine;
