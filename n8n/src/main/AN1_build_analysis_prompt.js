// Build Analysis Prompt. ONE LLM call per kept tender, BEFORE any expensive research: closed labels (type + fit) against the
// company profile, one verbatim quote as proof, and - only when the fit is high or medium - the requirements written in the text.
// Tender types come from Config (company.tenderTypes). Dropped tenders, source errors and the run marker get _run = false.
/*@lib toks*/
const cfg = $('00 - Config').first().json;
const cp = cfg.company;
const types = Object.entries(cp.tenderTypes || {});
const system = 'You are a bid manager. You read ONE public tender and judge it against ONE company profile. Answer with ONE JSON object only.';
const company = `COMPANY: ${cp.name}
SERVICES:
${cp.services.map((s, k) => `${k + 1}. ${s}`).join('\n')}
TECHNOLOGIES: ${cp.technologies.join(', ')}
TENDER TYPES THE COMPANY BIDS ON: ${types.filter(([, t]) => t.bid).map(([k]) => k).join(', ') || '-'}
DOES NOT DO: ${[...types.filter(([, t]) => !t.bid).map(([k]) => k), ...(cp.exclusions || [])].join(', ') || '-'}`;
const typeList = [...types.map(([k, t]) => `${k} (${t.desc})`), 'other'].join(', ');
const RAG_LANG = (cfg.rag && cfg.rag.language) || 'English';   // the language of the RAG knowledge base (Config rag.language)
// CPV divisions (the 2 first digits of a CPV code): a bare "33696500" means nothing to a model, "medical equipment" does
const CPV_DIV = { '03': 'agriculture, farming products', '09': 'fuels, energy', 14: 'mining products', 15: 'food, beverages', 16: 'agricultural machinery',
  18: 'clothing, footwear', 19: 'leather, textiles, plastics', 22: 'printed matter, books', 24: 'chemical products', 30: 'computers and office equipment',
  31: 'electrical machinery, lighting', 32: 'radio, TV, telecom equipment', 33: 'medical equipment, pharmaceuticals', 34: 'vehicles, transport equipment',
  35: 'security, defence equipment', 37: 'musical, sports goods, toys', 38: 'laboratory, optical, precision equipment', 39: 'furniture, household goods',
  41: 'water', 42: 'industrial machinery', 43: 'mining, construction machinery', 44: 'construction materials', 45: 'construction works',
  48: 'software packages, information systems', 50: 'repair and maintenance services', 51: 'installation services', 55: 'hotel, restaurant, catering',
  60: 'transport services', 63: 'transport support, travel', 64: 'postal and telecom services', 65: 'public utilities', 66: 'financial, insurance services',
  70: 'real estate', 71: 'architecture, engineering, inspection', 72: 'IT services: consulting, software development, Internet, support',
  73: 'research and development', 75: 'public administration, defence, social security', 76: 'oil and gas services', 77: 'agricultural, forestry, horticultural services',
  79: 'business services: legal, marketing, consulting, recruitment, printing, security', 80: 'education and training', 85: 'health and social work',
  90: 'sewage, refuse, cleaning, environmental services', 92: 'recreational, cultural, sporting services', 98: 'other community, personal services' };
const cpvText = cpv => (cpv || []).map(c => `${c}${CPV_DIV[String(c).slice(0, 2)] ? ` (${CPV_DIV[String(c).slice(0, 2)]})` : ''}`).join(', ');
// a portal page often ends with OTHER notices ("## Appels d'offres à proximité", "## Related tenders", "## مناقصات أخرى"): such a
// section is cut up to the next heading of the same or a higher level (its own sub-headings, "### Notice A", are other notices
// too), so a word of another notice ("... en gîte communal et touristique" on an LLM-agents notice) can never become this
// tender's sector, quote or requirement
const othersHeading = line => /^#{1,6}\s/.test(line) && /(appels? d.offres?|\bavis\b|annonces?|march[ée]s\b|consultations|tenders|notices|opportunit|مناقص|طلبات? عروض)/i.test(line)
  && /(proximit|similaire|m[êe]me (source|acheteur|r[ée]gion|secteur|cat[ée]gorie)|connexe|r[ée]cent|derni[eè]r|autres|other|related|similar|nearby|recent|latest|see also|voir aussi|أخرى|مشابه|ذات صلة)/i.test(line);
