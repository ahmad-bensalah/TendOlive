/**
 * rank.test.js - Tests for reference project ranking
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { extractKeywords, computeOverlap, rankProject, rankProjects, selectReferences } = require('../lib/rank.js');

describe('extractKeywords', () => {
  test('should extract lowercase words', () => {
    const keywords = extractKeywords('Application Mobile React Native');
    assert.ok(keywords.has('application'));
    assert.ok(keywords.has('mobile'));
    assert.ok(keywords.has('react'));
    assert.ok(keywords.has('native'));
  });
  
  test('should filter stop words', () => {
    const keywords = extractKeywords('le portail pour les citoyens');
    assert.ok(keywords.has('portail'));
    assert.ok(keywords.has('citoyens'));
    assert.ok(!keywords.has('le'));
    assert.ok(!keywords.has('pour'));
  });
  
  test('should handle French accents', () => {
    const keywords = extractKeywords('Système de gestion électronique');
    assert.ok(keywords.has('système'));
    assert.ok(keywords.has('gestion'));
    assert.ok(keywords.has('électronique'));
  });
  
  test('should return empty set for invalid input', () => {
    assert.strictEqual(extractKeywords(null).size, 0);
    assert.strictEqual(extractKeywords('').size, 0);
  });
});

describe('computeOverlap', () => {
  test('should compute Jaccard similarity', () => {
    const setA = new Set(['react', 'mobile', 'app']);
    const setB = new Set(['react', 'native', 'mobile']);
    const overlap = computeOverlap(setA, setB);
    // Intersection: {react, mobile} = 2
    // Union: {react, mobile, app, native} = 4
    // Jaccard = 2/4 = 0.5
    assert.strictEqual(overlap, 0.5);
  });
  
  test('should return 0 for empty sets', () => {
    const setA = new Set(['react']);
    const setB = new Set();
    assert.strictEqual(computeOverlap(setA, setB), 0);
  });
  
  test('should return 1 for identical sets', () => {
    const setA = new Set(['react', 'mobile']);
    const setB = new Set(['react', 'mobile']);
    assert.strictEqual(computeOverlap(setA, setB), 1);
  });
});

describe('rankProject', () => {
  test('should score recent project with keyword overlap', () => {
    const project = {
      name: 'Application Mobile Citoyenne',
      year: 2025,
      stack: ['React Native', 'Node.js'],
      project_type: 'software'
    };
    
    const context = {
      requirements: ['Application mobile', 'React Native'],
      projectType: 'software',
      currentYear: 2026
    };
    
    const score = rankProject(project, context);
    // Should get points for overlap + recency + type match
    assert.ok(score > 50, `Score ${score} should be > 50`);
  });
  
  test('should penalize old projects', () => {
    const recentProject = {
      name: 'Project A',
      year: 2025,
      stack: ['React'],
      project_type: 'software'
    };
    
    const oldProject = {
      name: 'Project B',
      year: 2015,
      stack: ['React'],
      project_type: 'software'
    };
    
    const context = {
      requirements: ['React application'],
      projectType: 'software',
      currentYear: 2026
    };
    
    const scoreRecent = rankProject(recentProject, context);
    const scoreOld = rankProject(oldProject, context);
    
    assert.ok(scoreRecent > scoreOld, 'Recent project should score higher');
  });
  
  test('should give bonus for matching project type', () => {
    const project = {
      name: 'Software Project',
      year: 2025,
      stack: ['Java'],
      project_type: 'software'
    };
    
    const withMatch = rankProject(project, {
      requirements: ['Java application'],
      projectType: 'software',
      currentYear: 2026
    });
    
    const withoutMatch = rankProject(project, {
      requirements: ['Java application'],
      projectType: 'other',
      currentYear: 2026
    });
    
    assert.ok(withMatch > withoutMatch, 'Type match should increase score');
  });
  
  test('should handle missing fields gracefully', () => {
    const project = {
      name: 'Minimal Project'
    };
    
    const context = {
      requirements: ['test'],
      currentYear: 2026
    };
    
    const score = rankProject(project, context);
    assert.ok(score >= 0, 'Should return non-negative score');
  });
});

describe('rankProjects', () => {
  test('should rank multiple projects by score', () => {
    const projects = [
      {
        name: 'Old Project',
        year: 2015,
        stack: ['PHP']
      },
      {
        name: 'Recent Relevant Project',
        year: 2025,
        stack: ['React', 'Node.js']
      },
      {
        name: 'Medium Project',
        year: 2022,
        stack: ['React']
      }
    ];
    
    const context = {
      requirements: ['React application', 'Node.js backend'],
      projectType: 'software',
      currentYear: 2026
    };
    
    const ranked = rankProjects(projects, context, 3);
    
    assert.strictEqual(ranked.length, 3);
    assert.strictEqual(ranked[0].name, 'Recent Relevant Project');
    assert.ok(ranked[0]._score > ranked[1]._score);
    assert.ok(ranked[1]._score > ranked[2]._score);
  });
  
  test('should limit to topN projects', () => {
    const projects = [
      { name: 'P1', year: 2025, stack: ['A'] },
      { name: 'P2', year: 2024, stack: ['B'] },
      { name: 'P3', year: 2023, stack: ['C'] },
      { name: 'P4', year: 2022, stack: ['D'] }
    ];
    
    const context = {
      requirements: ['test'],
      currentYear: 2026
    };
    
    const ranked = rankProjects(projects, context, 2);
    assert.strictEqual(ranked.length, 2);
  });
  
  test('should return empty array for no projects', () => {
    const ranked = rankProjects([], { requirements: [], currentYear: 2026 }, 3);
    assert.strictEqual(ranked.length, 0);
  });
  
  test('should handle fewer projects than topN', () => {
    const projects = [
      { name: 'P1', year: 2025, stack: ['A'] }
    ];
    
    const ranked = rankProjects(projects, { requirements: [], currentYear: 2026 }, 3);
    assert.strictEqual(ranked.length, 1);
  });
});

describe('selectReferences', () => {
  test('should select top 3 projects from input', () => {
    const input = {
      tender: {
        requirements: ['Application mobile', 'React Native'],
        project_type: 'software'
      },
      match: {
        similar_projects: [
          { name: 'Old PHP Project', year: 2015, stack: ['PHP'] },
          { name: 'Recent Mobile App', year: 2025, stack: ['React Native', 'Mobile'] },
          { name: 'Recent Backend', year: 2025, stack: ['Node.js'] },
          { name: 'Another Mobile', year: 2024, stack: ['React Native', 'iOS'] }
        ]
      }
    };
    
    const refs = selectReferences(input);
    
    assert.strictEqual(refs.length, 3);
    assert.ok(refs[0]._score > 0);
    // Recent mobile app should rank high
    assert.ok(refs[0].name.includes('Mobile'));
  });
  
  test('should return top 2 if only 2 projects exist', () => {
    const input = {
      match: {
        similar_projects: [
          { name: 'P1', year: 2025, stack: ['A'] },
          { name: 'P2', year: 2024, stack: ['B'] }
        ]
      }
    };
    
    const refs = selectReferences(input);
    assert.strictEqual(refs.length, 2);
  });
  
  test('should return empty array for no projects', () => {
    const input = {
      match: {
        similar_projects: []
      }
    };
    
    const refs = selectReferences(input);
    assert.strictEqual(refs.length, 0);
  });
  
  test('should handle missing match data', () => {
    const input = {};
    const refs = selectReferences(input);
    assert.strictEqual(refs.length, 0);
  });
});
