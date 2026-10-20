/** coverage.test.js - Requirements coverage score (code-computed). */
const test = require('node:test');
const assert = require('node:assert');
const { computeCoverage, applyCoverage } = require('../lib/coverage.js');
const { normalizeInput } = require('../lib/input.js');

const base = (reqs, match = {}, language = 'fr') => ({ tender: { requirements: reqs, language }, match });

test('RAG scores: thresholds 0.75 / 0.4 and the formula', () => {
  const input = base(['A', 'B', 'C', 'D'], { requirement_coverage: [
    { requirement: 'A', score: 1 }, { requirement: 'B', score: 0.75 }, { requirement: 'C', score: 0.5 }, { requirement: 'D', score: 0.1 }] });
  const c = computeCoverage(input);
  assert.deepStrictEqual([c.covered, c.partial, c.to_clarify, c.method], [2, 1, 1, 'rag']);
  assert.strictEqual(c.score, 63);    // (1 + 1 + 0.5 + 0) / 4 = 62.5 -> 63
});

test('heuristic: certification exact match covered, two words covered, one word partial, none to clarify', () => {
  const input = base(['Certification ISO 27001 souhaitée', 'Backend Java Spring', 'Hébergement cloud', 'Formation des agents'],
    { certifications: { list: ['ISO 27001'] }, similar_projects: [{ name: 'Portail', result: 'API Java Spring Boot', stack: [] }],
      why_us: ['Expertise cloud souverain'] });
  const c = computeCoverage(input);
  assert.deepStrictEqual(c.rows.map(r => r.status), ['covered', 'covered', 'partial', 'to_clarify']);
  assert.strictEqual(c.method, 'heuristic');
});

test('all covered, none covered, empty', () => {
  const all = computeCoverage(base(['x'], { requirement_coverage: [{ requirement: 'x', score: 0.9 }] }));
  assert.strictEqual(all.score, 100);
  assert.strictEqual(computeCoverage(base(['inconnu total'])).score, 0);
  assert.strictEqual(computeCoverage(base([])).score, null);
});

test('v2 input: the RAG matrix gives 100 %', () => {
  const { input } = normalizeInput(require('../fixtures/inputs/proposal_v2_example.json'));
  const c = computeCoverage(input);
  assert.deepStrictEqual([c.score, c.method, c.covered], [100, 'rag', 10]);
});

test('applyCoverage: column on s3, note with the formula, KPI on s1, English labels', () => {
  const env = { slides: [
    { id: 's1', blocks: [{ kind: 'text', text: 't' }, { kind: 'kpis', items: [{ label: 'a', value: '1' }] }] },
    { id: 's3', blocks: [{ kind: 'table', columns: ['Requirement', 'Our response', 'Evidence'], rows: [['A', 'r', 'e'], ['B', 'r', 'e']] }] }] };
  const input = base(['A', 'B'], { requirement_coverage: [{ requirement: 'A', score: 1 }, { requirement: 'B', score: 0.5 }] }, 'en');
  applyCoverage(env, input);
  const t = env.slides[1].blocks[0];
  assert.deepStrictEqual(t.columns, ['Requirement', 'Our response', 'Evidence', 'Coverage']);
  assert.deepStrictEqual(t.rows.map(r => r[3]), ['Covered', 'Partial']);
  assert.match(env.slides[1].blocks[1].text, /Coverage score: 75%/);
  assert.deepStrictEqual(env.slides[0].blocks[1].items[0], { label: 'Requirements coverage', value: '75 %' });
  assert.strictEqual(env.data.coverage.score, 75);
  applyCoverage(env, input);   // idempotent: no second column
  assert.strictEqual(env.slides[1].blocks[0].columns.length, 4);
});
