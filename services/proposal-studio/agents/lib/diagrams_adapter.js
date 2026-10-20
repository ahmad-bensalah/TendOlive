/**
 * diagrams_adapter.js - Converts diagram output → slides
 * 
 * Produces slides: s3b, s5, s10 (no class diagram)
 */

const i18n = require('./i18n.js');

/**
 * Converts diagrams output to slides
 * 
 * @param {object} diagramsOutput - { diagrams: [...], data: {...}, warnings: [] }
 * @param {object} input - Original input (for language, project_type)
 * @returns {object[]} - Array of slides
 */
function adaptDiagramsToSlides(diagramsOutput, input) {
  const { diagrams = [], data = {} } = diagramsOutput;
  const language = input.tender?.language || 'fr';
  const projectType = input.tender?.project_type || 'other';
  const isSoftware = projectType === 'software' || projectType === 'saas';
  
  const slides = [];
  const warnings = [];
  
  // Find diagrams by id
  const archDiagram = diagrams.find(d => d.id === 'architecture');
  const roadmapDiagram = diagrams.find(d => d.id === 'roadmap');
  const classDiagram = diagrams.find(d => d.id === 'class');
  
  // s3b: Architecture
  if (archDiagram) {
    const slide = buildArchitectureSlide(archDiagram, data, language);
    if (slide) slides.push(slide);
  } else {
    warnings.push('Architecture diagram missing');
  }
  
  // No class diagram slide (removed for all decks)
  // s5: Roadmap + Plan table
  if (roadmapDiagram && data.plan) {
    const slide = buildRoadmapSlide(roadmapDiagram, data.plan, language);
    if (slide) slides.push(slide);
  } else {
    warnings.push('Roadmap or plan data missing');
  }
  
  // s10: Risks
  if (data.risks && data.risks.length > 0) {
    const slide = buildRisksSlide(data.risks, language);
    if (slide) slides.push(slide);
  } else {
    warnings.push('Risk data missing');
  }
  
  return { slides, warnings };
}

/**
 * Builds s3b: Architecture slide
 */
function buildArchitectureSlide(diagram, data, language) {
  const blocks = [];
  
  // Image block
  if (diagram.src) {
    // Validate src is a proper upload path
    if (!diagram.src.startsWith('/uploads/') && !diagram.src.startsWith('data:image/')) {
      return {
        id: 's3b',
        type: 'content',
        title: i18n.translate('architecture_title', language),
        blocks: [{ kind: 'note', text: '[TO FILL: architecture diagram]' }],
        warnings: ['Invalid diagram source path']
      };
    }
    
    blocks.push({
      kind: 'image',
      src: diagram.src,
      caption: diagram.caption || i18n.translate('architecture_title', language)
    });
  } else {
    blocks.push({
      kind: 'note',
      text: '[TO FILL: architecture diagram]'
    });
  }
  
  // Components as bullets (max 6)
  const components = (data.components || []).slice(0, 6);
  if (components.length > 0) {
    blocks.push({
      kind: 'bullets',
      items: components
    });
  }
  
  const slide = {
    id: 's3b',
    type: 'content',
    title: i18n.translate('architecture_title', language),
    blocks
  };
  
  // Add sources if available
  if (diagram.sources) {
    slide.sources = diagram.sources;
  }
  
  return slide;
}

/**
 * Builds s3c: Class diagram slide
 */
function buildClassSlide(diagram, language) {
  const blocks = [];
  
  if (diagram.src) {
    if (!diagram.src.startsWith('/uploads/') && !diagram.src.startsWith('data:image/')) {
      return {
        id: 's3c',
        type: 'content',
        title: i18n.translate('class_diagram_title', language),
        blocks: [{ kind: 'note', text: '[TO FILL: class diagram]' }],
        warnings: ['Invalid diagram source path']
      };
    }
    
    blocks.push({
      kind: 'image',
      src: diagram.src,
      caption: diagram.caption || i18n.translate('class_diagram_title', language)
    });
  } else {
    blocks.push({
      kind: 'note',
      text: '[TO FILL: class diagram]'
    });
  }
  
  const slide = {
    id: 's3c',
    type: 'content',
    title: i18n.translate('class_diagram_title', language),
    blocks
  };
  
  if (diagram.sources) {
    slide.sources = diagram.sources;
  }
  
  return slide;
}