const cutOthers = s => { let skip = 0;   // the level (number of #) of the others-heading being cut, 0 = keep
  return String(s || '').split('\n').filter(line => { const h = /^(#{1,6})\s/.exec(line); if (h && (!skip || h[1].length <= skip)) skip = othersHeading(line) ? h[1].length : 0; return !skip; }).join('\n'); };
return $input.all().map(({ json: t }) => {
  if (t._type || t.status !== 'kept') return { json: { ...t, _run: false } };
  // the source text only: API body_text already holds title + description + lots; on the URL lane the page itself (never the
  // extract LLM's description, so a fact it invented can not become a "verbatim" quote)
  const text = cutOthers(t.source_type === 'url' ? [t.title, t.body_text].filter(Boolean).join('\n') : t.body_text || [t.title, t.description].filter(Boolean).join('\n')).slice(0, cfg.limits.analysisMaxChars);
  const titleOnly = toks(text).length - toks(t.title).length < 40;
  const user = `${company}

TENDER
Title: ${t.title}
Buyer: ${(t.buyer && t.buyer.name) || '-'}
CPV: ${cpvText(t.cpv) || '-'}
TENDER TEXT:
"""${text}"""

Answer in this order:
1. tender_type = the MAIN object of the tender, one of: ${typeList}.
2. fit: compare the MAIN deliverable with the SERVICES list above. high = the main deliverable is one of these services; medium = an important part (a lot, a module) is; low = only loosely related; none = not the company's business. Supplying equipment or reselling / maintaining a specific vendor's product is "low" or "none" unless the SERVICES list says the company does it; so is a study, a survey or a supply of data or statistics (the deliverable is a report or a dataset, not software); so is running or supporting IT in general (outsourced IT operations or IT department, maintenance of IT equipment, servers or networks, user helpdesk) and an audit or a compliance assessment. Being about IT is not enough: the deliverable itself must be one of the SERVICES.
3. reason: ONE short sentence in quotes (a text, never a list), only with facts written in the TENDER TEXT, even when fit is none.
   services: the NUMBERS (1 to ${cp.services.length}) of each service of the SERVICES list the TENDER TEXT asks for (not the whole list), e.g. [2] or [1, 5]; [] if none.
4. quote: ONE sentence (5 to 30 words) copied EXACTLY from the TENDER TEXT that supports your answer.
5. sector: the buyer's sector as this tender states it (title, buyer, object), exactly one of: ${(cfg.rag.sectors || []).join(', ') || 'public sector, health, education'}; or null if none fits. Other notices listed on the same page do not count.
6. requirements: ONLY when fit is high or medium, every requirement the bidder must meet that is WRITTEN in the TENDER TEXT, else []. Each sentence with an obligation or a wish (doit, devra, obligatoire, exigé, au moins, souhaité, must, shall, required, preferably, يجب...) about the solution, the team or the references gives at least one item; administrative documents (forms, tax or insurance certificates, signatures) are not requirements.${titleOnly ? '\n   This text is only a title: requirements must be [].' : ''}
   category: technical (technologies, functions, deliverables, standards, hosting, security), team (roles, profiles, qualifications,
   staff, headcount), experience (references, similar projects, years of experience, certifications). Look for team and experience
   requirements too, not only technical ones.
   text: ONE requirement only, short (5 to 20 words), TRANSLATED into ${RAG_LANG}, never the original sentence (it is matched against the
   company's ${RAG_LANG} documents: CVs, past projects, tech stack). A sentence that lists several requirements becomes several items
   (they may share the same quote).
   skill: the SAME requirement as a short line of 2 to 8 words in ${RAG_LANG}, the way a CV or a tech stack writes it: name the
   technology, role, certification or kind of project, keep the count, drop "the system must", "the bidder shall", "provide".
   Forms, each <...> filled with what the quote says: "<technology>", "<technology> or <technology>", "Minimum <n> senior
   <role>s", "1 <role> <certification> certified", "<n>+ <kind of project> projects", "<standard> certification".
   A technology is written by its name only, never followed by a generic word (interface, server, layer, exposure, development,
   hosting): "<technology>", not "<technology> interface". A role is the job title a CV uses, not a word-for-word translation.
   Use only what the quote states: never add a kind of system (chatbot, mobile app, website, dashboard...), a technology, a sector
   or one of the SERVICES that it does not name, and never narrow it ("public or private clients" stays both).
   Write numbers as digits (3, not three). quote: the words of the TENDER TEXT that state it, copied EXACTLY (original language).
   Never invent years of experience, certifications or standards.
7. timeline: the duration or execution period of the contract written in the text, with its unit as written ("<n> mois", "<n> years"; not the publication date, not the bid deadline, not a start date), else null. No duration in the text = null.
{"tender_type":"...","fit":"...","reason":"...","services":[],"quote":"...","sector":null,"requirements":[{"category":"...","text":"...","skill":"...","quote":"..."}],"timeline":null}`;
  return { json: { ...t, _run: true, _title_only: titleOnly, _text: text, _sys: system, _usr: user } };
});
