#!/usr/bin/env node
/**
 * guard_check.js - Verifies no existing platform files were changed, deleted, or renamed
 * For append-only files, checks that original content is an unchanged prefix
 * 
 * Run: node agents/tools/guard_check.js
 * Exit codes: 0 = PASS, 1 = FAIL
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const MANIFEST_PATH = path.join(__dirname, 'platform_manifest.json');

// Files that may only be appended to (never rewritten)
const APPEND_ONLY_FILES = new Set([
  'README.md',
  'CHANGELOG.md',
  '.gitignore',
  'workflows/README.md',
  'docs/README.md'
]);

function hashFile(filepath) {
  try {
    const content = fs.readFileSync(filepath);
    return crypto.createHash('sha256').update(content).digest('hex');
  } catch (err) {
    return null;
  }
}

function checkAppendOnly(filepath, originalHash) {
  const fullPath = path.join(ROOT, filepath);
  
  if (!fs.existsSync(fullPath)) {
    return { ok: false, reason: 'File deleted' };
  }
  
  try {
    const currentContent = fs.readFileSync(fullPath, 'utf-8');
    const currentHash = crypto.createHash('sha256').update(currentContent).digest('hex');
    
    if (currentHash === originalHash) {
      return { ok: true, reason: 'Unchanged' };
    }
    
    // For append-only: load original from backup and check prefix
    const backupRoot = path.join(ROOT, '..', 'rfp-studio-backup-agents-2026-10-18');
    const backupPath = path.join(backupRoot, filepath);
    
    if (!fs.existsSync(backupPath)) {
      return { ok: false, reason: 'Cannot verify append-only: backup missing' };
    }
    
    const originalContent = fs.readFileSync(backupPath, 'utf-8');
    
    if (!currentContent.startsWith(originalContent)) {
      return { 
        ok: false, 
        reason: 'Modified (not a pure append): original content changed',
        details: `Original: ${originalContent.length} bytes, Current: ${currentContent.length} bytes`
      };
    }
    
    const appendedBytes = currentContent.length - originalContent.length;
    return { 
      ok: true, 
      reason: `Append-only compliant (+${appendedBytes} bytes)` 
    };
    
  } catch (err) {
    return { ok: false, reason: `Error: ${err.message}` };
  }
}

function main() {
  console.log('='.repeat(70));
  console.log('GUARD CHECK: Verifying platform integrity');
  console.log('='.repeat(70));
  
  if (!fs.existsSync(MANIFEST_PATH)) {
    console.error('FAIL: Manifest not found. Run create_manifest.js first.');
    process.exit(1);
  }
  
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
  const manifestFiles = manifest.files;
  
  let violations = 0;
  let checked = 0;
  let appendOnlyOk = 0;
  let appendOnlyFail = 0;
  
  console.log(`\nChecking ${Object.keys(manifestFiles).length} platform files...\n`);
  
  for (const [filepath, originalHash] of Object.entries(manifestFiles)) {
    checked++;
    const fullPath = path.join(ROOT, filepath);
    
    if (APPEND_ONLY_FILES.has(filepath)) {
      const result = checkAppendOnly(filepath, originalHash);
      if (result.ok) {
        appendOnlyOk++;
        console.log(`✓ ${filepath}: ${result.reason}`);
      } else {
        appendOnlyFail++;
        violations++;
        console.error(`✗ ${filepath}: ${result.reason}`);
        if (result.details) {
          console.error(`  ${result.details}`);
        }
      }
      continue;
    }
    
    // Regular files: must not change at all
    if (!fs.existsSync(fullPath)) {
      violations++;
      console.error(`✗ ${filepath}: DELETED`);
      continue;
    }
    
    const currentHash = hashFile(fullPath);
    if (currentHash !== originalHash) {
      violations++;
      console.error(`✗ ${filepath}: MODIFIED`);
      console.error(`  Original: ${originalHash}`);
      console.error(`  Current:  ${currentHash}`);
    }
  }
  
  console.log('\n' + '='.repeat(70));
  console.log('SUMMARY');
  console.log('='.repeat(70));
  console.log(`Files checked: ${checked}`);
  console.log(`Regular files: ${checked - APPEND_ONLY_FILES.size} (must be unchanged)`);
  console.log(`Append-only files: ${APPEND_ONLY_FILES.size}`);
  console.log(`  - Compliant: ${appendOnlyOk}`);
  console.log(`  - Violated: ${appendOnlyFail}`);
  console.log(`Total violations: ${violations}`);
  
  if (violations > 0) {
    console.error('\n❌ GUARD CHECK FAILED\n');
    process.exit(1);
  }
  
  console.log('\n✅ GUARD CHECK PASSED: All platform files intact\n');
  process.exit(0);
}

main();
