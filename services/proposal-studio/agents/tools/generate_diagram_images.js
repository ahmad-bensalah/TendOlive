#!/usr/bin/env node
/**
 * Generate real diagram SVG images for fixtures
 * Creates SVG files in uploads/ folder so they exist
 */

const fs = require('fs');
const path = require('path');

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, '../../uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Theme colors (from default theme)
const theme = {
  primary: '#1d4ed8',
  secondary: '#3b82f6',
  bg: '#0f172a',
  text: '#ffffff',
  textMuted: '#94a3b8'
};

/**
 * Generate Architecture Diagram SVG
 */
function generateArchitectureSVG() {
  const nodes = [
    { id: 'frontend', label: 'Frontend\nReact/Vue', x: 200, y: 100, group: 'presentation' },
    { id: 'gateway', label: 'API Gateway\nNginx', x: 500, y: 100, group: 'api' },
    { id: 'auth', label: 'Auth Service', x: 350, y: 250, group: 'services' },
    { id: 'business', label: 'Business Logic', x: 650, y: 250, group: 'services' },
    { id: 'db', label: 'PostgreSQL\nHA Cluster', x: 500, y: 400, group: 'data' },
    { id: 'cache', label: 'Redis Cache', x: 800, y: 400, group: 'data' }
  ];
  
  const edges = [
    { from: 'frontend', to: 'gateway' },
    { from: 'gateway', to: 'auth' },
    { from: 'gateway', to: 'business' },
    { from: 'auth', to: 'db' },
    { from: 'business', to: 'db' },
    { from: 'business', to: 'cache' }
  ];
  
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 550" width="1000" height="550">
  <defs>
    <style>
      .box { fill: ${theme.bg}; stroke: ${theme.primary}; stroke-width: 2; rx: 8; }
      .box-text { fill: ${theme.text}; font-family: system-ui, sans-serif; font-size: 16px; text-anchor: middle; font-weight: 600; }
      .line { stroke: ${theme.secondary}; stroke-width: 2; fill: none; marker-end: url(#arrowhead); }
      .title { fill: ${theme.text}; font-family: system-ui, sans-serif; font-size: 20px; font-weight: 700; }
    </style>
    <marker id="arrowhead" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto">
      <polygon points="0 0, 10 3, 0 6" fill="${theme.secondary}" />
    </marker>
  </defs>
  
  <rect width="1000" height="550" fill="${theme.bg}" />
  <text x="500" y="40" class="title" text-anchor="middle">Architecture Technique</text>
`;

  // Draw edges first (behind boxes)
  edges.forEach(edge => {
    const fromNode = nodes.find(n => n.id === edge.from);
    const toNode = nodes.find(n => n.id === edge.to);
    
    svg += `  <line x1="${fromNode.x + 90}" y1="${fromNode.y + 40}" x2="${toNode.x + 90}" y2="${toNode.y + 40}" class="line" />\n`;
  });
  
  // Draw nodes
  nodes.forEach(node => {
    const lines = node.label.split('\n');
    svg += `  <rect x="${node.x}" y="${node.y}" width="180" height="80" class="box" />\n`;
    
    lines.forEach((line, i) => {
      const yOffset = lines.length === 1 ? 50 : 35 + (i * 20);
      svg += `  <text x="${node.x + 90}" y="${node.y + yOffset}" class="box-text">${escapeXml(line)}</text>\n`;
    });
  });
  
  svg += `</svg>`;
  return svg;
}

/**
 * Generate Roadmap/Timeline SVG
 */
function generateRoadmapSVG() {
  const phases = [
    { name: 'Cadrage', weeks: 4, color: '#10b981' },
    { name: 'Développement MVP', weeks: 8, color: '#3b82f6' },
    { name: 'Tests & QA', weeks: 3, color: '#f59e0b' },
    { name: 'Déploiement', weeks: 2, color: '#8b5cf6' },
    { name: 'Support', weeks: 3, color: '#06b6d4' }
  ];
  
  const totalWeeks = phases.reduce((sum, p) => sum + p.weeks, 0);
  const barHeight = 50;
  const spacing = 20;
  const startX = 100;
  const barWidth = 800;
  
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 ${phases.length * (barHeight + spacing) + 120}" width="1000">
  <defs>
    <style>
      .phase-bar { rx: 8; }
      .phase-text { fill: white; font-family: system-ui, sans-serif; font-size: 16px; font-weight: 600; }
      .week-text { fill: ${theme.textMuted}; font-family: system-ui, sans-serif; font-size: 14px; }
      .title { fill: ${theme.text}; font-family: system-ui, sans-serif; font-size: 20px; font-weight: 700; }
    </style>
  </defs>
  
  <rect width="1000" height="${phases.length * (barHeight + spacing) + 120}" fill="${theme.bg}" />
  <text x="500" y="40" class="title" text-anchor="middle">Planning de Mise en Œuvre</text>
  <text x="950" y="80" class="week-text" text-anchor="end">${totalWeeks} semaines</text>
`;

  let currentY = 100;
  let cumulativeWeeks = 0;
  
  phases.forEach((phase, i) => {
    const width = (phase.weeks / totalWeeks) * barWidth;
    
    svg += `  <rect x="${startX + (cumulativeWeeks / totalWeeks) * barWidth}" y="${currentY}" width="${width}" height="${barHeight}" fill="${phase.color}" class="phase-bar" />\n`;
    svg += `  <text x="${startX + (cumulativeWeeks / totalWeeks) * barWidth + width/2}" y="${currentY + 30}" class="phase-text" text-anchor="middle">${escapeXml(phase.name)}</text>\n`;
    svg += `  <text x="${startX + (cumulativeWeeks / totalWeeks) * barWidth + width/2}" y="${currentY + 75}" class="week-text" text-anchor="middle">${phase.weeks}s</text>\n`;
    
    cumulativeWeeks += phase.weeks;
    currentY += barHeight + spacing;
  });
  
  svg += `</svg>`;
  return svg;
}

/**
 * Generate Class Diagram SVG (even though we don't use it anymore, keep for reference)
 */
function generateClassDiagramSVG() {
  const classes = [
    { name: 'User', attrs: ['id: UUID', 'email: String', 'name: String'], methods: ['login()', 'logout()'], x: 150, y: 100 },
    { name: 'Project', attrs: ['id: UUID', 'title: String', 'status: Enum'], methods: ['create()', 'update()'], x: 450, y: 100 },
    { name: 'Document', attrs: ['id: UUID', 'content: Text', 'createdAt: Date'], methods: ['save()', 'delete()'], x: 750, y: 100 }
  ];
  
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1100 400" width="1100" height="400">
  <defs>
    <style>
      .class-box { fill: ${theme.bg}; stroke: ${theme.primary}; stroke-width: 2; }
      .class-header { fill: ${theme.primary}; }
      .class-name { fill: white; font-family: system-ui, sans-serif; font-size: 18px; font-weight: 700; text-anchor: middle; }
      .class-text { fill: ${theme.text}; font-family: 'Courier New', monospace; font-size: 13px; }
      .divider { stroke: ${theme.primary}; stroke-width: 1; }
      .relation { stroke: ${theme.secondary}; stroke-width: 2; fill: none; }
      .title { fill: ${theme.text}; font-family: system-ui, sans-serif; font-size: 20px; font-weight: 700; }
    </style>
  </defs>
  
  <rect width="1100" height="400" fill="${theme.bg}" />
  <text x="550" y="40" class="title" text-anchor="middle">Modèle de Classes Principal</text>
`;

  classes.forEach(cls => {
    const height = 60 + cls.attrs.length * 18 + cls.methods.length * 18;
    
    // Box
    svg += `  <rect x="${cls.x}" y="${cls.y}" width="250" height="${height}" class="class-box" />\n`;
    
    // Header
    svg += `  <rect x="${cls.x}" y="${cls.y}" width="250" height="40" class="class-header" />\n`;
    svg += `  <text x="${cls.x + 125}" y="${cls.y + 27}" class="class-name">${cls.name}</text>\n`;
    
    // Attributes
    let y = cls.y + 58;
    cls.attrs.forEach(attr => {
      svg += `  <text x="${cls.x + 10}" y="${y}" class="class-text">${escapeXml(attr)}</text>\n`;
      y += 18;
    });
    
    // Divider
    svg += `  <line x1="${cls.x}" y1="${y}" x2="${cls.x + 250}" y2="${y}" class="divider" />\n`;
    y += 12;
    
    // Methods
    cls.methods.forEach(method => {
      svg += `  <text x="${cls.x + 10}" y="${y}" class="class-text">${escapeXml(method)}</text>\n`;
      y += 18;
    });
  });
  
  // Relations
  svg += `  <line x1="${classes[0].x + 250}" y1="${classes[0].y + 70}" x2="${classes[1].x}" y2="${classes[1].y + 70}" class="relation" />\n`;
  svg += `  <line x1="${classes[1].x + 250}" y1="${classes[1].y + 70}" x2="${classes[2].x}" y2="${classes[2].y + 70}" class="relation" />\n`;
  
  svg += `</svg>`;
  return svg;
}

function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Generate and save all diagrams
console.log('🎨 Generating diagram SVG images...\n');

const diagrams = [
  { name: 'mock_architecture.svg', generator: generateArchitectureSVG },
  { name: 'mock_roadmap.svg', generator: generateRoadmapSVG },
  { name: 'mock_classes.svg', generator: generateClassDiagramSVG }
];

diagrams.forEach(({ name, generator }) => {
  const svg = generator();
  const filepath = path.join(uploadsDir, name);
  fs.writeFileSync(filepath, svg);
  console.log(`✅ Created: ${filepath}`);
  console.log(`   Size: ${svg.length} bytes`);
});

console.log('\n🎉 All diagram images generated!');
console.log(`📁 Location: ${uploadsDir}`);
console.log('\n💡 These images are now referenced by the fixtures and will appear in generated decks.');
