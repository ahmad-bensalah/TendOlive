/**
 * diagrams.js - Agents 2 & 3 logic (Architecture + Planning + Diagrams)
 * 
 * Produces structured JSON → Mermaid text → SVG fallback
 * Output: { diagrams: [...], data: {...}, warnings: [] }
 */

const { renderArchitecture, renderRoadmap, renderClassDiagram, scanSVGSecurity } = require('./svg.js');
const { buildSystemPrompt, wrapTenderData, withFeedback, makeCaller, runAgentLoop } = require('./llm.js');

/**
 * Generates Mermaid text from architecture structure
 */
function generateArchitectureMermaid(structure) {
  const { nodes = [], edges = [] } = structure;
  
  if (nodes.length === 0) {
    return null;
  }
  
  let mermaid = 'graph LR\n';
  
  // Define nodes (safe IDs, quoted labels)
  nodes.forEach(node => {
    const safeId = node.id.replace(/[^a-zA-Z0-9]/g, '_');
    const label = (node.label || node.id).replace(/"/g, '\\"');
    mermaid += `  ${safeId}["${label}"]\n`;
  });
  
  // Define edges
  edges.forEach(edge => {
    const fromId = edge.from.replace(/[^a-zA-Z0-9]/g, '_');
    const toId = edge.to.replace(/[^a-zA-Z0-9]/g, '_');
    
    if (edge.label) {
      const label = edge.label.replace(/"/g, '\\"');
      mermaid += `  ${fromId} -->|"${label}"| ${toId}\n`;
    } else {
      mermaid += `  ${fromId} --> ${toId}\n`;
    }
  });
  
  return mermaid;
}

/**
 * Generates Mermaid text from roadmap structure
 */
function generateRoadmapMermaid(structure) {
  const { phases = [] } = structure;
  
  if (phases.length === 0) {
    return null;
  }
  
  let mermaid = 'gantt\n';
  mermaid += '  title Plan de mise en œuvre\n';
  mermaid += '  dateFormat YYYY-MM-DD\n';
  
  // Calculate dates (assume start = today)
  const startDate = new Date();
  let currentDate = new Date(startDate);
  
  phases.forEach((phase, idx) => {
    const phaseName = (phase.phase || `Phase ${idx + 1}`).replace(/"/g, '\\"');
    const weeks = phase.weeks || 1;
    const days = weeks * 7;
    
    const start = currentDate.toISOString().split('T')[0];
    currentDate.setDate(currentDate.getDate() + days);
    const end = currentDate.toISOString().split('T')[0];
    
    mermaid += `  ${phaseName} : ${start}, ${end}\n`;
  });
  
  return mermaid;
}

/**
 * Generates Mermaid text from class diagram structure
 */
function generateClassMermaid(structure) {
  const { classes = [] } = structure;
  
  if (classes.length === 0) {
    return null;
  }
  
  let mermaid = 'classDiagram\n';
  
  classes.forEach(cls => {
    const name = (cls.name || 'Class').replace(/[^a-zA-Z0-9]/g, '_');
    
    mermaid += `  class ${name} {\n`;
    
    // Attributes
    (cls.attributes || []).forEach(attr => {
      const safe = attr.replace(/"/g, '\\"');
      mermaid += `    ${safe}\n`;
    });
    
    // Methods
    (cls.methods || []).forEach(method => {
      const safe = method.replace(/"/g, '\\"');
      mermaid += `    ${safe}\n`;
    });
    
    mermaid += `  }\n`;
    
    // Relations
    if (cls.relations) {
      cls.relations.forEach(rel => {
        const target = (rel.target || '').replace(/[^a-zA-Z0-9]/g, '_');
        const type = rel.type || '-->';
        mermaid += `  ${name} ${type} ${target}\n`;
      });
    }
  });
  
  return mermaid;
}

/**
 * Validates diagram structure
 */
function validateDiagramStructure(structure, type) {
  const errors = [];
  
  switch (type) {
    case 'architecture':
      if (!structure.nodes || !Array.isArray(structure.nodes)) {
        errors.push('architecture: nodes must be an array');
      } else if (structure.nodes.length > 12) {
        errors.push('architecture: max 12 nodes allowed');
      }
      
      structure.nodes?.forEach((node, i) => {
        if (!node.id) errors.push(`architecture.nodes[${i}]: missing id`);
        if (!node.label) errors.push(`architecture.nodes[${i}]: missing label`);
        if (node.label && node.label.split(/\s+/).length > 4) {
          errors.push(`architecture.nodes[${i}]: label max 4 words`);
        }
      });
      
      if (!structure.edges || !Array.isArray(structure.edges)) {
        errors.push('architecture: edges must be an array');
      }
      break;
    
    case 'roadmap':
      if (!structure.phases || !Array.isArray(structure.phases)) {
        errors.push('roadmap: phases must be an array');
      } else if (structure.phases.length > 8) {
        errors.push('roadmap: max 8 phases allowed');
      }
      
      structure.phases?.forEach((phase, i) => {
        if (!phase.phase) errors.push(`roadmap.phases[${i}]: missing phase name`);
        if (!Number.isInteger(phase.weeks) || phase.weeks < 1) {
          errors.push(`roadmap.phases[${i}]: weeks must be positive integer`);
        }
      });
      break;
    
    case 'class':
      if (!structure.classes || !Array.isArray(structure.classes)) {
        errors.push('class: classes must be an array');
      } else if (structure.classes.length > 8) {
        errors.push('class: max 8 classes allowed');
      }
      
      structure.classes?.forEach((cls, i) => {
        if (!cls.name) errors.push(`class.classes[${i}]: missing name`);
      });
      break;
    
    default:
      errors.push(`Unknown diagram type: ${type}`);
  }
  
  return errors;
}

/**
 * Builds ready facts for diagram agents from input
 */
function buildDiagramFacts(input) {
  const requirements = input.tender?.requirements || [];
  const projectType = input.tender?.project_type || 'other';
  const similarProjects = input.match?.similar_projects || [];
  
  // Extract technology stack from similar projects
  const allStacks = similarProjects.flatMap(p => p.stack || []);
  const uniqueTech = [...new Set(allStacks)];
  
  // Extract durations for planning
  const durations = similarProjects
    .map(p => p.duration_months)
    .filter(d => d > 0);
  
  const avgDuration = durations.length > 0
    ? Math.round(durations.reduce((sum, d) => sum + d, 0) / durations.length)
    : 6; // Default 6 months
  
  // Team profiles
  const profiles = input.match?.engineers?.profiles || [];
  
  return {
    projectType,
    requirements,
    technologies: uniqueTech.slice(0, 10), // Max 10
    avgDurationMonths: avgDuration,
    teamProfiles: profiles
  };
}

/**
 * Executes diagram agents (mock mode for now)
 */
function executeDiagramAgents(input, options = {}) {
  const { mode = 'mock', fixtures = {} } = options;
  
  const facts = buildDiagramFacts(input);
  
  if (mode === 'mock') {
    // Return fixture or placeholder
    const inputId = input.tender?.id || 'unknown';
    const fixture = fixtures[inputId];
    
    if (!fixture) {
      // Generate placeholder diagrams
      return {
        agent: 'diagrams',
        ok: true,
        diagrams: [
          {
            kind: 'image',
            id: 'architecture',
            src: null, // Will be uploaded
            caption: 'Architecture technique',
            sources: { mermaid: null }
          },
          {
            kind: 'image',
            id: 'roadmap',
            src: null,
            caption: 'Plan de mise en œuvre',
            sources: { mermaid: null }
          }
        ],
        data: {
          components: ['[TO FILL: components]'],
          plan: [{ phase: 'Phase 1', weeks: facts.avgDurationMonths * 4, roles: [] }],
          risks: []
        },
        warnings: ['Mock mode: no fixture available'],
        usage: { model: 'mock', promptTokens: 0, completionTokens: 0, ms: 0, attempts: 1 }
      };
    }
    
    return {
      ...fixture,
      data: {
        ...(fixture.data || {}),
        readyFacts: facts
      }
    };
  }
  
  return executeDiagramAgentsReal(input, facts, options);
}

const VALID_ROLES = ['backend', 'frontend', 'devops', 'pm', 'designer', 'qa'];

const AGENT2_PROMPT = `You are Agent 2 (architecture). Describe the technical architecture as structured data.
Code turns it into diagrams; never write Mermaid or SVG.

Return exactly this JSON:
{
  "architecture": { "nodes": [ { "id": "short_id", "label": "max 4 words", "group": "frontend|backend|data|infra|external" } ],
                    "edges": [ { "from": "id", "to": "id", "label": "max 3 words" } ] },
  "components": ["3 to 6 components, max 6 words each"],
  "assumptions": []
}
At most 12 nodes.
Use technologies from ready_facts.technologies when you name a technology; do not invent products.`;

const AGENT3_PROMPT = `You are Agent 3 (planning and risks). Propose the delivery plan and the main risks.

Return exactly this JSON:
{
  "plan": [ { "phase": "phase name", "weeks": 4, "roles": [ { "role": "backend", "people": 2 } ] } ],
  "risks": [ { "risk": "max 12 words", "impact": "high|medium|low", "mitigation": "max 15 words" } ],
  "assumptions": []
}
4 to 6 phases and 3 to 5 risks; weeks are whole numbers; roles only: backend, frontend, devops, pm, designer, qa,
and only roles present in ready_facts.team_profiles, with at most the available people. At most 5 risks.
Do not add up the weeks: code computes the total.`;

function validatePlanOutput(json, facts) {
  const v = [];
  const plan = Array.isArray(json.plan) ? json.plan : null;
  if (!plan) return ['plan must be an array'];
  if (plan.length < 4 || plan.length > 6) v.push(`plan must have 4 to 6 phases, got ${plan.length}`);
  const available = {};
  (facts.teamProfiles || []).forEach(p => { available[String(p.role).toLowerCase()] = p.count || 0; });
  plan.forEach((ph, i) => {
    if (!ph || !ph.phase) v.push(`plan[${i}].phase is missing`);
    if (!Number.isInteger(ph && ph.weeks) || ph.weeks < 1) v.push(`plan[${i}].weeks must be a positive whole number`);
    (ph && Array.isArray(ph.roles) ? ph.roles : []).forEach((r, j) => {
      const role = String(r && r.role || '').toLowerCase();
      if (!VALID_ROLES.includes(role)) v.push(`plan[${i}].roles[${j}].role "${r && r.role}" must be one of ${VALID_ROLES.join(', ')}`);
      else if (Object.keys(available).length && !(role in available)) v.push(`plan[${i}].roles[${j}].role "${role}" is not in the team profiles`);
      else if (available[role] && r.people > available[role]) v.push(`plan[${i}].roles[${j}] uses ${r.people} ${role} but only ${available[role]} are available`);
      if (!Number.isInteger(r && r.people) || r.people < 1) v.push(`plan[${i}].roles[${j}].people must be a positive whole number`);
    });
  });
  const risks = Array.isArray(json.risks) ? json.risks : [];
  if (risks.length < 3 || risks.length > 5) v.push(`risks must have 3 to 5 entries, got ${risks.length}`);
  risks.forEach((r, i) => {
    if (!r || !r.risk || !r.mitigation) v.push(`risks[${i}] needs risk and mitigation`);
    if (r && !['high', 'medium', 'low'].includes(r.impact)) v.push(`risks[${i}].impact must be high, medium or low`);
  });
  return v;
}

function svgDataUrl(svg) {
  const b64 = typeof Buffer !== 'undefined' ? Buffer.from(svg, 'utf-8').toString('base64')
    : btoa(unescape(encodeURIComponent(svg)));
  return `data:image/svg+xml;base64,${b64}`;
}

function makeDiagram(id, caption, svg, mermaid, warnings) {
  const unsafe = scanSVGSecurity(svg);
  if (unsafe.length) {
    warnings.push(`Diagramme ${id} rejeté par le contrôle de sécurité : ${unsafe.join(', ')}`);
    return null;
  }
  return { kind: 'image', id, src: svgDataUrl(svg), caption, sources: mermaid ? { mermaid } : {} };
}

async function executeDiagramAgentsReal(input, facts, options = {}) {
  const call = makeCaller(options);
  const fr = (input.tender?.language || 'fr') === 'fr';
  const isSoftware = facts.projectType === 'software' || facts.projectType === 'saas';
  const theme = input.theme || {};
  const warnings = [];
  const data = { tender: input.tender, ready_facts: {
    project_type: facts.projectType, technologies: facts.technologies,
    avg_similar_project_months: facts.avgDurationMonths, team_profiles: facts.teamProfiles } };

  const archSystem = buildSystemPrompt(AGENT2_PROMPT);
  const archUser = `Describe the architecture for this tender.\n${wrapTenderData(data)}`;
  const arch = await runAgentLoop({
    call, maxAttempts: options.maxAttempts || 3, initialViolations: options.feedback,
    build: (v) => ({ system: archSystem, user: withFeedback(archUser, v), temperature: 0.2, maxTokens: 2000 }),
    validate: (json) => {
      const v = validateDiagramStructure(json.architecture || {}, 'architecture');
      const ids = new Set((json.architecture?.nodes || []).map(n => n.id));
      (json.architecture?.edges || []).forEach((e, i) => {
        if (!ids.has(e.from) || !ids.has(e.to)) v.push(`architecture.edges[${i}] refers to an unknown node id`);
      });
      return v;
    }
  });

  const planSystem = buildSystemPrompt(AGENT3_PROMPT);
  const planUser = `Propose the plan and risks for this tender.\n${wrapTenderData(data)}`;
  const plan = await runAgentLoop({
    call, maxAttempts: options.maxAttempts || 3, initialViolations: options.feedback,
    build: (v) => ({ system: planSystem, user: withFeedback(planUser, v), temperature: 0.2, maxTokens: 1500 }),
    validate: (json) => validatePlanOutput(json, facts)
  });

  // Architecture (always drawn: from the LLM structure, or a placeholder diagram)
  const archStruct = arch.ok ? arch.json.architecture : { nodes: [], edges: [] };
  if (!arch.ok) warnings.push(`Architecture : ${arch.error || arch.violations.slice(0, 3).join('; ')} (diagramme à compléter)`);
  const diagrams = [];
  const archD = makeDiagram('architecture', fr ? 'Architecture technique' : 'Technical architecture',
    renderArchitecture(archStruct, theme), generateArchitectureMermaid(archStruct), warnings);
  if (archD) diagrams.push(archD);

  // Plan: weeks summed by code; invalid plan gives a single placeholder phase
  let phases = plan.ok ? plan.json.plan.map(p => ({
    phase: String(p.phase), weeks: p.weeks,
    roles: p.roles.map(r => ({ role: String(r.role).toLowerCase(), people: r.people }))
  })) : [];
  if (!plan.ok) {
    warnings.push(`Planning : ${plan.error || plan.violations.slice(0, 3).join('; ')} (plan à compléter)`);
    phases = [{ phase: '[TO FILL: phases du projet]', weeks: Math.max(1, facts.avgDurationMonths * 4), roles: [] }];
  }
  const totalWeeks = phases.reduce((sum, p) => sum + p.weeks, 0);
  const refWeeks = facts.avgDurationMonths * 4;
  if (plan.ok && refWeeks && Math.abs(totalWeeks - refWeeks) / refWeeks > 0.5) {
    warnings.push(`Durée totale ${totalWeeks} semaines, très différente des projets similaires (environ ${refWeeks} semaines)`);
  }
  const roadD = makeDiagram('roadmap', fr ? 'Plan de mise en oeuvre' : 'Implementation plan',
    renderRoadmap({ phases }, theme), generateRoadmapMermaid({ phases }), warnings);
  if (roadD) diagrams.push(roadD);

  const envelope = {
    agent: 'diagrams',
    ok: arch.ok && plan.ok,
    diagrams,
    data: {
      components: arch.ok ? (arch.json.components || []).filter(c => typeof c === 'string').slice(0, 6) : [],
      plan: phases,
      totalWeeks,
      risks: plan.ok ? (plan.json.risks || []).slice(0, 5) : [],
      readyFacts: facts
    },
    assumptions: [...(arch.json?.assumptions || []), ...(plan.json?.assumptions || [])].filter(a => typeof a === 'string'),
    warnings,
    usage: {
      model: arch.model || plan.model,
      promptTokens: arch.usage.promptTokens + plan.usage.promptTokens,
      completionTokens: arch.usage.completionTokens + plan.usage.completionTokens,
      ms: arch.ms + plan.ms, attempts: arch.attempts + plan.attempts,
      rateLimitWaits: arch.rateLimitWaits + plan.rateLimitWaits
    }
  };
  // Slides s3b, s3c, s5, s10 built by the adapter (required lazily to keep the lib order free)
  const adapted = require('./diagrams_adapter.js').adaptDiagramsToSlides(envelope, input);
  envelope.slides = adapted.slides;
  envelope.warnings.push(...adapted.warnings);
  return envelope;
}

// Export for CommonJS (n8n Code nodes) and ES modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    generateArchitectureMermaid,
    generateRoadmapMermaid,
    generateClassMermaid,
    validateDiagramStructure,
    buildDiagramFacts,
    executeDiagramAgents,
    executeDiagramAgentsReal,
    validatePlanOutput
  };
}
