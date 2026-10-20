#!/usr/bin/env node
/**
 * create_manifest.js - Creates SHA-256 manifest of all existing platform files
 * Run: node agents/tools/create_manifest.js
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const MANIFEST_PATH = path.join(__dirname, 'platform_manifest.json');

// Directories to exclude
const EXCLUDED_DIRS = new Set([
  '.venv', '__pycache__', 'exports', 'uploads', 'saves', 
  'screenshots', 'dist', 'node_modules', '.git',
  'agents', 'rfp-studio-backup-agents-2026-10-18'
]);

function hashFile(filepath) {
  const content = fs.readFileSync(filepath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

function walkDir(dir, basePath = ROOT) {
  const files = {};
  
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(basePath, fullPath);
      
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name)) {
          Object.assign(files, walkDir(fullPath, basePath));
        }
      } else if (entry.isFile()) {
        files[relativePath] = hashFile(fullPath);
      }
    }
  } catch (err) {
    console.error(`Error reading directory ${dir}: ${err.message}`);
  }
  
  return files;
}

function main() {
  console.log('Creating platform manifest...');
  console.log(`Root: ${ROOT}`);
  
  const manifest = {
    created: new Date().toISOString(),
    version: '1.0.0',
    purpose: 'SHA-256 hashes of all platform files before agent work',
    files: walkDir(ROOT)
  };
  
  const fileCount = Object.keys(manifest.files).length;
  console.log(`Found ${fileCount} files`);
  
  fs.writeFileSync(
    MANIFEST_PATH,
    JSON.stringify(manifest, null, 2),
    'utf-8'
  );
  
  console.log(`Manifest written to: ${MANIFEST_PATH}`);
  console.log('Sample entries:');
  
  const entries = Object.entries(manifest.files).slice(0, 5);
  entries.forEach(([file, hash]) => {
    console.log(`  ${file}: ${hash.substring(0, 16)}...`);
  });
}

main();
