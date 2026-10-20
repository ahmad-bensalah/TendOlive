/* ═══════════════════════════════════════════════════════════════════
   app.js — Production controller for RFP Slide Deck Studio
   Orchestrates slide management, navigation drawer, floating context bar,
   canvas engine, history undo/redo, auto-save persistence, and export.
   ═══════════════════════════════════════════════════════════════════ */

// ── Application State ──────────────────────────────────────────────
let project = {
  id: null,
  name: 'Mon RFP Commercial',
  theme: {
    bg: '#0f172a',
    primary: '#6366f1',
    secondary: '#10b981',
    accent: '#06b6d4',
    text: '#ffffff',
    textMuted: '#94a3b8',
    fontHeading: "'Plus Jakarta Sans', sans-serif",
    fontBody: "'Inter', sans-serif",
    fontHeadingWeight: 700,
    fontBodyWeight: 400,
    background: { type: 'solid', color: '#0f172a' },
  },
  slides: [],
  activeSlideIndex: 0,
};

let history;
let engine;
let autoSaveTimer = null;
let saveDebounceTimer = null;
let isSaving = false;
let pendingSave = false;
let serverConfig = { hasRegenerate: false };

// ── Toast System ───────────────────────────────────────────────────
function showToast(message, type = 'info', duration = 3000) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(8px)';
    setTimeout(() => toast.remove(), 250);
  }, duration);
}

// ── Initialization ─────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  history = new HistoryManager(60);

  // Load from session, URL param ?id=, or saved project
  const urlParams = new URLSearchParams(window.location.search);
  const urlId = urlParams.get('id') || urlParams.get('deck');
  const newRfp = sessionStorage.getItem('rfp_new');
  const loadId = urlId || sessionStorage.getItem('rfp_load_id');

  if (urlId) {
    sessionStorage.removeItem('rfp_new');
    sessionStorage.removeItem('rfp_load_id');
  }

  if (newRfp && !urlId) {
    sessionStorage.removeItem('rfp_new');
    const data = JSON.parse(newRfp);
    project.name = data.name || 'Mon RFP Commercial';
    project.theme = data.theme || project.theme;
    if (data._canvasSize) project._canvasSize = data._canvasSize;
    if (data.slides && data.slides.length > 0) {
      project.slides = data.slides;
    } else {
      project.slides = [createTitleSlide(), createBlankSlide(), createThankYouSlide()];
    }
  } else if (loadId) {
    sessionStorage.removeItem('rfp_load_id');
    try {
      const res = await fetch(`/api/save/${loadId}`);
      const data = await res.json();
      if (!data.error) {
        project = data;
        project.id = loadId;
        const nameInput = document.getElementById('project-name-input');
        if (nameInput && project.name) nameInput.value = project.name;
        project.activeSlideIndex = 0;
      }
    } catch (e) {
      console.error('Failed to load project from server:', e);
      showToast('Impossible de charger le projet depuis le serveur', 'error');
    }
  } else {
    // Check localStorage fallback
    const autosaved = localStorage.getItem('rfp_autosave');
    if (autosaved) {
      try {
        project = JSON.parse(autosaved);
        project.activeSlideIndex = 0;
      } catch (e) {}
    }
    if (!project.slides || project.slides.length === 0) {
      project.slides = [createTitleSlide(), createBlankSlide(), createThankYouSlide()];
    }
  }

  // Ensure coordinates scale to 1920×1080
  migrateProjectDimensions();
  
  // Initialize opacity for existing elements
  migrateElementOpacity();

  // Fetch server configuration
  try {
    const cfgRes = await fetch('/api/config');
    if (cfgRes.ok) {
      serverConfig = await cfgRes.json();
    }
  } catch (e) {
    console.warn('Failed to load server config:', e);
  }

  // Setup UI components
  setupProjectTitle();
  setupNavRail();
  setupExportDropdown();
  setupShortcutsModal();
  setupSourcesModal();

  // Initialize Canvas Engine
  const canvasEl = document.getElementById('slide-canvas');
  engine = new CanvasEngine(canvasEl, {
    theme: project.theme,
    onChanged: onCanvasChanged,
    onSelectionChanged: onSelectionChanged,
  });
  // static/interactions.js (opacity control) reads window.engine; a top-level `let` is not a window property
  window.engine = engine;

  loadSlideToCanvas(project.activeSlideIndex);
  renderSlideList();
  updateReviewPanel();
  renderLayersPanel();
  history.push(getSnapshot());

  // Setup interaction tools & shortcuts
  setupAddTools();
  setupContextBar();
  setupThemePanel();
  setupZoom();
  setupKeyboardShortcuts();

  // Initial save status & debounced background autosave
  updateSaveStatus('saved');
  startAutoSave();
});

// ── Project Title Renaming ─────────────────────────────────────────
function setupProjectTitle() {
  const input = document.getElementById('project-name-input');
  if (!input) return;
  input.value = project.name || 'Mon RFP Commercial';
  input.addEventListener('change', () => {
    project.name = input.value.trim() || 'Mon RFP Commercial';
    recordChange();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
  });
}

// ── Nav Rail & Drawer Navigation ───────────────────────────────────
function setupNavRail() {
  const railBtns = document.querySelectorAll('.nav-rail-btn');
  railBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      railBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const targetPanelId = btn.dataset.panel;
      document.querySelectorAll('.drawer-panel').forEach(p => p.classList.remove('active'));
      const activePanel = document.getElementById(targetPanelId);
      if (activePanel) activePanel.classList.add('active');
      if (targetPanelId === 'panel-layers') renderLayersPanel();
      if (targetPanelId === 'panel-uploads') renderMediaLibrary();
    });
  });
}

// ── Slide List & Thumbnails ────────────────────────────────────────
function renderSlideList() {
  const list = document.getElementById('slide-list');
  if (!list) return;
  list.innerHTML = '';

  const badge = document.getElementById('slide-count-badge');
  if (badge) badge.textContent = project.slides.length;

  const indicator = document.getElementById('status-slide-indicator');
  if (indicator) indicator.textContent = `Slide ${project.activeSlideIndex + 1} / ${project.slides.length}`;

  project.slides.forEach((slide, i) => {
    const item = document.createElement('div');
    item.className = 'slide-thumb' + (i === project.activeSlideIndex ? ' active' : '');
    item.draggable = true;
    item.dataset.slideIdx = i;

    const label = slide.label || `Slide ${i + 1}`;
    const previewSvg = generateSlidePreviewSVG(slide);

    // Calculate status badge
    const placeholders = countPlaceholdersInSlide(slide);
    const hasWarnings = Array.isArray(slide.warnings) && slide.warnings.length > 0;
    const isApproved = project.approvals && project.approvals.pricing;
    let badgeHtml = '';
    if (placeholders > 0) {
      badgeHtml = `<span class="slide-status-badge red" title="${placeholders} placeholder(s) restant(s)">${placeholders}</span>`;
    } else if (slide.requiresApproval && isApproved) {
      badgeHtml = `<span class="slide-status-badge check" title="Tarifs approuvés">✓</span>`;
    } else if (hasWarnings || slide.requiresApproval) {
      badgeHtml = `<span class="slide-status-badge orange" title="Avertissement ou approbation requise">!</span>`;
    }

    let regenBtnHtml = '';
    const isFixedSlide = (i === 0 || i === project.slides.length - 1);
    if (serverConfig.hasRegenerate && project.id && !isFixedSlide) {
      regenBtnHtml = `
        <button class="btn btn-ghost btn-icon sm btn-slide-regen" data-action="regen" data-idx="${i}" title="Régénérer cette slide via l'agent n8n">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>
        </button>
      `;
    }

    item.innerHTML = `
      <div class="thumb-preview" style="background:${project.theme.bg};">
        ${previewSvg}
      </div>
      <div class="thumb-info">
        <div class="thumb-num">#${i + 1} ${badgeHtml}</div>
        <div class="thumb-label">${escHtml(label)}</div>
      </div>
      <div class="thumb-actions">
        ${regenBtnHtml}
        <button class="btn btn-ghost btn-icon sm" data-action="dup" data-idx="${i}" title="Dupliquer la slide">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
        </button>
        <button class="btn btn-ghost btn-icon sm" data-action="del" data-idx="${i}" title="Supprimer la slide">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"></path></svg>
        </button>
      </div>
    `;

    // Click to switch
    item.addEventListener('click', (e) => {
      if (e.target.closest('[data-action]')) return;
      switchToSlide(i);
    });

    // Drag-and-drop slide reordering
    item.addEventListener('dragstart', (e) => {
      item.classList.add('dragging');
      e.dataTransfer.setData('text/plain', i.toString());
      e.dataTransfer.effectAllowed = 'move';
    });
    item.addEventListener('dragend', () => item.classList.remove('dragging'));
    item.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; });
    item.addEventListener('drop', (e) => {
      e.preventDefault();
      const fromIdx = parseInt(e.dataTransfer.getData('text/plain'));
      const toIdx = i;
      if (fromIdx !== toIdx) {
        const moved = project.slides.splice(fromIdx, 1)[0];
        project.slides.splice(toIdx, 0, moved);
        project.activeSlideIndex = toIdx;
        loadSlideToCanvas(toIdx);
        renderSlideList();
        if (moved && moved.requiresApproval) {
          resetPricingApproval();
        }
        recordChange();
        showToast(`Slide déplacée en position #${toIdx + 1}`);
      }
    });

    list.appendChild(item);
  });

  // Action buttons
  list.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const action = btn.dataset.action;
      const idx = parseInt(btn.dataset.idx);
      if (action === 'dup') duplicateSlide(idx);
      if (action === 'del') deleteSlide(idx);
      if (action === 'regen') regenerateSlide(idx);
    });
  });
}

