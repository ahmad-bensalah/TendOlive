#!/usr/bin/env node
/**
 * import_catalog.js - Load OliveSoft's real rates from a filled CSV into pricing_catalog.json.
 *
 *   node agents/tools/import_catalog.js agents/catalog/rates.csv [--dry-run]
 *
 * CSV columns: key,value,unit,note (copy agents/catalog/rates.template.csv). Keys are group.item
 * (daily_rates.backend, cloud.app_server_month, ...) or top-level settings. Values must be
 * numbers >= 0; percentages are fractions between 0 and 1. Unknown keys are rejected. last_updated
 * becomes today. A rate is never guessed: empty values keep the current value.
 */
const fs = require('fs');
const path = require('path');

const CATALOG = path.join(__dirname, '..', 'catalog', 'pricing_catalog.json');

function importRates(csvText, catalog, today) {
  const errors = [];
  const out = JSON.parse(JSON.stringify(catalog));
  let changed = 0;
  const lines = csvText.split(/\r?\n/).filter(l => l.trim());
  lines.slice(1).forEach((line, i) => {
    const [key, valueRaw] = line.split(',').map(s => (s || '').trim());
    if (!key) return;
    if (valueRaw === '') return;
    const value = Number(valueRaw);
    const where = `line ${i + 2} (${key})`;
    if (!Number.isFinite(value) || value < 0) { errors.push(`${where}: value must be a number >= 0`); return; }
    const [group, item] = key.split('.');
    if (item !== undefined) {
      if (!out[group] || typeof out[group] !== 'object' || !(item in out[group])) { errors.push(`${where}: unknown key`); return; }
      out[group][item] = value;
    } else {
      if (!(key in out) || typeof out[key] !== 'number') { errors.push(`${where}: unknown key`); return; }
      if (/percent/.test(key) && value > 1) { errors.push(`${where}: percentages are fractions between 0 and 1`); return; }
      if (key === 'workdays_per_week' && (value < 1 || value > 7 || !Number.isInteger(value))) { errors.push(`${where}: 1 to 7`); return; }
      out[key] = value;
    }
    changed++;
  });
  if (!errors.length && changed) out.last_updated = today;
  // A file whose notes say ESTIMATE marks the catalog as estimated (shown as a warning on the budget slide)
  if (!errors.length && changed) out.status = /\bESTIMATE\b/.test(csvText) ? 'estimate' : 'confirmed';
  return { catalog: out, errors, changed };
}

if (require.main === module) {
  const file = process.argv[2];
  if (!file) { console.error('usage: node agents/tools/import_catalog.js <rates.csv> [--dry-run]'); process.exit(2); }
  const res = importRates(fs.readFileSync(file, 'utf-8'), JSON.parse(fs.readFileSync(CATALOG, 'utf-8')),
                          new Date().toISOString().slice(0, 10));
  if (res.errors.length) { res.errors.forEach(e => console.error(`ERROR ${e}`)); process.exit(1); }
  if (!process.argv.includes('--dry-run')) fs.writeFileSync(CATALOG, JSON.stringify(res.catalog, null, 2) + '\n');
  console.log(`${res.changed} value(s) ${process.argv.includes('--dry-run') ? 'checked' : 'imported'}; last_updated ${res.catalog.last_updated}`);
}

module.exports = { importRates };
