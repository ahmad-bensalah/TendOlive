/**
 * ═══════════════════════════════════════════════════════════════════
 * RFP Studio - Professional UI Interactions (Phase 1)
 * Canva-level interactions with NO "vibe-coded" effects
 * ═══════════════════════════════════════════════════════════════════
 */

// ─── Zoom Indicator ─────────────────────────────────────────────────
function showZoomIndicator(zoomLevel) {
  let indicator = document.getElementById('zoom-indicator');
  if (!indicator) {
    indicator = document.createElement('div');
    indicator.id = 'zoom-indicator';
    indicator.className = 'zoom-indicator';
    document.body.appendChild(indicator);
  }
  
  indicator.textContent = Math.round(zoomLevel * 100) + '%';
  indicator.classList.add('visible');
  
  clearTimeout(window.zoomIndicatorTimeout);
  window.zoomIndicatorTimeout = setTimeout(() => {
    indicator.classList.remove('visible');
  }, 800);
}

// ─── Keyboard Nudge Indicator ───────────────────────────────────────
function showNudgeIndicator(element, distance) {
  if (!element) return;
  
  const indicator = document.createElement('div');
  indicator.style.cssText = `
    position: absolute;
    top: -30px;
    left: 50%;
    transform: translateX(-50%);
    background: rgba(99, 102, 241, 0.95);
    color: white;
    padding: 4px 10px;
    border-radius: 6px;
    font-size: 11px;
    font-weight: 700;
    pointer-events: none;
    z-index: 10000;
    animation: nudge-indicator 0.6s ease-out;
  `;
  indicator.textContent = distance === 1 ? '1px' : '10px';
  
  element.appendChild(indicator);
  setTimeout(() => indicator.remove(), 600);
}

// ─── Opacity Control Setup ──────────────────────────────────────────
function setupOpacityControl() {
  const opacityControl = document.getElementById('bar-opacity-control');
  const slider = document.getElementById('prop-opacity-slider');
  const valueInput = document.getElementById('prop-opacity-value');
  
  console.log('🔧 Setting up opacity control:', { opacityControl, slider, valueInput });
  
  if (!slider || !valueInput) {
    console.error('❌ Opacity controls not found!');
    return;
  }
  
  // Prevent mousedown on opacity controls from deselecting elements
  opacityControl.addEventListener('mousedown', (e) => {
    e.stopPropagation();
  });
  
  // Sync slider and input
  slider.addEventListener('input', (e) => {
    e.stopPropagation(); // Prevent deselection
    console.log('🎛️ Slider input event:', e.target.value);
    
    // Only update if there's actually a selected element
    if (!window.engine || !window.engine.getSelected()) {
      console.log('⚠️ No element selected, skipping update');
      return;
    }
    
    const value = e.target.value;
    valueInput.value = value;
    updateElementOpacity(value);
    showOpacityFeedback(value);
  });
  
  valueInput.addEventListener('input', (e) => {
    e.stopPropagation(); // Prevent deselection
    console.log('🔢 Value input event:', e.target.value);
    
    // Only update if there's actually a selected element
    if (!window.engine || !window.engine.getSelected()) {
      console.log('⚠️ No element selected, skipping update');
      return;
    }
    
    let value = parseInt(e.target.value) || 0;
    value = Math.max(0, Math.min(100, value));
    slider.value = value;
    valueInput.value = value;
    updateElementOpacity(value);
  });
  
  valueInput.addEventListener('change', (e) => {
    e.stopPropagation(); // Prevent deselection
    if (window.engine && window.engine.getSelected() && window.recordChange) {
      window.recordChange();
    }
  });
  
  slider.addEventListener('change', (e) => {
    e.stopPropagation(); // Prevent deselection
    if (window.engine && window.engine.getSelected() && window.recordChange) {
      window.recordChange();
    }
  });
  
  console.log('✅ Opacity control setup complete');
}

function updateElementOpacity(opacityPercent) {
  // Try to get selected element from canvas engine
  const selectedEl = (window.engine && window.engine.getSelected) ? window.engine.getSelected() : null;
  if (!selectedEl) {
    console.log('❌ No selected element');
    return;
  }
  
  const opacity = opacityPercent / 100;
  console.log('🎨 Updating opacity:', {
    elementId: selectedEl.id,
    opacityPercent,
    opacity,
    currentOpacity: selectedEl.opacity
  });
  
  // Update element data through engine - it will handle DOM sync
  if (window.engine && window.engine.updateElement) {
    window.engine.updateElement(selectedEl.id, { opacity: opacity });
    
    // Verify it was updated
    const updated = window.engine.getSelected();
    console.log('✅ After update:', {
      newOpacity: updated?.opacity,
      success: updated?.opacity === opacity
    });
  }
  
  // Add visual feedback class (not opacity - that's handled by engine)
  const domEl = document.querySelector('.canvas-element.selected');
  if (domEl) {
    domEl.classList.add('opacity-adjusting');
  }
}

function showOpacityFeedback(opacityPercent) {
  const domEl = document.querySelector('.canvas-element.selected');
  if (!domEl) return;
  
  domEl.dataset.opacityLabel = `${opacityPercent}% Opacité`;
  
  clearTimeout(window.opacityFeedbackTimeout);
  window.opacityFeedbackTimeout = setTimeout(() => {
    domEl.classList.remove('opacity-adjusting');
  }, 1000);
}