function generateSlidePreviewSVG(slide) {
  const elements = slide.elements || [];
  let svgContent = '';
  // Map 1920x1080 to viewBox 0 0 1920 1080
  elements.forEach(el => {
    if (el.type === 'text') {
      const fill = el.color || '#ffffff';
      const text = escHtml((el.content || '').substring(0, 30));
      svgContent += `<text x="${el.x + 10}" y="${el.y + (el.fontSize || 30)}" fill="${fill}" font-size="${el.fontSize || 24}" font-family="sans-serif" opacity="0.85">${text}</text>`;
    } else if (el.type === 'shape') {
      const fill = el.fill || 'transparent';
      const stroke = el.stroke || '#6366f1';
      const sw = el.strokeWidth || 2;
      if (el.shapeType === 'path' && Array.isArray(el.pathData)) {
        const pathW = Number(el.pathWidth) || el.width;
        const pathH = Number(el.pathHeight) || el.height;
        const tx = el.pathFlipH ? pathW : 0;
        const ty = el.pathFlipV ? pathH : 0;
        const transform = (el.pathFlipH || el.pathFlipV)
          ? ` transform="translate(${tx} ${ty}) scale(${el.pathFlipH ? -1 : 1} ${el.pathFlipV ? -1 : 1})"` : '';
        const paths = el.pathData.map(path => `<path d="${escHtml(path.d)}" fill="${path.noFill ? 'none' : fill}" stroke="${path.noStroke || !sw ? 'none' : stroke}" stroke-width="${sw}"/>`).join('');
        svgContent += `<svg x="${el.x}" y="${el.y}" width="${el.width}" height="${el.height}" viewBox="0 0 ${pathW} ${pathH}" preserveAspectRatio="none"><g${transform}>${paths}</g></svg>`;
        return;
      }
      const rx = el.shapeType === 'circle' ? el.width / 2 : (el.borderRadius || 0);
      svgContent += `<rect x="${el.x}" y="${el.y}" width="${el.width}" height="${el.height}" rx="${rx}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" />`;
    } else if (el.type === 'image') {
      svgContent += `<rect x="${el.x}" y="${el.y}" width="${el.width}" height="${el.height}" fill="rgba(255,255,255,0.1)" stroke="rgba(255,255,255,0.2)" stroke-dasharray="4,4" />`;
    }
  });
  return `<svg viewBox="0 0 1920 1080" preserveAspectRatio="xMidYMid slice">${svgContent}</svg>`;
}

function switchToSlide(idx) {
  if (idx < 0 || idx >= project.slides.length) return;
  saveCurrentSlideElements();
  project.activeSlideIndex = idx;
  loadSlideToCanvas(idx);
  renderSlideList();
  updateContextBar(null);
  
  // Update page number display
  if (typeof updatePageNumber === 'function') {
    updatePageNumber(idx + 1, project.slides.length);
  }
}

function addSlide(type) {
  let slide;
  if (type === 'title') slide = createTitleSlide();
  else if (type === 'thankyou') slide = createThankYouSlide();
  else slide = createBlankSlide();

  const insertAt = project.activeSlideIndex + 1;
  project.slides.splice(insertAt, 0, slide);
  switchToSlide(insertAt);
  renderSlideList();
  recordChange();
  showToast('Nouvelle diapositive ajoutée');
}

function duplicateSlide(idx) {
  const dup = JSON.parse(JSON.stringify(project.slides[idx]));
  dup.label = (dup.label || 'Diapositive') + ' (copie)';
  // Give all elements unique IDs
  (dup.elements || []).forEach(el => {
    el.id = 'el_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
  });
  project.slides.splice(idx + 1, 0, dup);
  switchToSlide(idx + 1);
  renderSlideList();
  recordChange();
  showToast('Diapositive dupliquée');
}

function deleteSlide(idx) {
  if (project.slides.length <= 1) {
    showToast('La présentation doit comporter au moins une diapositive', 'info');
    return;
  }
  const deleted = project.slides.splice(idx, 1)[0];
  if (deleted && deleted.requiresApproval) {
    resetPricingApproval();
  }
  if (project.activeSlideIndex >= project.slides.length) {
    project.activeSlideIndex = project.slides.length - 1;
  }
  loadSlideToCanvas(project.activeSlideIndex);
  renderSlideList();
  recordChange();
  showToast('Diapositive supprimée');
}

// ── Slide Factories ────────────────────────────────────────────────
function createTitleSlide() {
  const t = project.theme;
  const isLight = t.bg && (t.bg.toLowerCase() === '#ffffff' || t.bg.toLowerCase().startsWith('#f'));
  const textColor = isLight ? '#0f172a' : (t.text || '#ffffff');
  const primaryColor = t.primary || '#6366f1';
  const mutedColor = isLight ? '#64748b' : (t.textMuted || '#94a3b8');

  return {
    type: 'title',
    label: 'Titre & Couverture',
    elements: [
      {
        id: 'el_title_card',
        type: 'shape',
        shapeType: 'rectangle',
        fill: 'rgba(255, 255, 255, 0.03)',
        stroke: primaryColor,
        strokeWidth: 2,
        strokeStyle: 'solid',
        borderRadius: 20,
        x: 200, y: 220,
        width: 1520, height: 640,
        zIndex: 1,
      },
      {
        id: 'el_title_main',
        type: 'text',
        content: project.name || 'Proposition Commerciale RFP',
        x: 260, y: 340,
        width: 1400, height: 160,
        fontFamily: t.fontHeading || "'Plus Jakarta Sans', sans-serif",
        fontSize: 72,
        fontWeight: 800,
        color: textColor,
        textAlign: 'center',
        zIndex: 2,
      },
      {
        id: 'el_title_client',
        type: 'text',
        content: 'Réponse à Appel d\'Offres — Dossier Technique & Financier',
        x: 360, y: 540,
        width: 1200, height: 80,
        fontFamily: t.fontBody || "'Inter', sans-serif",
        fontSize: 32,
        fontWeight: 600,
        color: primaryColor,
        textAlign: 'center',
        zIndex: 3,
      },
      {
        id: 'el_title_date',
        type: 'text',
        content: new Date().toLocaleDateString('fr-FR', { year: 'numeric', month: 'long', day: 'numeric' }),
        x: 560, y: 680,
        width: 800, height: 60,
        fontFamily: t.fontBody || "'Inter', sans-serif",
        fontSize: 22,
        fontWeight: 400,
        color: mutedColor,
        textAlign: 'center',
        zIndex: 4,
      },
    ],
  };
}

function createBlankSlide() {
  const t = project.theme;
  const isLight = t.bg && (t.bg.toLowerCase() === '#ffffff' || t.bg.toLowerCase().startsWith('#f'));
  const textColor = isLight ? '#0f172a' : (t.text || '#ffffff');
  return {
    type: 'blank',
    label: 'Diapositive de contenu',
    elements: [
      {
        id: 'el_blank_heading',
        type: 'text',
        content: 'Titre de la section',
        x: 140, y: 120,
        width: 1200, height: 80,
        fontFamily: t.fontHeading || "'Plus Jakarta Sans', sans-serif",
        fontSize: 48,
        fontWeight: 700,
        color: textColor,
        textAlign: 'left',
        zIndex: 1,
      },
    ],
  };
}

function createThankYouSlide() {
  const t = project.theme;
  const isLight = t.bg && (t.bg.toLowerCase() === '#ffffff' || t.bg.toLowerCase().startsWith('#f'));
  const textColor = isLight ? '#0f172a' : (t.text || '#ffffff');
  const slide = {
    type: 'thankyou',
    label: 'Conclusion & Contact',
    elements: [
      {
        id: 'el_thanks_msg',
        type: 'text',
        content: 'Merci pour votre confiance',
        x: 360, y: 240,
        width: 1200, height: 120,
        fontFamily: t.fontHeading || "'Plus Jakarta Sans', sans-serif",
        fontSize: 64,
        fontWeight: 800,
        color: textColor,
        textAlign: 'center',
        zIndex: 2,
      },
      {
        id: 'el_thanks_sub',
        type: 'text',
        content: 'Scannez pour accéder au dossier digitalisé complet',
        x: 460, y: 400,
        width: 1000, height: 60,
        fontFamily: t.fontBody || "'Inter', sans-serif",
        fontSize: 26,
        fontWeight: 500,
        color: t.primary || '#6366f1',
        textAlign: 'center',
        zIndex: 3,
      },
      {
        id: 'el_thanks_qr',
        type: 'image',
        src: '',
        alt: 'QR Code dossier',
        x: 810, y: 500,
        width: 300, height: 300,
        zIndex: 4,
      },
    ],
  };

  // Generate QR code via backend API locally
  fetch('/api/qrcode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://rfp-studio.com' }),
  })
    .then(r => r.json())
    .then(res => {
      if (res && res.dataurl) {
        const qrEl = slide.elements.find(e => e.id === 'el_thanks_qr');
        if (qrEl) {
          qrEl.src = res.dataurl;
          if (canvasEngine && project.slides[currentSlideIdx] === slide) {
            canvasEngine.loadElements(slide.elements);
          }
        }
      }
    })
    .catch(() => {});

  return slide;
}

// ── Slide Canvas Sync ──────────────────────────────────────────────
function loadSlideToCanvas(idx) {
  const slide = project.slides[idx];
  if (!slide) return;
  const canvasEl = document.getElementById('slide-canvas');

  // Apply theme background
  const bg = project.theme.background || { type: 'solid', color: project.theme.bg };
  if (bg.type === 'image' && bg.dataurl) {
    canvasEl.style.background = `url(${bg.dataurl}) center/cover no-repeat`;
  } else if (bg.type === 'gradient' && bg.stops) {
    const stops = bg.stops.map(s => `${s.color} ${s.position}%`).join(', ');
    canvasEl.style.background = `linear-gradient(135deg, ${stops})`;
  } else {
    canvasEl.style.background = bg.color || project.theme.bg;
  }

  engine.clearAll();
  if (slide.elements && slide.elements.length > 0) {
    engine.setState(slide.elements);
  }
  updateContextBar(null);
  renderLayersPanel();
}

function saveCurrentSlideElements() {
  const slide = project.slides[project.activeSlideIndex];
  if (!slide) return;
  slide.elements = engine.getState();
}

function resetPricingApproval() {
  if (project.approvals && project.approvals.pricing) {
    delete project.approvals.pricing;
    delete project.approvals.at;
  }
}

function onCanvasChanged() {
  saveCurrentSlideElements();
  recordChange(project.slides[project.activeSlideIndex]);
  renderLayersPanel();
}

function recordChange(slideModified) {
  // If the modified slide requires approval, reset pricing approval
  const s = slideModified !== undefined ? slideModified : project.slides[project.activeSlideIndex];
  if (s && s.requiresApproval) {
    resetPricingApproval();
  }
  history.push(getSnapshot());
  renderSlideList();
  updateReviewPanel();
  updateSaveStatus('unsaved');
  scheduleAutoSave();
}

// ── Floating Context Bar ───────────────────────────────────────────
function onSelectionChanged(el) {
  updateContextBar(el);
  renderLayersPanel();
}

// ── Active-slide layer panel ──────────────────────────────────────
function layerLabel(el) {
  const text = String(el.content || el.title || el.alt || '').trim().replace(/\s+/g, ' ');
  const shortText = text.length > 38 ? `${text.slice(0, 35)}…` : text;
  const names = {
    text: 'Texte', bullets: 'Liste', table: 'Tableau', card: 'Carte',
    shape: 'Forme', image: 'Image', video: 'Vidéo', kpi: 'Indicateur',
  };
  return shortText || names[el.type] || 'Élément';
}

