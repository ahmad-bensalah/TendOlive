/* ═══════════════════════════════════════════════════════════════════
   page_numbers.js — Page Numbering for RFP Slide Deck Studio
   Adds page numbers to the bottom-right of each slide in the editor
   ═══════════════════════════════════════════════════════════════════ */

(function(global) {
  'use strict';

  /**
   * Adds or updates page number display on the canvas
   * @param {number} currentPage - Current slide number (1-indexed)
   * @param {number} totalPages - Total number of slides
   */
  function updatePageNumber(currentPage, totalPages) {
    const viewport = document.getElementById('canvas-viewport');
    if (!viewport) return;

    let pageNum = viewport.querySelector('.page-number-display');
    
    if (!pageNum) {
      pageNum = document.createElement('div');
      pageNum.className = 'page-number-display';
      pageNum.style.cssText = `
        position: absolute;
        bottom: 20px;
        right: 30px;
        background: rgba(15, 23, 42, 0.95);
        border: 1px solid rgba(99, 102, 241, 0.5);
        border-radius: 6px;
        padding: 6px 12px;
        font-family: 'Inter', sans-serif;
        font-size: 13px;
        font-weight: 600;
        color: #ffffff;
        pointer-events: none;
        z-index: 1000;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
        backdrop-filter: blur(8px);
      `;
      viewport.appendChild(pageNum);
    }

    pageNum.textContent = `${currentPage} / ${totalPages}`;
    
    // Hide on first and last slide (title + thank you)
    if (currentPage === 1 || currentPage === totalPages) {
      pageNum.style.display = 'none';
    } else {
      pageNum.style.display = 'block';
    }
  }

  /**
   * Initialize page numbering
   */
  function initPageNumbering() {
    // Will be called by app.js when slide changes
    if (typeof global.updatePageNumber === 'undefined') {
      global.updatePageNumber = updatePageNumber;
    }
  }

  // Auto-initialize
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initPageNumbering);
  } else {
    initPageNumbering();
  }

})(typeof window !== 'undefined' ? window : globalThis);
