// Parse Research. The agent's TOOL RESULTS (not its prose) become the buyer profile; every fact passes a gate:
//  - registry: name similarity >= Config.buyerNameSimilarity (0.85 when the candidate is not a public body), France only;
//    similarity understands acronyms ("CCAS de X" ~ "CENTRE COMMUNAL D'ACTION SOCIALE DE X") and admin prefixes
//  - identity: the notice's SIREN (Select Buyers) names the registry row and the Wikidata entity, whatever their names; another
//    SIREN is another body. A match only an acronym supports ("ATIH." -> a Paris translation firm "... (ATIH)") is refused unless
//    the notice's SIREN, department / town or own website confirms it: a refused identity leaves the profile empty, with a check
//  - procurement history: rows whose buyer name equals this buyer; awards only from the SIREN the registry gate accepted
//  - Wikidata: label / alias gate, then identity: its country (P17) is the buyer's, its SIREN (P1616) the registry's, no website
//    under another country's TLD; namesakes nothing tells apart -> none, and so is the one left beside a namesake abroad when
//    nothing places it in the buyer's country (P17, its TLD) or names it (the registry's SIREN)
//  - official website: the notice's website, else Wikidata's (gated), else a search result whose TITLE matches the buyer, else
//    the notice email's domain when spelled with the buyer name's words; never a tender portal (exclude_hosts from Select
//    Buyers), a mailbox provider, a social / encyclopedia site or (but the notice's) a host under another country's TLD
//  - contacts: the notice, then pages of the official domain only
// The agent's final JSON (buyer_type, size_hint, summary) is kept only where supported: summary sentences whose numbers are
// not in the evidence, and sentences about the website, are removed; no evidence -> "unknown"; a known staff sets size_hint; a
// public registry legal form (SEM, EPIC, 7xxx) overrides a private / other / unknown buyer_type. enrichment_status counts facts,
// never the LLM's words; awards not searched (no decp_awards with the matched SIREN) are unknown (null), not "none".
/*@lib fold toks nameSim nameMatch hostOfUrl parseAnswer PLATFORM_HOST*/
const cfg = $('00 - Config').first().json;
const gate = cfg.buyerNameSimilarity || 0.6;
const schema = { type: 'object', required: ['buyer_type', 'size_hint', 'summary'], properties: {
  buyer_type: { type: 'string', enum: ['local_authority', 'regional_authority', 'state_administration', 'public_agency', 'public_company', 'health', 'education_research', 'private_company', 'other', 'unknown'] },
  size_hint: { type: 'string', enum: ['small', 'medium', 'large', 'unknown'] },
  summary: { type: 'string', maxLength: 800 }, official_website: { type: 'string', nullable: true, maxLength: 300 } } };
