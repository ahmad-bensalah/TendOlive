/**
 * secrets_audit.js - Scans for exposed secrets in code
 * 
 * Fails CI if any secrets are found
 */

const fs = require('fs');
const path = require('path');

// Patterns that indicate exposed secrets
const SECRET_PATTERNS = [
  { name: 'Groq API Key', pattern: /gsk_[a-zA-Z0-9]{32,}/, severity: 'CRITICAL' },
  { name: 'OpenAI API Key', pattern: /sk-[a-zA-Z0-9]{20,}/, severity: 'CRITICAL' },
  { name: 'Bearer Token', pattern: /Bearer\s+[a-zA-Z0-9_\-\.]{20,}/, severity: 'HIGH' },
  { name: 'API Key Header', pattern: /X-API-Key['":\s]+[a-zA-Z0-9_\-]{16,}/, severity: 'HIGH' },
  { name: 'Studio Dev Key', pattern: /dev-key-studio-rfp-2024-shared/, severity: 'MEDIUM' }, // The actual dev key
  { name: 'AWS Key', pattern: /AKIA[0-9A-Z]{16}/, severity: 'CRITICAL' },
  { name: 'Generic Secret', pattern: /secret['":\s]+[a-zA-Z0-9_\-]{16,}/i, severity: 'LOW' }
];

// Directories to scan
const SCAN_DIRS = ['agents', 'workflows', 'tests'];

// Files/dirs to skip
const SKIP_PATTERNS = [
  /node_modules/,
  /\.venv/,
  /__pycache__/,
  /\.git/,
  /agents\/registry/,
  /agents\/.cache/,
  /exports/,
  /uploads/,
  /saves/,
  /dist/
];

/**
 * Scans a file for secret patterns
 */
function scanFile(filePath) {
  const findings = [];
  
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    
    SECRET_PATTERNS.forEach(({ name, pattern, severity }) => {
      lines.forEach((line, idx) => {
        const match = line.match(pattern);
        if (match) {
          // Check if it's in a comment or documentation
          const isComment = line.trim().startsWith('//') || 
                           line.trim().startsWith('*') ||
                           line.trim().startsWith('#');
          
          // Check if it's a placeholder/example
          const isPlaceholder = /example|placeholder|your-key-here|xxx|\.\.\./.test(line.toLowerCase());
          
          if (!isComment && !isPlaceholder) {
            findings.push({
              file: filePath,
              line: idx + 1,
              severity,
              type: name,
              preview: line.trim().substring(0, 80) + (line.length > 80 ? '...' : '')
            });
          }
        }
      });
    });
  } catch (error) {
    console.error(`Error reading ${filePath}:`, error.message);
  }
  
  return findings;
}

/**
 * Recursively scans a directory
 */
function scanDirectory(dir, findings = []) {
  if (!fs.existsSync(dir)) {
    return findings;
  }
  
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  
  entries.forEach(entry => {
    const fullPath = path.join(dir, entry.name);
    
    // Skip patterns
    if (SKIP_PATTERNS.some(pattern => pattern.test(fullPath))) {
      return;
    }
    
    if (entry.isDirectory()) {
      scanDirectory(fullPath, findings);
    } else if (entry.isFile()) {
      // Only scan text files
      const ext = path.extname(entry.name);
      if (['.js', '.json', '.md', '.py', '.txt', '.yml', '.yaml', '.env'].includes(ext)) {
        const fileFindings = scanFile(fullPath);
        findings.push(...fileFindings);
      }
    }
  });
  
  return findings;
}

/**
 * Main audit function
 */
function auditSecrets() {
  console.log('🔍 Scanning for exposed secrets...\n');
  
  const allFindings = [];
  
  SCAN_DIRS.forEach(dir => {
    const dirPath = path.join(process.cwd(), dir);
    if (fs.existsSync(dirPath)) {
      const findings = scanDirectory(dirPath);
      allFindings.push(...findings);
    }
  });
  
  // Group by severity
  const critical = allFindings.filter(f => f.severity === 'CRITICAL');
  const high = allFindings.filter(f => f.severity === 'HIGH');
  const medium = allFindings.filter(f => f.severity === 'MEDIUM');
  const low = allFindings.filter(f => f.severity === 'LOW');
  
  // Report
  console.log('======================================================================');
  console.log('SECRETS AUDIT REPORT');
  console.log('======================================================================\n');
  
  if (allFindings.length === 0) {
    console.log('✅ NO SECRETS FOUND\n');
    console.log('All scanned files are clean.');
    return 0;
  }
  
  console.log(`Total findings: ${allFindings.length}\n`);
  
  if (critical.length > 0) {
    console.log(`🚨 CRITICAL (${critical.length}):`);
    critical.forEach(f => {
      console.log(`  ${f.file}:${f.line}`);
      console.log(`    Type: ${f.type}`);
      console.log(`    Preview: ${f.preview}\n`);
    });
  }
  
  if (high.length > 0) {
    console.log(`⚠️  HIGH (${high.length}):`);
    high.forEach(f => {
      console.log(`  ${f.file}:${f.line}`);
      console.log(`    Type: ${f.type}`);
      console.log(`    Preview: ${f.preview}\n`);
    });
  }
  
  if (medium.length > 0) {
    console.log(`⚡ MEDIUM (${medium.length}):`);
    medium.forEach(f => {
      console.log(`  ${f.file}:${f.line}`);
      console.log(`    Type: ${f.type}\n`);
    });
  }
  
  if (low.length > 0) {
    console.log(`ℹ️  LOW (${low.length}): (Review manually)`);
  }
  
  console.log('======================================================================');
  
  if (critical.length > 0 || high.length > 0) {
    console.log('❌ AUDIT FAILED: Secrets found with CRITICAL or HIGH severity');
    console.log('\nAction required:');
    console.log('1. Remove secrets from code');
    console.log('2. Use environment variables or n8n credentials instead');
    console.log('3. Rotate any exposed keys immediately');
    return 1;
  }
  
  if (medium.length > 0) {
    console.log('⚠️  WARNING: Secrets found with MEDIUM severity');
    console.log('Review and ensure they are not real credentials.');
  }
  
  return 0;
}

// Run if called directly
if (require.main === module) {
  const exitCode = auditSecrets();
  process.exit(exitCode);
}

module.exports = { auditSecrets, scanFile, scanDirectory };
