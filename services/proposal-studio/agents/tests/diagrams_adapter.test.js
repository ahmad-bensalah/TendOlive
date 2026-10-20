/**
 * diagrams_adapter.test.js - Tests for diagrams → slides adapter
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  adaptDiagramsToSlides,
  buildArchitectureSlide,
  buildClassSlide,
  buildRoadmapSlide,
  buildPlanTable,
  buildRisksSlide
} = require('../lib/diagrams_adapter.js');

describe('buildArchitectureSlide', () => {
  test('should build s3b with image and components', () => {
    const diagram = {
      id: 'architecture',
      src: '/uploads/abc123_arch.svg',
      caption: 'Architecture',
      sources: { mermaid: 'graph LR...' }
    };
    
    const data = {
      components: ['API Gateway', 'Database', 'Cache']
    };
    
    const slide = buildArchitectureSlide(diagram, data, 'fr');
    
    assert.strictEqual(slide.id, 's3b');
    assert.strictEqual(slide.type, 'content');
    assert.ok(slide.title.includes('Architecture'));
    assert.strictEqual(slide.blocks.length, 2); // Image + bullets
    assert.strictEqual(slide.blocks[0].kind, 'image');
    assert.strictEqual(slide.blocks[0].src, '/uploads/abc123_arch.svg');
    assert.strictEqual(slide.blocks[1].kind, 'bullets');
    assert.strictEqual(slide.blocks[1].items.length, 3);
    assert.ok(slide.sources);
  });
  
  test('should limit components to 6', () => {
    const diagram = { src: '/uploads/test.svg' };
    const data = {
      components: ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8']
    };
    
    const slide = buildArchitectureSlide(diagram, data, 'fr');
    const bullets = slide.blocks.find(b => b.kind === 'bullets');
    
    assert.strictEqual(bullets.items.length, 6);
  });
  
  test('should handle missing src', () => {
    const diagram = { id: 'architecture' };
    const data = { components: [] };
    
    const slide = buildArchitectureSlide(diagram, data, 'fr');
    
    assert.ok(slide.blocks.some(b => b.kind === 'note'));
  });
  
  test('should reject invalid src paths', () => {
    const diagram = { src: 'http://evil.com/image.svg' };
    const data = {};
    
    const slide = buildArchitectureSlide(diagram, data, 'fr');
    
    assert.ok(slide.warnings);
    assert.ok(slide.blocks.some(b => b.text && b.text.includes('[TO FILL')));
  });
});

describe('buildClassSlide', () => {
  test('should build s3c with image', () => {
    const diagram = {
      id: 'class',
      src: '/uploads/abc123_class.svg',
      caption: 'Classes',
      sources: { mermaid: 'classDiagram...' }
    };
    
    const slide = buildClassSlide(diagram, 'en');
    
    assert.strictEqual(slide.id, 's3c');
    assert.strictEqual(slide.type, 'content');
    assert.ok(slide.title.includes('Class'));
    assert.strictEqual(slide.blocks[0].kind, 'image');
    assert.ok(slide.sources);
  });
  
  test('should handle missing src', () => {
    const diagram = { id: 'class' };
    const slide = buildClassSlide(diagram, 'fr');
    
    assert.ok(slide.blocks.some(b => b.kind === 'note'));
  });
});

describe('buildPlanTable', () => {
  test('should build plan table', () => {
    const plan = [
      {
        phase: 'Design',
        weeks: 2,
        roles: [
          { role: 'Backend', people: 2 },
          { role: 'Frontend', people: 1 }
        ]
      },
      {
        phase: 'Development',
        weeks: 8,
        roles: [{ role: 'Backend', people: 3 }]
      }
    ];
    
    const table = buildPlanTable(plan, 'fr');
    
    assert.strictEqual(table.kind, 'table');
    assert.strictEqual(table.columns.length, 3);
    assert.strictEqual(table.rows.length, 2);
    assert.strictEqual(table.rows[0][0], 'Design');
    assert.strictEqual(table.rows[0][1], '2');
    assert.ok(table.rows[0][2].includes('Backend'));
  });
  
  test('should limit to 10 rows', () => {
    const plan = Array(15).fill(null).map((_, i) => ({
      phase: `Phase ${i}`,
      weeks: 1,
      roles: []
    }));
    
    const table = buildPlanTable(plan, 'fr');
    assert.strictEqual(table.rows.length, 10);
  });
  
  test('should handle empty plan', () => {
    const table = buildPlanTable([], 'fr');
    assert.strictEqual(table, null);
  });
});

describe('buildRoadmapSlide', () => {
  test('should build s5 with image and table', () => {
    const diagram = {
      id: 'roadmap',
      src: '/uploads/roadmap.svg',
      sources: { mermaid: 'gantt...' }
    };
    
    const plan = [
      { phase: 'Phase 1', weeks: 4, roles: [] },
      { phase: 'Phase 2', weeks: 6, roles: [] }
    ];
    
    const slide = buildRoadmapSlide(diagram, plan, 'en');
    
    assert.strictEqual(slide.id, 's5');
    assert.ok(slide.title.includes('Plan'));
    assert.ok(slide.blocks.some(b => b.kind === 'image'));
    assert.ok(slide.blocks.some(b => b.kind === 'table'));
    // Total weeks is the last table row (a separate note pushed it onto a continuation slide)
    const table = slide.blocks.find(b => b.kind === 'table');
    assert.deepStrictEqual(table.rows[table.rows.length - 1].slice(0, 2), ['Total duration', '10']);
    assert.ok(!slide.blocks.some(b => b.kind === 'note'));
  });
  
  test('should calculate total weeks', () => {
    const diagram = { src: '/uploads/test.svg' };
    const plan = [
      { phase: 'P1', weeks: 3, roles: [] },
      { phase: 'P2', weeks: 5, roles: [] },
      { phase: 'P3', weeks: 2, roles: [] }
    ];
    
    const slide = buildRoadmapSlide(diagram, plan, 'fr');
    const table = slide.blocks.find(b => b.kind === 'table');
    
    assert.deepStrictEqual(table.rows[table.rows.length - 1].slice(0, 2), ['Durée totale', '10']);
  });
});

describe('buildRisksSlide', () => {
  test('should build s10 with risks table', () => {
    const risks = [
      { risk: 'Risk 1', impact: 'high', mitigation: 'Mitigation 1' },
      { risk: 'Risk 2', impact: 'medium', mitigation: 'Mitigation 2' }
    ];
    
    const slide = buildRisksSlide(risks, 'fr');
    
    assert.strictEqual(slide.id, 's10');
    assert.strictEqual(slide.type, 'content');
    assert.ok(slide.title.includes('Risques'));
    assert.strictEqual(slide.blocks[0].kind, 'table');
    assert.strictEqual(slide.blocks[0].rows.length, 2);
    assert.strictEqual(slide.blocks[0].rows[0][0], 'Risk 1');
    assert.ok(slide.blocks[0].rows[0][1].includes('levé')); // French translation
  });
  
  test('should limit to 5 risks', () => {
    const risks = Array(10).fill(null).map((_, i) => ({
      risk: `Risk ${i}`,
      impact: 'low',
      mitigation: `Mit ${i}`
    }));
    
    const slide = buildRisksSlide(risks, 'en');
    assert.strictEqual(slide.blocks[0].rows.length, 5);
  });
  
  test('should handle missing mitigation', () => {
    const risks = [{ risk: 'R1', impact: 'high' }];
    const slide = buildRisksSlide(risks, 'fr');
    
    assert.ok(slide.blocks[0].rows[0][2].includes('[TO FILL'));
  });
});

describe('adaptDiagramsToSlides', () => {
  test('should adapt complete diagrams output (software)', () => {
    const diagramsOutput = {
      diagrams: [
        { id: 'architecture', src: '/uploads/arch.svg', sources: { mermaid: '...' } },
        { id: 'roadmap', src: '/uploads/road.svg', sources: { mermaid: '...' } },
        { id: 'class', src: '/uploads/class.svg', sources: { mermaid: '...' } }
      ],
      data: {
        components: ['API', 'DB'],
        plan: [{ phase: 'P1', weeks: 4, roles: [] }],
        risks: [{ risk: 'R1', impact: 'low', mitigation: 'M1' }]
      }
    };
    
    const input = {
      tender: { language: 'fr', project_type: 'software' }
    };
    
    const result = adaptDiagramsToSlides(diagramsOutput, input);
    
    assert.ok(result.slides.length >= 3); // s3b, s5, s10
    assert.ok(result.slides.some(s => s.id === 's3b'));
    assert.ok(!result.slides.some(s => s.id === 's3c'));   // class diagram removed for all decks
    assert.ok(result.slides.some(s => s.id === 's5'));
    assert.ok(result.slides.some(s => s.id === 's10'));
  });
  
  test('should exclude s3c for non-software projects', () => {
    const diagramsOutput = {
      diagrams: [
        { id: 'architecture', src: '/uploads/arch.svg' },
        { id: 'roadmap', src: '/uploads/road.svg' }
      ],
      data: {
        components: [],
        plan: [{ phase: 'P1', weeks: 4, roles: [] }],
        risks: []
      }
    };
    
    const input = {
      tender: { language: 'fr', project_type: 'other' }
    };
    
    const result = adaptDiagramsToSlides(diagramsOutput, input);
    
    assert.ok(!result.slides.some(s => s.id === 's3c'));
  });
  
  test('should generate warnings for missing diagrams', () => {
    const diagramsOutput = {
      diagrams: [],
      data: {}
    };
    
    const input = {
      tender: { language: 'en', project_type: 'software' }
    };
    
    const result = adaptDiagramsToSlides(diagramsOutput, input);
    
    assert.ok(result.warnings.length > 0);
    assert.ok(result.warnings.some(w => w.includes('missing')));
  });
});
