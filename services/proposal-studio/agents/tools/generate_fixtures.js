#!/usr/bin/env node
/**
 * generate_fixtures.js - Generates stub fixtures for all test inputs
 * Run: node agents/tools/generate_fixtures.js
 */

const fs = require('fs');
const path = require('path');

const INPUTS_DIR = path.join(__dirname, '..', '..', 'tests', 'inputs');
const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures');

const INPUT_FILES = ['software.json', 'thin.json', 'non_software.json', 'injection.json', 'many_projects.json'];

// Generate Agent 1 fixture (Requirements)
function generateAgent1Fixture(input, inputId) {
  const tender = input.tender || {};
  const match = input.match || {};
  const reqCount = (tender.requirements || []).length;
  
  return {
    agent: 'requirements',
    ok: true,
    slides: [
      {
        id: 's1',
        type: 'content',
        title: tender.language === 'en' ? 'Executive Summary' : 'Synthèse exécutive',
        blocks: [
          {
            kind: 'text',
            text: `Notre équipe propose une solution complète pour ${tender.title || 'votre projet'}.`
          },
          {
            kind: 'kpis',
            items: [
              { label: 'Projets similaires', value: String(match.similar_projects?.length || 0) },
              { label: 'Score de correspondance', value: `${Math.round((match.score || 0) * 100)}%` },
              { label: 'Ingénieurs spécialisés', value: String(match.engineers?.specialized || 0) }
            ]
          },
          {
            kind: 'bullets',
            items: [
              'Solution éprouvée et conforme aux exigences',
              'Équipe expérimentée sur des projets similaires',
              'Méthodologie agile garantissant une livraison progressive'
            ]
          }
        ]
      },
      {
        id: 's2',
        type: 'content',
        title: tender.language === 'en' ? 'Understanding Your Needs' : 'Compréhension de vos besoins',
        blocks: [
          {
            kind: 'bullets',
            items: (tender.requirements || []).slice(0, 6).map(r => 
              `${r.substring(0, 80)}${r.length > 80 ? '...' : ''}`
            )
          }
        ]
      },
      {
        id: 's3',
        type: 'content',
        title: tender.language === 'en' ? 'Proposed Solution and Compliance' : 'Solution proposée et conformité',
        blocks: [
          {
            kind: 'table',
            columns: ['Exigence', 'Notre réponse', 'Preuve'],
            rows: (tender.requirements || []).map((req, idx) => [
              req.substring(0, 50),
              'Solution technique adaptée',
              match.similar_projects?.[0]?.name || 'À préciser'
            ])
          }
        ]
      },
      {
        id: 's11',
        type: 'content',
        title: tender.language === 'en' ? 'Next Steps' : 'Prochaines étapes',
        blocks: [
          {
            kind: 'bullets',
            items: [
              'Atelier de cadrage et validation des exigences',
              'Conception détaillée et plan de déploiement',
              'Démarrage du développement après validation'
            ]
          },
          {
            kind: 'text',
            text: '[TO FILL: contact]'
          }
        ]
      }
    ],
    data: {
      requirement_list: tender.requirements || [],
      project_type: tender.project_type || 'other',
      key_features: ['Feature 1', 'Feature 2', 'Feature 3']
    },
    assumptions: [],
    warnings: [],
    usage: {
      model: 'mock-model',
      promptTokens: 1000,
      completionTokens: 500,
      ms: 150,
      attempts: 1
    }
  };
}

// Generate Agent 5 fixture (Credibility)
function generateAgent5Fixture(input, inputId) {
  const tender = input.tender || {};
  const match = input.match || {};
  const lang = tender.language || 'fr';
  
  const topProjects = (match.similar_projects || []).slice(0, 3);
  
  return {
    agent: 'credibility',
    ok: true,
    slides: [
      {
        id: 's4',
        type: 'content',
        title: lang === 'en' ? 'Our Strengths' : 'Nos atouts',
        blocks: [
          {
            kind: 'bullets',
            items: (match.why_us || []).slice(0, 5)
          }
        ]
      },
      {
        id: 's6',
        type: 'content',
        title: lang === 'en' ? 'Team and Governance' : 'Équipe et gouvernance',
        blocks: [
          {
            kind: 'table',
            columns: ['Rôle', 'Effectif', 'Niveau'],
            rows: (match.engineers?.profiles || []).map(p => [
              p.role,
              String(p.count),
              'Senior'
            ])
          },
          {
            kind: 'bullets',
            items: [
              'Comité de pilotage hebdomadaire',
              'Revues techniques bi-mensuelles',
              'Points d\'avancement quotidiens'
            ]
          }
        ]
      },
      {
        id: 's7',
        type: 'content',
        title: lang === 'en' ? 'Relevant References' : 'Références pertinentes',
        blocks: [
          {
            kind: 'cards',
            cards: topProjects.map(p => ({
              title: p.name,
              text: `${p.client} (${p.year}). ${p.result.substring(0, 80)}`
            }))
          }
        ]
      },
      {
        id: 's8',
        type: 'content',
        title: lang === 'en' ? 'Support and SLA' : 'Support et SLA',
        blocks: [
          {
            kind: 'bullets',
            items: [
              'Support niveau 1, 2 et 3 en français',
              '[TO FILL: SLA levels]',
              'Garantie de disponibilité 99.9%'
            ]
          }
        ]
      }
    ],
    data: {
      evidence: {
        'expertise': topProjects.map(p => p.name),
        'certifications': match.certifications?.list || []
      }
    },
    assumptions: ['Gouvernance standard proposée, à adapter selon besoins client'],
    warnings: [],
    usage: {
      model: 'mock-model',
      promptTokens: 800,
      completionTokens: 400,
      ms: 120,
      attempts: 1
    }
  };
}