function layerTypeIcon(type) {
  return ({ text: 'T', bullets: '•', table: '▦', card: '▤', shape: '◇', image: '▧', video: '▶', kpi: '◉' })[type] || '□';
}

function renderLayersPanel() {
  const list = document.getElementById('layers-list');
  const badge = document.getElementById('layers-count-badge');
  if (!list) return;
  const slide = project.slides[project.activeSlideIndex];
  const elements = engine && slide ? engine.getState() : (slide?.elements || []);
  const ordered = [...elements].sort((a, b) => (b.zIndex || 0) - (a.zIndex || 0));
  if (badge) badge.textContent = ordered.length;
  list.innerHTML = '';

  if (!ordered.length) {
    list.innerHTML = '<div class="layers-empty">Cette diapositive ne contient aucun calque.</div>';
    return;
  }

  ordered.forEach((el, index) => {
    const item = document.createElement('div');
    const selected = engine && engine.selectedId === el.id;
    item.className = `layer-item${selected ? ' selected' : ''}`;
    item.title = `Calque ${index + 1} : ${layerLabel(el)}`;
    item.innerHTML = `
      <span class="layer-order">${index + 1}</span>
      <span class="layer-type-icon">${layerTypeIcon(el.type)}</span>
      <span class="layer-name">${escHtml(layerLabel(el))}</span>
      ${el.locked ? '<span class="layer-lock" title="Position verrouillée">🔒</span>' : ''}
      <span class="layer-actions">
        <button class="btn btn-ghost btn-icon sm" data-layer-action="front" title="Avancer d’un calque" ${index === 0 ? 'disabled' : ''}>↑</button>
        <button class="btn btn-ghost btn-icon sm" data-layer-action="back" title="Reculer d’un calque" ${index === ordered.length - 1 ? 'disabled' : ''}>↓</button>
      </span>`;
    item.addEventListener('click', () => engine.selectElement(el.id));
    item.querySelectorAll('[data-layer-action]').forEach(button => {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        engine.moveLayer(el.id, button.dataset.layerAction === 'front' ? 1 : -1);
      });
    });
    list.appendChild(item);
  });
}

function updateContextBar(el) {
  const bar = document.getElementById('context-bar');
  const textControls = document.getElementById('bar-text-controls');
  const bulletsControls = document.getElementById('bar-bullets-controls');
  const tableControls = document.getElementById('bar-table-controls');
  const cardControls = document.getElementById('bar-card-controls');
  const shapeControls = document.getElementById('bar-shape-controls');
  const opacityControl = document.getElementById('bar-opacity-control');

  if (!el) {
    bar.classList.remove('visible');
    if (opacityControl) opacityControl.style.display = 'none';
    return;
  }

  bar.classList.add('visible');
  updateLockButton(el);

  // Update opacity control (all elements EXCEPT text)
  if (window.updateContextBarForSelection) {
    window.updateContextBarForSelection(el);
  } else if (opacityControl) {
    // Fallback if interactions.js not loaded
    const showOpacity = el.type !== 'text';
    opacityControl.style.display = showOpacity ? 'flex' : 'none';
    
    if (showOpacity) {
      const opacity = el.opacity !== undefined ? el.opacity : 1;
      const opacityPercent = Math.round(opacity * 100);
      
      const slider = document.getElementById('prop-opacity-slider');
      const valueInput = document.getElementById('prop-opacity-value');
      if (slider) slider.value = opacityPercent;
      if (valueInput) valueInput.value = opacityPercent;
    }
  }

  if (el.type === 'text') {
    textControls.style.display = 'flex';
    if (bulletsControls) bulletsControls.style.display = 'none';
    if (tableControls) tableControls.style.display = 'none';
    if (cardControls) cardControls.style.display = 'none';
    shapeControls.style.display = 'none';

    document.getElementById('prop-font-family').value = el.fontFamily || "'Inter', sans-serif";
    document.getElementById('prop-font-size').value = el.fontSize || 24;
    document.getElementById('prop-font-color').value = el.color || '#ffffff';

    document.getElementById('btn-bold').classList.toggle('active', (el.fontWeight || 400) >= 700);
    document.getElementById('btn-italic').classList.toggle('active', el.fontStyle === 'italic');
    document.getElementById('btn-underline').classList.toggle('active', el.textDecoration === 'underline');
    document.getElementById('btn-link').classList.toggle('active', !!el.link);

    // Align buttons
    ['left', 'center', 'right'].forEach(a => {
      const btn = document.getElementById(`btn-align-${a}`);
      if (btn) btn.classList.toggle('active', (el.textAlign || 'left') === a);
    });
  } else if (el.type === 'bullets') {
    textControls.style.display = 'none';
    if (bulletsControls) bulletsControls.style.display = 'flex';
    if (tableControls) tableControls.style.display = 'none';
    if (cardControls) cardControls.style.display = 'none';
    shapeControls.style.display = 'none';

    const bStyle = document.getElementById('prop-bullets-style');
    if (bStyle) bStyle.value = el.bulletStyle || 'disc';
    const bFont = document.getElementById('prop-bullets-font');
    if (bFont) bFont.value = el.fontFamily || "'Inter', sans-serif";
    const bSize = document.getElementById('prop-bullets-size');
    if (bSize) bSize.value = el.fontSize || 24;
    const bColor = document.getElementById('prop-bullets-color');
    if (bColor) bColor.value = el.color || '#ffffff';
    const bLh = document.getElementById('prop-bullets-lineheight');
    if (bLh) bLh.value = el.lineHeight || 1.5;
    const bAuto = document.getElementById('prop-bullets-autoheight');
    if (bAuto) bAuto.checked = el.autoHeight !== false;
  } else if (el.type === 'table') {
    textControls.style.display = 'none';
    if (bulletsControls) bulletsControls.style.display = 'none';
    if (tableControls) tableControls.style.display = 'flex';
    if (cardControls) cardControls.style.display = 'none';
    shapeControls.style.display = 'none';

    const hFill = document.getElementById('prop-table-headerfill');
    if (hFill) hFill.value = el.headerFill && el.headerFill.startsWith('#') ? el.headerFill : '#4338ca';
    const hColor = document.getElementById('prop-table-headercolor');
    if (hColor) hColor.value = el.headerColor && el.headerColor.startsWith('#') ? el.headerColor : '#ffffff';
    const rFill = document.getElementById('prop-table-rowfill');
    if (rFill) rFill.value = el.rowFill && el.rowFill.startsWith('#') ? el.rowFill : '#1e293b';
    const altFill = document.getElementById('prop-table-altrowfill');
    if (altFill) altFill.value = el.altRowFill && el.altRowFill.startsWith('#') ? el.altRowFill : '#0f172a';
    const bColor = document.getElementById('prop-table-bordercolor');
    if (bColor) bColor.value = el.borderColor && el.borderColor.startsWith('#') ? el.borderColor : '#334155';
    const fSize = document.getElementById('prop-table-fontsize');
    if (fSize) fSize.value = el.fontSize || 18;
  } else if (el.type === 'card') {
    textControls.style.display = 'none';
    if (bulletsControls) bulletsControls.style.display = 'none';
    if (tableControls) tableControls.style.display = 'none';
    if (cardControls) cardControls.style.display = 'flex';
    shapeControls.style.display = 'none';

    const cFill = document.getElementById('prop-card-fill');
    if (cFill) cFill.value = el.fill && el.fill.startsWith('#') ? el.fill : '#1e293b';
    const cRadius = document.getElementById('prop-card-radius');
    if (cRadius) cRadius.value = el.radius !== undefined ? el.radius : 12;
  } else if (el.type === 'shape') {
    textControls.style.display = 'none';
    if (bulletsControls) bulletsControls.style.display = 'none';
    if (tableControls) tableControls.style.display = 'none';
    if (cardControls) cardControls.style.display = 'none';
    shapeControls.style.display = 'flex';

    document.getElementById('prop-shape-fill').value = el.fill && el.fill.startsWith('#') ? el.fill : '#6366f1';
    document.getElementById('prop-shape-stroke').value = el.stroke && el.stroke.startsWith('#') ? el.stroke : '#ffffff';
    document.getElementById('prop-shape-strokewidth').value = el.strokeWidth !== undefined ? el.strokeWidth : 2;
    syncShapeRadiusControls(el);
    document.getElementById('prop-shape-strokestyle').value = el.strokeStyle || 'solid';
  } else {
    textControls.style.display = 'none';
    if (bulletsControls) bulletsControls.style.display = 'none';
    if (tableControls) tableControls.style.display = 'none';
    if (cardControls) cardControls.style.display = 'none';
    shapeControls.style.display = 'none';
  }
}

function updateLockButton(el) {
  const button = document.getElementById('btn-toggle-lock');
  if (!button) return;
  const isLocked = Boolean(el && el.locked);
  button.classList.toggle('active', isLocked);
  button.setAttribute('aria-pressed', String(isLocked));
  button.title = isLocked ? 'Déverrouiller la position' : 'Verrouiller la position';
  button.setAttribute('aria-label', button.title);
}

// A CSS radius larger than half of the shortest side is indistinguishable from
// a pill. Keeping that limit in the model makes canvas, saved projects and PPTX
// exports agree on what the user selected.
function normalizedShapeRadius(el, value) {
  const shortestSide = Math.min(Number(el.width) || 0, Number(el.height) || 0);
  const limit = Math.max(0, shortestSide / 2);
  return Math.round(Math.max(0, Math.min(Number(value) || 0, limit)));
}

function syncShapeRadiusControls(el) {
  const numeric = document.getElementById('prop-shape-radius');
  const range = document.getElementById('prop-shape-radius-range');
  if (!numeric || !range) return;
  const max = Math.max(0, Math.floor(Math.min(Number(el.width) || 0, Number(el.height) || 0) / 2));
  const value = normalizedShapeRadius(el, el.borderRadius);
  numeric.max = max;
  range.max = max;
  numeric.value = value;
  range.value = value;
  const disabled = el.shapeType === 'circle' || max === 0;
  numeric.disabled = disabled;
  range.disabled = disabled;
  const radiusHint = el.shapeType === 'path'
    ? 'Arrondit les coins du cadre de cette forme importée.'
    : 'Rayon d’arrondi des coins';
  numeric.title = radiusHint;
  range.title = radiusHint;
}

