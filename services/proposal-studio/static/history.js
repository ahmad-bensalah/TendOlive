/* ═══════════════════════════════════════════════════════════════════
   history.js — Undo / Redo stack for the RFP Slide Deck Studio.
   Stores deep snapshots of the full project state.
   ═══════════════════════════════════════════════════════════════════ */

class HistoryManager {
  constructor(maxSteps = 80) {
    this._stack = [];
    this._index = -1;
    this._max = maxSteps;
    this._paused = false;
  }

  /** Take a snapshot of the current state. */
  push(state) {
    if (this._paused) return;
    // Deep clone
    const snap = JSON.parse(JSON.stringify(state));
    // Trim future states
    this._stack = this._stack.slice(0, this._index + 1);
    this._stack.push(snap);
    // Enforce max
    if (this._stack.length > this._max) {
      this._stack.shift();
    }
    this._index = this._stack.length - 1;
  }

  /** Undo — go back one step. Returns the previous state or null. */
  undo() {
    if (this._index <= 0) return null;
    this._index--;
    return JSON.parse(JSON.stringify(this._stack[this._index]));
  }

  /** Redo — go forward one step. Returns the next state or null. */
  redo() {
    if (this._index >= this._stack.length - 1) return null;
    this._index++;
    return JSON.parse(JSON.stringify(this._stack[this._index]));
  }

  /** Can undo? */
  get canUndo() { return this._index > 0; }

  /** Can redo? */
  get canRedo() { return this._index < this._stack.length - 1; }

  /** Pause recording (e.g., during undo/redo restore). */
  pause() { this._paused = true; }
  resume() { this._paused = false; }
}

// Export as global
window.HistoryManager = HistoryManager;
