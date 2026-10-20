/**
 * input_v2.test.js - The olivesoft.proposal-input.v2 contract (RAG output) and "nothing invented".
 */
const test = require('node:test');
const assert = require('node:assert');
const { normalizeInput, assetName, roleFromCv } = require('../lib/input.js');
const V2 = require('../fixtures/inputs/proposal_v2_example.json');

const clone = (o) => JSON.parse(JSON.stringify(o));

test('v2: tender fields, client, language, type and score', () => {
  const { input, input_warnings } = normalizeInput(V2);
  assert.strictEqual(input.tender.id, 'T1wp05cp');
  assert.strictEqual(input.tender.client, 'Office du Tourisme de Sampleville (démo)');
  assert.strictEqual(input.tender.language, 'fr');
  assert.strictEqual(input.tender.project_type, 'software');   // analysis.tender_type software_build
  assert.strictEqual(input.match.score, 1);
  assert.strictEqual(input.tender.requirements.length, 10);    // matrix rows, not doubled with analysis
  assert.strictEqual(input.template, 'olivesoft_default');      // options.template_id
  assert.deepStrictEqual(input_warnings, []);
});

test('v2: cpv as a list does not crash, and 72xxxxxx means software', () => {
  const raw = clone(V2);
  delete raw.analysis.tender_type;
  raw.tender.title = 'Mission';
  assert.strictEqual(normalizeInput(raw).input.tender.project_type, 'software');
});

test('v2: projects from RAG assets get readable names and their title as result', () => {
  const projects = normalizeInput(V2).input.match.similar_projects;
  assert.deepStrictEqual(projects.map(p => p.name),
    ['Ministry Interior Licensing Portal', 'Health Analytics Dashboard', 'Insurance ISO27001']);
  assert.match(projects[0].result, /React \+ Spring Boot \+ PostgreSQL/);
  assert.strictEqual(assetName('Project_MinistryInterior_LicensingPortal.md'), 'Ministry Interior Licensing Portal');
});

test('v2: team from CV assets (one person per CV), roles mapped, unknown role not invented', () => {
  const eng = normalizeInput(V2).input.match.engineers;
  assert.strictEqual(eng.specialized, 7);
  assert.deepStrictEqual(eng.profiles, [
    { role: 'Backend', count: 1 }, { role: 'Frontend', count: 2 }, { role: 'DevOps', count: 1 },
    { role: 'PM', count: 1 }, { role: 'Designer', count: 1 }]);
  assert.strictEqual(roleFromCv({ title: 'Senior React / Redux developer', snippets: [] }), 'Frontend');
});

test('v2: certifications only from the evidence', () => {
  const certs = normalizeInput(V2).input.match.certifications;
  assert.ok(certs.list.includes('PMP'));
  assert.ok(certs.list.includes('AWS Certified Solutions Architect - Associate'));
  assert.strictEqual(certs.matching, certs.list.length);
});

test('v2: competition becomes research (budget range and competitors with facts only)', () => {
  const r = normalizeInput(V2).input.research;
  assert.deepStrictEqual([r.estimated_budget.min, r.estimated_budget.max, r.estimated_budget.currency], [134470, 197000, 'TND']);
  assert.strictEqual(r.competitors[0].name, 'DATAERA');
  assert.match(r.competitors[0].strengths[0], /1 marché/);
  assert.deepStrictEqual(r.competitors[2].strengths, []);   // no wins: no strength invented
});

test('v2: matrix coverage is passed on for the coverage score', () => {
  const cov = normalizeInput(V2).input.match.requirement_coverage;
  assert.strictEqual(cov.length, 10);
  assert.strictEqual(cov[0].score, 1);
});

test('nothing invented when the evidence is empty: no default certifications, team or why-us', () => {
  const raw = clone(V2);
  raw.matrix.rows.forEach(r => { r.evidence = []; r.justification = ''; });
  raw.rag.assets = [];
  raw.rag.suggested_assets = {};
  const { input, input_warnings } = normalizeInput(raw);
  assert.deepStrictEqual(input.match.certifications, { matching: 0, list: [] });
  assert.deepStrictEqual(input.match.engineers, { specialized: 0, profiles: [] });
  assert.deepStrictEqual(input.match.similar_projects, []);
  assert.deepStrictEqual(input.match.why_us, []);
  assert.ok(input_warnings.some(w => /certifications/.test(w)));
  assert.ok(input_warnings.some(w => /team profiles/.test(w)));
});

test('a competition status other than OK gives no competitors', () => {
  const raw = clone(V2);
  raw.competition.status = 'SKIPPED';
  const r = normalizeInput(raw).input.research;
  assert.ok(!r.competitors);
});
