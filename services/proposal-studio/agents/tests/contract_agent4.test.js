/**
 * contract_agent4.test.js - Contract test for Agent 4 (Budget)
 * 
 * Any implementation must pass this test.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// Load all fixtures
const fixturesDir = path.join(__dirname, '../fixtures/agent4');
const fixtures = {};

['software', 'non_software', 'thin', 'injection', 'many_projects'].forEach(name => {
  const filePath = path.join(fixturesDir, `${name}.json`);
  if (fs.existsSync(filePath)) {
    fixtures[name] = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  }
});

/**
 * Validates Agent 4 output against the contract
 */
function validateAgent4Contract(output) {
  const errors = [];
  
  // Envelope shape
  if (!output || typeof output !== 'object') {
    errors.push('Output must be an object');
    return errors;
  }
  
  if (output.agent !== 'budget') {
    errors.push(`agent must be "budget", got "${output.agent}"`);
  }
  
  if (typeof output.ok !== 'boolean') {
    errors.push('ok must be a boolean');
  }
  
  if (!Array.isArray(output.slides)) {
    errors.push('slides must be an array');
    return errors;
  }
  
  // Must have exactly 1 slide (s9)
  if (output.slides.length !== 1) {
    errors.push(`Must have exactly 1 slide (s9), got ${output.slides.length}`);
  }
  
  const slide = output.slides[0];
  
  if (!slide) {
    errors.push('Missing slide s9');
    return errors;
  }
  
  // Validate s9
  if (slide.id !== 's9') {
    errors.push(`Slide id must be "s9", got "${slide.id}"`);
  }
  
  if (slide.type !== 'content') {
    errors.push(`Slide type must be "content", got "${slide.type}"`);
  }
  
  if (!slide.title || typeof slide.title !== 'string') {
    errors.push('Slide must have a title');
  }
  
  if (!Array.isArray(slide.blocks) || slide.blocks.length === 0) {
    errors.push('Slide must have blocks');
  }
  
  // Must have requiresApproval: true
  if (slide.requiresApproval !== true) {
    errors.push('Slide must have requiresApproval: true');
  }
  
  // Must have catalogDate
  if (!slide.catalogDate || typeof slide.catalogDate !== 'string') {
    errors.push('Slide must have catalogDate');
  }
  
  // Must have assumptions array
  if (!Array.isArray(slide.assumptions)) {
    errors.push('Slide must have assumptions array');
  }
  
  // Check blocks
  let hasTable = false;
  let hasNote = false;
  
  slide.blocks?.forEach((block, idx) => {
    if (!block.kind) {
      errors.push(`blocks[${idx}]: missing kind`);
    }
    
    if (block.kind === 'table') {
      hasTable = true;
      
      if (!Array.isArray(block.columns)) {
        errors.push(`blocks[${idx}]: table must have columns array`);
      }
      
      if (!Array.isArray(block.rows)) {
        errors.push(`blocks[${idx}]: table must have rows array`);
      }
      
      // Check all cells are strings
      block.rows?.forEach((row, rIdx) => {
        if (!Array.isArray(row)) {
          errors.push(`blocks[${idx}].rows[${rIdx}]: must be an array`);
        } else {
          row.forEach((cell, cIdx) => {
            if (typeof cell !== 'string') {
              errors.push(`blocks[${idx}].rows[${rIdx}][${cIdx}]: must be a string`);
            }
          });
        }
      });
    }
    
    if (block.kind === 'note') {
      hasNote = true;
    }
  });
  
  if (!hasTable) {
    errors.push('Slide must have a table block');
  }
  
  if (!hasNote) {
    errors.push('Slide must have a note block');
  }
  
  // Validate data
  if (!output.data || typeof output.data !== 'object') {
    errors.push('data must be an object');
  } else {
    if (!Array.isArray(output.data.people)) {
      errors.push('data.people must be an array');
    } else {
      const validRoles = ['backend', 'frontend', 'devops', 'pm', 'designer', 'qa'];
      output.data.people.forEach((p, idx) => {
        const role = p.role?.toLowerCase();
        if (!validRoles.includes(role)) {
          errors.push(`data.people[${idx}].role "${p.role}" invalid`);
        }
        if (!Number.isInteger(p.days) || p.days < 1) {
          errors.push(`data.people[${idx}].days must be positive integer`);
        }
      });
    }
    
    if (!Array.isArray(output.data.infrastructure)) {
      errors.push('data.infrastructure must be an array');
    }
    
    if (!Array.isArray(output.data.api_usage)) {
      errors.push('data.api_usage must be an array');
    }
    
    if (!Array.isArray(output.data.licenses)) {
      errors.push('data.licenses must be an array');
    }
  }
  
  // Validate warnings
  if (!Array.isArray(output.warnings)) {
    errors.push('warnings must be an array');
  }
  
  // Validate usage
  if (!output.usage || typeof output.usage !== 'object') {
    errors.push('usage must be an object');
  }
  
  return errors;
}

