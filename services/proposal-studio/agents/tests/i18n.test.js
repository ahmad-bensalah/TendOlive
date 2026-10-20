/**
 * i18n.test.js - Tests for internationalization
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { translate, getSlideTitles } = require('../lib/i18n.js');

describe('translate', () => {
  test('should translate French keys', () => {
    assert.strictEqual(translate('risk', 'fr'), 'Risque');
    assert.strictEqual(translate('impact_high', 'fr'), 'Élevé');
    assert.strictEqual(translate('role_backend', 'fr'), 'Backend');
  });
  
  test('should translate English keys', () => {
    assert.strictEqual(translate('risk', 'en'), 'Risk');
    assert.strictEqual(translate('impact_high', 'en'), 'High');
    assert.strictEqual(translate('role_pm', 'en'), 'Project Manager');
  });
  
  test('should fallback to English for unknown language', () => {
    const result = translate('risk', 'es');
    assert.strictEqual(result, 'Risk'); // English fallback
  });
  
  test('should return key for unknown translation', () => {
    const result = translate('unknown_key', 'fr');
    assert.strictEqual(result, 'unknown_key');
  });
});

describe('getSlideTitles', () => {
  test('should return all French slide titles', () => {
    const titles = getSlideTitles('fr');
    
    assert.ok(titles.s1.includes('Synthèse'));
    assert.ok(titles.s3b.includes('Architecture'));
    assert.ok(titles.s10.includes('Risques'));
  });
  
  test('should return all English slide titles', () => {
    const titles = getSlideTitles('en');
    
    assert.ok(titles.s1.includes('Executive'));
    assert.ok(titles.s3b.includes('Architecture'));
    assert.ok(titles.s10.includes('Risks'));
  });
  
  test('should have all required slide IDs', () => {
    const titles = getSlideTitles('fr');
    const requiredIds = ['s1', 's2', 's3', 's3b', 's3c', 's4', 's5', 's6', 's7', 's8', 's9', 's10', 's11'];
    
    requiredIds.forEach(id => {
      assert.ok(titles[id], `Missing translation for ${id}`);
    });
  });
});
