/**
 * registry.js - Registry management for regenerate functionality
 * 
 * Stores deck metadata and slide mappings for regeneration
 */

const fs = require('fs');
const path = require('path');

// Registry directory
// Registry folder: setRegistryDir() (n8n passes $env.AGENTS_REGISTRY_DIR, because process.env is
// not visible inside n8n task runners), else the AGENTS_REGISTRY_DIR env var, else agents/registry.
const REGISTRY_DIR = (typeof process !== 'undefined' && process.env && process.env.AGENTS_REGISTRY_DIR)
  || path.join(__dirname, '../registry');
let currentDir = REGISTRY_DIR;

function setRegistryDir(dir) {
  if (dir) currentDir = dir;
}

/** The registry folder, created on first use. */
function registryDir() {
  if (!fs.existsSync(currentDir)) fs.mkdirSync(currentDir, { recursive: true });
  return currentDir;
}

/**
 * Builds projectSlideMap from platform response
 * 
 * @param {Array} platformSlides - Slides from GET /api/decks/<id>
 * @param {Array} specSlides - Original spec slides (with id)
 * @returns {Array} - [{ index, id, part, of }]
 */
function buildProjectSlideMap(platformSlides, specSlides) {
  const map = [];
  
  // Create a lookup of spec slide titles
  const specTitles = {};
  specSlides.forEach(slide => {
    // Use first 25 chars as matching key
    const key = slide.title.substring(0, 25).toLowerCase().trim();
    specTitles[key] = slide.id;
  });
  
  // Walk through platform slides
  platformSlides.forEach((platformSlide, index) => {
    const label = platformSlide.label || '';
    
    // Check if it's a continuation slide (ends with "(k/n)")
    const continuationMatch = label.match(/^(.+?)\s*\((\d+)\/(\d+)\)$/);
    
    if (continuationMatch) {
      const baseLabel = continuationMatch[1].trim();
      const part = parseInt(continuationMatch[2], 10);
      const of = parseInt(continuationMatch[3], 10);
      
      const key = baseLabel.substring(0, 25).toLowerCase().trim();
      const specId = specTitles[key];
      
      if (specId) {
        map.push({ index, id: specId, part, of });
      } else {
        map.push({ index, id: 'unknown', part, of });
      }
    } else {
      // Regular slide
      const key = label.substring(0, 25).toLowerCase().trim();
      const specId = specTitles[key];
      
      if (specId) {
        map.push({ index, id: specId, part: 1, of: 1 });
      } else {
        // Could be title slide (index 0) or thank-you slide (last)
        // But only if we have a reasonable deck structure
        if (index === 0 && platformSlides.length > 2) {
          map.push({ index, id: 'title', part: 1, of: 1 });
        } else if (index === platformSlides.length - 1 && platformSlides.length > 2) {
          map.push({ index, id: 'thankyou', part: 1, of: 1 });
        } else {
          map.push({ index, id: 'unknown', part: 1, of: 1 });
        }
      }
    }
  });
  
  return map;
}

/**
 * Stores a deck in the registry
 * 
 * @param {Object} entry - Registry entry
 */
function storeDeck(entry) {
  const filename = path.join(registryDir(), `${entry.deckId}.json`);
  fs.writeFileSync(filename, JSON.stringify(entry, null, 2), 'utf8');
}

/**
 * Retrieves a deck from the registry
 * 
 * @param {string} deckId
 * @returns {Object|null}
 */
function getDeck(deckId) {
  const filename = path.join(registryDir(), `${deckId}.json`);
  
  if (!fs.existsSync(filename)) {
    return null;
  }
  
  try {
    const content = fs.readFileSync(filename, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    console.error(`Failed to read registry entry ${deckId}:`, error.message);
    return null;
  }
}

/**
 * Lists all deck IDs in the registry
 * 
 * @returns {Array} - Array of deckId strings
 */
function listDecks() {
  if (!fs.existsSync(currentDir)) {
    return [];
  }
  
  const files = fs.readdirSync(registryDir());
  return files
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace('.json', ''));
}

/**
 * Purges old decks (keeps last N)
 * 
 * @param {number} keepLast - Number of decks to keep (default 200)
 */
function purgeOldDecks(keepLast = 200) {
  const decks = listDecks();
  
  if (decks.length <= keepLast) {
    return 0;
  }
  
  // Get deck metadata (createdAt)
  const deckMeta = decks.map(deckId => {
    const entry = getDeck(deckId);
    return {
      deckId,
      createdAt: entry?.createdAt || 0
    };
  });
  
  // Sort by createdAt descending
  deckMeta.sort((a, b) => b.createdAt - a.createdAt);
  
  // Delete oldest ones
  const toDelete = deckMeta.slice(keepLast);
  let deleted = 0;
  
  toDelete.forEach(deck => {
    const filename = path.join(registryDir(), `${deck.deckId}.json`);
    try {
      fs.unlinkSync(filename);
      deleted++;
    } catch (error) {
      console.error(`Failed to delete ${deck.deckId}:`, error.message);
    }
  });
  
  return deleted;
}

/**
 * Maps project slide index to spec slide id
 * 
 * @param {string} deckId
 * @param {number} slideIndex - Project slide index (0-based)
 * @returns {Object|null} - { specSlideId, part, of, slide } or null if not found
 */
function mapSlideIndexToSpec(deckId, slideIndex) {
  const entry = getDeck(deckId);
  
  if (!entry) {
    return null;
  }
  
  const mapping = entry.projectSlideMap?.find(m => m.index === slideIndex);
  
  if (!mapping) {
    return null;
  }
  
  // Find the original spec slide
  const specSlide = entry.specSlides?.find(s => s.id === mapping.id);
  
  return {
    specSlideId: mapping.id,
    part: mapping.part,
    of: mapping.of,
    slide: specSlide
  };
}

/**
 * Gets the responsible agent for a spec slide id
 * 
 * @param {string} specSlideId
 * @returns {string} - Agent name
 */
function getResponsibleAgent(specSlideId) {
  const agentMap = {
    's1': 'agent1',
    's2': 'agent1',
    's3': 'agent1',
    's11': 'agent1',
    's4': 'agent5',
    's6': 'agent5',
    's7': 'agent5',
    's8': 'agent5',
    's3b': 'diagrams',
    's3c': 'diagrams',
    's5': 'diagrams',
    's10': 'diagrams',
    's9': 'agent4'
  };
  
  return agentMap[specSlideId] || 'unknown';
}

// Export for CommonJS (n8n Code nodes) and ES modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    buildProjectSlideMap,
    storeDeck,
    getDeck,
    listDecks,
    purgeOldDecks,
    mapSlideIndexToSpec,
    getResponsibleAgent,
    REGISTRY_DIR,
    setRegistryDir,
    registryDir
  };
}
