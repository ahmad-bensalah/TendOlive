/**
 * svg.js - Deterministic SVG fallback renderer for diagrams
 * 
 * Generates clean SVG from structured data (no external dependencies).
 * Used when Mermaid rendering fails or is unavailable.
 * 
 * Features:
 * - Theme colors applied
 * - System font stack (no web fonts needed)
 * - Proper viewBox and text sizing
 * - No foreignObject (PPTX export rasterizes SVG)
 * - Security: plain SVG only, no scripts
 */

// Single quotes only: the stack goes inside double-quoted XML attributes (a " here broke every SVG)
const FONT_STACK = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const BOX_WIDTH = 180;
const BOX_HEIGHT = 80;
const PADDING = 20;
const LINE_HEIGHT = 20;

/**
 * Escapes text for SVG
 */
function escapeXml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Wraps text to fit in box width
 */
function wrapText(text, maxWidth = 160) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let currentLine = '';
  
  for (const word of words) {
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    // Rough estimate: 8px per character
    if (testLine.length * 8 > maxWidth && currentLine) {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = testLine;
    }
  }
  
  if (currentLine) {
    lines.push(currentLine);
  }
  
  return lines.slice(0, 3); // Max 3 lines per box
}

/**
 * Renders architecture diagram as SVG
 * 
 * @param {object} structure - { nodes: [{id, label, group}], edges: [{from, to, label}] }
 * @param {object} theme - { primary, secondary }
 * @returns {string} - SVG markup
 */