function setupContextBar() {
  // Font Family
  document.getElementById('prop-font-family').addEventListener('change', (e) => {
    const sel = engine.getSelected();
    if (sel && sel.type === 'text') engine.updateElement(sel.id, { fontFamily: e.target.value });
  });

  // Font Size
  document.getElementById('prop-font-size').addEventListener('input', (e) => {
    const sel = engine.getSelected();
    if (sel && sel.type === 'text') {
      const val = parseInt(e.target.value) || 24;
      engine.updateElement(sel.id, { fontSize: Math.max(8, Math.min(400, val)) });
    }
  });

  // Font Color
  document.getElementById('prop-font-color').addEventListener('input', (e) => {
    const sel = engine.getSelected();
    if (sel && sel.type === 'text') engine.updateElement(sel.id, { color: e.target.value });
  });

  // Bold / Italic / Underline
  document.getElementById('btn-bold').addEventListener('click', () => {
    const sel = engine.getSelected();
    if (sel && sel.type === 'text') {
      const isBold = (sel.fontWeight || 400) >= 700;
      engine.updateElement(sel.id, { fontWeight: isBold ? 400 : 700 });
      document.getElementById('btn-bold').classList.toggle('active', !isBold);
    }
  });

  document.getElementById('btn-italic').addEventListener('click', () => {
    const sel = engine.getSelected();
    if (sel && sel.type === 'text') {
      const isItalic = sel.fontStyle === 'italic';
      engine.updateElement(sel.id, { fontStyle: isItalic ? 'normal' : 'italic' });
      document.getElementById('btn-italic').classList.toggle('active', !isItalic);
    }
  });

  document.getElementById('btn-underline').addEventListener('click', () => {
    const sel = engine.getSelected();
    if (sel && sel.type === 'text') {
      const isUnderline = sel.textDecoration === 'underline';
      engine.updateElement(sel.id, { textDecoration: isUnderline ? 'none' : 'underline' });
      document.getElementById('btn-underline').classList.toggle('active', !isUnderline);
    }
  });

  // Hyperlink on a text (optional): empty URL removes it
  document.getElementById('btn-link').addEventListener('click', () => {
    const sel = engine.getSelected();
    if (!sel || sel.type !== 'text') return;
    const url = window.prompt('Lien (https://..., mailto:...) — laisser vide pour supprimer', sel.link || '');
    if (url === null) return;
    const v = url.trim();
    if (v && !/^(https?:\/\/|mailto:)\S+$/i.test(v)) { alert('Lien invalide : utilisez https://, http:// ou mailto:'); return; }
    engine.updateElement(sel.id, { link: v || undefined });
    document.getElementById('btn-link').classList.toggle('active', !!v);
  });

  // Alignment
  ['left', 'center', 'right'].forEach(a => {
    document.getElementById(`btn-align-${a}`).addEventListener('click', () => {
      const sel = engine.getSelected();
      if (sel && sel.type === 'text') {
        engine.updateElement(sel.id, { textAlign: a });
        ['left', 'center', 'right'].forEach(other => {
          document.getElementById(`btn-align-${other}`).classList.toggle('active', other === a);
        });
      }
    });
  });

  // Bullets controls
  const bStyleInput = document.getElementById('prop-bullets-style');
  if (bStyleInput) {
    bStyleInput.addEventListener('change', (e) => {
      const sel = engine.getSelected();
      if (sel && sel.type === 'bullets') engine.updateElement(sel.id, { bulletStyle: e.target.value });
    });
  }
  const bFontInput = document.getElementById('prop-bullets-font');
  if (bFontInput) {
    bFontInput.addEventListener('change', (e) => {
      const sel = engine.getSelected();
      if (sel && sel.type === 'bullets') engine.updateElement(sel.id, { fontFamily: e.target.value });
    });
  }
  const bSizeInput = document.getElementById('prop-bullets-size');
  if (bSizeInput) {
    bSizeInput.addEventListener('input', (e) => {
      const sel = engine.getSelected();
      if (sel && sel.type === 'bullets') {
        const val = parseInt(e.target.value) || 24;
        engine.updateElement(sel.id, { fontSize: Math.max(8, Math.min(200, val)) });
      }
    });
  }
  const bColorInput = document.getElementById('prop-bullets-color');
  if (bColorInput) {
    bColorInput.addEventListener('input', (e) => {
      const sel = engine.getSelected();
      if (sel && sel.type === 'bullets') engine.updateElement(sel.id, { color: e.target.value });
    });
  }
  const bLhInput = document.getElementById('prop-bullets-lineheight');
  if (bLhInput) {
    bLhInput.addEventListener('input', (e) => {
      const sel = engine.getSelected();
      if (sel && sel.type === 'bullets') {
        const val = parseFloat(e.target.value) || 1.5;
        engine.updateElement(sel.id, { lineHeight: val });
      }
    });
  }
  const bAutoInput = document.getElementById('prop-bullets-autoheight');
  if (bAutoInput) {
    bAutoInput.addEventListener('change', (e) => {
      const sel = engine.getSelected();
      if (sel && sel.type === 'bullets') engine.updateElement(sel.id, { autoHeight: e.target.checked });
    });
  }

  // Table controls
  const btnAddRow = document.getElementById('btn-table-add-row');
  if (btnAddRow) {
    btnAddRow.addEventListener('click', () => {
      const sel = engine.getSelected();
      if (sel && sel.type === 'table') {
        const colsCount = Array.isArray(sel.columns) ? sel.columns.length : 3;
        const newRow = new Array(colsCount).fill('Texte');
        const rows = Array.isArray(sel.rows) ? [...sel.rows, newRow] : [newRow];
        engine.updateElement(sel.id, { rows });
      }
    });
  }
  const btnDelRow = document.getElementById('btn-table-del-row');
  if (btnDelRow) {
    btnDelRow.addEventListener('click', () => {
      const sel = engine.getSelected();
      if (sel && sel.type === 'table') {
        if (Array.isArray(sel.rows) && sel.rows.length > 1) {
          const rows = sel.rows.slice(0, -1);
          engine.updateElement(sel.id, { rows });
        } else {
          showToast('Le tableau doit conserver au moins 1 ligne');
        }
      }
    });
  }
  const btnAddCol = document.getElementById('btn-table-add-col');
  if (btnAddCol) {
    btnAddCol.addEventListener('click', () => {
      const sel = engine.getSelected();
      if (sel && sel.type === 'table') {
        const cols = Array.isArray(sel.columns) ? [...sel.columns, `Col ${sel.columns.length + 1}`] : ['Col 1'];
        const rows = (sel.rows || []).map(r => [...r, 'Texte']);
        engine.updateElement(sel.id, { columns: cols, rows });
      }
    });
  }
  const btnDelCol = document.getElementById('btn-table-del-col');
  if (btnDelCol) {
    btnDelCol.addEventListener('click', () => {
      const sel = engine.getSelected();
      if (sel && sel.type === 'table') {
        if (Array.isArray(sel.columns) && sel.columns.length > 1) {
          const cols = sel.columns.slice(0, -1);
          const rows = (sel.rows || []).map(r => r.slice(0, -1));
          engine.updateElement(sel.id, { columns: cols, rows });
        } else {
          showToast('Le tableau doit conserver au moins 1 colonne');
        }
      }
    });
  }
  const tHFill = document.getElementById('prop-table-headerfill');
  if (tHFill) {
    tHFill.addEventListener('input', (e) => {
      const sel = engine.getSelected();
      if (sel && sel.type === 'table') engine.updateElement(sel.id, { headerFill: e.target.value });
    });
  }
  const tHColor = document.getElementById('prop-table-headercolor');
  if (tHColor) {
    tHColor.addEventListener('input', (e) => {
      const sel = engine.getSelected();
      if (sel && sel.type === 'table') engine.updateElement(sel.id, { headerColor: e.target.value });
    });
  }
  const tRFill = document.getElementById('prop-table-rowfill');
  if (tRFill) {
    tRFill.addEventListener('input', (e) => {
      const sel = engine.getSelected();
      if (sel && sel.type === 'table') engine.updateElement(sel.id, { rowFill: e.target.value });
    });
  }
  const tAltFill = document.getElementById('prop-table-altrowfill');
  if (tAltFill) {
    tAltFill.addEventListener('input', (e) => {
      const sel = engine.getSelected();
      if (sel && sel.type === 'table') engine.updateElement(sel.id, { altRowFill: e.target.value });
    });
  }
  const tBorder = document.getElementById('prop-table-bordercolor');
  if (tBorder) {
    tBorder.addEventListener('input', (e) => {
      const sel = engine.getSelected();
      if (sel && sel.type === 'table') engine.updateElement(sel.id, { borderColor: e.target.value });
    });
  }
  const tFontSize = document.getElementById('prop-table-fontsize');
  if (tFontSize) {
    tFontSize.addEventListener('input', (e) => {
      const sel = engine.getSelected();
      if (sel && sel.type === 'table') {
        const val = parseInt(e.target.value) || 18;
        engine.updateElement(sel.id, { fontSize: Math.max(10, Math.min(64, val)) });
      }
    });
  }

  // Card controls
  const cFillInput = document.getElementById('prop-card-fill');
  if (cFillInput) {
    cFillInput.addEventListener('input', (e) => {
      const sel = engine.getSelected();
      if (sel && sel.type === 'card') engine.updateElement(sel.id, { fill: e.target.value });
    });
  }
  const cRadiusInput = document.getElementById('prop-card-radius');
  if (cRadiusInput) {
    cRadiusInput.addEventListener('input', (e) => {
      const sel = engine.getSelected();
      if (sel && sel.type === 'card') {
        const val = parseInt(e.target.value) || 0;
        engine.updateElement(sel.id, { radius: val });
      }
    });
  }
  const btnCardChooseImg = document.getElementById('btn-card-choose-img');
  if (btnCardChooseImg) {
    btnCardChooseImg.addEventListener('click', () => {
      const sel = engine.getSelected();
      if (sel && sel.type === 'card') {
        // Trigger media file input
        const fileInput = document.getElementById('media-file-input');
        if (fileInput) {
          const onCardImageChosen = async (ev) => {
            const file = ev.target.files && ev.target.files[0];
            if (file) {
              const formData = new FormData();
              formData.append('file', file);
              try {
                const res = await fetch('/api/upload', { method: 'POST', body: formData });
                const data = await res.json();
                if (data.status === 'ok') {
                  engine.updateElement(sel.id, { image: data.url });
                  showToast('Image appliquée à la carte');
                } else {
                  showToast(data.message || 'Erreur upload', 'error');
                }
              } catch (err) {
                showToast('Erreur réseau', 'error');
              }
            }
            fileInput.removeEventListener('change', onCardImageChosen);
            fileInput.value = '';
          };
          fileInput.addEventListener('change', onCardImageChosen);
          fileInput.click();
        }
      }
    });
  }
  const btnCardRemoveImg = document.getElementById('btn-card-remove-img');
  if (btnCardRemoveImg) {
    btnCardRemoveImg.addEventListener('click', () => {
      const sel = engine.getSelected();
      if (sel && sel.type === 'card') {
        engine.updateElement(sel.id, { image: null });
        showToast('Image retirée');
      }
    });
  }

  // Shape controls
  document.getElementById('prop-shape-fill').addEventListener('input', (e) => {
    const sel = engine.getSelected();
    if (sel && sel.type === 'shape') engine.updateElement(sel.id, { fill: e.target.value, ...(sel.shapeType === 'path' ? { pathStyleOverride: true } : {}) });
  });
  document.getElementById('prop-shape-stroke').addEventListener('input', (e) => {
    const sel = engine.getSelected();
    if (sel && sel.type === 'shape') engine.updateElement(sel.id, { stroke: e.target.value, ...(sel.shapeType === 'path' ? { pathStyleOverride: true } : {}) });
  });
  document.getElementById('prop-shape-strokewidth').addEventListener('input', (e) => {
    const sel = engine.getSelected();
    if (sel && sel.type === 'shape') engine.updateElement(sel.id, { strokeWidth: parseInt(e.target.value) || 0, ...(sel.shapeType === 'path' ? { pathStyleOverride: true } : {}) });
  });
  const updateShapeRadius = (value) => {
    const sel = engine.getSelected();
    if (!sel || sel.type !== 'shape' || sel.shapeType === 'circle') return;
    const radius = normalizedShapeRadius(sel, value);
    engine.updateElement(sel.id, { borderRadius: radius });
    syncShapeRadiusControls({ ...sel, borderRadius: radius });
  };
  document.getElementById('prop-shape-radius').addEventListener('input', (e) => updateShapeRadius(e.target.value));
  document.getElementById('prop-shape-radius-range').addEventListener('input', (e) => updateShapeRadius(e.target.value));
  document.getElementById('prop-shape-strokestyle').addEventListener('change', (e) => {
    const sel = engine.getSelected();
    if (sel && sel.type === 'shape') engine.updateElement(sel.id, { strokeStyle: e.target.value, ...(sel.shapeType === 'path' ? { pathStyleOverride: true } : {}) });
  });

  // Layering & Action buttons
  document.getElementById('btn-bring-front').addEventListener('click', () => {
    const sel = engine.getSelected();
    if (sel) engine.bringToFront(sel.id);
  });
  document.getElementById('btn-send-back').addEventListener('click', () => {
    const sel = engine.getSelected();
    if (sel) engine.sendToBack(sel.id);
  });
  const moveButtons = {
    'btn-move-up': [0, -1], 'btn-move-left': [-1, 0],
    'btn-move-down': [0, 1], 'btn-move-right': [1, 0],
  };
  Object.entries(moveButtons).forEach(([id, [dx, dy]]) => {
    document.getElementById(id).addEventListener('click', () => {
      const sel = engine.getSelected();
      if (!sel) return;
      const step = 1;
      if (!engine.nudgeElement(sel.id, dx * step, dy * step) && sel.locked) {
        showToast('Déverrouillez l’élément pour le déplacer', 'info');
      }
    });
  });
  document.getElementById('btn-toggle-lock').addEventListener('click', () => {
    const sel = engine.getSelected();
    if (!sel) return;
    const locked = !sel.locked;
    engine.updateElement(sel.id, { locked });
    updateLockButton({ ...sel, locked });
    showToast(locked ? 'Position verrouillée' : 'Position déverrouillée');
  });
  document.getElementById('btn-duplicate').addEventListener('click', () => {
    const sel = engine.getSelected();
    if (sel) engine.duplicateElement(sel.id);
  });
  document.getElementById('btn-delete').addEventListener('click', () => {
    const sel = engine.getSelected();
    if (sel) engine.removeElement(sel.id);
  });
}