// Generate Diagrams fixture
function generateDiagramsFixture(input, inputId) {
  const tender = input.tender || {};
  const lang = tender.language || 'fr';
  
  return {
    agent: 'diagrams',
    ok: true,
    slides: [
      {
        id: 's3b',
        type: 'content',
        title: lang === 'en' ? 'Technical Architecture' : 'Architecture technique',
        blocks: [
          {
            kind: 'image',
            src: '/uploads/mock_architecture.svg',
            caption: 'Architecture en microservices conteneurisés'
          },
          {
            kind: 'bullets',
            items: [
              'Frontend : Interface utilisateur responsive',
              'Backend : API REST sécurisées',
              'Base de données : PostgreSQL haute disponibilité',
              'Infrastructure : Kubernetes orchestré'
            ]
          }
        ],
        sources: {
          mermaid: 'graph TD; A[Frontend] --> B[API]; B --> C[Database];'
        }
      },
      {
        id: 's3c',
        type: 'content',
        title: lang === 'en' ? 'Class Model' : 'Modèle de classes',
        blocks: [
          {
            kind: 'image',
            src: '/uploads/mock_classes.svg',
            caption: 'Modèle de données principal'
          }
        ],
        sources: {
          mermaid: 'classDiagram; User <|-- Admin; User : +login(); User : +logout();'
        }
      },
      {
        id: 's5',
        type: 'content',
        title: lang === 'en' ? 'Implementation Plan' : 'Plan de mise en oeuvre',
        blocks: [
          {
            kind: 'image',
            src: '/uploads/mock_roadmap.svg',
            caption: 'Planning prévisionnel'
          },
          {
            kind: 'table',
            columns: ['Phase', 'Durée (semaines)', 'Équipe'],
            rows: [
              ['Cadrage et conception', '4', '2 PM + 2 Backend'],
              ['Développement socle', '8', '4 Backend + 3 Frontend'],
              ['Tests et déploiement', '4', 'Toute l\'équipe'],
              ['Recette et mise en production', '2', '2 DevOps + 1 QA']
            ]
          },
          {
            kind: 'note',
            text: 'Durée totale estimée : 18 semaines'
          }
        ],
        sources: {
          mermaid: 'gantt; section Phase1; Cadrage: 4w;'
        }
      },
      {
        id: 's10',
        type: 'content',
        title: lang === 'en' ? 'Risks and Mitigation' : 'Risques et mitigation',
        blocks: [
          {
            kind: 'table',
            columns: ['Risque', 'Impact', 'Mitigation'],
            rows: [
              ['Retard de livraison', 'Moyen', 'Méthode agile avec sprints courts et livraisons progressives'],
              ['Complexité technique', 'Élevé', 'Architecture modulaire et tests continus'],
              ['Conformité RGAA', 'Moyen', 'Audit accessibilité dès les premières maquettes'],
              ['Sécurité des données', 'Élevé', 'Chiffrement bout en bout et audits de sécurité réguliers']
            ]
          }
        ]
      }
    ],
    data: {
      components: ['Frontend', 'Backend', 'Database', 'Infrastructure'],
      plan: [
        { phase: 'Cadrage', weeks: 4, roles: [{ role: 'PM', people: 2 }, { role: 'Backend', people: 2 }] },
        { phase: 'Développement', weeks: 8, roles: [{ role: 'Backend', people: 4 }, { role: 'Frontend', people: 3 }] },
        { phase: 'Tests', weeks: 4, roles: [{ role: 'QA', people: 2 }, { role: 'DevOps', people: 2 }] },
        { phase: 'Production', weeks: 2, roles: [{ role: 'DevOps', people: 2 }, { role: 'QA', people: 1 }] }
      ],
      risks: [
        { risk: 'Retard', impact: 'medium', mitigation: 'Agile' },
        { risk: 'Complexité', impact: 'high', mitigation: 'Architecture modulaire' }
      ]
    },
    assumptions: [],
    warnings: [],
    usage: {
      model: 'mock-model',
      promptTokens: 1200,
      completionTokens: 600,
      ms: 180,
      attempts: 1
    }
  };
}

