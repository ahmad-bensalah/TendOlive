/**
 * contract_diagrams.test.js - Contract test for diagram agents
 * 
 * Any implementation (ours or teammate's) must pass this test.
 * Tests the output contract, not the internal logic.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// Load all fixtures
const fixturesDir = path.join(__dirname, '../fixtures/diagrams');
const fixtures = {};

['software', 'non_software', 'thin', 'injection', 'many_projects'].forEach(name => {
  const filePath = path.join(fixturesDir, `${name}.json`);
  if (fs.existsSync(filePath)) {
    fixtures[name] = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  }
});

/**
 * Validates a diagram agent output against the contract
 */
function validateDiagramsContract(output, inputType = 'unknown') {
  const errors = [];
  
  // Envelope shape
  if (!output || typeof output !== 'object') {
    errors.push('Output must be an object');
    return errors;
  }
  
  if (output.agent !== 'diagrams') {
    errors.push(`agent must be "diagrams", got "${output.agent}"`);
  }
  
  if (typeof output.ok !== 'boolean') {
    errors.push('ok must be a boolean');
  }
  
  if (!Array.isArray(output.slides)) {
    errors.push('slides must be an array');
    return errors; // Can't continue
  }
  
  // Slide count by project type
  const isSoftware = inputType === 'software';
  const expectedSlides = isSoftware ? 4 : 3; // s3b, s3c (if software), s5, s10
  
  if (output.slides.length < expectedSlides - 1) {
    errors.push(`Expected at least ${expectedSlides - 1} slides for ${inputType}, got ${output.slides.length}`);
  }
  
  // Check slide IDs
  const slideIds = output.slides.map(s => s.id);
  
  if (!slideIds.includes('s3b')) {
    errors.push('Missing s3b (architecture)');
  }
  
  if (isSoftware && !slideIds.includes('s3c')) {
    errors.push('Missing s3c (class diagram) for software project');
  }
  
  if (!isSoftware && slideIds.includes('s3c')) {
    errors.push('s3c (class diagram) should not be present for non-software project');
  }
  
  if (!slideIds.includes('s5')) {
    errors.push('Missing s5 (roadmap)');
  }
  
  if (!slideIds.includes('s10')) {
    errors.push('Missing s10 (risks)');
  }
  
  // Validate each slide
  output.slides.forEach((slide, idx) => {
    if (!slide.id || typeof slide.id !== 'string') {
      errors.push(`slides[${idx}]: missing or invalid id`);
    }
    
    if (slide.type !== 'content') {
      errors.push(`slides[${idx}]: type must be "content", got "${slide.type}"`);
    }
    
    if (!slide.title || typeof slide.title !== 'string') {
      errors.push(`slides[${idx}]: missing or invalid title`);
    }
    
    if (!Array.isArray(slide.blocks) || slide.blocks.length === 0) {
      errors.push(`slides[${idx}]: blocks must be a non-empty array`);
    }
    
    // Check only allowed fields (after id stripping)
    const allowedFields = ['id', 'type', 'title', 'blocks', 'notes', 'warnings', 'requiresApproval', 'assumptions', 'catalogDate', 'sources'];
    Object.keys(slide).forEach(key => {
      if (!allowedFields.includes(key)) {
        errors.push(`slides[${idx}]: unknown field "${key}"`);
      }
    });
    
    // Validate blocks
    slide.blocks?.forEach((block, bIdx) => {
      if (!block.kind) {
        errors.push(`slides[${idx}].blocks[${bIdx}]: missing kind`);
      }
      
      const validKinds = ['text', 'note', 'bullets', 'table', 'image', 'cards', 'kpis'];
      if (!validKinds.includes(block.kind)) {
        errors.push(`slides[${idx}].blocks[${bIdx}]: invalid kind "${block.kind}"`);
      }
      
      // Validate image blocks
      if (block.kind === 'image') {
        if (!block.src) {
          errors.push(`slides[${idx}].blocks[${bIdx}]: image block missing src`);
        } else if (!block.src.startsWith('/uploads/') && !block.src.startsWith('data:image/')) {
          errors.push(`slides[${idx}].blocks[${bIdx}]: image src must start with /uploads/ or data:image/`);
        }
      }
      
      // Validate table blocks
      if (block.kind === 'table') {
        if (!Array.isArray(block.columns)) {
          errors.push(`slides[${idx}].blocks[${bIdx}]: table must have columns array`);
        }
        if (!Array.isArray(block.rows)) {
          errors.push(`slides[${idx}].blocks[${bIdx}]: table must have rows array`);
        }
        
        // All cells must be strings
        block.rows?.forEach((row, rIdx) => {
          if (!Array.isArray(row)) {
            errors.push(`slides[${idx}].blocks[${bIdx}].rows[${rIdx}]: must be an array`);
          } else {
            row.forEach((cell, cIdx) => {
              if (typeof cell !== 'string') {
                errors.push(`slides[${idx}].blocks[${bIdx}].rows[${rIdx}][${cIdx}]: must be a string, got ${typeof cell}`);
              }
            });
          }
        });
      }
    });
    
    // Validate sources
    if (slide.sources) {
      if (typeof slide.sources !== 'object') {
        errors.push(`slides[${idx}]: sources must be an object`);
      }
      
      if (slide.sources.mermaid !== undefined && typeof slide.sources.mermaid !== 'string') {
        errors.push(`slides[${idx}]: sources.mermaid must be a string`);
      }
      
      if (slide.sources.drawio !== undefined && typeof slide.sources.drawio !== 'string') {
        errors.push(`slides[${idx}]: sources.drawio must be a string`);
      }
    }
  });
  
  // Validate data
  if (!output.data || typeof output.data !== 'object') {
    errors.push('data must be an object');
  } else {
    if (!Array.isArray(output.data.components)) {
      errors.push('data.components must be an array');
    }
    
    if (!Array.isArray(output.data.plan)) {
      errors.push('data.plan must be an array');
    } else {
      output.data.plan.forEach((phase, idx) => {
        if (!Number.isInteger(phase.weeks) || phase.weeks < 1) {
          errors.push(`data.plan[${idx}].weeks must be a positive integer`);
        }
        
        if (!Array.isArray(phase.roles)) {
          errors.push(`data.plan[${idx}].roles must be an array`);
        } else {
          const validRoles = ['backend', 'frontend', 'devops', 'pm', 'designer', 'qa'];
          phase.roles.forEach((r, rIdx) => {
            const roleLower = r.role?.toLowerCase();
            if (!validRoles.includes(roleLower)) {
              errors.push(`data.plan[${idx}].roles[${rIdx}].role must be one of: ${validRoles.join(', ')}, got "${r.role}"`);
            }
          });
        }
      });
    }
    
    if (!Array.isArray(output.data.risks)) {
      errors.push('data.risks must be an array');
    } else {
      output.data.risks.forEach((risk, idx) => {
        if (!risk.risk) errors.push(`data.risks[${idx}]: missing risk description`);
        if (!risk.impact) errors.push(`data.risks[${idx}]: missing impact`);
        if (!risk.mitigation) errors.push(`data.risks[${idx}]: missing mitigation`);
      });
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

describe('Diagrams Contract Test', () => {
  test('software fixture must pass contract', () => {
    const output = fixtures.software;
    const errors = validateDiagramsContract(output, 'software');
    
    if (errors.length > 0) {
      assert.fail(`software fixture failed contract:\n${errors.join('\n')}`);
    }
    
    assert.ok(true);
  });
  
  test('non_software fixture must pass contract', () => {
    const output = fixtures.non_software;
    const errors = validateDiagramsContract(output, 'non_software');
    
    if (errors.length > 0) {
      assert.fail(`non_software fixture failed contract:\n${errors.join('\n')}`);
    }
    
    assert.ok(true);
  });
  
  test('thin fixture must pass contract', () => {
    const output = fixtures.thin;
    const errors = validateDiagramsContract(output, 'thin');
    
    if (errors.length > 0) {
      assert.fail(`thin fixture failed contract:\n${errors.join('\n')}`);
    }
    
    assert.ok(true);
  });
  
  test('injection fixture must pass contract', () => {
    const output = fixtures.injection;
    const errors = validateDiagramsContract(output, 'software'); // injection is software type
    
    if (errors.length > 0) {
      assert.fail(`injection fixture failed contract:\n${errors.join('\n')}`);
    }
    
    assert.ok(true);
  });
  
  test('many_projects fixture must pass contract', () => {
    const output = fixtures.many_projects;
    const errors = validateDiagramsContract(output, 'software'); // many_projects is software type
    
    if (errors.length > 0) {
      assert.fail(`many_projects fixture failed contract:\n${errors.join('\n')}`);
    }
    
    assert.ok(true);
  });
  
  test('software must have 4 slides (s3b, s3c, s5, s10)', () => {
    const output = fixtures.software;
    const slideIds = output.slides.map(s => s.id);
    
    assert.ok(slideIds.includes('s3b'), 'Missing s3b');
    assert.ok(slideIds.includes('s3c'), 'Missing s3c');
    assert.ok(slideIds.includes('s5'), 'Missing s5');
    assert.ok(slideIds.includes('s10'), 'Missing s10');
  });
  
  test('non_software must not have s3c', () => {
    const output = fixtures.non_software;
    const slideIds = output.slides.map(s => s.id);
    
    assert.ok(!slideIds.includes('s3c'), 's3c should not be present');
  });
  
  test('all image src must be valid paths', () => {
    Object.entries(fixtures).forEach(([name, output]) => {
      output.slides.forEach(slide => {
        slide.blocks.forEach(block => {
          if (block.kind === 'image' && block.src) {
            const valid = block.src.startsWith('/uploads/') || block.src.startsWith('data:image/');
            assert.ok(valid, `${name}: invalid image src "${block.src}"`);
          }
        });
      });
    });
  });
  
  test('plan weeks must be integers', () => {
    Object.entries(fixtures).forEach(([name, output]) => {
      output.data?.plan?.forEach((phase, idx) => {
        assert.ok(
          Number.isInteger(phase.weeks) && phase.weeks > 0,
          `${name}: data.plan[${idx}].weeks must be positive integer, got ${phase.weeks}`
        );
      });
    });
  });
  
  test('plan roles must be valid', () => {
    const validRoles = ['backend', 'frontend', 'devops', 'pm', 'designer', 'qa'];
    
    Object.entries(fixtures).forEach(([name, output]) => {
      output.data?.plan?.forEach((phase, idx) => {
        phase.roles?.forEach((r, rIdx) => {
          const roleLower = r.role?.toLowerCase();
          assert.ok(
            validRoles.includes(roleLower),
            `${name}: data.plan[${idx}].roles[${rIdx}].role "${r.role}" is invalid`
          );
        });
      });
    });
  });
});

// Export validator for reuse
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { validateDiagramsContract };
}