// ── Element Insertion Tools ────────────────────────────────────────
function setupAddTools() {
  const t = project.theme;

  // Text cards
  document.getElementById('add-text-heading').addEventListener('click', () => {
    engine.addElement({
      type: 'text',
      content: 'Titre principal de section',
      x: 200, y: 200,
      width: 1200, height: 110,
      fontFamily: t.fontHeading || "'Plus Jakarta Sans', sans-serif",
      fontSize: 72,
      fontWeight: 800,
      color: t.text || '#ffffff',
      textAlign: 'left',
    });
    showToast('Titre inséré');
  });

  document.getElementById('add-text-subheading').addEventListener('click', () => {
    engine.addElement({
      type: 'text',
      content: 'Sous-titre explicatif et percutant',
      x: 200, y: 240,
      width: 1000, height: 80,
      fontFamily: t.fontHeading || "'Plus Jakarta Sans', sans-serif",
      fontSize: 36,
      fontWeight: 600,
      color: t.primary || '#6366f1',
      textAlign: 'left',
    });
    showToast('Sous-titre inséré');
  });

  document.getElementById('add-text-body').addEventListener('click', () => {
    engine.addElement({
      type: 'text',
      content: 'Paragraphe d\'argumentation démontrant la conformité aux exigences du cahier des charges et la valeur ajoutée de l\'offre.',
      x: 200, y: 280,
      width: 900, height: 140,
      fontFamily: t.fontBody || "'Inter', sans-serif",
      fontSize: 24,
      fontWeight: 400,
      color: t.text || '#ffffff',
      textAlign: 'left',
    });
    showToast('Corps de texte inséré');
  });

  const addBulletsBtn = document.getElementById('add-element-bullets');
  if (addBulletsBtn) {
    addBulletsBtn.addEventListener('click', () => {
      engine.addElement({
        type: 'bullets',
        items: [
          'Engagement de niveau de service SLA 99.9%',
          'Équipe dédiée avec chef de projet sénior',
          'Méthodologie agile et jalons de recette stricts',
        ],
        bulletStyle: 'disc',
        fontFamily: t.fontBody || "'Inter', sans-serif",
        fontSize: 24,
        color: t.text || '#ffffff',
        lineHeight: 1.5,
        autoHeight: true,
        x: 200, y: 280,
        width: 900, height: 180,
      });
      showToast('Liste à puces insérée');
    });
  }

  const legacyBulletBtn = document.getElementById('add-text-bullet');
  if (legacyBulletBtn) {
    legacyBulletBtn.addEventListener('click', () => {
      engine.addElement({
        type: 'bullets',
        items: [
          'Engagement de niveau de service SLA 99.9%',
          'Équipe dédiée avec chef de projet sénior',
          'Méthodologie agile et jalons de recette stricts',
        ],
        bulletStyle: 'disc',
        fontFamily: t.fontBody || "'Inter', sans-serif",
        fontSize: 24,
        color: t.text || '#ffffff',
        lineHeight: 1.5,
        autoHeight: true,
        x: 200, y: 280,
        width: 900, height: 180,
      });
      showToast('Liste à puces insérée');
    });
  }

  // Table Tool
  const addTableBtn = document.getElementById('add-element-table');
  if (addTableBtn) {
    addTableBtn.addEventListener('click', () => {
      engine.addElement({
        type: 'table',
        columns: ['Critère d\'évaluation', 'Exigence du CCTP', 'Proposition & Engagement'],
        rows: [
          ['Architecture logicielle', 'Compatibilité cloud souverain et API REST', '100% Conforme — Architecture micro-services'],
          ['Niveaux de service (SLA)', 'Disponibilité garantie 99.9% 24/7', 'Engagement contractuel à 99.95%'],
          ['Sécurité & RGPD', 'Hébergement certifié ISO 27001 / HDS', 'Certifié HDS & SecNumCloud en France'],
        ],
        headerFill: t.primary || '#4338ca',
        headerColor: '#ffffff',
        rowFill: '#1e293b',
        altRowFill: '#0f172a',
        borderColor: '#334155',
        fontSize: 18,
        x: 160, y: 220,
        width: 1600, height: 260,
      });
      showToast('Tableau inséré');
    });
  }

  // Card Tool
  const addCardBtn = document.getElementById('add-element-card');
  if (addCardBtn) {
    addCardBtn.addEventListener('click', () => {
      engine.addElement({
        type: 'card',
        title: 'Directeur de Projet Dédié',
        text: '15 ans d\'expérience dans le déploiement de solutions critiques pour le secteur public. Garant du respect des engagements contractuels et des délais.',
        fill: '#1e293b',
        radius: 12,
        x: 200, y: 240,
        width: 440, height: 320,
      });
      showToast('Carte profil/référence insérée');
    });
  }

  // Shapes
  document.getElementById('add-shape-rect').addEventListener('click', () => {
    engine.addElement({
      type: 'shape',
      shapeType: 'rectangle',
      fill: 'rgba(99, 102, 241, 0.2)',
      stroke: t.primary || '#6366f1',
      strokeWidth: 2,
      strokeStyle: 'solid',
      borderRadius: 0,
      x: 300, y: 300,
      width: 400, height: 250,
    });
    showToast('Rectangle inséré');
  });

  document.getElementById('add-shape-rounded').addEventListener('click', () => {
    engine.addElement({
      type: 'shape',
      shapeType: 'rectangle',
      fill: 'rgba(99, 102, 241, 0.2)',
      stroke: t.primary || '#6366f1',
      strokeWidth: 2,
      strokeStyle: 'solid',
      borderRadius: 16,
      x: 300, y: 300,
      width: 400, height: 250,
    });
    showToast('Rectangle arrondi inséré');
  });

  document.getElementById('add-shape-circle').addEventListener('click', () => {
    engine.addElement({
      type: 'shape',
      shapeType: 'circle',
      fill: 'rgba(16, 185, 129, 0.2)',
      stroke: t.secondary || '#10b981',
      strokeWidth: 2,
      strokeStyle: 'solid',
      borderRadius: 200,
      x: 350, y: 300,
      width: 250, height: 250,
    });
    showToast('Cercle inséré');
  });

  document.getElementById('add-shape-card').addEventListener('click', () => {
    engine.addElement({
      type: 'shape',
      shapeType: 'rectangle',
      fill: 'rgba(255, 255, 255, 0.04)',
      stroke: 'rgba(255, 255, 255, 0.15)',
      strokeWidth: 1,
      strokeStyle: 'solid',
      borderRadius: 12,
      x: 250, y: 250,
      width: 500, height: 320,
    });
    showToast('Encadré RFP inséré');
  });

  // Slide Add buttons
  document.getElementById('add-slide-blank').addEventListener('click', () => addSlide('blank'));
  document.getElementById('add-slide-title').addEventListener('click', () => addSlide('title'));
  document.getElementById('add-slide-thanks').addEventListener('click', () => addSlide('thankyou'));

  // Media / Uploads
  const mediaInput = document.getElementById('media-file-input');
  const browseBtn = document.getElementById('btn-browse-media');
  const dropZone = document.getElementById('media-drop-zone');

  browseBtn.addEventListener('click', () => mediaInput.click());
  dropZone.addEventListener('click', (e) => {
    if (e.target !== browseBtn) mediaInput.click();
  });

  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    if (e.dataTransfer.files[0]) handleMediaUpload(e.dataTransfer.files[0]);
  });

  mediaInput.addEventListener('change', () => {
    if (mediaInput.files[0]) handleMediaUpload(mediaInput.files[0]);
  });
  document.getElementById('btn-refresh-media').addEventListener('click', () => renderMediaLibrary());
  renderMediaLibrary();

  document.getElementById('add-video-btn').addEventListener('click', () => {
    const url = prompt('URL de la vidéo (YouTube, Vimeo ou MP4) :');
    if (!url) return;
    const isEmbed = /youtube|youtu\.be|vimeo/.test(url);
    engine.addElement({
      type: 'video',
      src: url,
      videoType: isEmbed ? 'link' : 'file',
      x: 300, y: 250,
      width: 800, height: 450,
    });
    showToast('Lecteur vidéo inséré');
  });
}

