/**
 * svg.test.js - Tests for SVG fallback renderer
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { 
  renderArchitecture, 
  renderRoadmap, 
  renderClassDiagram,
  renderPlaceholder,
  scanSVGSecurity,
  escapeXml,
  wrapText
} = require('../lib/svg.js');

describe('escapeXml', () => {
  test('should escape special characters', () => {
    assert.strictEqual(escapeXml('<tag>'), '&lt;tag&gt;');
    assert.strictEqual(escapeXml('A & B'), 'A &amp; B');
    assert.strictEqual(escapeXml('"quote"'), '&quot;quote&quot;');
  });
  
  test('should handle null and undefined', () => {
    assert.strictEqual(escapeXml(null), '');
    assert.strictEqual(escapeXml(undefined), '');
  });
});

describe('wrapText', () => {
  test('should wrap long text', () => {
    const lines = wrapText('This is a very long text that needs to be wrapped');
    assert.ok(lines.length > 1);
  });
  
  test('should limit to 3 lines', () => {
    const longText = 'word '.repeat(50);
    const lines = wrapText(longText);
    assert.ok(lines.length <= 3);
  });
  
  test('should handle short text', () => {
    const lines = wrapText('Short');
    assert.strictEqual(lines.length, 1);
    assert.strictEqual(lines[0], 'Short');
  });
});

describe('renderArchitecture', () => {
  test('should render architecture diagram', () => {
    const structure = {
      nodes: [
        { id: 'api', label: 'API Gateway', group: 'frontend' },
        { id: 'db', label: 'Database', group: 'backend' }
      ],
      edges: [
        { from: 'api', to: 'db', label: 'queries' }
      ]
    };
    
    const svg = renderArchitecture(structure, { primary: '#1F4E79' });
    
    assert.ok(svg.includes('<svg'));
    assert.ok(svg.includes('API Gateway'));
    assert.ok(svg.includes('Database'));
    assert.ok(svg.includes('queries'));
    assert.ok(svg.includes('viewBox="0 0 1600 700"'));
  });
  
  test('should handle empty structure', () => {
    const svg = renderArchitecture({});
    assert.ok(svg.includes('À compléter'));
  });
  
  test('should escape labels', () => {
    const structure = {
      nodes: [{ id: 'n1', label: '<script>alert("xss")</script>' }],
      edges: []
    };
    
    const svg = renderArchitecture(structure);
    assert.ok(!svg.includes('<script>'));
    assert.ok(svg.includes('&lt;script&gt;'));
  });
  
  test('should group nodes', () => {
    const structure = {
      nodes: [
        { id: 'n1', label: 'Node 1', group: 'A' },
        { id: 'n2', label: 'Node 2', group: 'A' },
        { id: 'n3', label: 'Node 3', group: 'B' }
      ],
      edges: []
    };
    
    const svg = renderArchitecture(structure);
    assert.ok(svg.includes('Node 1'));
    assert.ok(svg.includes('Node 2'));
    assert.ok(svg.includes('Node 3'));
  });
});

describe('renderRoadmap', () => {
  test('should render roadmap diagram', () => {
    const structure = {
      phases: [
        { phase: 'Design', weeks: 2, roles: [] },
        { phase: 'Development', weeks: 8, roles: [] },
        { phase: 'Testing', weeks: 2, roles: [] }
      ]
    };
    
    const svg = renderRoadmap(structure, { primary: '#1F4E79' });
    
    assert.ok(svg.includes('<svg'));
    assert.ok(svg.includes('Design'));
    assert.ok(svg.includes('Development'));
    assert.ok(svg.includes('Testing'));
    assert.ok(svg.includes('2 sem.'));
    assert.ok(svg.includes('8 sem.'));
  });
  
  test('should handle empty phases', () => {
    const svg = renderRoadmap({});
    assert.ok(svg.includes('À compléter'));
  });
  
  test('should calculate total weeks correctly', () => {
    const structure = {
      phases: [
        { phase: 'Phase 1', weeks: 3, roles: [] },
        { phase: 'Phase 2', weeks: 5, roles: [] }
      ]
    };
    
    const svg = renderRoadmap(structure);
    // Should show both phases
    assert.ok(svg.includes('3 sem.'));
    assert.ok(svg.includes('5 sem.'));
  });
});

describe('renderClassDiagram', () => {
  test('should render class diagram', () => {
    const structure = {
      classes: [
        {
          name: 'User',
          attributes: ['id', 'name', 'email'],
          methods: ['login()', 'logout()']
        },
        {
          name: 'Order',
          attributes: ['id', 'total'],
          methods: ['calculate()']
        }
      ]
    };
    
    const svg = renderClassDiagram(structure, { primary: '#1F4E79' });
    
    assert.ok(svg.includes('<svg'));
    assert.ok(svg.includes('User'));
    assert.ok(svg.includes('Order'));
    assert.ok(svg.includes('login()'));
    assert.ok(svg.includes('email'));
  });
  
  test('should handle empty classes', () => {
    const svg = renderClassDiagram({});
    assert.ok(svg.includes('À compléter'));
  });
  
  test('should limit attributes and methods', () => {
    const structure = {
      classes: [{
        name: 'BigClass',
        attributes: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'],
        methods: ['m1()', 'm2()', 'm3()', 'm4()', 'm5()']
      }]
    };
    
    const svg = renderClassDiagram(structure);
    // Should show only first 4 of each
    assert.ok(svg.includes('a1'));
    assert.ok(svg.includes('a4'));
    assert.ok(!svg.includes('a5'));
  });
});

describe('renderPlaceholder', () => {
  test('should render placeholder SVG', () => {
    const svg = renderPlaceholder('Test Diagram', 800, 600);
    
    assert.ok(svg.includes('<svg'));
    assert.ok(svg.includes('viewBox="0 0 800 600"'));
    assert.ok(svg.includes('Test Diagram'));
    assert.ok(svg.includes('À compléter'));
  });
});

describe('scanSVGSecurity', () => {
  test('should pass safe SVG', () => {
    const safeSvg = '<svg><rect x="0" y="0" width="100" height="100"/></svg>';
    const result = scanSVGSecurity(safeSvg);
    
    assert.strictEqual(result.safe, true);
    assert.strictEqual(result.violations.length, 0);
  });
  
  test('should detect script tags', () => {
    const malicious = '<svg><script>alert("xss")</script></svg>';
    const result = scanSVGSecurity(malicious);
    
    assert.strictEqual(result.safe, false);
    assert.ok(result.violations.some(v => v.includes('script')));
  });
  
  test('should detect onclick', () => {
    const malicious = '<svg><rect onclick="alert(1)"/></svg>';
    const result = scanSVGSecurity(malicious);
    
    assert.strictEqual(result.safe, false);
    assert.ok(result.violations.some(v => v.includes('onclick')));
  });
  
  test('should detect onload', () => {
    const malicious = '<svg onload="alert(1)"></svg>';
    const result = scanSVGSecurity(malicious);
    
    assert.strictEqual(result.safe, false);
    assert.ok(result.violations.some(v => v.includes('onload')));
  });
  
  test('should detect javascript: URLs', () => {
    const malicious = '<svg><a href="javascript:alert(1)">link</a></svg>';
    const result = scanSVGSecurity(malicious);
    
    assert.strictEqual(result.safe, false);
    assert.ok(result.violations.some(v => v.includes('javascript:')));
  });
  
  test('should detect multiple violations', () => {
    const malicious = '<svg onclick="bad()" onload="worse()"><script>alert(1)</script></svg>';
    const result = scanSVGSecurity(malicious);
    
    assert.strictEqual(result.safe, false);
    assert.ok(result.violations.length >= 3);
  });
});

describe('SVG Integration', () => {
  test('rendered SVG should pass security scan', () => {
    const arch = renderArchitecture({ nodes: [{ id: 'n1', label: 'Test' }], edges: [] });
    assert.strictEqual(scanSVGSecurity(arch).safe, true);
    
    const roadmap = renderRoadmap({ phases: [{ phase: 'P1', weeks: 2 }] });
    assert.strictEqual(scanSVGSecurity(roadmap).safe, true);
    
    const classes = renderClassDiagram({ classes: [{ name: 'C1', attributes: [], methods: [] }] });
    assert.strictEqual(scanSVGSecurity(classes).safe, true);
  });
  
  test('all diagrams should have proper SVG structure', () => {
    const diagrams = [
      renderArchitecture({ nodes: [{ id: 'n1', label: 'Test' }], edges: [] }),
      renderRoadmap({ phases: [{ phase: 'P1', weeks: 2 }] }),
      renderClassDiagram({ classes: [{ name: 'C1', attributes: [], methods: [] }] })
    ];
    
    diagrams.forEach(svg => {
      assert.ok(svg.startsWith('<svg'));
      assert.ok(svg.includes('xmlns="http://www.w3.org/2000/svg"'));
      assert.ok(svg.includes('viewBox'));
      assert.ok(svg.endsWith('</svg>'));
    });
  });
});
