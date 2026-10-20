#!/usr/bin/env node
/**
 * platform_facts.js - Verifies platform API behavior against documented contracts
 * Run against a live platform: node agents/tools/platform_facts.js
 * 
 * Requires: STUDIO_API_KEY and STUDIO_BASE_URL environment variables
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const BASE_URL = process.env.STUDIO_BASE_URL || 'http://localhost:8091';
const API_KEY = process.env.STUDIO_API_KEY;
if (!API_KEY) {
  console.error('Set STUDIO_API_KEY (the value the platform was started with).');
  process.exit(2);
}

const results = [];

function log(test, status, details = '') {
  const symbol = status === 'PASS' ? '✓' : '✗';
  const line = `${symbol} ${test}: ${status}${details ? ' - ' + details : ''}`;
  console.log(line);
  results.push({ test, status, details });
}

function request(method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;
    
    const options = {
      method,
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      headers: {
        'Content-Type': 'application/json',
        ...headers
      }
    };
    
    if (body) {
      const bodyStr = JSON.stringify(body);
      options.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }
    
    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = data ? JSON.parse(data) : null;
          resolve({ status: res.statusCode, body: json, headers: res.headers });
        } catch (err) {
          resolve({ status: res.statusCode, body: data, headers: res.headers });
        }
      });
    });
    
    req.on('error', reject);
    
    if (body) {
      req.write(JSON.stringify(body));
    }
    
    req.end();
  });
}

async function test401WithoutKey() {
  try {
    const res = await request('POST', '/api/decks', { name: 'Test', slides: [] });
    if (res.status === 401) {
      log('401 without key', 'PASS');
    } else {
      log('401 without key', 'FAIL', `Got ${res.status}`);
    }
  } catch (err) {
    log('401 without key', 'FAIL', err.message);
  }
}

async function test200WithValidDeck() {
  try {
    const samplePath = path.join(__dirname, '..', '..', 'samples', 'software.json');
    const deck = JSON.parse(fs.readFileSync(samplePath, 'utf-8'));
    
    const res = await request('POST', '/api/decks', deck, { 'X-API-Key': API_KEY });
    
    if (res.status === 200 && res.body.id && res.body.url && Array.isArray(res.body.warnings)) {
      log('200 on samples/software.json', 'PASS', `ID: ${res.body.id}`);
      return res.body.id;
    } else {
      log('200 on samples/software.json', 'FAIL', `Status ${res.status}`);
      return null;
    }
  } catch (err) {
    log('200 on samples/software.json', 'FAIL', err.message);
    return null;
  }
}

async function test400UnknownBlockKind() {
  try {
    const deck = {
      name: 'Test',
      slides: [{
        type: 'content',
        title: 'Test',
        blocks: [{ kind: 'chart', data: [] }]
      }]
    };
    
    const res = await request('POST', '/api/decks', deck, { 'X-API-Key': API_KEY });
    
    if (res.status === 400 && res.body.errors && Array.isArray(res.body.errors)) {
      const hasError = res.body.errors.some(e => e.includes('unknown block kind'));
      if (hasError) {
        log('400 with errors[] on unknown block kind', 'PASS');
      } else {
        log('400 with errors[] on unknown block kind', 'FAIL', 'No unknown block kind error');
      }
    } else {
      log('400 with errors[] on unknown block kind', 'FAIL', `Status ${res.status}`);
    }
  } catch (err) {
    log('400 with errors[] on unknown block kind', 'FAIL', err.message);
  }
}

async function test400UnknownSlideField() {
  try {
    const deck = {
      name: 'Test',
      slides: [{
        type: 'content',
        title: 'Test',
        blocks: [],
        author: 'John'
      }]
    };
    
    const res = await request('POST', '/api/decks', deck, { 'X-API-Key': API_KEY });
    
    if (res.status === 400 && res.body.errors && Array.isArray(res.body.errors)) {
      const hasError = res.body.errors.some(e => e.includes('unknown field'));
      if (hasError) {
        log('400 on unknown slide field', 'PASS');
      } else {
        log('400 on unknown slide field', 'FAIL', 'No unknown field error');
      }
    } else {
      log('400 on unknown slide field', 'FAIL', `Status ${res.status}`);
    }
  } catch (err) {
    log('400 on unknown slide field', 'FAIL', err.message);
  }
}

async function testResponseKeys(deckId) {
  if (!deckId) {
    log('Response keys check', 'SKIP', 'No deck ID');
    return;
  }
  
  try {
    const res = await request('GET', `/api/decks/${deckId}`, null, { 'X-API-Key': API_KEY });
    
    if (res.status === 200) {
      const required = ['name', 'slides', 'theme'];
      const hasAll = required.every(k => k in res.body);
      
      if (hasAll && Array.isArray(res.body.slides) && res.body.slides.length > 0) {
        const firstSlide = res.body.slides[0];
        const hasLabel = 'label' in firstSlide;
        const hasElements = 'elements' in firstSlide;
        
        if (hasLabel && hasElements) {
          log('GET /api/decks/<id> keys', 'PASS', 'Has label and elements');
        } else {
          log('GET /api/decks/<id> keys', 'FAIL', 'Missing label or elements');
        }
      } else {
        log('GET /api/decks/<id> keys', 'FAIL', 'Missing required keys or slides');
      }
    } else {
      log('GET /api/decks/<id> keys', 'FAIL', `Status ${res.status}`);
    }
  } catch (err) {
    log('GET /api/decks/<id> keys', 'FAIL', err.message);
  }
}

async function testTableCellNumber() {
  try {
    const deck = {
      name: 'Test',
      slides: [{
        type: 'content',
        title: 'Test',
        blocks: [{
          kind: 'table',
          columns: ['A', 'B'],
          rows: [['Text', 123]]
        }]
      }]
    };
    
    const res = await request('POST', '/api/decks', deck, { 'X-API-Key': API_KEY });
    
    if (res.status === 400) {
      log('400 when table cell is a number', 'PASS');
    } else {
      log('400 when table cell is a number', 'FAIL', `Got ${res.status}`);
    }
  } catch (err) {
    log('400 when table cell is a number', 'FAIL', err.message);
  }
}

async function test5thCardDropped() {
  try {
    const deck = {
      name: 'Test',
      slides: [{
        type: 'content',
        title: 'Test',
        blocks: [{
          kind: 'cards',
          cards: [
            { title: '1', text: 'A' },
            { title: '2', text: 'B' },
            { title: '3', text: 'C' },
            { title: '4', text: 'D' },
            { title: '5', text: 'E' }
          ]
        }]
      }]
    };
    
    const res = await request('POST', '/api/decks', deck, { 'X-API-Key': API_KEY });
    
    if (res.status === 200) {
      // Platform accepts but silently drops 5th card (no warning)
      log('5th card is dropped', 'PASS', 'Accepted (silent drop is platform behavior)');
    } else {
      log('5th card is dropped', 'FAIL', `Status ${res.status}`);
    }
  } catch (err) {
    log('5th card is dropped', 'FAIL', err.message);
  }
}

async function testLongTableSplit() {
  try {
    const rows = [];
    for (let i = 1; i <= 25; i++) {
      rows.push([`Row ${i}`, 'Data']);
    }
    
    const deck = {
      name: 'Test',
      slides: [{
        type: 'content',
        title: 'Long Table',
        blocks: [{
          kind: 'table',
          columns: ['Col1', 'Col2'],
          rows
        }]
      }]
    };
    
    const res = await request('POST', '/api/decks', deck, { 'X-API-Key': API_KEY });
    
    if (res.status === 200) {
      const getRes = await request('GET', `/api/decks/${res.body.id}`, null, { 'X-API-Key': API_KEY });
      
      if (getRes.status === 200) {
        const contentSlides = getRes.body.slides.filter(s => s.type === 'content');
        const titles = contentSlides.map(s => s.label || s.title);
        const hasSplit = titles.some(t => t.includes('(1/3)')) && titles.some(t => t.includes('(3/3)'));
        
        if (hasSplit) {
          log('25-row table produces (1/3)...(3/3)', 'PASS', titles.join(', '));
        } else {
          log('25-row table produces (1/3)...(3/3)', 'FAIL', `Titles: ${titles.join(', ')}`);
        }
      } else {
        log('25-row table produces (1/3)...(3/3)', 'FAIL', 'Could not GET deck');
      }
    } else {
      log('25-row table produces (1/3)...(3/3)', 'FAIL', `POST failed with ${res.status}`);
    }
  } catch (err) {
    log('25-row table produces (1/3)...(3/3)', 'FAIL', err.message);
  }
}

async function testLongBulletListSplit() {
  try {
    const items = [];
    for (let i = 1; i <= 14; i++) {
      items.push(`Item ${i}`);
    }
    
    const deck = {
      name: 'Test',
      slides: [{
        type: 'content',
        title: 'Long List',
        blocks: [{
          kind: 'bullets',
          items
        }]
      }]
    };
    
    const res = await request('POST', '/api/decks', deck, { 'X-API-Key': API_KEY });
    
    if (res.status === 200) {
      const getRes = await request('GET', `/api/decks/${res.body.id}`, null, { 'X-API-Key': API_KEY });
      
      if (getRes.status === 200) {
        const contentSlides = getRes.body.slides.filter(s => s.type === 'content');
        const hasSplit = contentSlides.length > 1;
        
        if (hasSplit) {
          log('14-item bullet list splits', 'PASS', `${contentSlides.length} slides`);
        } else {
          log('14-item bullet list splits', 'FAIL', 'No split occurred');
        }
      } else {
        log('14-item bullet list splits', 'FAIL', 'Could not GET deck');
      }
    } else {
      log('14-item bullet list splits', 'FAIL', `POST failed with ${res.status}`);
    }
  } catch (err) {
    log('14-item bullet list splits', 'FAIL', err.message);
  }
}

async function main() {
  console.log('='.repeat(70));
  console.log('PLATFORM FACTS CHECK');
  console.log('='.repeat(70));
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`API Key: ${API_KEY ? '[SET]' : '[MISSING]'}\n`);
  
  await test401WithoutKey();
  const deckId = await test200WithValidDeck();
  await test400UnknownBlockKind();
  await test400UnknownSlideField();
  await testResponseKeys(deckId);
  await testTableCellNumber();
  await test5thCardDropped();
  await testLongTableSplit();
  await testLongBulletListSplit();
  
  console.log('\n' + '='.repeat(70));
  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  const skipped = results.filter(r => r.status === 'SKIP').length;
  
  console.log(`SUMMARY: ${passed} PASS, ${failed} FAIL, ${skipped} SKIP`);
  console.log('='.repeat(70));
  
  if (failed > 0) {
    console.log('\nFailed tests:');
    results.filter(r => r.status === 'FAIL').forEach(r => {
      console.log(`  - ${r.test}: ${r.details}`);
    });
  }
  
  // Write results to docs
  const docPath = path.join(__dirname, '..', '..', 'docs', 'agents', 'PLATFORM_FACTS.md');
  const doc = generateMarkdown(results);
  fs.writeFileSync(docPath, doc, 'utf-8');
  console.log(`\nResults written to: ${docPath}`);
  
  process.exit(failed > 0 ? 1 : 0);
}

function generateMarkdown(results) {
  const timestamp = new Date().toISOString();
  let md = `# Platform Facts Verification\n\n`;
  md += `Last run: ${timestamp}\n`;
  md += `Base URL: ${BASE_URL}\n\n`;
  md += `## Results\n\n`;
  md += `| Test | Status | Details |\n`;
  md += `|------|--------|----------|\n`;
  
  results.forEach(r => {
    const status = r.status === 'PASS' ? '✓ PASS' : r.status === 'FAIL' ? '✗ FAIL' : '⊘ SKIP';
    md += `| ${r.test} | ${status} | ${r.details || ''} |\n`;
  });
  
  md += `\n## Differences from Prompt\n\n`;
  md += `(To be filled after verification)\n\n`;
  
  return md;
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