function addLibraryMedia(media) {
  if (media.type === 'video') {
    engine.addElement({ type: 'video', src: media.url, videoType: 'file', x: 300, y: 250, width: 800, height: 450 });
  } else {
    engine.addElement({ type: 'image', src: media.url, alt: media.filename || 'Image', x: 300, y: 200, width: 600, height: 400 });
  }
  showToast(media.type === 'video' ? 'Vidéo ajoutée à la diapositive' : 'Image ajoutée à la diapositive', 'success');
}

async function renderMediaLibrary() {
  const library = document.getElementById('media-library');
  if (!library) return;
  library.innerHTML = '<div class="media-library-loading">Chargement des médias…</div>';
  try {
    const response = await fetch('/api/media');
    const data = await response.json();
    const items = Array.isArray(data.media) ? data.media : [];
    if (!items.length) {
      library.innerHTML = '<div class="media-library-loading">Aucun média partagé pour le moment.</div>';
      return;
    }
    library.innerHTML = '';
    items.forEach(media => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'media-library-item';
      card.title = `Ajouter ${media.filename}`;
      const safeName = escHtml(media.filename || 'Média');
      const preview = media.type === 'video'
        ? `<video src="${escHtml(media.url)}" muted preload="metadata"></video><span class="media-video-badge">▶ Vidéo</span>`
        : `<img src="${escHtml(media.url)}" alt="${safeName}" loading="lazy">`;
      card.innerHTML = `<span class="media-preview">${preview}</span><span class="media-name">${safeName}</span><span class="media-add">+ Ajouter</span>`;
      card.addEventListener('click', () => addLibraryMedia(media));
      library.appendChild(card);
    });
  } catch (err) {
    library.innerHTML = '<div class="media-library-loading">Impossible de charger la bibliothèque.</div>';
  }
}

async function handleMediaUpload(file) {
  if (!file.type.startsWith('image/') && !file.type.startsWith('video/')) {
    showToast('Veuillez sélectionner une image ou une vidéo valide', 'error');
    return;
  }
  showToast('Téléversement du média...', 'info');
  const fd = new FormData();
  fd.append('file', file);
  try {
    const res = await fetch('/api/upload', { method: 'POST', body: fd });
    const data = await res.json();
    if (data.status === 'ok') {
      addLibraryMedia({ url: data.url, filename: file.name, type: file.type.startsWith('video/') ? 'video' : 'image' });
      renderMediaLibrary();
    } else {
      showToast(`Erreur d'upload : ${data.message || 'Échec'}`, 'error');
    }
  } catch (err) {
    showToast('Erreur de connexion lors de l\'upload', 'error');
  }
}

// ── Theme Customizer Panel ─────────────────────────────────────────
function setupThemePanel() {
  const t = project.theme;
  const bgColor = document.getElementById('theme-bg-color');
  const bgHex = document.getElementById('theme-bg-hex');
  const primaryColor = document.getElementById('theme-primary-color');
  const primaryHex = document.getElementById('theme-primary-hex');
  const secColor = document.getElementById('theme-secondary-color');
  const secHex = document.getElementById('theme-secondary-hex');
  const headingSelect = document.getElementById('theme-font-heading');
  const bodySelect = document.getElementById('theme-font-body');

  bgColor.value = t.bg || '#0f172a';
  bgHex.value = t.bg || '#0f172a';
  primaryColor.value = t.primary || '#6366f1';
  primaryHex.value = t.primary || '#6366f1';
  secColor.value = t.secondary || '#10b981';
  secHex.value = t.secondary || '#10b981';

  bgColor.addEventListener('input', () => { bgHex.value = bgColor.value; });
  bgHex.addEventListener('change', () => { bgColor.value = bgHex.value; });

  primaryColor.addEventListener('input', () => { primaryHex.value = primaryColor.value; });
  primaryHex.addEventListener('change', () => { primaryColor.value = primaryHex.value; });

  secColor.addEventListener('input', () => { secHex.value = secColor.value; });
  secHex.addEventListener('change', () => { secColor.value = secHex.value; });

  document.getElementById('btn-apply-theme').addEventListener('click', () => {
    project.theme.bg = bgColor.value;
    project.theme.background = { type: 'solid', color: bgColor.value };
    project.theme.primary = primaryColor.value;
    project.theme.secondary = secColor.value;
    project.theme.fontHeading = headingSelect.value;
    project.theme.fontBody = bodySelect.value;

    loadSlideToCanvas(project.activeSlideIndex);
    renderSlideList();
    recordChange();
    showToast('Charte graphique appliquée au deck', 'success');
  });
}

// ── Zoom Controls ──────────────────────────────────────────────────
function setupZoom() {
  const display = document.getElementById('zoom-display');
  const viewport = document.getElementById('canvas-viewport');

  function updateDisplay() {
    if (display) display.textContent = Math.round(engine.zoom * 100) + '%';
  }

  document.getElementById('btn-zoom-in').addEventListener('click', () => {
    engine.setZoom(engine.zoom + 0.1);
    updateDisplay();
  });
  document.getElementById('btn-zoom-out').addEventListener('click', () => {
    engine.setZoom(engine.zoom - 0.1);
    updateDisplay();
  });

  function fitToScreen() {
    const vw = Math.max(100, viewport.clientWidth - 80);
    const vh = Math.max(100, viewport.clientHeight - 80);
    const fitZoom = Math.min(vw / 1920, vh / 1080);
    engine.setZoom(fitZoom);
    updateDisplay();
  }

  document.getElementById('btn-zoom-fit').addEventListener('click', fitToScreen);
  setTimeout(fitToScreen, 100);
  window.addEventListener('resize', fitToScreen);

  // Ctrl + Wheel Zoom
  viewport.addEventListener('wheel', (e) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.05 : 0.05;
      engine.setZoom(engine.zoom + delta);
      updateDisplay();
    }
  }, { passive: false });
}

// ── Keyboard Shortcuts & Modals ────────────────────────────────────
function setupKeyboardShortcuts() {
  document.getElementById('btn-undo').addEventListener('click', doUndo);
  document.getElementById('btn-redo').addEventListener('click', doRedo);
  document.getElementById('btn-manual-save').addEventListener('click', doSave);

  document.addEventListener('keydown', (e) => {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
    if (document.activeElement?.contentEditable === 'true') return;

    // Undo / Redo
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 'z') {
      e.preventDefault(); doUndo();
    }
    if (((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'z') || ((e.ctrlKey || e.metaKey) && e.key === 'y')) {
      e.preventDefault(); doRedo();
    }
    // Save
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault(); doSave();
    }
    // Shortcuts helper modal
    if ((e.ctrlKey || e.metaKey) && e.key === '/') {
      e.preventDefault(); toggleShortcutsModal();
    }
  });
}

function setupShortcutsModal() {
  const modal = document.getElementById('shortcuts-modal');
  const btn = document.getElementById('btn-shortcuts');
  const closeBtn = document.getElementById('shortcuts-close-btn');

  btn.addEventListener('click', () => modal.classList.add('active'));
  closeBtn.addEventListener('click', () => modal.classList.remove('active'));
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.classList.remove('active');
  });
}

function toggleShortcutsModal() {
  const modal = document.getElementById('shortcuts-modal');
  modal.classList.toggle('active');
}

// ── History (Undo / Redo) ──────────────────────────────────────────
function doUndo() {
  const snapshot = history.undo();
  if (snapshot) {
    history.pause();
    restoreSnapshot(snapshot);
    history.resume();
    showToast('Action annulée');
  }
}

function doRedo() {
  const snapshot = history.redo();
  if (snapshot) {
    history.pause();
    restoreSnapshot(snapshot);
    history.resume();
    showToast('Action rétablie');
  }
}

function getSnapshot() {
  saveCurrentSlideElements();
  return {
    slides: JSON.parse(JSON.stringify(project.slides)),
    activeSlideIndex: project.activeSlideIndex,
  };
}

function restoreSnapshot(snapshot) {
  project.slides = snapshot.slides;
  project.activeSlideIndex = snapshot.activeSlideIndex;
  renderSlideList();
  loadSlideToCanvas(project.activeSlideIndex);
}

// ── Persistence & Auto-Save ────────────────────────────────────────
function startAutoSave() {
  setInterval(() => {
    if (!isSaving) doAutoSave();
  }, 10000);
}

function scheduleAutoSave() {
  clearTimeout(saveDebounceTimer);
  saveDebounceTimer = setTimeout(doAutoSave, 1800);
}

async function doAutoSave() {
  await executeSave(false);
}

async function doSave() {
  await executeSave(true);
}

async function executeSave(manual = false) {
  if (isSaving) {
    pendingSave = true;
    return;
  }
  isSaving = true;
  saveCurrentSlideElements();
  updateSaveStatus('saving');

  // Save to localStorage immediately as backup
  try {
    localStorage.setItem('rfp_autosave', JSON.stringify(project));
  } catch (e) {}

  try {
    const res = await fetch('/api/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(project),
    });
    const data = await res.json();
    if (data.status === 'ok') {
      if (typeof data.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(data.id) && data.id !== 'None') {
        project.id = data.id;
      }
      updateSaveStatus('saved');
      if (manual) showToast('Projet sauvegardé sur le serveur', 'success');
    } else {
      updateSaveStatus('error');
      if (manual) showToast('Échec de la sauvegarde sur le serveur', 'error');
    }
  } catch (e) {
    updateSaveStatus('error');
    if (manual) showToast('Erreur réseau lors de la sauvegarde', 'error');
  } finally {
    isSaving = false;
    if (pendingSave) {
      pendingSave = false;
      executeSave(false);
    }
  }
}

function updateSaveStatus(status) {
  const dot = document.getElementById('save-dot');
  const text = document.getElementById('save-text');
  if (!dot || !text) return;

  dot.className = 'status-indicator-dot ' + status;
  if (status === 'saving') {
    text.textContent = 'Sauvegarde...';
  } else if (status === 'saved') {
    text.textContent = 'Enregistré';
  } else if (status === 'unsaved') {
    text.textContent = 'Non enregistré';
  } else if (status === 'error') {
    text.textContent = 'Erreur serveur';
  }
}