const fallback = { buyer_type: 'unknown', size_hint: 'unknown', summary: '', official_website: null };
const NOT_OFFICIAL = /(^|\.)(wikipedia\.org|wikidata\.org|linkedin\.com|facebook\.com|twitter\.com|x\.com|youtube\.com|instagram\.com|tiktok\.com|google\.[a-z.]+|bing\.com)$/i;
// generic administrative prefixes (fr / en / ar) dropped for name matching: "Ville de Lille" ~ "COMMUNE DE LILLE"
const simplify = name => String(name || '').replace(/\(.*?\)/g, ' ')
  .replace(/^\s*(commune|ville|mairie|municipalit[eé]|city|town|county|municipality|d[eé]partement|r[eé]gion|region|minist[eè]re|ministry|conseil (d[eé]partemental|r[eé]gional)|communaut[eé] (de communes|d'agglom[eé]ration|urbaine)|m[eé]tropole|syndicat( mixte)?|centre hospitalier|بلدية|وزارة|ولاية)\s+(de la |de l'|des |du |de |d'|of the |of )?/i, '')
  .split(/\s[-–,]\s/)[0].replace(/\s+/g, ' ').trim();
const match = (a, b) => Math.max(nameMatch(a, b), nameMatch(simplify(a), simplify(b)));
// INSEE staff band codes (tranche_effectif_salarie) -> employees; NN / 00 = not known or none
const STAFF = { '01': '1-2', '02': '3-5', '03': '6-9', 11: '10-19', 12: '20-49', 21: '50-99', 22: '100-199', 31: '200-249', 32: '250-499', 41: '500-999',
  42: '1000-1999', 51: '2000-4999', 52: '5000-9999', 53: '10000+' };
// registry_search now prints the band itself ("staff=10-19": the code was read as a headcount); a code still reads as before
const staffBand = code => { const s = String(code || '').trim(); return STAFF[s] || (/^\d+(-\d+|\+)$/.test(s) ? s : null); };
const DIGITAL = /(logiciel|application|num[eé]rique|plate-?forme|site (internet|web)|informatique|digital|donn[eé]es|\bdata\b|syst[eè]me d.information|\bweb\b|intelligence artificielle|\bia\b|cloud|portail|d[eé]mat|software|t[eé]l[eé]com|r[eé]seaux? (informatique|t[eé]l[eé]com|de t[eé]l[eé]communications?|internet|wi-?fi|lan|wan|local)|cyber|s[eé]curit[eé] (des )?(si|syst))/i;
// "SI" / "SIRH" / "DSI" (système d'information) only in capitals: lowercase "si" is the French "if"; a sewer network ("réseaux
// enterrés") is no digital project, a computer / telecom network is
const DIGITAL_SI = /\b(SI|SIRH|SIG|SIH|DSI)\b/;
const LEGAL_FORM = new Set(['epa', 'epic', 'epst', 'epscp', 'gip', 'gie', 'sem', 'spl', 'spa', 'sas', 'sasu', 'sarl', 'eurl', 'scop', 'scic', 'sca', 'ets']);
// INSEE legal form (catégorie juridique) of the matched registry row -> buyer type: 5515 / 5615 = SEM (société d'économie mixte,
// majority public capital), 41xx = public EPIC / régie, 7xxx = public-law body (71 State, 72 territorial authorities, 731x / 734x /
// 735x their subdivisions, intercommunalities and syndicats, 7364-7365 hospitals, 7331 / 7383-7384 education). The other 73xx are
// local public AGENCIES, not authorities (7371 OPHLM, 7372 SDIS, 7373 EPCC "Metz en scènes", 7366 social body): public_agency.
// The agent reads the registry's "public=no" as private (City'up, a 5515 SEM, came out private_company): a public legal form
// overrides private_company / other / unknown only
const LEGAL_TYPE = [[/^(5515|5615|41)/, 'public_company'], [/^71/, 'state_administration'], [/^723/, 'regional_authority'], [/^736[45]/, 'health'],
  [/^(7331|738[34])/, 'education_research'], [/^(72|731|734|735)/, 'local_authority'], [/^7/, 'public_agency']];
const legalType = nature => (LEGAL_TYPE.find(([re]) => re.test(String(nature || ''))) || [])[1] || null;
// identity by ACRONYM: "ATIH." (the Agence technique de l'information sur l'hospitalisation, Lyon) took the registry's "AGENCE DE
// TRADUCTION INTERPRETARIAT HASSIBI (ATIH)", a Paris translation firm whose initials spell the same 4 letters. A match is acronym-only
// when the buyer name is ONE acronym (one word in capitals, legal form aside: "ATIH.", "OPPIC", "GIP MDS", "-CND-") or when the two
// names share no word outside parentheses (only a "(SDET)" or initials). Such a match needs the notice to confirm it (below)
const ACRONYM = /^[A-Z][A-Z0-9]{1,9}$/;
const outsideParens = s => String(s || '').replace(/\([^)]*\)/g, ' ');
const sigToks = s => toks(s).filter(t => t.length > 2 && !NAME_STOP.has(t) && !LEGAL_FORM.has(t));
const acronymOf = name => { const w = outsideParens(name).replace(/\./g, '').split(/[^\p{L}\p{N}]+/u).filter(x => x && !LEGAL_FORM.has(fold(x))); return w.length === 1 && ACRONYM.test(w[0]) ? fold(w[0]) : ''; };
const shareWords = (x, y) => { const Y = new Set(sigToks(outsideParens(y)).map(stem)); return sigToks(outsideParens(x)).some(t => Y.has(stem(t))); };
const acronymOnly = (name, cand) => !!acronymOf(name) || !shareWords(name, cand);
// the acronym a match rests on: the buyer's own, else the word the two names share inside parentheses
const acronymKey = (name, cand) => acronymOf(name) || sigToks(name).find(t => sigToks(cand).includes(t)) || '';
// a body "uses" an acronym: one of its parenthesised groups is it ("(RESAH-LR)" is not "RESAH"), its name is it, or its initials spell it
const ownAcronym = (rowName, a) => !!a && ((String(rowName).match(/\([^)]*\)/g) || []).some(p => fold(p) === a) || fold(outsideParens(rowName)) === a);
const usesAcronym = (rowName, a) => ownAcronym(rowName, a) || (!!a && expandAcronyms(a, rowName) !== a);
// a registry body that publishes public tenders: public-law (7xxx), public EPIC / régie (41xx), SEM (5515 / 5615)
const publicish = r => r.public === 'yes' || r.public === 'mixed' || /^(7|41|5515|5615)/.test(r.nature || '');
// mailbox providers: an address there says nothing about the buyer's own domain
const WEBMAIL = /(^|\.)(gmail|googlemail|yahoo|hotmail|outlook|live|msn|aol|icloud|me|gmx|proton|protonmail|laposte|orange|wanadoo|free|sfr|neuf|bbox|numericable|club-internet|voila|topnet|planet|mail|email)\.[a-z.]+$/i;
const SIDE_ORG =/\b(comite|oeuvres|sociales|amicale|association|foyer|mutuelle|fondation|sci|union)\b/;
// country code TLDs used as generic ones, and the TLDs a country uses besides its own code (France's overseas territories; .uk)
const ANY_TLD = new Set(['eu', 'io', 'co', 'me', 'tv', 'ai', 'cc', 'fm', 'ly', 'to', 'ws', 'nu', 'tk', 'app']);
const OWN_TLD = { FR: ['fr', 'mq', 'gp', 're', 'yt', 'gf', 'pf', 'nc', 'pm', 'wf', 'tf', 'bl', 'mf'], GB: ['uk', 'gb'] };
// the size of the body from its staff (registry band, else Wikidata's headcount), not from the agent's reading of a band code
const sizeOfStaff = n => (!Number.isFinite(n) ? null : n < 50 ? 'small' : n < 1000 ? 'medium' : 'large');
const unwrap = obs => {
  const s = typeof obs === 'string' ? obs : JSON.stringify(obs ?? '');
  try { const j = JSON.parse(s); const pick = x => (x && typeof x === 'object' ? String(x.result ?? x.response ?? x.output ?? JSON.stringify(x)) : String(x)); return Array.isArray(j) ? j.map(pick).join('\n') : pick(j); }
  catch { return s.replace(/\\n/g, '\n').replace(/\\"/g, '"'); }
};
const inputOf = a => { let x = a && a.toolInput; if (typeof x === 'string') { try { x = JSON.parse(x); } catch { x = { input: x }; } } return x || {}; };
const rowsOf = (text, tag) => [...String(text).matchAll(new RegExp('^' + tag + ' \\| (.*)$', 'gm'))].map(m => m[1].split(' | ').map(x => x.trim()));
const kv = arr => Object.fromEntries(arr.filter(x => /^[a-z_]+=/.test(x)).map(x => [x.slice(0, x.indexOf('=')), x.slice(x.indexOf('=') + 1)]));
const PHONE_LIKE = /(?:\+|00)?\d[\d .\-()\/]{7,18}\d/g;
// the FIRST word of a summary sentence is capitalised anyway ("Capgemini runs the city IT systems." kept an invented company as its
// subject): it is checked as a name when it reads as one, by its shape (a capital after its first letter: "SOPRA", "OliveSoft") or
// as the subject of a supplier's claim (it runs, hosts, supplies, wins..., "is the incumbent"; a passive is none: "Software
// developed in-house"), never when it is a word a sentence starts with: the agents' openers in the recorded runs ("The", "Its",
// "No", "Bids", "Winners", "Expect", "Therefore", "Large"), the usual English / French ones and a word with an English ending
// ("Recently", "Located", "Typically", "Following"). Other first words
// ("Medium-sized local authority ...", "Municipal body that ...", "Située à ...", "L'acheteur ...") are no names: checking them all
// removed true sentences. A name in the evidence (the buyer's own) passes anyway. Same rule in Parse Market
const OPENERS = new Set(('the this that these those its they their there here his her she our one some any each every all both either neither none not nor several ' +
  'many much most more less few other another such only also just even for from with within without into onto over under about after before ' +
  'between during through across against along among around despite since until upon via per and but yet then thus therefore hence however ' +
  'although though while whereas when where whether which who what why how unless because moreover furthermore additionally overall finally ' +
  'first second third lastly meanwhile otherwise instead still already often today now given according based known expect consider focus ' +
  'emphasize emphasise highlight position offer propose note bids bid bidders winners winner companies company firms firm suppliers supplier ' +
  'providers provider vendors competitors competition players incumbent contracts contract awards award notices notice tenders tender ' +
  'procurement budget budgets prices price amounts amount values value costs cost data information records registry history staff employees ' +
  'revenue size website web search results public private digital large small medium major main key local national regional recent past ' +
  'previous similar comparable typical average median total buyer buyers organisation organization body entity agency authority municipality ' +
  'commune city town region department ministry government state sector market projects project services service two three four five six seven ' +
  'eight nine ten les une des cet cette ces elle ils elles son ses leur leurs dans depuis selon avec sans pour par sur sous entre aucun aucune ' +
  'plusieurs ainsi donc toutefois cependant enfin').split(' '));
const opener = w => OPENERS.has(fold(w)) || (/^\p{Lu}\p{Ll}+$/u.test(w) && /(ly|ed|ing|ies|tion|sion|ment|ness|ity)$/.test(fold(w)));
const ROLE = /^(?:,[^,.]{1,60},)?\s*(?:\p{L}+ly\s+|(?:also|already|often|still|now|d[eé]j[aà])\s+)?(?:(?:wins?|won|runs?|ran|suppl(?:y|ies|ied)|provides?|provided|hosts?|hosted|operates?|operated|manages?|managed|maintains?|maintained|holds?|held|dominates?|dominated|builds?|built|develops?|developed|delivers?|delivered|serves?|served|leads?|led|owns?|quot(?:es?|ed)|bids?|offer(?:s|ed)|charge[sd]?|priced|submit(?:s|ted)|propos(?:es|ed)|secure[sd]|compet(?:es|ed))(?![\p{L}])(?!\s+(?:by|to|in|on|at|for|from|under|with|as|par)(?![\p{L}]))|(?:is|was|remains) (?:the|a|an|its|their) (?:\p{L}+ )?(?:incumbent|supplier|provider|contractor|vendor|operator|partner|holder|competitor|player|leader)(?![\p{L}])|(?:g[eè]re|exploite|fournit|h[eé]berge|remporte|a remport[eé]|d[eé]tient|maintient|d[eé]veloppe|a d[eé]velopp[eé]|est (?:le |l.)(?:titulaire|attributaire|prestataire|fournisseur))(?![\p{L}]))/iu;
const firstName = s => { const m = s.match(/^[^\p{L}]*([A-ZÀ-Ý][\p{L}'-]{2,})(.*)$/su); if (!m) return [];
  const w = m[1].replace(/['’]s$/, '').replace(/['-]+$/, '');
  return w.length > 2 && !opener(w) && (/\p{Lu}/u.test(w.slice(1)) || ROLE.test(m[2].trim())) ? [w] : []; };

const out = [];
const items = $input.all();
for (let i = 0; i < items.length; i++) {
  const b = $('Select Buyers').itemMatching(i).json;
  const r = items[i].json || {};
  const checks = [];
  const calls = (r.intermediateSteps || []).map(st => ({ tool: String((st.action && st.action.tool) || ''), input: inputOf(st.action), text: unwrap(st.observation) }));
  const isFR = String(b.country || '').toUpperCase() === 'FR';
  const exclude = new Set(b.exclude_hosts || []);
  // hostOfUrl(undefined) parses "https://undefined": no value is no host (a Wikidata row without website= became the buyer's
  // site "https://undefined"); a web host has a dot
  const hostOf = u => (String(u ?? '').trim() ? hostOfUrl(u) : '');
  const okHost = h => !!h && h.includes('.') && !exclude.has(h) && !NOT_OFFICIAL.test(h) && !PLATFORM_HOST.test(h);   // never a tender platform
  // a host under ANOTHER country's code TLD is a namesake's site (mv.gov.cz, the Czech interior ministry, became the French
  // Ministère de l'Intérieur's website in the export and the proposal input); generic TLDs (.com, .org, .eu, .io...) and the buyer's
  // own, France's overseas ones included (cityup.mq), say nothing. Never applied to the website the notice itself gives
  const cc = String(b.country || '').trim().toUpperCase();
  const foreignHost = h => { const tld = String(h || '').split('.').pop(); return /^[a-z]{2}$/.test(tld) && /^[A-Z]{2}$/.test(cc) && !ANY_TLD.has(tld) && !(OWN_TLD[cc] || [cc.toLowerCase()]).includes(tld); };
  const ownHost = h => !!h && /^[A-Z]{2}$/.test(cc) && (OWN_TLD[cc] || [cc.toLowerCase()]).includes(String(h).split('.').pop());

  // ---- what the notice itself says of its buyer (Select Buyers): its SIREN (France), where it is (a postal code of its address, else
  // the place's department codes; a "(972)" in its name) and its own web hosts (website, e-mail domain). A registry / Wikidata identity
  // with another SIREN is another body; an acronym-only match must be confirmed by one of them. With none of them given (a page
  // without address), an acronym-only match is kept only for the one body seen under that acronym (public, in the registry), with a check
  const nc = b.notice_contacts || {};
  const noticeSirens = isFR ? (b.notice_sirens || []).map(s => String(s).replace(/\D/g, '')).filter(s => s.length === 9) : [];
  // a postal code, never a CS / BP / TSA box number ("CS 70043 59040 Lille" is in the Nord, 59); 97x = an overseas department
  const postalDepts = s => (String(s || '').match(/(?<!\b(?:CS|BP|TSA|SP|CEDEX)\s*)\b\d{5}\b/gi) || []).map(cp => (/^97/.test(cp) ? cp.slice(0, 3) : cp.slice(0, 2)));
  const codeDepts = s => (/^\s*(\d{1,3}|2[AB])(\s*[,;]\s*(\d{1,3}|2[AB]))*\s*$/i.test(s) ? String(s).split(/[,;]/) : (String(s || '').match(/\((\d{2,3}|2[AB])\)/gi) || []).map(x => x.slice(1, -1)))
    .map(x => x.trim().toUpperCase()).map(x => (/^2[AB]$/.test(x) ? '20' : x.padStart(2, '0')));
  // a place naming every department ("(67) Bas-Rhin, (68) Haut-Rhin, ...", the Ministère de l'Intérieur's) tells nothing of where the
  // buyer is: only a place of at most 3 departments counts (its words, its codes)
  const places = (b.notice_places || []).map(String).filter(p => new Set([...postalDepts(p), ...codeDepts(p)]).size <= 3), addrDepts = (nc.addresses || []).flatMap(postalDepts);
  const noticeDepts = new Set([...addrDepts, ...codeDepts(b.name), ...(addrDepts.length ? [] : places.flatMap(p => [...postalDepts(p), ...codeDepts(p)]))]);
  const noticeGeo = ` ${fold([...(nc.addresses || []), ...places].join(' '))} `;
  const selfHosts = [hostOf(b.known_website), ...(nc.emails || []).map(e => String(e).split('@')[1] || '').map(h => h.toLowerCase().trim().replace(/^www\./, ''))]
    .filter(h => okHost(h) && !WEBMAIL.test(h));
  const onNoticeHost = h => !!h && selfHosts.some(n => h === n || h.endsWith('.' + n));
  const nothingToCheck = !noticeSirens.length && !noticeDepts.size && !noticeGeo.trim() && !selfHosts.length;
  const web = calls.filter(c => c.tool === 'web_search').flatMap(c => rowsOf(c.text, 'WEB')).map(a => ({ url: a[0], title: a[1] || '', snippet: a[2] || '', host: hostOf(a[0]) }));
  // text the buyer's own site shows (search titles / snippets, scraped pages on a notice host): it may name the body in full
  const siteText = [...web.map(w => ({ host: w.host, text: `${w.title} ${w.snippet}` })),
    ...calls.filter(c => c.tool === 'web_scrape').map(c => ({ host: hostOf((c.text.match(/^PAGE \| (\S+)/m) || [])[1]), text: c.text }))].filter(o => onNoticeHost(o.host));

  // ---- Wikidata (any country)
  const wd = calls.filter(c => c.tool === 'wikidata_lookup').flatMap(c => rowsOf(c.text, 'WD')).map(a => ({ label: a[0], desc: a[1], ...kv(a.slice(2)) }));
  // gate: label similarity, or Wikidata itself says the buyer name is this entity's ALIAS ("RESAH"); entities that are not
  // organisations (a plant species labelled "Resah", a given name, a disambiguation page) never pass
  // (a description STARTS with its class: a river, a lake or a film named like the département never ties with it below)
  const NOT_ORG = /\b(species|genus|taxon|given name|family name|surname|disambiguation|scientific article|scholarly article|asteroid|gene|protein|chemical compound|esp[eè]ce|genre de|pr[eé]nom|patronyme|homonymie)\b|^\s*(rivi[eè]re|fleuve|cours d.eau|lac|river|lake|stream|mountain|montagne|[iî]le|island|film|album|chanson|song|roman|novel|s[eé]rie t[eé]l[eé]vis[eé]e|television series|navire|ship)\b/i;
  const aliasHit = x => { const m = String(x.match || ''), i = m.indexOf(':'), type = m.slice(0, i), txt = m.slice(i + 1);
    return fold(txt) === fold(b.name) && (type === 'alias' || fold(x.label) === fold(txt)); };
  // ...and identity: a namesake of another country is never this buyer ("ministère de l'Intérieur" gave the Czech ministry first,
  // a row with no country second, both labelled alike: the first one won). Wikidata's countries (P17) must include the buyer's; with none
  // given, a website under another country's TLD says it is foreign. The one placed in the buyer's country (its P17, else a website
  // under the buyer's own TLD) wins a tie
  const inCountry = x => (cc && String(x.country || '').split(',').includes(cc) ? 1 : 0);
  const placed = x => (inCountry(x) || (!x.country && ownHost(hostOf(x.website))) ? 1 : 0);
  const foreignWhy = x => (x.country && cc && !inCountry(x) ? `country ${x.country}` : !x.country && foreignHost(hostOf(x.website)) ? `website ${hostOf(x.website)}` : '');
  const wdGated = wd.filter(x => !NOT_ORG.test(x.desc || '')).map(x => ({ x, s: aliasHit(x) ? 1 : match(b.name, x.label), t: match(b.name, x.label) })).filter(o => o.s >= gate);
  const wdAbroad = wdGated.filter(o => foreignWhy(o.x));
  for (const o of wdAbroad) checks.push(`Wikidata ${o.x.id} "${o.x.label}" ignored: another country's (${foreignWhy(o.x)})`);
  // the notice's SIREN is identity: an entity with another SIREN (P1616) is another body, the one with it is the buyer (below)
  const wdHere = wdGated.filter(o => !foreignWhy(o.x)), wdNotOwn = noticeSirens.length ? wdHere.filter(o => o.x.siren && !noticeSirens.includes(o.x.siren)) : [];
  for (const o of wdNotOwn) checks.push(`Wikidata ${o.x.id} "${o.x.label}" ignored: SIREN ${o.x.siren}, not the notice's ${noticeSirens.join(' / ')}`);
  const wdCands = wdHere.filter(o => !wdNotOwn.includes(o)).sort((a, z) => z.s - a.s || z.t - a.t || placed(z.x) - placed(a.x));
  // two entities named alike that nothing tells apart (same scores, neither placed in the buyer's country): neither is used, unless
  // the registry's SIREN names one of them (below)
  const wdTied = wdCands.filter(o => o.s === wdCands[0].s && o.t === wdCands[0].t && placed(o.x) === placed(wdCands[0].x));
  let wdOk = wdTied.length === 1 ? wdTied[0].x : null;
  // ...and a namesake ABROAD named at least as well still counts in that tie: "ministère de l'Intérieur" left Q6589202 once the
  // Czech ministry went for its .cz site, a row with no country, website nor SIREN and a description that names no country (the
  // generic "interior ministry" item, by all signs), and it became the French ministry's identity. The one left must be placed in
  // the buyer's country or carry the registry's SIREN (below); with no namesake abroad nothing changes (many organisations have no
  // P17 on Wikidata)
  const wdNamesakes = wdOk && !placed(wdOk) ? wdAbroad.filter(o => o.s > wdTied[0].s || (o.s === wdTied[0].s && o.t >= wdTied[0].t)) : [];
  if (wdNamesakes.length) wdOk = null;
  const wdByNotice = wdCands.find(o => noticeSirens.includes(o.x.siren));
  if (wdByNotice) wdOk = wdByNotice.x;

  // ---- registry (France). The buyer is matched under its notice name, or under the official name Wikidata gave for it
  // ("EPA-SHOM" -> "Service hydrographique et océanographique de la Marine"): the agent is told to retry the registry with it.
  const regRows = calls.filter(c => c.tool === 'registry_search').flatMap(c => rowsOf(c.text, 'REG')).map(a => ({ name: a[0], ...kv(a.slice(1)) }));
  const regNames = [b.name, wdOk && fold(wdOk.label) !== fold(b.name) ? wdOk.label : null].filter(Boolean);
  let reg = null, regScore = 0, regVia = '';
  const cands = [];
  for (const c of regRows) for (const n of regNames) {
    if (SIDE_ORG.test(fold(c.name)) && !SIDE_ORG.test(fold(n))) continue;
    const s = match(n, c.name), pub = c.public === 'yes' || /^7/.test(c.nature || '');
    if (s < (pub ? gate : Math.max(gate, 0.85))) continue;                // a private company must match more closely
    // words of the name missing from the candidate's name (often the town: "CCAS de X") must be in its address
    const inName = new Set(toks(c.name).map(stem));
    const missingWords = toks(simplify(n)).filter(t => t.length > 2 && !NAME_STOP.has(t) && !LEGAL_FORM.has(t))
      .filter(t => !inName.has(stem(t)) && expandAcronyms(t, c.name) === t).map(stem);   // an acronym of the candidate's words is covered
    const where = new Set(toks(`${c.addr || ''} ${c.city || ''}`).map(stem));
    if (missingWords.length && !missingWords.every(t => where.has(t))) continue;
    // under the Wikidata name, the notice name's OWN words (the town of "CCAS de Bourgoin-Jallieu") must still match: a generic
    // Wikidata class ("centre communal d'action sociale") must not let another town's CCAS through. Legal forms (EPA...) aside.
    if (n !== b.name) {
      const own = toks(simplify(b.name)).filter(t => t.length > 2 && !NAME_STOP.has(t) && !LEGAL_FORM.has(t))
        .filter(t => !inName.has(stem(t)) && expandAcronyms(t, c.name) === t && expandAcronyms(t, n) === t).map(stem);
      if (own.length && !own.every(t => where.has(t))) continue;
    }
    const score = s + (pub ? 0.05 : 0) - (n === b.name ? 0 : 0.01);    // the notice's own name wins a tie
    // acronym-only: under the notice name, the two names; under the Wikidata name, also the buyer name -> Wikidata link ("OPPIC" is
    // the alias of the "Opérateur du patrimoine...", whose full name then matches the registry's)
    cands.push({ c, score, pub, via: n === b.name ? 'notice name' : `Wikidata name "${n}"`, acr: acronymOnly(b.name, n === b.name ? c.name : n) || acronymOnly(n, c.name), key: acronymKey(b.name, n === b.name ? c.name : n) });
  }
  // an acronym buyer's own body may share nothing but its acronym ("AGENCE TECHNIQUE DE L'INFORMATION SUR L'HOSPITALISATION (ATIH)":
  // "sur" breaks the initials): a row whose own acronym it is becomes a candidate, kept only when the notice confirms it
  const buyerAcr = acronymOf(b.name);
  if (buyerAcr) for (const c of regRows) if (!cands.some(o => o.c.siren === c.siren) && ownAcronym(c.name, buyerAcr) && !SIDE_ORG.test(fold(c.name)))
    cands.push({ c, score: gate, pub: c.public === 'yes' || /^7/.test(c.nature || ''), via: `its acronym ${buyerAcr.toUpperCase()}`, acr: true, key: buyerAcr, own: true });
  // the notice confirms a body by its SIREN, its department / town (registry address), or its own site (a Wikidata entity with that
  // SIREN and the notice's website or e-mail domain; a search title / page there naming the body in full)
  const rowTown = c => fold(c.city).split(' ').filter(w => w && !/\d/.test(w) && w !== 'cedex').join(' ');
  const confirmReg = c => {
    if (noticeSirens.includes(c.siren)) return `the notice's SIREN ${c.siren}`;
    const d = postalDepts(c.addr).pop() || '';
    if (d && noticeDepts.has(d)) return `the notice's department ${d}`;
    if (rowTown(c).length > 2 && noticeGeo.includes(` ${rowTown(c)} `)) return `the notice's town ${c.city}`;
    const wdSite = wdCands.find(o => o.x.siren && o.x.siren === c.siren && onNoticeHost(hostOf(o.x.website)));
    if (wdSite) return `the notice's website ${hostOf(wdSite.x.website)} (Wikidata ${wdSite.x.id})`;
    const page = sigToks(outsideParens(c.name)).length >= 2 && siteText.find(o => containment(outsideParens(c.name), o.text) >= 0.85);
    return page ? `the notice's website ${page.host}` : '';
  };
  const refused = new Map();                                           // siren -> why: one check per body
  const refuse = (c, why) => { if (!refused.has(c.siren)) refused.set(c.siren, `registry "${c.name}" (SIREN ${c.siren}) ignored: ${why}`); };
  // the row with the notice's SIREN IS the buyer, whatever its name (the agent searches the registry by that SIREN first)
  const bySiren = isFR && noticeSirens.length ? regRows.find(c => noticeSirens.includes(c.siren)) : null;
  if (bySiren) { reg = bySiren; regScore = 1; regVia = `SIREN given by the notice (${bySiren.siren})`; }
  for (const o of cands.sort((x, z) => z.score - x.score)) {
    if (!isFR) { reg = o.c; regScore = o.score; break; }               // a French registry hit abroad is ignored below
    if (noticeSirens.length && !noticeSirens.includes(o.c.siren)) { if (!o.own) refuse(o.c, `the notice gives SIREN ${noticeSirens.join(' / ')}`); continue; }
    if (reg) break;
    const how = o.acr ? confirmReg(o.c) : '';
    // nothing to check it against: the one public body seen under that acronym is kept (check), never a company sharing it ("(OPPIC)"
    // is also a private association of Anduze: a buyer of public tenders is the public body, a SEM or régie would compete)
    const alone = !regRows.some(r => r.siren !== o.c.siren && publicish(r) && usesAcronym(r.name, o.key));
    if (o.acr && !how && !(nothingToCheck && o.pub && !o.own && alone)) {
      const why = nothingToCheck ? (o.pub ? 'another public body seen uses it, and the notice gives nothing to tell them apart' : 'it is not a public body, and the notice gives nothing to confirm it')
        : `the notice confirms it by no SIREN, department${noticeDepts.size ? ` (${[...noticeDepts].join(' / ')}, not ${postalDepts(o.c.addr).pop() || '?'})` : ''}, town or website`;
      if (!o.own) refuse(o.c, `it shares only the acronym ${(o.key || '?').toUpperCase()} with "${b.name}", and ${why}`);
      continue;
    }
    if (o.acr && !how) checks.push(`registry "${o.c.name}" taken by its acronym only: the notice gives no SIREN, address or website to confirm it`);
    reg = o.c; regScore = o.score; regVia = o.via + (how ? `, acronym confirmed by ${how}` : ''); break;
  }
  checks.push(...[...refused.values()].slice(0, 3));
  if (isFR && noticeSirens.length && !bySiren && !calls.some(c => c.tool === 'registry_search' && noticeSirens.includes(String(c.input.q || '').replace(/\D/g, ''))))
    checks.push(`registry not searched with the notice's SIREN ${noticeSirens.join(' / ')}`);
  if (reg && !isFR) { checks.push('registry ignored: French registry for a non-French buyer'); reg = null; }
  // Wikidata's SIREN (P1616) is identity: the registry's names the buyer's entity among namesakes, another one is another body
  if (reg) {
    const own = wdCands.find(o => o.x.siren === reg.siren);
    if (own) wdOk = own.x;
    else if (wdOk && wdOk.siren && wdOk.siren !== reg.siren) { checks.push(`Wikidata ${wdOk.id} "${wdOk.label}" ignored: SIREN ${wdOk.siren}, not the registry's ${reg.siren}`); wdOk = null; }
  }
  // an acronym-only Wikidata entity (the buyer name is its alias "OPPIC", or its label shares no word with the buyer name) is
  // confirmed the same way: its SIREN is the notice's or the registry body's, its label names that body in full, or its website is the
  // notice's own; with nothing in the notice to check, it is kept when no other body seen in the registry uses that acronym (check)
  if (wdOk && acronymOnly(b.name, wdOk.label)) {
    const wo = wdOk, key = acronymKey(b.name, wo.label), namesBody = r => match(wo.label, r.name) >= gate && shareWords(wo.label, r.name);
    const how = noticeSirens.includes(wo.siren) ? 'SIREN' : reg && (wo.siren === reg.siren || namesBody(reg)) ? 'registry' : onNoticeHost(hostOf(wo.website)) ? 'website' : '';
    const alone = !regRows.some(r => publicish(r) && usesAcronym(r.name, key) && !(wo.siren && r.siren === wo.siren) && !namesBody(r));
    if (!how && !(nothingToCheck && alone)) {
      checks.push(`Wikidata ${wo.id} "${wo.label}" ignored: it shares only the acronym ${(key || '?').toUpperCase()} with "${b.name}", and ${nothingToCheck ? 'another public body seen in the registry uses it' : 'neither the notice\'s SIREN, the registry body nor the notice\'s website confirms it'}`);
      wdOk = null;
    } else if (!how) checks.push(`Wikidata ${wo.id} "${wo.label}" taken by its acronym only: the notice gives no SIREN, address or website to confirm it`);
  }
  if (!wdOk && wdTied.length > 1) checks.push(`Wikidata ignored: ${wdTied.length} entities named like the buyer that nothing tells apart (${wdTied.map(o => o.x.id).join(', ')})`);
  if (!wdOk && wdNamesakes.length) checks.push(`Wikidata ${wdTied[0].x.id} "${wdTied[0].x.label}" ignored: named like ${wdNamesakes.map(o => o.x.id).join(', ')} of another country, and nothing places it in ${cc} (no country, no ${isFR ? 'SIREN of the registry, no ' : ''}website under its TLD)`);
  // a row that only echoes the searched label (no description, website, staff or revenue) tells nothing about the buyer: it is
  // not an enrichment fact and not evidence ("WD | City'up |  | id=Q115468931" made City'up "enriched")
  const wdInfo = !!wdOk && !!(wdOk.desc || wdOk.website || wdOk.employees || wdOk.revenue);
  const registry = { match_ok: !!reg, score: Math.round(regScore * 100) / 100,
    reason: !isFR ? 'not applicable (non-French buyer)' : !regRows.length ? 'not searched or no results' : reg === bySiren && reg ? regVia : reg ? `name similarity above threshold (${regVia})`
      : refused.size ? `no candidate confirmed (${regRows.length} seen, ${refused.size} refused: see checks)` : `no candidate above threshold (${regRows.length} seen)` };

  // ---- procurement history and awards (France)
  // history: the notice name and the registry name (when the registry matched under the Wikidata name, that IS this body)
  const names = [b.name, reg && reg.name].filter(Boolean);
  const core = s => toks(s).filter(t => !LEGAL_FORM.has(t) && !NAME_STOP.has(t)).join(' ');
  const sameBody = (n, x) => fold(n) === fold(x) || (core(n) && core(n) === core(x)) || nameSim(n, x) >= 0.85 || nameSim(core(n), core(x)) >= 0.85;
  const own = new Set((b.tenders || []).map(t => String(t.external_id || '')).filter(Boolean)), ownTitles = new Set((b.tenders || []).map(t => fold(t.title)));
  const boampCalls = calls.filter(c => c.tool === 'boamp_history');
  const history = boampCalls.flatMap(c => rowsOf(c.text, 'BOAMP'))
    .map(a => ({ id: a[0], date: a[1], nature: a[2], title: a[3], ...kv(a.slice(4)) }))
    .filter(x => names.some(n => sameBody(n, x.buyer)))
    // the tender's own notices go; an AWARD of a contract with the same title stays: it names the incumbent
    .filter(x => !own.has(x.id) && !(ownTitles.has(fold(x.title)) && !/ATTRIBUTION/i.test(x.nature)) && !/RECTIFICATIF|ANNULATION/i.test(x.nature));
  // boamp_history is a PHRASE search on the published buyer name (parentheses aside): a query with a word the published name
  // lacks (the registry's "COMMUNE DE X" for "Ville de X") cannot reach this buyer's notices, so its empty answer is no history
  const pubWords = new Set(toks(`${b.name} ${b.search_name || ''}`)), canReach = q => { const w = toks(String(q || '').replace(/\([^)]*\)/g, ' ')); return w.length > 0 && w.every(t => pubWords.has(t)); };
  if (isFR && boampCalls.length && !history.length && !boampCalls.some(c => canReach(c.input.buyer_name)))
    checks.push(`history not searched under the published name "${b.name}" (searched: ${boampCalls.map(c => String(c.input.buyer_name || '')).join(' | ').slice(0, 120)})`);
  const decpCalls = calls.filter(c => c.tool === 'decp_awards'), sirenIn = c => String(c.input.siren || '').replace(/\D/g, '');
  const decp = reg ? decpCalls.filter(c => sirenIn(c) === reg.siren)
    .flatMap(c => rowsOf(c.text, 'DECP')).map(a => ({ date: a[0], amount: Number(a[1]) || null, title: a[2], ...kv(a.slice(3)) })) : [];
  // the "wrong SIREN" check only when no call used the matched one; the right SIREN with no row is DECP's answer, said as such
  if (reg && decpCalls.length && !decpCalls.some(c => sirenIn(c) === reg.siren)) checks.push('awards ignored: not queried with the matched SIREN');
  else if (reg && decpCalls.length && !decp.length) checks.push(`awards: no DECP contract for SIREN ${reg.siren}`);
  // the agent may stop before decp_awards (a small model made its 3 first calls at once, before any SIREN, then answered): then
  // the awards are not known, which is not "no awards"
  const awardsUnknown = !!reg && !decpCalls.some(c => sirenIn(c) === reg.siren);
  if (reg && !decpCalls.length) checks.push(`awards not searched: decp_awards not called with the matched SIREN ${reg.siren}`);
  const seenTitle = new Set();
  const past_projects = [...history.map(x => ({ title: x.title, date: x.date, source: 'BOAMP', id: x.id, kind: /ATTRIBUTION/i.test(x.nature) ? 'award' : 'notice' })),
    ...decp.map(x => ({ title: x.title, date: x.date, source: 'DECP', amount: x.amount, kind: 'contract' }))]
    .filter(p => { const k = fold(p.title); if (!k || seenTitle.has(k)) return false; seenTitle.add(k); return true; })
    .map(p => ({ ...p, digital: DIGITAL.test(p.title) || DIGITAL_SI.test(p.title) })).sort((x, y) => y.digital - x.digital).slice(0, 10);
  // the winners of this buyer's award notices, with the notices that name them (newest first: the proof of a key partner) and all
  // the winners each notice names (several = lots or co-contractors: who won which part is not said)
  const wins = {}, winnersOf = x => [...new Set(String(x.winners || '').split(';').map(s => s.trim()).filter(Boolean))];
  for (const x of history) if (/ATTRIBUTION/i.test(x.nature)) for (const w of winnersOf(x)) (wins[w] = wins[w] || []).push(x);
  const competitors = Object.entries(wins).sort((a, z) => z[1].length - a[1].length).slice(0, 8).map(([name, l]) => ({ name, wins: l.length, source: 'BOAMP award notices',
    awards: l.slice(0, 3).map(x => ({ id: x.id, date: x.date || null, title: x.title || null, winners: winnersOf(x) })) }));
  const amounts = decp.map(x => x.amount).filter(Boolean).sort((a, z) => a - z);
  const bids = decp.map(x => Number(x.bids)).filter(n => Number.isFinite(n) && n > 0).sort((a, z) => a - z);
  const median = a => (a.length ? a[Math.floor(a.length / 2)] : null);
  const budget_signals = amounts.length ? { contracts: amounts.length, min: amounts[0], median: median(amounts), max: amounts[amounts.length - 1], currency: 'EUR',
    median_bids_received: median(bids), basis: "this buyer's awarded contracts (DECP)" } : null;

  // ---- official domain + contacts (web: the search rows read above)
  let domain = '', how = '';
  const declared = hostOf(b.known_website);
  // the notice's contact address names the buyer's own domain (cu.commandepublique@cityup.mq -> cityup.mq) when that domain is
  // spelled with the words of the buyer name ("City'up", "Métropole européenne de Lille" -> lillemetropole.fr); never a mailbox
  // provider or a tender platform
  const nameWords = toks(b.name).sort((x, y) => y.length - x.length);
  const spelledByName = h => { const full = fold(h.split('.').slice(0, -1).join(' ')).replace(/ /g, ''); let rest = full; for (const w of nameWords) rest = rest.split(w).join(''); return full.length >= 4 && rest.length <= 2; };
  const mailHost = ((b.notice_contacts && b.notice_contacts.emails) || []).map(e => String(e).split('@')[1] || '').map(h => h.toLowerCase().trim().replace(/^www\./, ''))
    .find(h => okHost(h) && !WEBMAIL.test(h) && spelledByName(h));
  if (okHost(declared)) { domain = declared; how = 'tender notice'; }
  else if (wdOk && okHost(hostOf(wdOk.website)) && !foreignHost(hostOf(wdOk.website))) { domain = hostOf(wdOk.website); how = 'Wikidata'; }
  else {
    // a page title carries extra words ("- Site officiel", "Accueil"): every word of the buyer name must be in it; a namesake
    // abroad (another country's TLD) is not the buyer's site
    const titleScore = t => Math.max(match(b.name, t), containment(b.name, t), containment(expandAcronyms(b.name, t), t));
    const hit = web.filter(w => okHost(w.host) && !foreignHost(w.host)).map(w => ({ w, s: titleScore(w.title) })).filter(o => o.s >= Math.max(gate, 0.85)).sort((a, z) => z.s - a.s)[0];
    if (hit) { domain = hit.w.host; how = `search title match ${hit.s.toFixed(2)}`; }
    else if (mailHost) { domain = mailHost; how = 'notice email domain'; }
  }
  // the reason said as it is: a notice that gives only a tender platform (dropped by Select Buyers) or a social page is not one
  // without a website
  const noticeHosts = ((b.notice_contacts && b.notice_contacts.websites) || []).map(hostOf).filter(Boolean);
  if (!domain && calls.length && !calls.some(c => c.tool === 'web_search')) checks.push(`website not searched: web_search not called (${declared ? `the notice's ${declared} is not an official site`
    : noticeHosts.length ? `the notice gives only ${noticeHosts.slice(0, 2).join(', ')}, not the buyer's own site` : 'no website in the notice'})`);
  const onDomain = h => !!domain && (h === domain || h.endsWith('.' + domain));
  const pages = calls.filter(c => c.tool === 'web_scrape').map(c => {
    const t = c.text, url = (t.match(/^PAGE \| (\S+)/m) || [])[1] || '';
    const list = re => { const v = (t.match(re) || [])[1] || ''; return v === 'none' ? [] : v.split(',').map(s => s.trim()).filter(Boolean); };
    return { url, emails: list(/^EMAILS: (.*)$/m), phones: list(/^PHONES: (.*)$/m), text: (t.match(/^TEXT: ([\s\S]*)$/m) || [])[1] || '' };
  }).filter(p => p.url);
  const trusted = pages.filter(p => onDomain(hostOfUrl(p.url)));
  if (pages.length > trusted.length) checks.push(`${pages.length - trusted.length} scraped page(s) ignored: not on the official domain`);
  const siteEmails = trusted.flatMap(p => p.emails).filter(e => onDomain(String(e.split('@')[1] || '').toLowerCase()));
  const contacts = {
    emails: [...new Set([...(nc.emails || []), ...siteEmails])].slice(0, 6),
    phones: [...new Set([...(nc.phones || []), ...trusted.flatMap(p => p.phones)])].slice(0, 6),
    website: domain ? `https://${domain}` : '',
    addresses: [...new Set([...(nc.addresses || []), reg && reg.addr].filter(Boolean))].slice(0, 3),
    sources: { notice: (nc.emails || []).length + (nc.phones || []).length, official_site: siteEmails.length + trusted.flatMap(p => p.phones).length, website: how || null },
  };

  // ---- evidence + the agent's summary, checked
  // the count BOAMP gives for the name searched, when its rows are this buyer's ("12 public notices in the last three years" was
  // removed: the dates are not numbers of the evidence and the count was nowhere)
  const boampTotal = Math.max(0, ...boampCalls.filter(c => rowsOf(c.text, 'BOAMP').some(a => names.some(n => sameBody(n, kv(a.slice(4)).buyer))))
    .map(c => Number((c.text.match(/^TOTAL (\d+)/m) || [])[1]) || 0));
  const evidence = [
    reg ? `Registry: ${reg.name}, legal form ${reg.nature || '?'}, ${staffBand(reg.staff) ? `${staffBand(reg.staff)} employees` : 'staff not known'} (${reg.staff_year || '?'})${reg.ca ? `, revenue ${reg.ca}` : ''}, ${reg.addr || ''}` : '',
    wdInfo ? `Wikidata: ${wdOk.label} - ${wdOk.desc}${wdOk.employees ? `, ${wdOk.employees} employees` : ''}${wdOk.revenue ? `, revenue ${wdOk.revenue} ${wdOk.revenue_year || ''}` : ''}` : '',
    history.length ? `Public notices in the last 3 years (BOAMP): ${boampTotal || history.length} found under the name searched, ${history.length} of this buyer listed` : '',
    ...history.slice(0, 15).map(x => `Notice ${x.date} ${x.title}${x.winners ? ` (won by ${x.winners})` : ''}`),
    ...decp.slice(0, 15).map(x => `Contract ${x.date} ${x.amount || ''} ${x.title}`),
    ...web.filter(w => onDomain(w.host)).map(w => `${w.title}. ${w.snippet}`),
    ...trusted.map(p => p.text.slice(0, 1500)),
  ].filter(Boolean);
  const evText = evidence.join('\n');
  const evNums = new Set([...(fold(evText.replace(PHONE_LIKE, ' ')).match(/\d+/g) || []), ...(evText.match(/\b(19|20)\d{2}\b/g) || [])]);
  let a = parseAnswer(r, schema, fallback);
  // one field outside its list ("buyer_type": "public") lost the whole answer, summary and size too: only that field becomes
  // "unknown" (the registry's legal form may still type the buyer below), the rest is checked as usual
  const offList = a.ok ? [] : a.errors.map(e => (e.match(/^\$\.(buyer_type|size_hint): ".*" not in /) || [])[1]);
  if (offList.length && offList.every(Boolean)) {
    const loose = parseAnswer(r, { ...schema, properties: { ...schema.properties, buyer_type: { type: 'string' }, size_hint: { type: 'string' } } }, fallback);
    if (loose.ok) { checks.push(`agent answer: ${a.errors.slice(0, 2).join('; ')} -> unknown`); a = { ...loose, value: { ...loose.value, ...Object.fromEntries(offList.map(k => [k, 'unknown'])) } }; }
  }
  if (r.error) checks.push('agent error: ' + String((r.error && r.error.message) || r.error).slice(0, 160));
  else if (!a.ok) checks.push('agent final answer invalid: ' + a.errors.slice(0, 2).join('; '));
  const v = a.value || fallback;
  const sentences = String(v.summary || '').split(/(?<=[.!?؟])\s+/).filter(Boolean);
  const evWords = new Set(fold(`${evText} ${b.name} ${(b.tenders || []).map(t => t.title).join(' ')} ${b.country_name || ''} ${cfg.company.name}`).split(' '));
  // the website is set by code (notice, Wikidata, search title, e-mail domain): the agent's words about it are dropped, never
  // contradicting it ("Its official website is not listed in Wikidata but can be found via the French public procurement portal")
  const WEB_TALK = /\b(web ?sites?|site (web|internet|officiel)|wikidata)\b|https?:\/\/|\bwww\./i;
  const summary = evidence.length ? sentences.filter(s => {
    if (WEB_TALK.test(s)) { checks.push(`summary sentence removed (the website is set by code): ${s.slice(0, 80)}`); return false; }
    const okNum = (fold(s).match(/\d+/g) || []).every(n => evNums.has(n));
    // a capitalised word (a city, an organisation) must be in the evidence: "based in Rennes" from a REJECTED registry row is
    // removed; the sentence's first word too, unless it is a usual opener (firstName)
    const names = [...firstName(s), ...(s.match(/(?<=\S\s+)[A-ZÀ-Ý][\p{L}'-]{2,}/gu) || [])].flatMap(w => fold(w.replace(/['’]s$/, '')).split(' ')).filter(w => w && !/^(the|it|its|they|this|and|with|for|in|of|public|company|agency|french|france)$/.test(w));
    const okNames = names.every(w => evWords.has(w));
    if (!okNum) checks.push(`summary sentence removed (number not in evidence): ${s.slice(0, 80)}`);
    else if (!okNames) checks.push(`summary sentence removed (name not in evidence): ${s.slice(0, 80)}`);
    return okNum && okNames;
  }).join(' ') : '';
  const sizeEvidence = !!(reg && staffBand(reg.staff)) || !!(wdOk && (wdOk.employees || wdOk.revenue)) || !!budget_signals;
  // a known staff sets the size (the agent read the band code 22 as "22 employees" and said small for a 100-199 body)
  const band = reg && staffBand(reg.staff), sizeByStaff = sizeOfStaff(band ? parseInt(band, 10) : wdOk && wdOk.employees ? Number(wdOk.employees) : NaN);
  if (sizeByStaff && !['unknown', sizeByStaff].includes(v.size_hint)) checks.push(`size ${sizeByStaff} from ${band ? `the registry staff band ${band}` : `Wikidata's ${wdOk.employees} employees`} (agent said ${v.size_hint})`);
  if (v.official_website && hostOfUrl(v.official_website) !== domain) checks.push(`agent website ignored (not verified): ${String(v.official_website).slice(0, 80)}`);
  const revenue = reg && reg.ca && Number(reg.ca.split(':')[1]) > 0 ? (() => { const [y, n] = reg.ca.split(':'), v = Number(n);
      return `${v >= 1e6 ? `${Math.round(v / 1e5) / 10} M` : `${Math.round(v / 1e3)} k`} EUR in ${y} (registry)`; })()
    : wdOk && wdOk.revenue ? `${wdOk.revenue} ${wdOk.unit || ''}${wdOk.revenue_year ? ` in ${wdOk.revenue_year}` : ' (year unknown)'} (Wikidata)` : null;
  const facts = { registry: !!reg, history: history.length > 0, awards: awardsUnknown ? null : decp.length > 0, official_site: trusted.length > 0 || !!declared, wikidata: wdInfo };
  const n = Object.values(facts).filter(Boolean).length;
  const research_status = r.error ? 'research_failed' : !calls.length && !a.ok ? 'research_invalid' : 'researched';
  let buyer_type = evidence.length ? v.buyer_type : 'unknown';
  const byForm = reg && legalType(reg.nature);
  if (byForm && ['private_company', 'other', 'unknown'].includes(buyer_type)) {
    if (v.buyer_type !== 'unknown') checks.push(`buyer type ${byForm} from the registry legal form ${reg.nature} (agent said ${v.buyer_type})`);
    buyer_type = byForm;
  }
  out.push({ json: { ...b, _run: undefined, research_status, enrichment_status: n >= 2 ? 'enriched' : n === 1 ? 'partial' : 'none', facts,
    profile: {
      buyer_type, size_hint: sizeByStaff || (sizeEvidence ? v.size_hint : 'unknown'), summary,
      legal_name: reg ? reg.name : '', siren: reg ? reg.siren : '', siret: reg ? reg.siret : '', legal_form: reg ? reg.nature : '', registry,
      // a label-only Wikidata hit is not shown either: nothing tells it is this buyer (City'up's "Q115468931" has no description)
      wikidata_id: wdInfo ? wdOk.id : null, staff: reg && staffBand(reg.staff) ? `${staffBand(reg.staff)} employees (registry, ${reg.staff_year || 'year ?'})` : wdOk && wdOk.employees ? `${wdOk.employees}${wdOk.employees_year ? ` in ${wdOk.employees_year}` : ''} (Wikidata)` : null,
      estimated_revenue: revenue, official_website: contacts.website, contacts,
      past_projects, competitors, budget_signals, history_total: history.length, tools_used: calls.map(c => c.tool), checks } } });
}
return out;
