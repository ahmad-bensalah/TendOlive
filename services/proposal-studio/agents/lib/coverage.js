/**
 * coverage.js - Requirements coverage score, computed by code (never by the LLM).
 *
 * Per requirement: covered (weight 1), partial (0.5) or to_clarify (0).
 *  - With match.requirement_coverage (the RAG matrix): score >= 0.75 covered, 0.4..0.75 partial,
 *    below 0.4 to_clarify.
 *  - Otherwise a heuristic: the requirement's words (without stop words) compared with each
 *    evidence item (certification, project name/stack/result, why-us point): 2+ distinct words in
 *    one item, or an exact certification, = covered; 1 word = partial; none = to_clarify.
 * Score = round(100 x sum(weights) / number of requirements).
 */

const STOP = new Set(('le la les un une des de du d et ou en au aux a à pour par sur avec dans sans ' +
  'the a an of and or to for with on in by at is are be our your doit être sera tous toute toutes ' +
  'niveau ensemble minimum moins plus').split(' '));
const WEIGHT = { covered: 1, partial: 0.5, to_clarify: 0 };

function words(text) {
  return String(text || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/).filter(w => w.length >= 3 && !STOP.has(w));
}

function evidenceItems(input) {
  const m = input.match || {};
  const items = [];
  ((m.certifications || {}).list || []).forEach(c => items.push({ text: c, cert: true }));
  (m.similar_projects || []).forEach(p => items.push({ text: [p.name, p.result, ...(p.stack || [])].join(' ') }));
  (m.why_us || []).forEach(w => items.push({ text: w }));
  return items;
}

function heuristicStatus(requirement, items) {
  const req = new Set(words(requirement));
  let best = 0;
  for (const it of items) {
    if (it.cert && String(requirement).toLowerCase().includes(String(it.text).toLowerCase())) return 'covered';
    const hit = new Set(words(it.text).filter(w => req.has(w))).size;
    best = Math.max(best, hit);
  }
  return best >= 2 ? 'covered' : (best === 1 ? 'partial' : 'to_clarify');
}

function statusFromScore(score) {
  return score >= 0.75 ? 'covered' : (score >= 0.4 ? 'partial' : 'to_clarify');
}

/** { score|null, covered, partial, to_clarify, method, rows: [{ requirement, status }] } */
function computeCoverage(input) {
  const requirements = (input.tender && input.tender.requirements) || [];
  const provided = (input.match && input.match.requirement_coverage) || [];
  const byReq = new Map(provided.filter(r => typeof r.score === 'number').map(r => [r.requirement, r.score]));
  const useProvided = requirements.length > 0 && requirements.every(r => byReq.has(r));
  const items = useProvided ? [] : evidenceItems(input);
  const rows = requirements.map(r => ({
    requirement: r,
    status: useProvided ? statusFromScore(byReq.get(r)) : heuristicStatus(r, items)
  }));
  const count = (s) => rows.filter(r => r.status === s).length;
  const score = rows.length ? Math.round(100 * rows.reduce((sum, r) => sum + WEIGHT[r.status], 0) / rows.length) : null;
  return { score, covered: count('covered'), partial: count('partial'), to_clarify: count('to_clarify'),
           method: useProvided ? 'rag' : 'heuristic', rows };
}

const LABELS = {
  fr: { column: 'Couverture', covered: 'Couverte', partial: 'Partielle', to_clarify: 'À préciser', kpi: 'Couverture des exigences',
        note: (s) => `Score de couverture : ${s} % (couverte = 1, partielle = 0,5, à préciser = 0)`,
        heuristic: 'Couverture estimée par mots-clés (pas de score RAG fourni) : à vérifier' },
  en: { column: 'Coverage', covered: 'Covered', partial: 'Partial', to_clarify: 'To clarify', kpi: 'Requirements coverage',
        note: (s) => `Coverage score: ${s}% (covered = 1, partial = 0.5, to clarify = 0)`,
        heuristic: 'Coverage estimated by keywords (no RAG score provided): to be checked' }
};

/**
 * Adds the coverage to Agent 1's envelope: a column on the s3 compliance table (rows matched by
 * requirement text), a note with the score and formula, a KPI on s1, and data.coverage.
 */
function applyCoverage(env, input) {
  if (!env || !Array.isArray(env.slides)) return env;
  const lang = (input.tender && input.tender.language) === 'en' ? 'en' : 'fr';
  const L = LABELS[lang];
  const cov = computeCoverage(input);
  env.data = { ...(env.data || {}), coverage: cov };
  if (cov.score === null) return env;
  const status = new Map(cov.rows.map(r => [r.requirement, r.status]));

  const s3 = env.slides.find(s => s.id === 's3');
  const table = s3 && (s3.blocks || []).find(b => b.kind === 'table');
  if (table && !table.columns.includes(L.column)) {
    table.columns = [...table.columns, L.column];
    table.rows = table.rows.map(row => [...row, L[status.get(row[0]) || 'to_clarify']]);
    s3.blocks = [...s3.blocks.filter(b => !(b.kind === 'note' && /couverture|coverage/i.test(b.text))), { kind: 'note', text: L.note(cov.score) }];
    if (cov.method === 'heuristic') s3.warnings = [...(s3.warnings || []), L.heuristic];
  }
  const s1 = env.slides.find(s => s.id === 's1');
  if (s1) {
    let kpis = (s1.blocks || []).find(b => b.kind === 'kpis');
    const item = { label: L.kpi, value: `${cov.score} %` };
    if (!kpis) {
      kpis = { kind: 'kpis', items: [] };
      s1.blocks = [s1.blocks[0], kpis, ...s1.blocks.slice(1)].filter(Boolean);
    }
    kpis.items = [item, ...kpis.items.filter(k => k.label !== L.kpi)].slice(0, 4);
  }
  return env;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { computeCoverage, applyCoverage, words };
}