// ── Export Workflow & Gating ───────────────────────────────────────
let pendingExportFormat = null;

function setupExportDropdown() {
  const btn = document.getElementById('btn-export-dropdown');
  const menu = document.getElementById('export-menu');
  const pdfBtn = document.getElementById('btn-export-pdf');
  const pptxBtn = document.getElementById('btn-export-pptx');
  const modalClose = document.getElementById('modal-close-btn');
  const exportAnywayBtn = document.getElementById('modal-export-anyway-btn');
  const chkApproval = document.getElementById('chk-pricing-approval');

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.classList.toggle('active');
  });

  document.addEventListener('click', () => menu.classList.remove('active'));

  pdfBtn.addEventListener('click', () => {
    menu.classList.remove('active');
    handleExportRequested('pdf');
  });

  pptxBtn.addEventListener('click', () => {
    menu.classList.remove('active');
    handleExportRequested('pptx');
  });

  modalClose.addEventListener('click', () => {
    document.getElementById('export-modal').classList.remove('active');
  });

  if (chkApproval) {
    chkApproval.addEventListener('change', () => {
      if (chkApproval.checked) {
        project.approvals = { pricing: true, at: Date.now() };
        renderSlideList();
        updateReviewPanel();
      } else {
        if (project.approvals) {
          delete project.approvals.pricing;
          delete project.approvals.at;
        }
        renderSlideList();
        updateReviewPanel();
      }
      updateGateModalState();
    });
  }

  if (exportAnywayBtn) {
    exportAnywayBtn.addEventListener('click', () => {
      if (pendingExportFormat) {
        const fmt = pendingExportFormat;
        pendingExportFormat = null;
        triggerExport(fmt);
      }
    });
  }
}

function handleExportRequested(format) {
  saveCurrentSlideElements();
  pendingExportFormat = format;

  const totalPlaceholders = countAllPlaceholders();
  const needsApproval = project.slides.some(s => s.requiresApproval === true);
  const isApproved = !!(project.approvals && project.approvals.pricing);

  // If no gating needed, export immediately
  if (totalPlaceholders === 0 && (!needsApproval || isApproved)) {
    triggerExport(format);
    return;
  }

  // Show gating in export modal
  const modal = document.getElementById('export-modal');
  const title = document.getElementById('modal-title');
  const desc = document.getElementById('modal-desc');
  const spinner = document.getElementById('modal-spinner');
  const successIcon = document.getElementById('modal-success-icon');
  const actions = document.getElementById('modal-actions');
  const downloadLink = document.getElementById('modal-download');
  const gateBox = document.getElementById('export-gate-box');
  const placeholdersMsg = document.getElementById('export-gate-placeholders-msg');
  const approvalRow = document.getElementById('export-gate-approval-row');
  const chkApproval = document.getElementById('chk-pricing-approval');

  modal.classList.add('active');
  spinner.style.display = 'none';
  successIcon.style.display = 'none';
  downloadLink.style.display = 'none';
  actions.style.display = 'flex';

  title.textContent = 'Vérification avant export';
  desc.textContent = 'Certains points requièrent votre attention avant de finaliser la présentation :';

  if (gateBox) gateBox.style.display = 'block';

  if (placeholdersMsg) {
    if (totalPlaceholders > 0) {
      placeholdersMsg.style.display = 'block';
      placeholdersMsg.textContent = `⚠️ Il reste ${totalPlaceholders} placeholder(s) [TO FILL: ...] non renseigné(s).`;
    } else {
      placeholdersMsg.style.display = 'none';
    }
  }

  if (approvalRow && chkApproval) {
    if (needsApproval && !isApproved) {
      approvalRow.style.display = 'flex';
      chkApproval.checked = false;
    } else {
      approvalRow.style.display = 'none';
    }
  }

  updateGateModalState();
}

function updateGateModalState() {
  const needsApproval = project.slides.some(s => s.requiresApproval === true);
  const isApproved = !!(project.approvals && project.approvals.pricing);
  const exportAnywayBtn = document.getElementById('modal-export-anyway-btn');

  if (!exportAnywayBtn) return;
  exportAnywayBtn.style.display = 'inline-flex';

  if (needsApproval && !isApproved) {
    exportAnywayBtn.disabled = true;
    exportAnywayBtn.title = 'Veuillez approuver les tarifs avant d\'exporter';
  } else {
    exportAnywayBtn.disabled = false;
    exportAnywayBtn.title = '';
  }
}

async function triggerExport(format) {
  saveCurrentSlideElements();
  const modal = document.getElementById('export-modal');
  const title = document.getElementById('modal-title');
  const desc = document.getElementById('modal-desc');
  const spinner = document.getElementById('modal-spinner');
  const successIcon = document.getElementById('modal-success-icon');
  const actions = document.getElementById('modal-actions');
  const downloadLink = document.getElementById('modal-download');
  const gateBox = document.getElementById('export-gate-box');
  const exportAnywayBtn = document.getElementById('modal-export-anyway-btn');

  modal.classList.add('active');
  if (gateBox) gateBox.style.display = 'none';
  if (exportAnywayBtn) exportAnywayBtn.style.display = 'none';
  spinner.style.display = 'block';
  successIcon.style.display = 'none';
  actions.style.display = 'none';

  title.textContent = `Exportation ${format.toUpperCase()} en cours...`;
  desc.textContent = format === 'pdf'
    ? 'Playwright effectue le rendu haute fidélité des diapositives 1920×1080...'
    : 'Génération des objets natifs éditables PowerPoint (.pptx) : textes, listes, tableaux et formes vectorielles...';

  try {
    const html = buildExportHTML();
    const res = await fetch('/api/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        format,
        html,
        slideCount: project.slides.length,
        project: project
      }),
    });
    const data = await res.json();
    if (data.status === 'ok') {
      spinner.style.display = 'none';
      successIcon.style.display = 'flex';
      title.textContent = 'Présentation prête !';
      desc.textContent = format === 'pptx'
        ? 'Le fichier PPTX a été généré avec des objets natifs éditables (textes, tableaux, listes à puces).'
        : `Le fichier ${format.toUpperCase()} a été généré avec succès sans overlays d'édition.`;
      actions.style.display = 'flex';
      downloadLink.style.display = 'inline-flex';
      downloadLink.href = data.url;
      downloadLink.download = `${project.name || 'presentation'}.${format}`;
      showToast(`Export ${format.toUpperCase()} réussi`, 'success');
    } else {
      spinner.style.display = 'none';
      title.textContent = 'Erreur lors de l\'exportation';
      desc.textContent = data.message || 'Le serveur n\'a pas pu générer le document.';
      actions.style.display = 'flex';
      downloadLink.style.display = 'none';
      showToast('Erreur lors de l\'exportation', 'error');
    }
  } catch (err) {
    spinner.style.display = 'none';
    title.textContent = 'Erreur réseau';
    desc.textContent = err.message;
    actions.style.display = 'flex';
    downloadLink.style.display = 'none';
  }
}

// ── Placeholders & Review Panel ────────────────────────────────────
function countAllPlaceholders() {
  let count = 0;
  (project.slides || []).forEach(slide => {
    count += countPlaceholdersInSlide(slide);
  });
  return count;
}

function countPlaceholdersInSlide(slide) {
  return findPlaceholdersInSlide(slide).length;
}

function findPlaceholdersInSlide(slide) {
  const results = [];
  const regex = /\[TO FILL:[^\]]*\]/gi;

  function scanString(str, elId, contextName) {
    if (!str || typeof str !== 'string') return;
    let match;
    while ((match = regex.exec(str)) !== null) {
      results.push({
        placeholder: match[0],
        elementId: elId,
        context: contextName,
      });
    }
  }

  (slide.elements || []).forEach(el => {
    if (el.type === 'text') {
      scanString(el.content, el.id, 'Texte');
    } else if (el.type === 'bullets') {
      (el.items || []).forEach((item, idx) => {
        scanString(item, el.id, `Puce #${idx + 1}`);
      });
    } else if (el.type === 'table') {
      (el.columns || []).forEach((col, idx) => {
        scanString(col, el.id, `Colonne #${idx + 1}`);
      });
      (el.rows || []).forEach((row, rIdx) => {
        (row || []).forEach((cell, cIdx) => {
          scanString(cell, el.id, `Cellule [${rIdx + 1},${cIdx + 1}]`);
        });
      });
    } else if (el.type === 'card') {
      scanString(el.title, el.id, 'Titre encadré');
      scanString(el.text, el.id, 'Texte encadré');
    }
  });

  return results;
}

