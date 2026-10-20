#!/usr/bin/env node
/**
 * embed_check.js - Fails when a workflow's embedded lib code differs from agents/lib.
 *
 * Reads workflows/*.json (not workflows/teammates/), extracts every block between
 * "// BEGIN agents/lib/<file>" and "// END agents/lib/<file>" in Code nodes, and compares
 * it with the file. Fix a failure with: node agents/tools/generate_workflows.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const WF = path.join(ROOT, 'workflows');
const problems = [];
let blocks = 0;

for (const file of fs.readdirSync(WF).filter(f => f.endsWith('.json')).sort()) {
  let wf;
  try {
    wf = JSON.parse(fs.readFileSync(path.join(WF, file), 'utf-8'));
  } catch (err) {
    problems.push(`${file}: not valid JSON (${err.message})`);
    continue;
  }
  for (const node of wf.nodes || []) {
    const code = node.parameters && node.parameters.jsCode;
    if (!code) continue;
    const re = /\/\/ BEGIN agents\/lib\/([\w.-]+)\n([\s\S]*?)\n\/\/ END agents\/lib\/\1/g;
    let m;
    while ((m = re.exec(code))) {
      blocks++;
      const libPath = path.join(ROOT, 'agents', 'lib', m[1]);
      if (!fs.existsSync(libPath)) {
        problems.push(`${file} / ${node.name}: embeds agents/lib/${m[1]}, which does not exist`);
      } else if (fs.readFileSync(libPath, 'utf-8') !== m[2]) {
        problems.push(`${file} / ${node.name}: agents/lib/${m[1]} is out of date`);
      }
    }
  }
}

if (problems.length) {
  console.log(`EMBED CHECK FAILED (${problems.length}):\n- ${problems.join('\n- ')}\nRun: node agents/tools/generate_workflows.js`);
  process.exit(1);
}
console.log(`EMBED CHECK PASSED: ${blocks} embedded lib blocks match agents/lib`);
