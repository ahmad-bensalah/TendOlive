/** profile.test.js - Company profile facts and the rates CSV import. */
const test = require('node:test');
const assert = require('node:assert');
const { applyProfile, qrUrl } = require('../lib/profile.js');
const { importRates } = require('../tools/import_catalog.js');

const EMPTY = require('../config/company_profile.json');
const FILLED = {
  contact: { name: 'Sami Trabelsi', role: 'Directeur commercial', email: 'sami@olivesoft.example', phone: '' },
  sla: { levels: [{ name: 'Critique', response_time: '1 h', resolution_time: '4 h', availability: '99,5 %' }],
         support_hours: 'Lundi à vendredi, 8 h à 18 h', maintenance: '', training: '' },
  qr: { url_template: 'https://olivesoft.example/offres/{tenderId}' }
};
const env = () => ({ slides: [
  { id: 's11', blocks: [{ kind: 'bullets', items: ['a'] }, { kind: 'text', text: '[TO FILL: contact]' }] },
  { id: 's8', blocks: [{ kind: 'bullets', items: ['Support'] }, { kind: 'note', text: '[TO FILL: SLA levels]' }] }] });
const input = { tender: { id: 'T 1', language: 'fr' } };

test('empty profile: placeholders stay, nothing invented', () => {
  const e = env();
  applyProfile('agent1', e, EMPTY, input);
  applyProfile('agent5', e, EMPTY, input);
  assert.strictEqual(e.slides[0].blocks[1].text, '[TO FILL: contact]');
  assert.strictEqual(e.slides[1].blocks[1].text, '[TO FILL: SLA levels]');
  assert.strictEqual(qrUrl(EMPTY, input), '');
});

test('filled profile: contact line, SLA table and support hours replace the placeholders', () => {
  const e = env();
  applyProfile('agent1', e, FILLED, input);
  applyProfile('agent5', e, FILLED, input);
  assert.strictEqual(e.slides[0].blocks[1].text, 'Contact : Sami Trabelsi · Directeur commercial · sami@olivesoft.example');
  const t = e.slides[1].blocks[0];
  assert.deepStrictEqual(t.rows, [['Critique', '1 h', '4 h', '99,5 %']]);
  assert.ok(e.slides[1].blocks.some(b => b.kind === 'bullets' && b.items.includes('Horaires de support : Lundi à vendredi, 8 h à 18 h')));
  assert.ok(!JSON.stringify(e).includes('[TO FILL: SLA'));
  assert.strictEqual(qrUrl(FILLED, input), 'https://olivesoft.example/offres/T%201');
});

test('rates CSV: valid values imported, wrong ones rejected, empty values keep the catalog', () => {
  const catalog = require('../catalog/pricing_catalog.json');
  const ok = importRates('key,value,unit,note\ndaily_rates.backend,450,,\nmargin_percent,0.12,,\ncloud.database_month,,,\n', catalog, '2026-10-19');
  assert.deepStrictEqual(ok.errors, []);
  assert.strictEqual(ok.catalog.daily_rates.backend, 450);
  assert.strictEqual(ok.catalog.cloud.database_month, catalog.cloud.database_month);
  assert.strictEqual(ok.catalog.last_updated, '2026-10-19');
  const bad = importRates('key,value\ndaily_rates.chef,500\nmargin_percent,15\ncloud.app_server_month,-3\n', catalog, '2026-10-19');
  assert.strictEqual(bad.errors.length, 3);
});