function renderArchitecture(structure, theme = {}) {
  const { nodes = [], edges = [] } = structure;
  const primary = theme.primary || '#1F4E79';
  const secondary = theme.secondary || '#4472C4';
  
  if (nodes.length === 0) {
    return renderPlaceholder('Architecture diagram', 1600, 700);
  }
  
  // Group nodes by group field
  const groups = {};
  nodes.forEach(node => {
    const group = node.group || 'default';
    if (!groups[group]) groups[group] = [];
    groups[group].push(node);
  });
  
  const groupNames = Object.keys(groups);
  const colWidth = 1600 / (groupNames.length || 1);
  
  // Position nodes
  const positions = {};
  groupNames.forEach((groupName, colIdx) => {
    const groupNodes = groups[groupName];
    const x = colIdx * colWidth + colWidth / 2;
    
    groupNodes.forEach((node, rowIdx) => {
      const y = 100 + rowIdx * (BOX_HEIGHT + PADDING * 2);
      positions[node.id] = { x, y };
    });
  });
  
  // Build SVG
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 700" style="background: white; font-family: ${FONT_STACK};">`;
  
  // Draw edges first (behind boxes)
  edges.forEach(edge => {
    const from = positions[edge.from];
    const to = positions[edge.to];
    
    if (from && to) {
      const x1 = from.x + BOX_WIDTH / 2;
      const y1 = from.y + BOX_HEIGHT / 2;
      const x2 = to.x - BOX_WIDTH / 2;
      const y2 = to.y + BOX_HEIGHT / 2;
      
      svg += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${secondary}" stroke-width="2" marker-end="url(#arrowhead)"/>`;
      
      // Edge label
      if (edge.label) {
        const midX = (x1 + x2) / 2;
        const midY = (y1 + y2) / 2;
        svg += `<text x="${midX}" y="${midY - 5}" text-anchor="middle" font-size="12" fill="#666">${escapeXml(edge.label)}</text>`;
      }
    }
  });
  
  // Draw nodes
  Object.entries(positions).forEach(([nodeId, pos]) => {
    const node = nodes.find(n => n.id === nodeId);
    if (!node) return;
    
    const x = pos.x - BOX_WIDTH / 2;
    const y = pos.y;
    
    // Box
    svg += `<rect x="${x}" y="${y}" width="${BOX_WIDTH}" height="${BOX_HEIGHT}" fill="${primary}" stroke="${secondary}" stroke-width="2" rx="5"/>`;
    
    // Label (wrapped)
    const lines = wrapText(node.label, BOX_WIDTH - 20);
    const startY = y + BOX_HEIGHT / 2 - (lines.length - 1) * LINE_HEIGHT / 2;
    
    lines.forEach((line, i) => {
      svg += `<text x="${pos.x}" y="${startY + i * LINE_HEIGHT}" text-anchor="middle" font-size="14" fill="white" font-weight="500">${escapeXml(line)}</text>`;
    });
  });
  
  // Arrow marker
  svg += `<defs><marker id="arrowhead" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto"><polygon points="0 0, 10 3, 0 6" fill="${secondary}"/></marker></defs>`;
  
  svg += '</svg>';
  return svg;
}

/**
 * Renders roadmap (Gantt chart) as SVG
 * 
 * @param {object} structure - { phases: [{phase, weeks, roles}] }
 * @param {object} theme - { primary, secondary }
 * @returns {string} - SVG markup
 */
function renderRoadmap(structure, theme = {}) {
  const { phases = [] } = structure;
  const primary = theme.primary || '#1F4E79';
  const secondary = theme.secondary || '#4472C4';
  
  if (phases.length === 0) {
    return renderPlaceholder('Roadmap', 1600, 400);
  }
  
  const totalWeeks = phases.reduce((sum, p) => sum + (p.weeks || 0), 0);
  const barHeight = 40;
  const rowHeight = barHeight + 30;
  const startX = 150;
  const chartWidth = 1300;
  const weekWidth = totalWeeks > 0 ? chartWidth / totalWeeks : 50;
  
  const height = 100 + phases.length * rowHeight + 50;
  
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 ${height}" style="background: white; font-family: ${FONT_STACK};">`;
  
  // Title
  svg += `<text x="800" y="40" text-anchor="middle" font-size="20" font-weight="600" fill="${primary}">Plan de mise en œuvre</text>`;
  
  let currentWeek = 0;
  
  phases.forEach((phase, idx) => {
    const y = 80 + idx * rowHeight;
    const barWidth = (phase.weeks || 1) * weekWidth;
    const barX = startX + currentWeek * weekWidth;
    
    // Phase name
    svg += `<text x="10" y="${y + barHeight / 2 + 5}" font-size="14" fill="#333">${escapeXml(phase.phase || `Phase ${idx + 1}`)}</text>`;
    
    // Bar
    svg += `<rect x="${barX}" y="${y}" width="${barWidth}" height="${barHeight}" fill="${secondary}" stroke="${primary}" stroke-width="1" rx="3"/>`;
    
    // Weeks label
    svg += `<text x="${barX + barWidth / 2}" y="${y + barHeight / 2 + 5}" text-anchor="middle" font-size="12" fill="white" font-weight="500">${phase.weeks || 1} sem.</text>`;
    
    currentWeek += (phase.weeks || 1);
  });
  
  // Timeline
  svg += `<line x1="${startX}" y1="60" x2="${startX + chartWidth}" y2="60" stroke="#ccc" stroke-width="1"/>`;
  
  svg += '</svg>';
  return svg;
}

/**
 * Renders class diagram as SVG
 * 
 * @param {object} structure - { classes: [{name, attributes, methods, relations}] }
 * @param {object} theme - { primary, secondary }
 * @returns {string} - SVG markup
 */
function renderClassDiagram(structure, theme = {}) {
  const { classes = [] } = structure;
  const primary = theme.primary || '#1F4E79';
  const secondary = theme.secondary || '#4472C4';
  
  if (classes.length === 0) {
    return renderPlaceholder('Class diagram', 1600, 700);
  }
  
  const classWidth = 220;
  const classSpacing = 50;
  const cols = Math.ceil(Math.sqrt(classes.length));
  
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 700" style="background: white; font-family: ${FONT_STACK};">`;
  
  classes.forEach((cls, idx) => {
    const col = idx % cols;
    const row = Math.floor(idx / cols);
    const x = 50 + col * (classWidth + classSpacing);
    const y = 50 + row * 200;
    
    const attrs = (cls.attributes || []).slice(0, 4); // Max 4
    const methods = (cls.methods || []).slice(0, 4); // Max 4
    const boxHeight = 40 + attrs.length * 18 + methods.length * 18 + 30;
    
    // Box
    svg += `<rect x="${x}" y="${y}" width="${classWidth}" height="${boxHeight}" fill="white" stroke="${primary}" stroke-width="2" rx="5"/>`;
    
    // Class name (header)
    svg += `<rect x="${x}" y="${y}" width="${classWidth}" height="40" fill="${primary}" rx="5"/>`;
    svg += `<text x="${x + classWidth / 2}" y="${y + 25}" text-anchor="middle" font-size="14" fill="white" font-weight="600">${escapeXml(cls.name || 'Class')}</text>`;
    
    let currentY = y + 50;
    
    // Attributes
    if (attrs.length > 0) {
      attrs.forEach(attr => {
        svg += `<text x="${x + 10}" y="${currentY}" font-size="12" fill="#333">- ${escapeXml(attr)}</text>`;
        currentY += 18;
      });
      
      // Separator
      svg += `<line x1="${x}" y1="${currentY + 5}" x2="${x + classWidth}" y2="${currentY + 5}" stroke="${secondary}" stroke-width="1"/>`;
      currentY += 15;
    }
    
    // Methods
    if (methods.length > 0) {
      methods.forEach(method => {
        svg += `<text x="${x + 10}" y="${currentY}" font-size="12" fill="#333">+ ${escapeXml(method)}</text>`;
        currentY += 18;
      });
    }
  });
  
  svg += '</svg>';
  return svg;
}

/**
 * Renders a placeholder diagram
 */
function renderPlaceholder(label, width = 1600, height = 700) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" style="background: #f5f5f5; font-family: ${FONT_STACK};">
    <rect x="0" y="0" width="${width}" height="${height}" fill="#f5f5f5"/>
    <text x="${width / 2}" y="${height / 2}" text-anchor="middle" font-size="24" fill="#999">${escapeXml(label)} - À compléter</text>
  </svg>`;
}

/**
 * Security scan: ensures SVG is safe for upload
 * Checks for script tags, event handlers, javascript: URLs
 * 
 * @param {string} svg - SVG markup
 * @returns {{ safe: boolean, violations: string[] }}
 */
function scanSVGSecurity(svg) {
  const violations = [];
  const lower = svg.toLowerCase();
  
  // Check for script tags
  if (lower.includes('<script')) {
    violations.push('Contains <script> tag');
  }
  
  // Check for event handlers
  const eventHandlers = ['onload', 'onclick', 'onerror', 'onmouseover', 'onfocus'];
  eventHandlers.forEach(handler => {
    if (lower.includes(handler + '=')) {
      violations.push(`Contains ${handler} event handler`);
    }
  });
  
  // Check for javascript: URLs
  if (lower.includes('javascript:')) {
    violations.push('Contains javascript: URL');
  }
  
  // Check for data URLs with script
  if (lower.includes('data:') && lower.includes('script')) {
    violations.push('Contains data URL with script');
  }
  
  return {
    safe: violations.length === 0,
    violations
  };
}

// Export for CommonJS (n8n Code nodes) and ES modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    renderArchitecture,
    renderRoadmap,
    renderClassDiagram,
    renderPlaceholder,
    scanSVGSecurity,
    escapeXml,
    wrapText
  };
}
