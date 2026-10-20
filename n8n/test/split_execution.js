// Split an n8n execution (test/out/execution*.json, or one downloaded from your n8n) into one JSON file per node:
//   node test/split_execution.js test/out/execution_gemini.json [out-dir]
// Each file holds every run of that node: [{run, error, items: [...json]}]. Handy to read a node's output without n8n.
const fs = require('fs'), path = require('path');
const file = process.argv[2] || path.join(__dirname, 'out', 'execution.json');
const dir = process.argv[3] || path.join(path.dirname(file), path.basename(file, '.json') + '_nodes');
const raw = fs.readFileSync(file, 'utf8');
const d = JSON.parse(raw.slice(raw.indexOf('{')));
const runData = (d.data || d).resultData ? (d.data || d).resultData.runData : d.data.resultData.runData;
fs.mkdirSync(dir, { recursive: true });
const index = [];
for (const [name, runs] of Object.entries(runData)) {
  const out = runs.map((r, k) => ({ run: k, error: r.error ? (r.error.message || String(r.error)) : null,
    items: ((r.data && r.data.main) || []).map(o => (o || []).map(i => i.json)) }));
  const safe = name.replace(/[^\w.-]+/g, '_');
  fs.writeFileSync(path.join(dir, safe + '.json'), JSON.stringify(out, null, 1));
  index.push(`${safe}.json  runs=${runs.length} items=${JSON.stringify(out[out.length - 1].items.map(x => x.length))}${out.some(o => o.error) ? ' ERROR' : ''}`);
}
fs.writeFileSync(path.join(dir, '_index.txt'), index.join('\n'));
console.log(`${index.length} nodes -> ${dir}`);