describe('Agent 4 Contract Test', () => {
  test('software fixture must pass contract', () => {
    const output = fixtures.software;
    const errors = validateAgent4Contract(output);
    
    if (errors.length > 0) {
      assert.fail(`software fixture failed contract:\n${errors.join('\n')}`);
    }
    
    assert.ok(true);
  });
  
  test('non_software fixture must pass contract', () => {
    const output = fixtures.non_software;
    const errors = validateAgent4Contract(output);
    
    if (errors.length > 0) {
      assert.fail(`non_software fixture failed contract:\n${errors.join('\n')}`);
    }
    
    assert.ok(true);
  });
  
  test('thin fixture must pass contract', () => {
    const output = fixtures.thin;
    const errors = validateAgent4Contract(output);
    
    if (errors.length > 0) {
      assert.fail(`thin fixture failed contract:\n${errors.join('\n')}`);
    }
    
    assert.ok(true);
  });
  
  test('injection fixture must pass contract', () => {
    const output = fixtures.injection;
    const errors = validateAgent4Contract(output);
    
    if (errors.length > 0) {
      assert.fail(`injection fixture failed contract:\n${errors.join('\n')}`);
    }
    
    assert.ok(true);
  });
  
  test('many_projects fixture must pass contract', () => {
    const output = fixtures.many_projects;
    const errors = validateAgent4Contract(output);
    
    if (errors.length > 0) {
      assert.fail(`many_projects fixture failed contract:\n${errors.join('\n')}`);
    }
    
    assert.ok(true);
  });
  
  test('s9 must have requiresApproval: true', () => {
    Object.entries(fixtures).forEach(([name, output]) => {
      const slide = output.slides[0];
      assert.strictEqual(slide.requiresApproval, true, `${name}: s9 must have requiresApproval: true`);
    });
  });
  
  test('s9 must have catalogDate', () => {
    Object.entries(fixtures).forEach(([name, output]) => {
      const slide = output.slides[0];
      assert.ok(slide.catalogDate, `${name}: s9 must have catalogDate`);
    });
  });
  
  test('s9 must have assumptions', () => {
    Object.entries(fixtures).forEach(([name, output]) => {
      const slide = output.slides[0];
      assert.ok(Array.isArray(slide.assumptions), `${name}: s9 must have assumptions array`);
      assert.ok(slide.assumptions.length > 0, `${name}: assumptions must not be empty`);
    });
  });
  
  test('all people roles must be valid', () => {
    const validRoles = ['backend', 'frontend', 'devops', 'pm', 'designer', 'qa'];
    
    Object.entries(fixtures).forEach(([name, output]) => {
      output.data.people.forEach((p, idx) => {
        const role = p.role?.toLowerCase();
        assert.ok(
          validRoles.includes(role),
          `${name}: data.people[${idx}].role "${p.role}" must be one of: ${validRoles.join(', ')}`
        );
      });
    });
  });
  
  test('all people days must be positive integers', () => {
    Object.entries(fixtures).forEach(([name, output]) => {
      output.data.people.forEach((p, idx) => {
        assert.ok(
          Number.isInteger(p.days) && p.days > 0,
          `${name}: data.people[${idx}].days must be positive integer, got ${p.days}`
        );
      });
    });
  });
});

// Export validator for reuse
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { validateAgent4Contract };
}
