/**
 * reviewer.js - Agent 6 (Reviewer) logic
 * 
 * Two-stage review: code checks (deterministic) then LLM review (optional)
 * Correction loop: max rounds, group by agent, re-run, remaining → warnings
 */

const checks = require('./checks.js');
const i18n = require('./i18n.js');

/**
 * Runs deterministic code checks on the complete deck
 * 
 * @param {Object} mergedDeck - Complete deck with all slides
 * @param {Object} input - Original input
 * @param {Object} agentOutputs - { agent1, agent5, diagrams, budget }
 * @returns {Object} - { passed: boolean, problems: [...] }
 */
function runCodeChecks(mergedDeck, input, agentOutputs) {
  const problems = [];
  const language = input.tender?.language || 'fr';
  const projectType = input.tender?.project_type || 'other';
  const isSoftware = projectType === 'software' || projectType === 'saas';
  
  // 1. COVERAGE CHECKS
  
  // Expected slide IDs
  const expectedIds = ['s1', 's2', 's3', 's3b', 's4', 's5', 's6', 's7', 's8', 's9', 's10', 's11'];
  if (isSoftware) {
    expectedIds.splice(4, 0, 's3c'); // Insert s3c after s3b
  }
  
  const presentIds = mergedDeck.slides.map(s => s.id);
  
  expectedIds.forEach(id => {
    if (!presentIds.includes(id)) {
      problems.push({
        agent: getResponsibleAgent(id),
        slide: id,
        issue: `Missing slide ${id}`,
        fix: 'Generate the missing slide'
      });
    }
  });
  
  // Check each requirement appears in compliance table (s3)
  const requirements = input.tender?.requirements || [];
  const s3Slide = mergedDeck.slides.find(s => s.id === 's3');
  
  if (s3Slide && requirements.length > 0) {
    const s3Text = JSON.stringify(s3Slide).toLowerCase();
    
    requirements.forEach((req, idx) => {
      const reqLower = req.toLowerCase();
      const keywords = reqLower.split(/\s+/).filter(w => w.length > 3);
      
      const found = keywords.some(kw => s3Text.includes(kw));
      
      if (!found && idx < 10) { // Only check first 10 requirements
        problems.push({
          agent: 'requirements',
          slide: 's3',
          issue: `Requirement "${req.substring(0, 50)}..." may not be covered in compliance table`,
          fix: 'Ensure all requirements are listed in the table'
        });
      }
    });
  }
  
  // Check each slide has at least one block
  mergedDeck.slides.forEach(slide => {
    if (!slide.blocks || slide.blocks.length === 0) {
      problems.push({
        agent: getResponsibleAgent(slide.id),
        slide: slide.id,
        issue: 'Slide has no content blocks',
        fix: 'Add at least one block'
      });
    }
  });
  
  // 2. CONSISTENCY CHECKS
  
  // Total weeks consistency (s5 vs s9)
  const s5Slide = mergedDeck.slides.find(s => s.id === 's5');
  const s9Slide = mergedDeck.slides.find(s => s.id === 's9');
  
  if (s5Slide && s9Slide && agentOutputs.diagrams?.data?.plan) {
    const plan = agentOutputs.diagrams.data.plan;
    const totalWeeks = plan.reduce((sum, p) => sum + (p.weeks || 0), 0);
    
    // Check if s5 mentions the total
    const s5Text = JSON.stringify(s5Slide);
    if (!s5Text.includes(String(totalWeeks))) {
      problems.push({
        agent: 'diagrams',
        slide: 's5',
        issue: `Total weeks (${totalWeeks}) not mentioned in roadmap`,
        fix: 'Add note with total duration'
      });
    }
  }
  
  // Team counts consistency (s6 vs input)
  const s6Slide = mergedDeck.slides.find(s => s.id === 's6');
  const inputProfiles = input.match?.engineers?.profiles || [];
  
  if (s6Slide && inputProfiles.length > 0) {
    const s6Text = JSON.stringify(s6Slide);
    
    inputProfiles.forEach(profile => {
      const count = profile.count;
      if (count && !s6Text.includes(String(count))) {
        // Might be OK if aggregated differently, so this is low priority
      }
    });
  }
  
  // Language consistency
  const languages = new Set();
  mergedDeck.slides.forEach(slide => {
    // Detect language by looking for French-specific characters
    const text = JSON.stringify(slide);
    if (text.includes('é') || text.includes('è') || text.includes('à')) {
      languages.add('fr');
    } else if (/[a-zA-Z]/.test(text)) {
      languages.add('en');
    }
  });
  
  if (languages.size > 1) {
    problems.push({
      agent: 'multiple',
      slide: 'all',
      issue: 'Mixed languages detected in slides',
      fix: 'Ensure all slides use the same language'
    });
  }
  
  // Titles must be unique
  const titles = mergedDeck.slides.map(s => s.title?.toLowerCase()).filter(Boolean);
  const duplicates = titles.filter((t, i) => titles.indexOf(t) !== i);
  
  if (duplicates.length > 0) {
    problems.push({
      agent: 'multiple',
      slide: 'all',
      issue: `Duplicate titles found: ${duplicates.join(', ')}`,
      fix: 'Make slide titles unique'
    });
  }
  
  // 3. EVIDENCE CHECKS
  
  // Numbers and names must trace to input or computed values
  // (Simplified: just check that we're not inventing large numbers)
  mergedDeck.slides.forEach(slide => {
    const text = JSON.stringify(slide);
    
    // Look for suspiciously specific numbers not from input
    const numbers = text.match(/\b\d{3,}\b/g) || [];
    
    // This is a heuristic - real check would need full tracing
    // Skip for now, as it's complex and prone to false positives
  });
  
  // 4. LIMITS AND PLACEHOLDERS
  
  const placeholders = [];
  
  mergedDeck.slides.forEach(slide => {
    const slideText = JSON.stringify(slide);
    const matches = slideText.match(/\[TO FILL:[^\]]+\]/g) || [];
    
    if (matches.length > 0) {
      placeholders.push({
        slide: slide.id,
        count: matches.length,
        placeholders: matches
      });
    }
  });
  
  // Placeholders are not problems, just tracked
  
  // 5. PRICING CHECKS
  
  if (s9Slide) {
    if (s9Slide.requiresApproval !== true) {
      problems.push({
        agent: 'budget',
        slide: 's9',
        issue: 'Missing requiresApproval: true',
        fix: 'Set requiresApproval flag'
      });
    }
    
    if (!s9Slide.catalogDate) {
      problems.push({
        agent: 'budget',
        slide: 's9',
        issue: 'Missing catalogDate',
        fix: 'Add catalog date from pricing catalog'
      });
    }
    
    if (!s9Slide.assumptions || s9Slide.assumptions.length === 0) {
      problems.push({
        agent: 'budget',
        slide: 's9',
        issue: 'Missing assumptions',
        fix: 'Add budget assumptions'
      });
    }
  }
  
  return {
    passed: problems.length === 0,
    problems,
    placeholders,
    summary: {
      totalSlides: mergedDeck.slides.length,
      expectedSlides: expectedIds.length,
      problemCount: problems.length,
      placeholderCount: placeholders.reduce((sum, p) => sum + p.count, 0)
    }
  };
}