function updateReviewPanel() {
  const reviewList = document.getElementById('review-list');
  const reviewBadge = document.getElementById('review-pending-badge');
  if (!reviewList) return;

  reviewList.innerHTML = '';
  let pendingIssuesCount = 0;

  project.slides.forEach((slide, sIdx) => {
    const placeholders = findPlaceholdersInSlide(slide);
    const warnings = Array.isArray(slide.warnings) ? slide.warnings : [];
    const assumptions = Array.isArray(slide.assumptions) ? slide.assumptions : [];
    const catalogDate = slide.catalogDate || null;
    const sources = slide.sources || null;
    const hasSources = sources && (sources.mermaid || sources.drawio);

    const slideHasIssues = placeholders.length > 0 || warnings.length > 0 || assumptions.length > 0 || catalogDate || hasSources || slide.requiresApproval;
    if (placeholders.length > 0 || warnings.length > 0 || (slide.requiresApproval && (!project.approvals || !project.approvals.pricing))) {
      pendingIssuesCount += (placeholders.length + warnings.length + (slide.requiresApproval && (!project.approvals || !project.approvals.pricing) ? 1 : 0));
    }

    if (!slideHasIssues) return;

    const group = document.createElement('div');
    group.className = 'review-slide-group';

    const header = document.createElement('div');
    header.className = 'review-slide-header';
    header.innerHTML = `<span>Diapositive #${sIdx + 1} — ${escHtml(slide.label || 'Slide')}</span><span style="font-size:11px;color:var(--text-muted);">Voir</span>`;
    header.addEventListener('click', () => {
      switchToSlide(sIdx);
    });
    group.appendChild(header);

    // Placeholders
    placeholders.forEach(ph => {
      const item = document.createElement('div');
      item.className = 'review-item';
      item.innerHTML = `
        <span class="review-item-icon" style="color:#ef4444;">🔴</span>
        <div class="review-item-text">
          <strong>${escHtml(ph.placeholder)}</strong>
          <div style="font-size:11px;color:var(--text-muted);">${escHtml(ph.context)}</div>
        </div>
      `;
      item.addEventListener('click', () => {
        switchToSlide(sIdx);
        if (ph.elementId && engine) {
          engine.selectElement(ph.elementId);
        }
      });
      group.appendChild(item);
    });

    // Warnings
    warnings.forEach(warn => {
      const item = document.createElement('div');
      item.className = 'review-item';
      item.innerHTML = `
        <span class="review-item-icon" style="color:#f59e0b;">⚠️</span>
        <div class="review-item-text">${escHtml(warn)}</div>
      `;
      item.addEventListener('click', () => switchToSlide(sIdx));
      group.appendChild(item);
    });

    // Budget Assumptions & Catalog Date
    if (assumptions.length > 0 || catalogDate) {
      const item = document.createElement('div');
      item.className = 'review-item';
      let assumptionsHtml = '';
      if (catalogDate) {
        assumptionsHtml += `<div style="font-size:11px;color:var(--accent-indigo);margin-bottom:4px;">Catalogue de prix au : <strong>${escHtml(catalogDate)}</strong></div>`;
      }
      if (assumptions.length > 0) {
        assumptionsHtml += `<div style="font-size:11px;color:var(--text-muted);margin-bottom:2px;">Hypothèses budgétaires :</div><ul style="padding-left:14px;margin:0;">`;
        assumptions.forEach(a => {
          assumptionsHtml += `<li>${escHtml(a)}</li>`;
        });
        assumptionsHtml += `</ul>`;
      }
      item.innerHTML = `
        <span class="review-item-icon" style="color:#6366f1;">ℹ️</span>
        <div class="review-item-text">${assumptionsHtml}</div>
      `;
      item.addEventListener('click', () => switchToSlide(sIdx));
      group.appendChild(item);
    }

    // Requires approval status
    if (slide.requiresApproval) {
      const isApproved = project.approvals && project.approvals.pricing;
      const item = document.createElement('div');
      item.className = 'review-item';
      item.innerHTML = isApproved
        ? `<span class="review-item-icon" style="color:#10b981;">✓</span><div class="review-item-text" style="color:#10b981;">Tarifs et budget approuvés</div>`
        : `<span class="review-item-icon" style="color:#f59e0b;">🔒</span><div class="review-item-text" style="color:#f59e0b;">Approbation tarifaire requise avant export</div>`;
      item.addEventListener('click', () => switchToSlide(sIdx));
      group.appendChild(item);
    }

    // Sources button
    if (hasSources) {
      const btnSources = document.createElement('button');
      btnSources.className = 'btn btn-outline btn-sm review-source-btn full-width';
      btnSources.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline></svg> <span>Voir le code source (${[sources.mermaid ? 'Mermaid' : '', sources.drawio ? 'Draw.io' : ''].filter(Boolean).join(', ')})</span>`;
      btnSources.addEventListener('click', (e) => {
        e.stopPropagation();
        openSourcesModal(sIdx, sources);
      });
      group.appendChild(btnSources);
    }

    reviewList.appendChild(group);
  });

  if (reviewBadge) {
    reviewBadge.textContent = pendingIssuesCount;
    reviewBadge.style.display = pendingIssuesCount > 0 ? 'inline-block' : 'none';
  }

  if (reviewList.children.length === 0) {
    reviewList.innerHTML = `<div style="text-align:center;padding:32px 16px;color:var(--text-muted);font-size:13px;">✅ Aucun placeholder ou avertissement détecté sur vos diapositives.</div>`;
  }
}

// ── Sources Modal ──────────────────────────────────────────────────
function setupSourcesModal() {
  const modal = document.getElementById('sources-modal');
  const closeBtn = document.getElementById('sources-close-btn');
  if (closeBtn && modal) {
    closeBtn.addEventListener('click', () => {
      modal.classList.remove('active');
    });
  }
}

function openSourcesModal(slideIdx, sources) {
  const modal = document.getElementById('sources-modal');
  const body = document.getElementById('sources-modal-body');
  const title = document.getElementById('sources-modal-title');
  if (!modal || !body) return;

  if (title) title.textContent = `Sources de la diapositive #${slideIdx + 1}`;
  body.innerHTML = '';

  if (sources.mermaid) {
    const card = document.createElement('div');
    card.style.cssText = 'background:var(--bg-canvas);border:1px solid var(--border);border-radius:8px;padding:12px;';
    card.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <strong style="color:var(--text-primary);font-size:13px;">Diagramme Mermaid</strong>
        <button class="btn btn-ghost btn-sm" data-copy="mermaid">Copier le code</button>
      </div>
      <pre style="margin:0;padding:8px;background:rgba(0,0,0,0.3);border-radius:4px;color:#a5f3fc;font-family:monospace;font-size:12px;max-height:180px;overflow:auto;white-space:pre-wrap;">${escHtml(sources.mermaid)}</pre>
    `;
    card.querySelector('[data-copy="mermaid"]').addEventListener('click', () => {
      navigator.clipboard.writeText(sources.mermaid);
      showToast('Code Mermaid copié dans le presse-papier !', 'success');
    });
    body.appendChild(card);
  }

  if (sources.drawio) {
    const card = document.createElement('div');
    card.style.cssText = 'background:var(--bg-canvas);border:1px solid var(--border);border-radius:8px;padding:12px;';
    card.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <strong style="color:var(--text-primary);font-size:13px;">Diagramme Draw.io (XML)</strong>
        <button class="btn btn-ghost btn-sm" data-copy="drawio">Copier le code</button>
      </div>
      <pre style="margin:0;padding:8px;background:rgba(0,0,0,0.3);border-radius:4px;color:#cbd5e1;font-family:monospace;font-size:12px;max-height:180px;overflow:auto;white-space:pre-wrap;">${escHtml(sources.drawio)}</pre>
    `;
    card.querySelector('[data-copy="drawio"]').addEventListener('click', () => {
      navigator.clipboard.writeText(sources.drawio);
      showToast('Code Draw.io copié dans le presse-papier !', 'success');
    });
    body.appendChild(card);
  }

  modal.classList.add('active');
}

// ── Slide Regeneration ─────────────────────────────────────────────
async function regenerateSlide(slideIdx) {
  if (slideIdx === 0 || slideIdx === project.slides.length - 1) {
    showToast('Les diapositives fixes ne peuvent pas être régénérées', 'warning');
    return;
  }
  if (!confirm(`Voulez-vous régénérer le contenu de la diapositive #${slideIdx + 1} via l'agent n8n ?`)) {
    return;
  }

  // Save the project (await the save) before calling the regenerate endpoint
  showToast(`Sauvegarde et régénération de la diapositive #${slideIdx + 1}...`, 'info');
  try {
    await executeSave(false);
  } catch (saveErr) {
    showToast(`Erreur lors de la sauvegarde préalable: ${saveErr.message}`, 'error');
    return;
  }

  if (!project.id) {
    showToast('Impossible de régénérer : identifiant de projet manquant', 'error');
    return;
  }

  try {
    const res = await fetch(`/api/decks/${encodeURIComponent(project.id)}/slides/${slideIdx}/regenerate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const data = await res.json();
    if (res.ok && data.status === 'ok') {
      // Replace only targeted slide in memory
      project.slides[slideIdx] = data.slide;
      // Invalidate pricing approval only if this slide requires approval
      if (data.slide && data.slide.requiresApproval) {
        resetPricingApproval();
      }
      if (project.activeSlideIndex === slideIdx) {
        loadSlideToCanvas(slideIdx);
      }
      renderSlideList();
      updateReviewPanel();
      recordChange();
      showToast(`Diapositive #${slideIdx + 1} régénérée avec succès`, 'success');
    } else {
      showToast(data.message || data.error || 'Erreur lors de la régénération', 'error');
    }
  } catch (err) {
    showToast(`Erreur réseau: ${err.message}`, 'error');
  }
}

function buildExportHTML() {
  const t = project.theme;
  let slidesHTML = '';

  project.slides.forEach((slide) => {
    let bgStyle = '';
    const bg = t.background || { type: 'solid', color: t.bg };
    if (bg.type === 'image' && bg.dataurl) {
      bgStyle = `background:url(${bg.dataurl}) center/cover no-repeat;`;
    } else if (bg.type === 'gradient' && bg.stops) {
      const stops = bg.stops.map(s => `${s.color} ${s.position}%`).join(', ');
      bgStyle = `background:linear-gradient(135deg, ${stops});`;
    } else {
      bgStyle = `background:${bg.color || t.bg};`;
    }

    let innerHTML = '';
    (slide.elements || []).forEach(el => {
      const opacity = el.opacity ?? 1;
      const baseStyle = `position:absolute;left:${el.x}px;top:${el.y}px;width:${el.width}px;height:${el.height}px;transform:rotate(${el.rotation || 0}deg);opacity:${opacity};z-index:${el.zIndex || 1};`;
      const elementVisual = renderElementHTML(el, t, 'export');
      innerHTML += `<div style="${baseStyle}">${elementVisual}</div>`;
    });

    slidesHTML += `<div class="slide-page" style="${bgStyle}">${innerHTML}</div>`;
  });

  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Montserrat:wght@400;500;600;700;800;900&family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<style>*{box-sizing:border-box;margin:0;padding:0;}body{margin:0;}.slide-page{width:1920px;height:1080px;position:relative;overflow:hidden;page-break-after:always;}</style>
</head><body>${slidesHTML}</body></html>`;
}

// ── Legacy Dimensions Migration ────────────────────────────────────
function migrateProjectDimensions() {
  if (project._canvasSize === 1920) return;
  const SX = 1920 / 1440;
  const SY = 1080 / 810;
  let needsMigration = false;

  for (const slide of project.slides) {
    if (!slide.elements) continue;
    for (const el of slide.elements) {
      if ((el.x + el.width) <= 1450 && (el.y + el.height) <= 820 && (el.x + el.width) > 100) {
        needsMigration = true;
        break;
      }
    }
    if (needsMigration) break;
  }

  if (needsMigration) {
    for (const slide of project.slides) {
      if (!slide.elements) continue;
      for (const el of slide.elements) {
        el.x = Math.round(el.x * SX);
        el.y = Math.round(el.y * SY);
        el.width = Math.round(el.width * SX);
        el.height = Math.round(el.height * SY);
        if (el.fontSize) el.fontSize = Math.round(el.fontSize * SX);
      }
    }
  }
  project._canvasSize = 1920;
}

// ── Opacity Migration ───────────────────────────────────────────────
function migrateElementOpacity() {
  // Initialize opacity for all existing elements that don't have it
  for (const slide of project.slides) {
    if (!slide.elements) continue;
    for (const el of slide.elements) {
      if (el.opacity === undefined) {
        el.opacity = 1;
      }
    }
  }
}

function escHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
