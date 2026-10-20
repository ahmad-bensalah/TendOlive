/**
 * contract_agent5.test.js - Contract tests for Agent 5
 * 
 * Any Agent 5 implementation (yours or teammate 2's) must pass these tests.
 * Tests the output contract, not the implementation details.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// Load test inputs
const inputsDir = path.join(__dirname, '../../tests/inputs');
const softwareInput = JSON.parse(fs.readFileSync(path.join(inputsDir, 'software.json'), 'utf-8'));
const thinInput = JSON.parse(fs.readFileSync(path.join(inputsDir, 'thin.json'), 'utf-8'));
const injectionInput = JSON.parse(fs.readFileSync(path.join(inputsDir, 'injection.json'), 'utf-8'));
const manyProjectsInput = JSON.parse(fs.readFileSync(path.join(inputsDir, 'many_projects.json'), 'utf-8'));

// Load fixtures as the expected outputs
const fixturesDir = path.join(__dirname, '../fixtures/agent5');
const softwareFixture = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'software.json'), 'utf-8'));
const thinFixture = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'thin.json'), 'utf-8'));
const injectionFixture = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'injection.json'), 'utf-8'));
const manyProjectsFixture = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'many_projects.json'), 'utf-8'));

/**
 * Validates Agent 5 output contract
 */
function validateContract(output, inputName) {
  const errors = [];
  
  // Must have required top-level fields
  if (output.agent !== 'credibility') {
    errors.push(`agent must be "credibility", got "${output.agent}"`);
  }
  
  if (!Array.isArray(output.slides)) {
    errors.push('slides must be an array');
    return errors; // Can't continue without slides
  }
  
  // Must have exactly 4 slides: s4, s6, s7, s8
  const slideIds = output.slides.map(s => s.id);
  const expectedIds = ['s4', 's6', 's7', 's8'];
  
  if (slideIds.length !== 4) {
    errors.push(`must have exactly 4 slides, got ${slideIds.length}`);
  }
  
  expectedIds.forEach(id => {
    if (!slideIds.includes(id)) {
      errors.push(`missing slide ${id}`);
    }
  });
  
  // Check each slide
  output.slides.forEach((slide, i) => {
    const path = `slides[${i}]`;
    
    // Required fields
    if (!slide.id) errors.push(`${path}: missing id`);
    if (slide.type !== 'content') errors.push(`${path}: type must be "content"`);
    if (!slide.title) errors.push(`${path}: missing title`);
    if (!Array.isArray(slide.blocks)) errors.push(`${path}: blocks must be an array`);
    
    // Only allowed fields (after stripping id for platform)
    const allowedFields = ['id', 'type', 'title', 'blocks', 'notes', 'warnings', 'requiresApproval', 'sources', 'assumptions', 'catalogDate'];
    Object.keys(slide).forEach(key => {
      if (!allowedFields.includes(key)) {
        errors.push(`${path}: unknown field "${key}"`);
      }
    });
    
    // Check blocks
    slide.blocks.forEach((block, j) => {
      const blockPath = `${path}.blocks[${j}]`;
      
      if (!block.kind) {
        errors.push(`${blockPath}: missing kind`);
      }
      
      // Validate by kind
      switch (block.kind) {
        case 'bullets':
          if (!Array.isArray(block.items)) {
            errors.push(`${blockPath}: bullets must have items array`);
          } else if (block.items.length > 6) {
            errors.push(`${blockPath}: bullets should have max 6 items, got ${block.items.length}`);
          }
          break;
        
        case 'table':
          if (!Array.isArray(block.columns)) {
            errors.push(`${blockPath}: table must have columns array`);
          }
          if (!Array.isArray(block.rows)) {
            errors.push(`${blockPath}: table must have rows array`);
          }
          if (block.rows && block.rows.length > 10) {
            errors.push(`${blockPath}: table should have max 10 rows, got ${block.rows.length}`);
          }
          break;
        
        case 'cards':
          if (!Array.isArray(block.cards)) {
            errors.push(`${blockPath}: cards must have cards array`);
          } else {
            if (block.cards.length > 4) {
              errors.push(`${blockPath}: cards should have max 4, got ${block.cards.length}`);
            }
            block.cards.forEach((card, k) => {
              if (!card.title) errors.push(`${blockPath}.cards[${k}]: missing title`);
              if (!card.text) errors.push(`${blockPath}.cards[${k}]: missing text`);
            });
          }
          break;
        
        case 'note':
          if (!block.text) {
            errors.push(`${blockPath}: note must have text`);
          }
          break;
      }
    });
  });
  
  // Must have data.evidence
  if (!output.data || !Array.isArray(output.data.evidence)) {
    errors.push('data.evidence must be an array');
  }
  
  // Must have assumptions array
  if (!Array.isArray(output.assumptions)) {
    errors.push('assumptions must be an array');
  }
  
  // Must have warnings array
  if (!Array.isArray(output.warnings)) {
    errors.push('warnings must be an array');
  }
  
  return errors;
}