// Generate Agent 4 fixture (Budget)
function generateAgent4Fixture(input, inputId) {
  const tender = input.tender || {};
  const lang = tender.language || 'fr';
  
  return {
    agent: 'budget',
    ok: true,
    slides: [
      {
        id: 's9',
        type: 'content',
        title: lang === 'en' ? 'Financial Proposal' : 'Offre financière',
        blocks: [
          {
            kind: 'table',
            columns: ['Poste', 'Quantité', 'Prix unitaire', 'Total'],
            rows: [
              ['Développement (Backend)', '160 j/h', '[TO FILL: tarif Backend]', '[TO FILL: total]'],
              ['Développement (Frontend)', '120 j/h', '[TO FILL: tarif Frontend]', '[TO FILL: total]'],
              ['DevOps et infrastructure', '80 j/h', '[TO FILL: tarif DevOps]', '[TO FILL: total]'],
              ['Gestion de projet', '80 j/h', '[TO FILL: tarif PM]', '[TO FILL: total]'],
              ['Tests et qualité', '40 j/h', '[TO FILL: tarif QA]', '[TO FILL: total]'],
              ['', '', 'Total Build', '[TO FILL: total]']
            ]
          },
          {
            kind: 'note',
            text: 'Montant one-time : [TO FILL: total]. Coûts récurrents : [TO FILL: total]/mois.'
          }
        ],
        requiresApproval: true,
        assumptions: [
          'Catalogue de prix du 2026-01-01',
          'Jours ouvrés par semaine : 5',
          'Estimations basées sur le plan de mise en oeuvre'
        ],
        catalogDate: '2026-01-01'
      }
    ],
    data: {
      people: [
        { role: 'backend', days: 160 },
        { role: 'frontend', days: 120 },
        { role: 'devops', days: 80 },
        { role: 'pm', days: 80 },
        { role: 'qa', days: 40 }
      ],
      infrastructure: [],
      api_usage: [],
      licenses: []
    },
    assumptions: ['Catalogue de prix du 2026-01-01', 'Jours ouvrés par semaine : 5'],
    warnings: ['Catalog prices not yet loaded - all prices shown as [TO FILL]'],
    usage: {
      model: 'mock-model',
      promptTokens: 600,
      completionTokens: 300,
      ms: 100,
      attempts: 1
    }
  };
}

// Generate Agent 6 fixture (Reviewer - returns ok for stubs)
function generateAgent6Fixture(input, inputId) {
  return {
    agent: 'reviewer',
    ok: true,
    slides: [], // Reviewer doesn't add slides, just validates
    data: {
      status: 'ok',
      problems: []
    },
    assumptions: [],
    warnings: [],
    usage: {
      model: 'mock-model',
      promptTokens: 500,
      completionTokens: 100,
      ms: 80,
      attempts: 1
    }
  };
}

// Main
function main() {
  console.log('Generating stub fixtures for all test inputs...\n');
  
  for (const inputFile of INPUT_FILES) {
    const inputPath = path.join(INPUTS_DIR, inputFile);
    const inputId = path.basename(inputFile, '.json');
    
    if (!fs.existsSync(inputPath)) {
      console.log(`⊘ Skip ${inputFile} (not found)`);
      continue;
    }
    
    const input = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));
    
    // Generate fixtures for each agent
    const agent1 = generateAgent1Fixture(input, inputId);
    const agent5 = generateAgent5Fixture(input, inputId);
    const diagrams = generateDiagramsFixture(input, inputId);
    const agent4 = generateAgent4Fixture(input, inputId);
    const agent6 = generateAgent6Fixture(input, inputId);
    
    // Don't generate s3c for non-software projects
    if (input.tender?.project_type !== 'software' && input.tender?.project_type !== 'saas') {
      diagrams.slides = diagrams.slides.filter(s => s.id !== 's3c');
    }
    
    // Write fixtures
    fs.writeFileSync(
      path.join(FIXTURES_DIR, 'agent1', `${inputId}.json`),
      JSON.stringify(agent1, null, 2)
    );
    fs.writeFileSync(
      path.join(FIXTURES_DIR, 'agent5', `${inputId}.json`),
      JSON.stringify(agent5, null, 2)
    );
    fs.writeFileSync(
      path.join(FIXTURES_DIR, 'diagrams', `${inputId}.json`),
      JSON.stringify(diagrams, null, 2)
    );
    fs.writeFileSync(
      path.join(FIXTURES_DIR, 'agent4', `${inputId}.json`),
      JSON.stringify(agent4, null, 2)
    );
    fs.writeFileSync(
      path.join(FIXTURES_DIR, 'agent6', `${inputId}.json`),
      JSON.stringify(agent6, null, 2)
    );
    
    console.log(`✓ ${inputFile} -> fixtures generated`);
  }
  
  console.log('\n✅ All fixtures generated');
}

main();