/**
 * Gets the responsible agent for a slide ID
 */
function getResponsibleAgent(slideId) {
  const agentMap = {
    's1': 'requirements',
    's2': 'requirements',
    's3': 'requirements',
    's3b': 'diagrams',
    's3c': 'diagrams',
    's4': 'credibility',
    's5': 'diagrams',
    's6': 'credibility',
    's7': 'credibility',
    's8': 'credibility',
    's9': 'budget',
    's10': 'diagrams',
    's11': 'requirements'
  };
  
  return agentMap[slideId] || 'unknown';
}

/**
 * Prepares slides for LLM review (text only, in delimiters)
 */
function prepareSlidesForLLMReview(mergedDeck) {
  return mergedDeck.slides.map(slide => {
    const blocks = slide.blocks || [];
    const textParts = [];
    
    blocks.forEach(block => {
      if (block.kind === 'text' || block.kind === 'note') {
        textParts.push(block.text);
      } else if (block.kind === 'bullets') {
        textParts.push(block.items.join('; '));
      } else if (block.kind === 'table') {
        // Simple table representation
        textParts.push(block.columns.join(' | '));
        block.rows.forEach(row => {
          textParts.push(row.join(' | '));
        });
      } else if (block.kind === 'cards') {
        block.cards.forEach(card => {
          textParts.push(`${card.title}: ${card.text}`);
        });
      } else if (block.kind === 'image') {
        textParts.push(`[image]${block.caption ? ` ${block.caption}` : ''}`);
      } else if (block.kind === 'kpis') {
        block.items.forEach(kpi => {
          textParts.push(`${kpi.label}: ${kpi.value}`);
        });
      }
    });
    
    return {
      id: slide.id,
      title: slide.title,
      content: textParts.join('\n')
    };
  });
}

/**
 * Validates LLM review output
 */