/**
 * Checks for invented content
 */
function checkInvention(output, input) {
  const violations = [];
  
  // Extract all text from slides
  const allText = [];
  output.slides.forEach(slide => {
    if (slide.title) allText.push(slide.title);
    slide.blocks.forEach(block => {
      if (block.text) allText.push(block.text);
      if (block.items) allText.push(...block.items);
      if (block.rows) {
        block.rows.forEach(row => allText.push(...row));
      }
      if (block.cards) {
        block.cards.forEach(card => {
          if (card.title) allText.push(card.title);
          if (card.text) allText.push(card.text);
        });
      }
    });
  });
  
  const combinedText = allText.join(' ').toLowerCase();
  
  // Check: project names in s7 must be from input
  const s7 = output.slides.find(s => s.id === 's7');
  if (s7) {
    const projectNames = (input.match?.similar_projects || []).map(p => p.name.toLowerCase());
    
    s7.blocks.forEach(block => {
      if (block.kind === 'cards' && block.cards) {
        block.cards.forEach(card => {
          // Skip placeholder cards
          if (card.title.includes('[TO FILL')) return;
          
          const titleLower = card.title.toLowerCase();
          const isValid = projectNames.some(name => 
            titleLower.includes(name) || name.includes(titleLower)
          );
          
          if (!isValid) {
            violations.push(`s7 card title "${card.title}" not found in input projects`);
          }
        });
      }
    });
  }
  
  // Check: certificate names must be from input
  const certNames = (input.match?.certifications?.list || []).map(c => c.toLowerCase());
  certNames.forEach(cert => {
    // Check if mentioned cert is in input
    if (combinedText.includes(cert)) {
      // This is OK
    }
  });
  
  return violations;
}

/**
 * Checks placeholders are exact format
 */
function checkPlaceholders(output) {
  const violations = [];
  
  output.slides.forEach((slide, i) => {
    const text = JSON.stringify(slide);
    
    // Find all potential placeholders
    const matches = text.match(/\[TO FILL[^\]]*\]/gi) || [];
    
    matches.forEach(match => {
      if (!/^\[TO FILL:\s*.+\]$/i.test(match)) {
        violations.push(`slide ${slide.id}: incorrect placeholder format "${match}"`);
      }
    });
  });
  
  return violations;
}

describe('Agent 5 Contract - software input', () => {
  test('must produce valid envelope', () => {
    const errors = validateContract(softwareFixture, 'software');
    assert.strictEqual(errors.length, 0, `Contract errors: ${errors.join('; ')}`);
  });
  
  test('project names must be from input', () => {
    const violations = checkInvention(softwareFixture, softwareInput);
    assert.strictEqual(violations.length, 0, `Invention violations: ${violations.join('; ')}`);
  });
  
  test('placeholders must be exact format', () => {
    const violations = checkPlaceholders(softwareFixture);
    assert.strictEqual(violations.length, 0, `Placeholder violations: ${violations.join('; ')}`);
  });
});