// ─── Update Context Bar for Selection ───────────────────────────────
function updateContextBarForSelection(element) {
  console.log('📍 updateContextBarForSelection called:', element);
  
  const opacityControl = document.getElementById('bar-opacity-control');
  
  if (!element) {
    console.log('🚫 No element - hiding opacity control');
    opacityControl.style.display = 'none';
    return;
  }
  
  // Show opacity for all elements EXCEPT text
  const showOpacity = element.type !== 'text';
  console.log('🎨 Element type:', element.type, 'showOpacity:', showOpacity);
  opacityControl.style.display = showOpacity ? 'flex' : 'none';
  
  if (showOpacity) {
    const opacity = element.opacity !== undefined ? element.opacity : 1;
    const opacityPercent = Math.round(opacity * 100);
    
    console.log('✏️ Setting slider to:', opacityPercent, '% (from element.opacity:', element.opacity, ')');
    
    document.getElementById('prop-opacity-slider').value = opacityPercent;
    document.getElementById('prop-opacity-value').value = opacityPercent;
  }
}

// ─── Mousewheel Zoom Setup ──────────────────────────────────────────
function setupMousewheelZoom() {
  const viewport = document.getElementById('canvas-viewport');
  if (!viewport) return;
  
  viewport.addEventListener('wheel', (e) => {
    // Ctrl/Cmd + wheel = zoom
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      
      const delta = e.deltaY > 0 ? -0.1 : 0.1;
      const currentZoom = window.currentZoom || 1;
      let newZoom = currentZoom + delta;
      
      // Clamp between 10% and 400%
      newZoom = Math.max(0.1, Math.min(4, newZoom));
      
      if (window.setZoom) {
        window.setZoom(newZoom);
      }
      showZoomIndicator(newZoom);
      
      // Update zoom display
      const display = document.getElementById('zoom-display');
      if (display) {
        display.textContent = Math.round(newZoom * 100) + '%';
        display.classList.add('zooming');
        setTimeout(() => display.classList.remove('zooming'), 300);
      }
    }
  }, { passive: false });
}

// ─── Enhanced Keyboard Nudge ────────────────────────────────────────
function setupKeyboardNudge() {
  document.addEventListener('keydown', (e) => {
    // Get selected element from canvas engine
    const selectedEl = (window.engine && window.engine.getSelected) ? window.engine.getSelected() : null;
    if (!selectedEl) return;
    
    // Don't interfere with text editing
    if (e.target.isContentEditable || e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
      return;
    }
    
    const shift = e.shiftKey ? 10 : 1; // Shift = 10px, normal = 1px
    
    let moved = false;
    let dx = 0, dy = 0;
    
    switch(e.key) {
      case 'ArrowUp':
        e.preventDefault();
        dy = -shift;
        moved = true;
        break;
      case 'ArrowDown':
        e.preventDefault();
        dy = shift;
        moved = true;
        break;
      case 'ArrowLeft':
        e.preventDefault();
        dx = -shift;
        moved = true;
        break;
      case 'ArrowRight':
        e.preventDefault();
        dx = shift;
        moved = true;
        break;
    }
    
    if (moved) {
      // Use engine's nudge method
      if (window.engine && window.engine.nudgeElement) {
        window.engine.nudgeElement(selectedEl.id, dx, dy);
      }
      
      const domEl = document.querySelector('.canvas-element.selected');
      if (domEl) {
        showNudgeIndicator(domEl, shift);
      }
    }
  });
}

// ─── Drag Preview Class ─────────────────────────────────────────────
class DragPreview {
  constructor() {
    this.preview = null;
  }
  
  show(element, x, y) {
    if (!this.preview) {
      this.preview = document.createElement('div');
      this.preview.className = 'drag-preview';
      document.body.appendChild(this.preview);
    }
    
    // Clone element appearance
    if (element.cloneNode) {
      this.preview.innerHTML = element.outerHTML;
    }
    
    this.preview.style.cssText = `
      position: fixed;
      left: ${x}px;
      top: ${y}px;
      opacity: 0.7;
      pointer-events: none;
      z-index: 99999;
      transform: translate(-50%, -50%) rotate(3deg);
      filter: drop-shadow(0 8px 24px rgba(0,0,0,0.4));
      transition: transform 0.15s ease;
    `;
  }
  
  move(x, y) {
    if (this.preview) {
      this.preview.style.left = x + 'px';
      this.preview.style.top = y + 'px';
    }
  }
  
  hide() {
    if (this.preview) {
      this.preview.style.opacity = '0';
      this.preview.style.transform = 'translate(-50%, -50%) scale(0.8)';
      setTimeout(() => {
        this.preview?.remove();
        this.preview = null;
      }, 200);
    }
  }
}

// ─── Enhanced Toast System ──────────────────────────────────────────
function showToast(message, type = 'info', duration = 3000) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  
  const icons = {
    success: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>',
    error: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>',
    info: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>'
  };
  
  toast.innerHTML = `
    <div class="toast-icon">${icons[type] || icons.info}</div>
    <span class="toast-message">${message}</span>
  `;
  
  container.appendChild(toast);
  
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(20px)';
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// ─── Initialize All Interactions ────────────────────────────────────
function initializeInteractions() {
  setupOpacityControl();
  setupMousewheelZoom();
  setupKeyboardNudge();
  
  console.log('✨ Professional UI interactions initialized');
}

// Export for use in main app
if (typeof window !== 'undefined') {
  window.showZoomIndicator = showZoomIndicator;
  window.showNudgeIndicator = showNudgeIndicator;
  window.updateContextBarForSelection = updateContextBarForSelection;
  window.DragPreview = DragPreview;
  window.showToast = showToast;
  window.initializeInteractions = initializeInteractions;
}

// Auto-initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeInteractions);
} else {
  initializeInteractions();
}