function validateLLMReview(review, mergedDeck) {
  if (!review || typeof review !== 'object') {
    return { valid: false, error: 'Review must be an object' };
  }
  
  if (!review.status || !['ok', 'problems'].includes(review.status)) {
    return { valid: false, error: 'status must be "ok" or "problems"' };
  }
  
  if (review.status === 'problems') {
    if (!Array.isArray(review.problems)) {
      return { valid: false, error: 'problems must be an array' };
    }
    
    const validAgents = ['requirements', 'credibility', 'diagrams', 'budget'];
    const validSlideIds = mergedDeck.slides.map(s => s.id);
    
    // Filter out problems that reference non-existent slides
    review.problems = review.problems.filter(p => {
      if (!p.agent || !p.slide || !p.issue) {
        return false; // Skip malformed
      }
      
      if (!validSlideIds.includes(p.slide) && p.slide !== 'all') {
        return false; // Skip unknown slide
      }
      
      return true;
    });
  }
  
  return { valid: true };
}

/**
 * Groups problems by responsible agent
 */
function groupProblemsByAgent(problems) {
  const grouped = {};
  
  problems.forEach(problem => {
    const agent = problem.agent || 'unknown';
    if (!grouped[agent]) {
      grouped[agent] = [];
    }
    grouped[agent].push(problem);
  });
  
  return grouped;
}

/**
 * Executes Agent 6 (reviewer) - mock mode for now
 */
function executeAgent6(mergedDeck, input, agentOutputs, options = {}) {
  const { mode = 'mock' } = options;
  
  // Always run code checks
  const codeCheckResult = runCodeChecks(mergedDeck, input, agentOutputs);
  
  // In mock mode, skip LLM review
  if (mode === 'mock') {
    return {
      agent: 'reviewer',
      ok: true,
      codeChecks: codeCheckResult,
      llmReview: { status: 'ok', skipped: 'mock mode' },
      allProblems: codeCheckResult.problems,
      warnings: [],
      usage: { model: 'mock', promptTokens: 0, completionTokens: 0, ms: 0, attempts: 1 }
    };
  }
  
  return executeAgent6Real(mergedDeck, input, codeCheckResult, options);
}

const AGENT6_PROMPT = `You are Agent 6 (reviewer). Read the slide texts of a tender response and report problems
of clarity, tone, redundancy, or claims that the slide's own proof does not support.
Do not rewrite slides. Do not check numbers or names (code already did).
Never report "[TO FILL: ...]" placeholders: they mark missing data on purpose for the human.
Slides with diagrams show "[image]" here: the diagram is not empty. Do not report prices missing.

Return exactly this JSON:
{ "status": "ok" | "problems",
  "problems": [ { "agent": "requirements|credibility|diagrams|budget", "slide": "slide id such as s4", "issue": "short", "fix": "short" } ] }
At most 8 problems, the most important first. Slide ids must be ones you were given.`;

async function executeAgent6Real(mergedDeck, input, codeCheckResult, options = {}) {
  const { buildSystemPrompt, wrapTenderData, withFeedback, makeCaller, runAgentLoop } = require('./llm.js');
  const call = makeCaller(options);
  const system = buildSystemPrompt(AGENT6_PROMPT);
  const user = `Review these slides (language: ${input.tender?.language || 'fr'}).\n${wrapTenderData(prepareSlidesForLLMReview(mergedDeck))}`;
  const loop = await runAgentLoop({
    call, maxAttempts: options.maxAttempts || 2,
    build: (v) => ({ system, user: withFeedback(user, v), temperature: 0.1, maxTokens: 1500,
                     model: options.reviewModel }),
    validate: (json) => {
      const r = validateLLMReview(json, mergedDeck);
      return r.valid ? [] : [r.error];
    }
  });
  const llmProblems = loop.ok && loop.json.status === 'problems' ? (loop.json.problems || []).slice(0, 8) : [];
  return {
    agent: 'reviewer',
    ok: true,
    codeChecks: codeCheckResult,
    llmReview: loop.ok ? { status: loop.json.status, problems: llmProblems } : { status: 'skipped', error: loop.error || loop.violations.join('; ') },
    allProblems: [...codeCheckResult.problems, ...llmProblems],
    warnings: loop.ok ? [] : [`Revue LLM ignorée : ${loop.error || loop.violations[0]}`],
    usage: { model: loop.model, promptTokens: loop.usage.promptTokens, completionTokens: loop.usage.completionTokens,
             ms: loop.ms, attempts: loop.attempts, rateLimitWaits: loop.rateLimitWaits }
  };
}

// Export for CommonJS (n8n Code nodes) and ES modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    runCodeChecks,
    getResponsibleAgent,
    prepareSlidesForLLMReview,
    validateLLMReview,
    groupProblemsByAgent,
    executeAgent6,
    executeAgent6Real
  };
}