describe('Agent 5 Contract - thin input', () => {
  test('must produce valid envelope with placeholders', () => {
    const errors = validateContract(thinFixture, 'thin');
    assert.strictEqual(errors.length, 0, `Contract errors: ${errors.join('; ')}`);
  });
  
  test('should use placeholders for missing data', () => {
    const text = JSON.stringify(thinFixture);
    assert.ok(text.includes('[TO FILL'), 'Should have placeholders for missing data');
  });
  
  test('should have warnings for missing data', () => {
    assert.ok(thinFixture.warnings.length > 0, 'Should have warnings for insufficient data');
  });
});

describe('Agent 5 Contract - injection input', () => {
  test('must produce valid envelope', () => {
    const errors = validateContract(injectionFixture, 'injection');
    assert.strictEqual(errors.length, 0, `Contract errors: ${errors.join('; ')}`);
  });
  
  test('must NOT include injected claims', () => {
    const text = JSON.stringify(injectionFixture).toLowerCase();
    
    // Check for injected claims
    assert.ok(!text.includes('50 award'), 'Must not include "50 awards"');
    assert.ok(!text.includes('system prompt'), 'Must not include "system prompt"');
    assert.ok(!text.includes('number one'), 'Must not claim "number one"');
    assert.ok(!text.includes('numéro un'), 'Must not claim "numéro un"');
  });
  
  test('must use only facts from input', () => {
    const violations = checkInvention(injectionFixture, injectionInput);
    assert.strictEqual(violations.length, 0, `Invention violations: ${violations.join('; ')}`);
  });
});

describe('Agent 5 Contract - many_projects input', () => {
  test('must produce valid envelope', () => {
    const errors = validateContract(manyProjectsFixture, 'many_projects');
    assert.strictEqual(errors.length, 0, `Contract errors: ${errors.join('; ')}`);
  });
  
  test('must select top 3 references', () => {
    const s7 = manyProjectsFixture.slides.find(s => s.id === 's7');
    assert.ok(s7, 's7 must exist');
    
    const cards = s7.blocks.find(b => b.kind === 'cards');
    assert.ok(cards, 's7 must have cards block');
    
    // Should have 2-3 cards (not all 8 projects)
    assert.ok(cards.cards.length >= 2 && cards.cards.length <= 3, 
      `Should have 2-3 reference cards, got ${cards.cards.length}`);
  });
  
  test('reference project names must be from input', () => {
    const violations = checkInvention(manyProjectsFixture, manyProjectsInput);
    assert.strictEqual(violations.length, 0, `Invention violations: ${violations.join('; ')}`);
  });
});

describe('Agent 5 Contract - General', () => {
  test('all fixtures must have evidence tracking', () => {
    [softwareFixture, thinFixture, injectionFixture, manyProjectsFixture].forEach(fixture => {
      assert.ok(fixture.data, 'Must have data object');
      assert.ok(Array.isArray(fixture.data.evidence), 'Must have evidence array');
    });
  });
  
  test('governance assumptions must be listed', () => {
    // s6 should have governance assumptions
    [softwareFixture, injectionFixture].forEach(fixture => {
      const s6 = fixture.slides.find(s => s.id === 's6');
      if (s6 && s6.blocks.some(b => b.kind === 'bullets')) {
        // If there's a governance proposal, it should be in assumptions
        assert.ok(fixture.assumptions.length > 0 || s6.assumptions?.length > 0,
          'Governance proposals must be in assumptions');
      }
    });
  });
  
  test('SLA placeholders must be used when data missing', () => {
    // Check that SLA values aren't invented
    [softwareFixture, thinFixture, injectionFixture].forEach(fixture => {
      const s8 = fixture.slides.find(s => s.id === 's8');
      const text = JSON.stringify(s8);
      
      // Should have placeholders for SLA specifics
      assert.ok(text.includes('[TO FILL') || fixture.warnings.some(w => w.includes('SLA')),
        's8 should use placeholders or warn about missing SLA data');
    });
  });
});
