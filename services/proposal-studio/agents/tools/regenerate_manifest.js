#!/usr/bin/env node
/**
 * regenerate_manifest.js - Rebuild platform manifest after cleanup
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const EXCLUDE = ['.venv', '__pycache__', 'exports', 'uploads', 'saves', 'screenshots', 'dist', 'node_modules', '.git', 'agents/registry', 'agents/.cache'];

function computeHash(filePath) {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

function walkDir(dir, files = {}) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(ROOT, fullPath);
    
    // Skip excluded directories
    if (EXCLUDE.some(ex => relPath.startsWith(ex) || relPath.includes('/' + ex))) {
      continue;
    }
    
    // Only include existing platform files (not new agent files)
    if (relPath.startsWith('agents/')) continue;
    if (relPath.startsWith('workflows/') && entry.isFile() && entry.name.endsWith('.json')) continue;
    if (relPath.startsWith('docs/agents/')) continue;
    
    if (entry.isFile()) {
      files[relPath] = computeHash(fullPath);
    } else if (entry.isDirectory()) {
      walkDir(fullPath, files);
    }
  }
  
  return files;
}

// Generate manifest
const files = walkDir(ROOT);
const manifest = {
  generated: new Date().toISOString(),
  note: "Platform files only (excludes agents/, workflows/*.json, docs/agents/)",
  files: files
};

const manifestPath = path.join(ROOT, 'agents/tools/platform_manifest.json');
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

console.log(`✅ Manifest regenerated: ${Object.keys(files).length} platform files`);
console.log(`   Saved to: ${path.relative(ROOT, manifestPath)}`);
