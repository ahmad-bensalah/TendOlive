/**
 * rank.js - Reference project ranking for Agent 5
 * 
 * Ranks similar_projects by relevance to tender requirements.
 * Score components: keyword overlap + recency + project type match
 */

/**
 * Extracts keywords from text for matching
 * @param {string} text - Text to extract keywords from
 * @returns {Set<string>} - Lowercase keywords
 */
function extractKeywords(text) {
  if (!text || typeof text !== 'string') return new Set();
  
  // Remove common words and punctuation, split on whitespace
  const stopWords = new Set([
    'le', 'la', 'les', 'un', 'une', 'des', 'de', 'du', 'et', 'ou', 'pour',
    'dans', 'avec', 'sans', 'sur', 'sous', 'par', 'en', 'à', 'au',
    'the', 'a', 'an', 'and', 'or', 'for', 'in', 'on', 'at', 'to', 'of', 'with'
  ]);
  
  const words = text
    .toLowerCase()
    .replace(/[^\w\sàâäéèêëïîôùûüÿæœç-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w));
  
  return new Set(words);
}

/**
 * Computes keyword overlap between two sets
 * @param {Set} setA - First keyword set
 * @param {Set} setB - Second keyword set
 * @returns {number} - Overlap score (0 to 1)
 */
function computeOverlap(setA, setB) {
  if (setA.size === 0 || setB.size === 0) return 0;
  
  const intersection = new Set([...setA].filter(x => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  
  return intersection.size / union.size; // Jaccard similarity
}

/**
 * Ranks a single project against tender requirements
 * @param {object} project - Project from match.similar_projects
 * @param {object} context - { requirements: string[], projectType: string, currentYear: number }
 * @returns {number} - Score (0 to 100)
 */
function rankProject(project, context) {
  const { requirements = [], projectType, currentYear = new Date().getFullYear() } = context;
  
  if (!project) return 0;
  
  let score = 0;
  
  // 1. Keyword overlap (max 50 points)
  const requirementsText = requirements.join(' ');
  const requirementKeywords = extractKeywords(requirementsText);
  
  const projectStack = (project.stack || []).join(' ');
  const projectText = `${project.name || ''} ${project.result || ''} ${projectStack}`;
  const projectKeywords = extractKeywords(projectText);
  
  const overlap = computeOverlap(requirementKeywords, projectKeywords);
  score += overlap * 50;
  
  // 2. Recency (max 30 points)
  // Projects from last 2 years get full points, older ones decay
  const projectYear = project.year || 0;
  const age = currentYear - projectYear;
  
  if (age <= 2) {
    score += 30;
  } else if (age <= 5) {
    score += 30 * (1 - (age - 2) / 3); // Linear decay over 3 years
  }
  // Older than 5 years: 0 points
  
  // 3. Project type match (max 20 points)
  if (projectType && project.project_type === projectType) {
    score += 20;
  } else if (projectType === 'software' || projectType === 'saas') {
    // Software/SaaS projects are similar
    if (project.project_type === 'software' || project.project_type === 'saas') {
      score += 15;
    }
  }
  
  return Math.round(score * 100) / 100; // Round to 2 decimals
}

/**
 * Ranks all projects and returns top N
 * @param {object[]} projects - Array of similar_projects
 * @param {object} context - Ranking context
 * @param {number} topN - Number of top projects to return (default 3)
 * @returns {object[]} - Ranked projects with scores
 */
function rankProjects(projects, context, topN = 3) {
  if (!Array.isArray(projects) || projects.length === 0) {
    return [];
  }
  
  // Score each project
  const scored = projects.map(project => ({
    ...project,
    _score: rankProject(project, context)
  }));
  
  // Sort by score descending
  scored.sort((a, b) => b._score - a._score);
  
  // Return top N (or fewer if not enough projects)
  const count = Math.min(topN, scored.length);
  return scored.slice(0, count);
}

/**
 * Selects reference projects for slide s7
 * @param {object} input - Normalized input
 * @returns {object[]} - Top 2-3 projects for reference cards
 */
function selectReferences(input) {
  const projects = input.match?.similar_projects || [];
  
  if (projects.length === 0) {
    return []; // Will become placeholder card
  }
  
  const context = {
    requirements: input.tender?.requirements || [],
    projectType: input.tender?.project_type,
    currentYear: new Date().getFullYear()
  };
  
  // Get top 3 (or top 2 if only 2 exist)
  const topN = Math.min(3, projects.length);
  return rankProjects(projects, context, topN);
}

// Export for CommonJS (n8n Code nodes) and ES modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    extractKeywords,
    computeOverlap,
    rankProject,
    rankProjects,
    selectReferences
  };
}