/**
 * Builds s5: Roadmap + Plan table slide
 */
function buildRoadmapSlide(diagram, plan, language) {
  const blocks = [];
  
  // Image block
  if (diagram.src) {
    if (!diagram.src.startsWith('/uploads/') && !diagram.src.startsWith('data:image/')) {
      return {
        id: 's5',
        type: 'content',
        title: i18n.translate('roadmap_title', language),
        blocks: [{ kind: 'note', text: '[TO FILL: roadmap]' }],
        warnings: ['Invalid diagram source path']
      };
    }
    
    blocks.push({
      kind: 'image',
      src: diagram.src,
      caption: diagram.caption || i18n.translate('roadmap_title', language)
    });
  }
  
  // Plan table, with the total weeks (computed by code) as its last row: a separate note
  // made the slide overflow into a "(2/2)" continuation slide holding only the note
  const tableData = buildPlanTable(plan, language);
  const totalWeeks = plan.reduce((sum, phase) => sum + (phase.weeks || 0), 0);
  if (tableData) {
    if (totalWeeks > 0) {
      tableData.rows.push([i18n.translate('total_duration', language), String(totalWeeks), '']);
    }
    blocks.push(tableData);
  }
  
  const slide = {
    id: 's5',
    type: 'content',
    title: i18n.translate('roadmap_title', language),
    blocks
  };
  
  if (diagram.sources) {
    slide.sources = diagram.sources;
  }
  
  return slide;
}

/**
 * Builds plan table from data.plan
 */
function buildPlanTable(plan, language) {
  if (!plan || plan.length === 0) {
    return null;
  }
  
  const columns = [
    i18n.translate('phase', language),
    i18n.translate('duration_weeks', language),
    i18n.translate('team', language)
  ];
  
  const rows = plan.slice(0, 10).map(phase => { // Max 10 rows
    const phaseName = phase.phase || '-';
    const weeks = String(phase.weeks || 0);
    
    // Build team string from roles
    const roles = phase.roles || [];
    const validRoles = ['backend', 'frontend', 'devops', 'pm', 'designer', 'qa'];
    const unknownRoles = roles.filter(r => !validRoles.includes(r.role?.toLowerCase()));
    
    const teamStr = roles
      .filter(r => validRoles.includes(r.role?.toLowerCase()))
      .map(r => {
        const roleLabel = i18n.translate(`role_${r.role.toLowerCase()}`, language);
        return `${roleLabel} (${r.people})`;
      })
      .join(', ') || '-';
    
    return [phaseName, weeks, teamStr];
  });
  
  return {
    kind: 'table',
    columns,
    rows
  };
}

/**
 * Builds s10: Risks slide
 */
function buildRisksSlide(risks, language) {
  const columns = [
    i18n.translate('risk', language),
    i18n.translate('impact', language),
    i18n.translate('mitigation', language)
  ];
  
  const rows = risks.slice(0, 5).map(risk => { // Max 5 risks
    const riskText = risk.risk || '[TO FILL: risk]';
    const impactLevel = risk.impact || 'medium';
    const impactLabel = i18n.translate(`impact_${impactLevel}`, language);
    const mitigation = risk.mitigation || '[TO FILL: mitigation]';
    
    return [riskText, impactLabel, mitigation];
  });
  
  return {
    id: 's10',
    type: 'content',
    title: i18n.translate('risks_title', language),
    blocks: [
      {
        kind: 'table',
        columns,
        rows
      }
    ]
  };
}

// Export for CommonJS (n8n Code nodes) and ES modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    adaptDiagramsToSlides,
    buildArchitectureSlide,
    buildClassSlide,
    buildRoadmapSlide,
    buildPlanTable,
    buildRisksSlide
  };
}
