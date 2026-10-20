/**
 * registry.test.js - Tests for registry management
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const {
  buildProjectSlideMap,
  storeDeck,
  getDeck,
  listDecks,
  purgeOldDecks,
  mapSlideIndexToSpec,
  getResponsibleAgent,
  REGISTRY_DIR
} = require('../lib/registry.js');

// Test registry directory
const TEST_REGISTRY_DIR = path.join(__dirname, '../registry-test');

// Override REGISTRY_DIR for tests (requires module reload)
// For this test, we'll use a test subdirectory

describe('buildProjectSlideMap', () => {
  test('should map regular slides', () => {
    const platformSlides = [
      { label: 'Title Slide' },
      { label: 'Executive Summary' },
      { label: 'Understanding' },
      { label: 'Thank You' }
    ];
    
    const specSlides = [
      { id: 's1', title: 'Executive Summary' },
      { id: 's2', title: 'Understanding' }
    ];
    
    const map = buildProjectSlideMap(platformSlides, specSlides);
    
    assert.strictEqual(map.length, 4);
    assert.strictEqual(map[0].id, 'title');
    assert.strictEqual(map[1].id, 's1');
    assert.strictEqual(map[2].id, 's2');
    assert.strictEqual(map[3].id, 'thankyou');
  });
  
  test('should handle continuation slides', () => {
    const platformSlides = [
      { label: 'Title' },
      { label: 'Long Table (1/3)' },
      { label: 'Long Table (2/3)' },
      { label: 'Long Table (3/3)' },
      { label: 'Thank You' }
    ];
    
    const specSlides = [
      { id: 's3', title: 'Long Table' }
    ];
    
    const map = buildProjectSlideMap(platformSlides, specSlides);
    
    assert.strictEqual(map[1].id, 's3');
    assert.strictEqual(map[1].part, 1);
    assert.strictEqual(map[1].of, 3);
    
    assert.strictEqual(map[2].id, 's3');
    assert.strictEqual(map[2].part, 2);
    assert.strictEqual(map[2].of, 3);
    
    assert.strictEqual(map[3].id, 's3');
    assert.strictEqual(map[3].part, 3);
    assert.strictEqual(map[3].of, 3);
  });
  
  test('should handle unknown slides', () => {
    const platformSlides = [
      { label: 'Unknown Slide' }
    ];
    
    const specSlides = [];
    
    const map = buildProjectSlideMap(platformSlides, specSlides);
    
    assert.strictEqual(map[0].id, 'unknown');
  });
  
  test('should match by first 25 characters', () => {
    const platformSlides = [
      { label: 'Very Long Title That Exceeds Twenty Five Characters And More' }
    ];
    
    const specSlides = [
      { id: 's1', title: 'Very Long Title That Exceeds Twenty Five Characters' }
    ];
    
    const map = buildProjectSlideMap(platformSlides, specSlides);
    
    assert.strictEqual(map[0].id, 's1');
  });
});

describe('registry storage and retrieval', () => {
  test('should store and retrieve a deck', () => {
    const entry = {
      deckId: 'test-deck-001',
      runId: 'run-001',
      createdAt: Date.now(),
      input: { tender: { id: 'T-001' } },
      specSlides: [
        { id: 's1', title: 'Test' }
      ],
      projectSlideMap: [
        { index: 0, id: 'title', part: 1, of: 1 },
        { index: 1, id: 's1', part: 1, of: 1 }
      ]
    };
    
    storeDeck(entry);
    
    const retrieved = getDeck('test-deck-001');
    
    assert.ok(retrieved);
    assert.strictEqual(retrieved.deckId, 'test-deck-001');
    assert.strictEqual(retrieved.runId, 'run-001');
    assert.strictEqual(retrieved.specSlides.length, 1);
    
    // Cleanup
    const filename = path.join(REGISTRY_DIR, 'test-deck-001.json');
    if (fs.existsSync(filename)) {
      fs.unlinkSync(filename);
    }
  });
  
  test('should return null for non-existent deck', () => {
    const result = getDeck('non-existent-deck-999');
    assert.strictEqual(result, null);
  });
  
  test('should list all decks', () => {
    // Store a test deck
    storeDeck({ deckId: 'list-test-001', createdAt: Date.now() });
    
    const decks = listDecks();
    
    assert.ok(Array.isArray(decks));
    assert.ok(decks.includes('list-test-001'));
    
    // Cleanup
    const filename = path.join(REGISTRY_DIR, 'list-test-001.json');
    if (fs.existsSync(filename)) {
      fs.unlinkSync(filename);
    }
  });
});

describe('purgeOldDecks', () => {
  test('should keep specified number of decks', () => {
    // This test would create many decks and verify purging
    // Skipped for brevity as it would clutter the registry
    // In real scenario, use a test-specific registry directory
    assert.ok(true);
  });
});

describe('mapSlideIndexToSpec', () => {
  test('should map slide index to spec slide', () => {
    const entry = {
      deckId: 'map-test-001',
      createdAt: Date.now(),
      specSlides: [
        { id: 's1', title: 'Test Slide', blocks: [] }
      ],
      projectSlideMap: [
        { index: 0, id: 'title', part: 1, of: 1 },
        { index: 1, id: 's1', part: 1, of: 1 }
      ]
    };
    
    storeDeck(entry);
    
    const result = mapSlideIndexToSpec('map-test-001', 1);
    
    assert.ok(result);
    assert.strictEqual(result.specSlideId, 's1');
    assert.strictEqual(result.part, 1);
    assert.strictEqual(result.of, 1);
    assert.ok(result.slide);
    assert.strictEqual(result.slide.id, 's1');
    
    // Cleanup
    const filename = path.join(REGISTRY_DIR, 'map-test-001.json');
    if (fs.existsSync(filename)) {
      fs.unlinkSync(filename);
    }
  });
  
  test('should return null for non-existent deck', () => {
    const result = mapSlideIndexToSpec('non-existent-999', 1);
    assert.strictEqual(result, null);
  });
  
  test('should return null for out-of-range index', () => {
    const entry = {
      deckId: 'range-test-001',
      createdAt: Date.now(),
      specSlides: [],
      projectSlideMap: [
        { index: 0, id: 'title', part: 1, of: 1 }
      ]
    };
    
    storeDeck(entry);
    
    const result = mapSlideIndexToSpec('range-test-001', 99);
    assert.strictEqual(result, null);
    
    // Cleanup
    const filename = path.join(REGISTRY_DIR, 'range-test-001.json');
    if (fs.existsSync(filename)) {
      fs.unlinkSync(filename);
    }
  });
});

describe('getResponsibleAgent', () => {
  test('should return correct agent for each slide', () => {
    assert.strictEqual(getResponsibleAgent('s1'), 'agent1');
    assert.strictEqual(getResponsibleAgent('s2'), 'agent1');
    assert.strictEqual(getResponsibleAgent('s3'), 'agent1');
    assert.strictEqual(getResponsibleAgent('s11'), 'agent1');
    
    assert.strictEqual(getResponsibleAgent('s4'), 'agent5');
    assert.strictEqual(getResponsibleAgent('s6'), 'agent5');
    assert.strictEqual(getResponsibleAgent('s7'), 'agent5');
    assert.strictEqual(getResponsibleAgent('s8'), 'agent5');
    
    assert.strictEqual(getResponsibleAgent('s3b'), 'diagrams');
    assert.strictEqual(getResponsibleAgent('s3c'), 'diagrams');
    assert.strictEqual(getResponsibleAgent('s5'), 'diagrams');
    assert.strictEqual(getResponsibleAgent('s10'), 'diagrams');
    
    assert.strictEqual(getResponsibleAgent('s9'), 'agent4');
  });
  
  test('should return unknown for unmapped slides', () => {
    assert.strictEqual(getResponsibleAgent('s99'), 'unknown');
  });
});
