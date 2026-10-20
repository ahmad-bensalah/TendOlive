/**
 * profile.js - Facts from agents/config/company_profile.json, applied by code (never by the LLM).
 *
 * Empty values mean "not provided": the slides keep their [TO FILL: ...] placeholders.
 *  - contact  -> s11 contact line (replaces [TO FILL: contact])
 *  - sla      -> s8 table of service levels and support bullets (no SLA placeholder otherwise)
 *  - qr       -> deck qr_url from qr.url_template ({tenderId}; {deckId} is unknown before creation)
 */

const filled = (v) => typeof v === 'string' && v.trim() !== '';

function contactLine(profile, lang) {
  const c = (profile && profile.contact) || {};
  const parts = [c.name, c.role, c.email, c.phone].filter(filled).map(s => s.trim());
  if (!parts.length) return null;
  return `${lang === 'en' ? 'Contact' : 'Contact'} : ${parts.join(' · ')}`;
}

function slaBlocks(profile, lang) {
  const sla = (profile && profile.sla) || {};
  const fr = lang !== 'en';
  const levels = (sla.levels || []).filter(l => l && ['name', 'response_time', 'resolution_time', 'availability'].some(k => filled(l[k])));
  const blocks = [];
  if (levels.length) {
    blocks.push({
      kind: 'table',
      columns: fr ? ['Niveau', 'Délai de réponse', 'Délai de résolution', 'Disponibilité'] : ['Level', 'Response time', 'Resolution time', 'Availability'],
      rows: levels.slice(0, 6).map(l => ['name', 'response_time', 'resolution_time', 'availability']
        .map(k => filled(l[k]) ? l[k].trim() : `[TO FILL: ${k.replace('_', ' ')}]`))
    });
  }
  const extra = [
    [sla.support_hours, fr ? 'Horaires de support' : 'Support hours'],
    [sla.maintenance, fr ? 'Maintenance' : 'Maintenance'],
    [sla.training, fr ? 'Formation' : 'Training']
  ].filter(([v]) => filled(v)).map(([v, label]) => `${label} : ${v.trim()}`);
  return { table: blocks[0] || null, items: extra };
}

/** Numbers and names that become allowed facts once the profile is filled. */
function profileFacts(profile) {
  const texts = [];
  const walk = (o) => {
    if (typeof o === 'string') { if (o.trim()) texts.push(o); }
    else if (Array.isArray(o)) o.forEach(walk);
    else if (o && typeof o === 'object') Object.values(o).forEach(walk);
  };
  walk({ contact: (profile || {}).contact, sla: (profile || {}).sla });
  return texts;
}

function applyProfile(stage, env, profile, input) {
  if (!env || !Array.isArray(env.slides) || !profile) return env;
  const lang = (input.tender && input.tender.language) === 'en' ? 'en' : 'fr';
  if (stage === 'agent1') {
    const line = contactLine(profile, lang);
    const s11 = env.slides.find(s => s.id === 's11');
    if (line && s11) {
      s11.blocks = (s11.blocks || []).map(b => (b.kind === 'text' && /\[TO FILL: contact\]/.test(b.text) ? { kind: 'text', text: line } : b));
    }
  }
  if (stage === 'agent5') {
    const s8 = env.slides.find(s => s.id === 's8');
    const { table, items } = slaBlocks(profile, lang);
    if (s8 && (table || items.length)) {
      const kept = (s8.blocks || []).filter(b => !(b.kind === 'note' && /\[TO FILL: SLA/i.test(b.text)));
      const bullets = kept.find(b => b.kind === 'bullets');
      if (bullets && items.length) bullets.items = [...bullets.items.filter(i => !items.includes(i)), ...items].slice(0, 6);
      else if (items.length) kept.push({ kind: 'bullets', items });
      s8.blocks = table ? [table, ...kept].slice(0, 3) : kept;
      env.data = { ...(env.data || {}), evidence: [...((env.data || {}).evidence || []), { claim: 'SLA', source: 'company_profile.sla' }] };
    }
  }
  return env;
}

function qrUrl(profile, input) {
  const t = profile && profile.qr && profile.qr.url_template;
  if (!filled(t) || t.includes('{deckId}')) return '';
  return t.replace('{tenderId}', encodeURIComponent((input.tender && input.tender.id) || ''));
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { applyProfile, contactLine, slaBlocks, profileFacts, qrUrl };
}
