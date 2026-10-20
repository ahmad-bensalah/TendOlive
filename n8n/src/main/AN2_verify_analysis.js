// Verify Analysis. Code checks what the LLM claims: the quote must be in the tender text (else fit goes down one level),
// a tender type the company does not bid on (Config company.tenderTypes, bid: false) is forced to "none", survivors = high / medium.
// Requirements are kept only when their quote is in the text and every number of their paraphrase is in that quote.
// rag_text = the short skill line sent to the RAG (its rules read "PostgreSQL", "3 senior developers"; long sentences fall to its
// reranker and come back missing): kept when 1 to 10 words and its numbers, names, sectors, kinds of system (or the title's) and
// most of its words are in the quote too, else the text is sent (checked the same way, and never the untranslated quote itself).
// A generic word next to a technology ("Angular interface") is dropped unless part of its name ("SQL Server"), a company SERVICES
// phrase must be a phrase of the quote.
// The sector must be written in the tender, the timeline must be a duration the text states (a bare number gets its unit from it),
// services given by name are mapped back to Config company.services (numbers only written in the reason, or a list of every service,
// are checked against the text), and obligation sentences that no kept requirement quotes (form fields and procedure apart, once
// each) are listed (requirements.uncovered).
// Output: ALL items (dropped tenders, errors and the run marker too) so the line always reaches Run Summary.
/*@lib fold quoteInText parseAnswer overlap nameSim*/
const cfg = $('00 - Config').first().json;
const TT = cfg.company.tenderTypes || {};
const TYPES = [...Object.keys(TT), 'other'];
const SVC = cfg.company.services;
// a bad tender_type gives 'other', not a failed answer; a missing reason ("reason": [] from a small model) gives '' (the fit and
// the quote are what the code checks, a reason only explains it): the answer is not lost for it. A missing quote (a small model
// leaves it out for non-fit notices) is an unproven fit, handled below like a quote not in the text: one level down, flagged
const schema = { type: 'object', required: ['fit'], properties: {
  tender_type: { type: 'string', enum: TYPES }, fit: { type: 'string', enum: ['high', 'medium', 'low', 'none'] },
  // services: numbers asked, but a small model also answers names ("AI / LLM solutions (...)"): strings here, mapped below
  reason: { type: 'string', maxLength: 400 }, services: { type: 'array', items: { type: 'string', maxLength: 200 }, maxItems: 10 }, quote: { type: 'string', maxLength: 600 }, sector: { type: 'string', nullable: true, ...((cfg.rag.sectors || []).length ? { enum: cfg.rag.sectors } : { maxLength: 80 }) },
  requirements: { type: 'array', maxItems: 30, items: { type: 'object', required: ['category', 'text', 'quote'], properties: {
    category: { type: 'string', enum: ['technical', 'team', 'experience'] }, text: { type: 'string', maxLength: 300 }, skill: { type: 'string', nullable: true, maxLength: 120 },
    quote: { type: 'string', maxLength: 600 }, mandatory: { type: 'boolean', default: false } } } },
  timeline: { type: 'string', nullable: true, maxLength: 300 } } };
const DOWN = { high: 'medium', medium: 'low', low: 'low', none: 'none' }, RANK = { high: 3, medium: 2, low: 1, none: 0, unknown: 0 };
// mandatory = the tender's own words say so (doit, obligatoire, must, يجب...), never the model's opinion; an award criterion or a
// weighted sub-criterion ("valant pour 30% de la note") is not a requirement that blocks a bid
const OBLIGATION = /\b(doit|doivent|devra|devront|obligatoire(ment)?|exig[ée]e?s?|imp[ée]rati(f|ve|vement)|requise?s?|indispensables?|au moins|minimum|must|shall|required|mandatory|at least)\b|يجب|إجباري|وجوبا|على الأقل/i;
const SCORED = /(% de la note|de la note finale|crit[eè]re|sous-crit|pond[ée]ration|valant pour|weighting|award criteri|points sur)/i;
const EN_NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30 };
const digitsInText = s => String(s).replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty)\b/gi, w => String(EN_NUM[w.toLowerCase()]));
// numbers in digits: thousands separators joined ("5 000", "5,000", "5.000" -> 5000), leading zeros ignored
const nums = s => (fold(String(s ?? '').replace(/(\d)[\s.,'\u00A0\u202F](?=\d{3}\b)/g, '$1')).match(/\d+/g) || []).map(n => String(Number(n)));
// requirements are written in the RAG's language: "trois ans" may become "3 years", "dix-huit mois" "18 months". Numbers written
// in WORDS count as numbers on BOTH sides (fr / en / ar); compounds are summed (vingt-quatre 24, quatre-vingt-dix 90, deux mille 2000)
const WORDS = { un: 1, une: 1, one: 1, deux: 2, two: 2, trois: 3, three: 3, quatre: 4, four: 4, cinq: 5, five: 5, six: 6, sept: 7, seven: 7, huit: 8, eight: 8,
  neuf: 9, nine: 9, dix: 10, ten: 10, onze: 11, eleven: 11, douze: 12, twelve: 12, treize: 13, thirteen: 13, quatorze: 14, fourteen: 14, quinze: 15, fifteen: 15,
  seize: 16, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, vingt: 20, vingts: 20, twenty: 20, trente: 30, thirty: 30, quarante: 40, forty: 40,
  cinquante: 50, fifty: 50, soixante: 60, sixty: 60, seventy: 70, eighty: 80, ninety: 90, cent: 100, cents: 100, hundred: 100, mille: 1000, thousand: 1000,
  'واحد': 1, 'اثنان': 2, 'اثنين': 2, 'ثلاث': 3, 'ثلاثة': 3, 'أربع': 4, 'أربعة': 4, 'خمس': 5, 'خمسة': 5, 'ست': 6, 'ستة': 6, 'سبع': 7, 'سبعة': 7, 'ثماني': 8, 'ثمانية': 8, 'تسع': 9, 'تسعة': 9, 'عشر': 10, 'عشرة': 10 };
const WORD_NUM = Object.fromEntries(Object.entries(WORDS).map(([w, n]) => [fold(w), n]));   // same folding as the text (أ -> ا, ة -> ه)
// withParts: also every single word ("dix huit" -> 10, 8, 18) - generous on the quote side, strict (whole numbers) on the text side
const wordNums = (s, withParts) => {
  const out = []; let cur = null, prev = null;
  const close = () => { if (cur != null) out.push(cur); cur = null; prev = null; };
  for (const w of fold(s).split(' ')) {
    const n = WORD_NUM[w];
    if (n == null) { if (!((w === 'et' || w === 'and') && cur != null)) close(); continue; }
    if (withParts) out.push(n);
    if (cur == null) cur = n;
    else if (n === 100 || n === 1000) cur = (cur || 1) * n;                      // deux mille, quatre cents
    else if (prev === 4 && n === 20) cur += 76;                                  // quatre-vingt = 80
    else if (n < prev || (prev % 10 === 0 && n < 10)) cur += n;                 // vingt-quatre, soixante-dix, dix-huit
    else { out.push(cur); cur = n; }
    prev = n;
  }
  close();
  return out.map(String);
};
// split a skill line on , and ; (not inside parentheses, not inside a number "5,000") and on "and 3" / "et 2" (a second count)
const splitSkill = s => {
  const out = []; let depth = 0, cur = '';
  for (let k = 0; k < s.length; k++) {
    const ch = s[k];
    if (ch === '(') depth++; else if (ch === ')') depth = Math.max(0, depth - 1);
    if ((ch === ',' || ch === ';') && !depth && !(/\d/.test(s[k - 1] || '') && /\d/.test(s[k + 1] || ''))) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out.flatMap(p => p.split(/\s+(?:and|et|&)\s+(?=\d)/i)).map(p => p.trim()).filter(Boolean);
};
// a skill line may only NAME what the tender's quote names: a capitalised / technical term (React, Node.js, LLM, Salesforce, PMP,
// AWS) missing from the quote means the model copied a prompt example or invented it ("React or Node.js frontend" for a ticketing
// notice, "LLM chatbot with RAG" for video analysis). Common words that only start a line are not names; equivalents across
// languages count (IA = AI, relation client = CRM, français = French).
const GENERIC = new Set(('minimum at least senior junior lead data compliance role multilingual online vector open source web mobile cloud ' +
  'ticketing website back front end project projects team experience development integration maintenance hosting support security sales ' +
  'health healthcare public sector digital deployed previous similar certification certified training user users customer citizen ' +
  'platform portal application app system software solution dashboard dashboards analytics reporting management document documents ' +
  'search booking payment e services e-services access control identity network infrastructure automation workflow migration audit ' +
  'design designer developer developers engineer engineers manager consultant expert references reference years year one 1 ' +
  'the a an each all any le la les l un une des du de d il elle ce cette').split(' '));
const SYN = { ai: ['ia', 'intelligence artificielle', 'ذكاء اصطناعي'], llm: ['grand modele de langage', 'modele de langage', 'language model', 'llms'],
  rag: ['generation augmentee', 'retrieval augmented'], crm: ['relation client', 'relation usager', 'relation citoyen', 'gestion de la relation', 'grc'],
  bi: ['decisionnel', 'business intelligence'], french: ['francais', 'فرنسيه', 'الفرنسيه'], arabic: ['arabe', 'عربيه', 'العربيه'],
  english: ['anglais', 'انجليزيه'], ux: ['ux', 'experience utilisateur'], ui: ['ui', 'interface'], gis: ['sig', 'information geographique'],
  gdpr: ['rgpd', 'protection des donnees'], rgpd: ['gdpr'] };
// the first word of a line is capitalised anyway: it is a name only when it looks technical (LLM, Node.js, PostgreSQL) or is the
// whole line ("Python"); "Knowledge of local authorities" names nothing
const technical = w => (w.match(/\p{Lu}/gu) || []).length >= 2 || /[.+#\d]/.test(w);
const namedTerms = s => {
  const words = String(s).trim().split(/\s+/);
  return words.flatMap((w, k) => w.split(/[/-]/).map(x => [x.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}+#]+$/gu, ''), k]))
    .filter(([w, k]) => w && /\p{Lu}/u.test(w) && !/^\d/.test(w) && !GENERIC.has(fold(w)) && (k > 0 || words.length === 1 || technical(w)))
    .map(([w]) => w);
};
const named = (w, quote) => { const Q = ` ${fold(quote)} `, f = fold(w);
  return Q.includes(` ${f} `) || (SYN[f] || []).some(x => hasForm(Q, x)); };   // hasForm: an Arabic form may carry "و" / "ال" ("والفرنسية")
const quoteNums = s => new Set([...nums(s), ...wordNums(s, true)]);
const textNums = s => [...new Set([...nums(s), ...wordNums(s, false)])];
// lexicon forms are written folded (no accents), "*" = any ending ("heberg*" = hébergée, hébergement), whole words; a non-Latin form
// starts a word, any ending, after the letters Arabic glues to it (و ف, ب ك ل, the article ال / لل: "لبوابة", "والفرنسية", "للدولة"),
// never inside another word ("طبي" is in "تطبيق", "مالي" in "شمالي")
const formRe = new Map();
const hasForm = (Q, f) => {
  if (!formRe.has(f)) { const g = fold(f), ar = /[^\p{Script=Latin}\s*]/u.test(f), pre = '(?<!\\S)[وف]?(?:[بكل]?ال|لل|[بكل])?';
    formRe.set(f, ar ? new RegExp(`${pre}${g}${g.startsWith('ال') ? `|(?<!\\S)[وف]?لل${g.slice(2)}` : ''}`, 'u') : new RegExp(` ${f.replace(/\*/g, '\\p{L}*')} `, 'u')); }
  return formRe.get(f).test(Q); };
// KINDS of system and SECTORS a line may only name when its quote does ([words of an English line, forms in the quote]): a small
// model adds them from a prompt example or from the company's own SERVICES ("LLM chatbot with RAG" for "agents LLM ... (RAG)",
// "web and mobile applications" for a ticketing notice, "in public sector" for "acteurs publics ou privés"), and the RAG then
// looks for a chatbot / a mobile app / public-sector projects that the tender never asked for
const KINDS = {
  chatbot: [['chatbot*', 'chat bot*', 'conversational', 'voicebot*', 'callbot*', 'virtual assistant*', 'virtual agent*'], ['conversation*', 'assistant* virtuel*', 'agent* virtuel*', 'assistant* ia', 'assistant* intelligent*', 'robot* conversationnel*', 'مساعد افتراضي', 'مساعد ذكي', 'مساعد رقمي', 'محادث', 'دردش']],
  mobile: [['mobile*', 'smartphone*', 'ios', 'android', 'tablet*'], ['tablette*', 'telephone*', 'محمول', 'هاتف', 'هواتف', 'جوال', 'لوحي']],
  web: [['web*', 'website*', 'online', 'internet', 'portal*', 'browser*', 'e service*', 'eservice*'], ['en ligne', 'site* internet', 'site* web', 'portail*', 'extranet*', 'intranet*', 'navigateur*', 'teleservice*', 'teleprocedure*', 'dematerialis*', 'إلكتروني', 'بوابة', 'انترنت', 'واب', 'ويب']],
  dashboard: [['dashboard*', 'dataviz'], ['tableau* de bord', 'pilotage', 'decisionnel*', 'reporting', 'visualisation*', 'power bi', 'لوحة قيادة', 'لوحة القيادة', 'لوحات القيادة', 'لوحة متابعة', 'لوحات متابعة']],
  booking: [['booking*', 'reservation*', 'appointment*'], ['reserv*', 'rendez vous', 'حجز', 'موعد', 'مواعيد']],
  ticketing: [['ticketing', 'ticket*'], ['billet*', 'تذاكر', 'تذكرة']],
  payment: [['payment*', 'checkout'], ['paiement*', 'payer', 'monetique', 'encaissement*', 'regie*', 'دفع', 'خلاص', 'سداد']],
  ecommerce: [['e commerce', 'ecommerce', 'online shop*', 'online store*', 'marketplace*', 'webshop*'], ['commerce electronique', 'boutique* en ligne', 'vente* en ligne', 'place* de marche', 'تجارة إلكترونية']],
  map: [['map', 'maps', 'geographic*', 'geospatial*', 'cartograph*'], ['carto*', 'carte*', 'geograph*', 'geolocalis*', 'sig', 'خرائط', 'خريطة', 'جغرافي']],
  video: [['video*', 'cctv', 'camera*'], ['videoprotection', 'videosurveillance', 'كاميرا', 'فيديو']],
  public: [['public', 'government*', 'municipal*', 'local authorit*', 'local government*'], ['publics', 'publique*', 'collectivit*', 'administration*', 'etat', 'ministere*', 'commune', 'communes', 'mairie*', 'departement*', 'region', 'regions', 'regional*', 'territori*', 'agence*', 'authorit*', 'council*', 'عمومي', 'حكومي', 'القطاع العام', 'القطاعين العام', 'بلدي', 'وزار', 'الدولة', 'ولاية']],
  private: [['private'], ['prive', 'prives', 'privee', 'privees', 'القطاع الخاص', 'خواص']],
  health: [['health*', 'medical', 'hospital*', 'clinical', 'clinic*', 'patient*', 'pharma*'], ['sante', 'medic*', 'hopita*', 'hospitali*', 'chu', 'chr', 'ars', 'ght', 'ehpad*', 'clinique*', 'soins', 'infirmi*',
    'officine*', 'parapharmac*', 'biologie medicale', 'biologiste*', 'laboratoire* d analyse*', 'imagerie*', 'radiolog*', 'echograph*', 'chirurg*', 'therapeut*', 'صحة', 'صحية', 'القطاع الصحي', 'مستشف', 'طبية', 'طبيب', 'أطباء']],
  // no form that is also the start of a common word: "enseigne*" = enseignement, "financ*" = financement (every EU-funded notice),
  // "مساعد" = مساعدة (help), "موقع" = a location, "لوحة" = any board, "مصرف" = a drain, "تأمين" = securing
  education: [['education*', 'school*', 'universit*', 'academic*', 'student*', 'teaching'], ['enseignement*', 'ecole*', 'lycee*', 'college*', 'academi*', 'rectorat*', 'eleve*', 'etudiant*', 'scolaire*', 'pedagog*', 'تعليم', 'مدرس', 'جامعة', 'جامعات', 'جامعي', 'تلاميذ', 'طلبة']],
  telecom: [['telecom*'], ['telephoni*', 'fibre optique', 'internet', 'اتصالات']],
  finance: [['finance', 'financial', 'bank*', 'insurance*', 'fintech*'], ['financier*', 'comptab*', 'banque*', 'bancaire*', 'bourse', 'fiscal*', 'mutuelle*', 'assureur*', 'مالية', 'مالي', 'بنك', 'بنوك', 'مصرفي', 'مصارف', 'شركات التأمين', 'شركة تأمين', 'قطاع التأمين']],
  retail: [['retail*'], ['commerce de detail', 'commerces', 'commercant*', 'magasin*', 'grande distribution', 'grande* surface*', 'distributeur*', 'enseigne', 'enseignes', 'متجر', 'متاجر']],
  tourism: [['touris*', 'hotel', 'hotels', 'hospitality', 'travel'], ['hotellerie', 'hotelier*', 'gite*', 'camping*', 'voyage*', 'سياح', 'فندق', 'نزل']],
};
const SECTORS = new Set(['public', 'private', 'health', 'education', 'telecom', 'finance', 'retail', 'tourism']);
const SECTOR_CPV = { health: ['33', '85'], education: ['80'], telecom: ['32', '64'], finance: ['66'], tourism: ['55', '6351'] };   // CPV divisions that state a sector too
const kindIn = (k, Q) => KINDS[k][0].some(f => hasForm(Q, f)) || KINDS[k][1].some(f => hasForm(Q, f));
// "publics ou privés", "secteurs public et privé", "public/private", "tant publics que privés", "القطاعين العام والخاص" (folded quote):
// the two named as a PAIR. Both words alone are no pair ("sur un cloud privé, l'administration étant assurée par le titulaire")
const PUB = '(?:publi(?:cs?|ques?)|(?:ال)?(?:عمومي|حكومي)\\p{L}*|(?:القطاعين |القطاع )?العام\\p{L}*)(?!\\p{L})', PRI = '(?:priv(?:es?|ees?|ate)|(?:ال)?(?:خاص|خواص)\\p{L}*)(?!\\p{L})';
const SEP = '(?: (?:et )?(?:ou|et|or|and|comme|que|او|و)(?: \\p{L}+){0,2} | و| )';
const PAIR = new RegExp(`(?<!\\p{L})(?:${PUB}${SEP}${PRI}|${PRI}${SEP}${PUB})`, 'u');
// public / private used as a SECTOR in a line ("in public sector", "private clients", "local authorities"), not "Private cloud hosting"
const SECTOR_USE = /\b(?:public|private|government|municipal)[\s-]+(?:sectors?|clients?|customers?|organi[sz]ations?|bodies|entities|actors?|players?|institutions?|agenc(?:y|ies)|departments?|administrations?|partners?|buyers?|companies|enterprises?|stakeholders?|markets?|projects?)\b|\blocal[\s-]+(?:authorit|government)/i;
// a KIND of system the tender's own title names is stated too ("Application mobile de signalement" + a quote "L'application doit
// ...", "... assistant conversationnel IA (chatbot RAG)" + "L'assistant doit ..."); a sector is not (a line naming one narrows the
// RAG search to that sector's projects), and a narrowing is judged on the quote only
const kindsNotStated = (s, quote, title) => {
  const P = ` ${fold(s)} `, Q = ` ${fold(quote)} `, T = ` ${fold(title)} `, kinds = Object.keys(KINDS).filter(k => KINDS[k][0].some(f => hasForm(P, f)));
  const out = kinds.filter(k => !kindIn(k, Q) && (SECTORS.has(k) || !kindIn(k, T)));
  // "auprès d'acteurs publics ou privés": a line naming only one of them as a sector narrows the requirement (the RAG then counts public-sector projects only)
  if (kinds.includes('public') !== kinds.includes('private') && PAIR.test(Q) && SECTOR_USE.test(s)) out.push(kinds.includes('public') ? 'public' : 'private');
  return [...new Set(out)];
};
// most words of a line must be in its quote too (in any language: the same word, a shared stem of 5+ letters "developers" ~
// "développeurs", or a lexicon form "hosting" ~ "hébergée"): "Methodology for development of open-source data platforms" for
// "Pertinence de la méthodologie d'intervention" is refused. Grammar and the form of a CV line ("Minimum 3 senior ...", "5 years of
// experience") are not judged, names were checked above, sector words strictly by KINDS; against a non-Latin quote only lexicon words
// can be judged
const FORM = new Set(('a an the and or of for with in on to by from at as per via its their our your all any each both other such than into within across ' +
  'must shall should will would can could may be been being is are was were has have had do does provide provided providing ensure ensuring include includes including ' +
  'use used using based able ability capable need needs needed required requirement requirements mandatory new strong good proven solid sector sectors client clients ' +
  'minimum maximum min max least most more plus senior seniors junior juniors lead experience experienced expertise expert experts knowledge skills skill skilled ' +
  'year years month months day days reference references similar previous past delivered deployed completed realised realized profile profiles ' +
  'le la les l un une des du de d et ou en au aux pour par sur dans avec sa son ses leur leurs qui que est sont doit doivent devra devront etre').split(' '));
const EQ = { app: ['appli*', 'تطبيق'], application: ['appli*', 'تطبيق'], software: ['logiciel*', 'progiciel*', 'برمجي', 'برنامج'], platform: ['plateforme*', 'plate forme*', 'منصة'],
  system: ['systeme*', 'نظام', 'منظومة'], tool: ['outil*', 'أداة'], database: ['base* de donnee*', 'bdd', 'sgbd', 'قاعدة', 'قواعد'], data: ['donnee*', 'bdd', 'بيانات', 'معطيات'],
  management: ['gestion*', 'gerer', 'gere*', 'pilotage', 'administration*', 'إدارة', 'تسيير', 'تصرف'], manage: ['gestion*', 'gerer', 'gere*', 'pilotage', 'إدارة', 'تسيير', 'تصرف'],
  hosting: ['heberg*', 'infogeranc*', 'datacenter*', 'استضافة', 'إيواء'], host: ['heberg*', 'استضافة'], maintenance: ['maintenance*', 'maintien*', 'mco', 'tma', 'صيانة'],
  support: ['assistance*', 'accompagnement*', 'appui', 'support*', 'hotline', 'دعم', 'مساندة', 'مرافقة'], training: ['formation*', 'تكوين', 'تدريب'],
  development: ['developp*', 'realis*', 'conception*', 'construi*', 'creation*', 'تطوير', 'إنجاز', 'بناء'], develop: ['developp*', 'realis*', 'conception*', 'creation*', 'تطوير', 'إنجاز'],
  build: ['developp*', 'realis*', 'construi*', 'creation*', 'تطوير', 'إنجاز', 'بناء'], design: ['conception*', 'concevoir', 'design*', 'maquett*', 'تصميم'],
  deployment: ['deploi*', 'mise en oeuvre', 'mise en service', 'mise en production', 'installation*', 'نشر', 'تركيز'], implementation: ['mise en oeuvre', 'mise en place', 'implement*', 'deploi*', 'تنفيذ', 'إرساء', 'تركيز'],
  integration: ['integr*', 'interfac*', 'connect*', 'connexion*', 'raccord*', 'interoperab*', 'إدماج', 'ربط', 'تكامل'], connect: ['connect*', 'connexion*', 'interfac*', 'raccord*', 'ربط'],
  interface: ['interface*', 'ihm', 'واجهة'], frontend: ['front*', 'interface*', 'ihm', 'واجهة'], backend: ['back*', 'serveur*', 'خادم'], security: ['securi*', 'cybersecuri*', 'أمن', 'سلامة', 'حماية'],
  access: ['acces*', 'habilitation*', 'authentifi*', 'نفاذ', 'ولوج'], role: ['role*', 'profil*', 'habilitation*', 'صلاحي'], user: ['utilisateur*', 'usager*', 'مستخدم', 'مستعمل'],
  citizen: ['citoyen*', 'usager*', 'habitant*', 'administre*', 'مواطن'], customer: ['client*', 'usager*', 'حريف', 'حرفاء', 'زبون', 'زبائن', 'عملاء'], relationship: ['relation*', 'علاقة'],
  service: ['service*', 'prestation*', 'خدمة', 'خدمات'], request: ['demande*', 'requete*', 'طلب'], monitoring: ['suivi*', 'supervision*', 'surveillance*', 'pilotage', 'متابعة', 'مراقبة'],
  tracking: ['suivi*', 'tracabilite*', 'متابعة'], track: ['suivi*', 'suivre', 'tracabilite*', 'متابعة'], traceability: ['tracab*', 'تتبع'], traceable: ['tracab*', 'تتبع'], sales: ['vente*', 'commercial*', 'مبيعات'], document: ['document*', 'piece*', 'وثيقة', 'وثائق', 'مستند'], search: ['recherche*', 'بحث'],
  generative: ['generati*', 'توليدي'], pipeline: ['pipeline*', 'chaine*', 'flux'], workflow: ['flux', 'workflow*', 'circuit*', 'processus', 'سير العمل'],
  automation: ['automati*', 'robotis*', 'rpa', 'أتمتة', 'آلي'], automated: ['automati*', 'أتمتة', 'آلي'], process: ['processus', 'procedure*', 'demarche*', 'إجراء'],
  digital: ['numerique*', 'digital*', 'dematerialis*', 'electroni*', 'رقمي', 'رقمنة', 'إلكتروني'], electronic: ['electroni*', 'dematerialis*', 'informatis*', 'إلكتروني'],
  analytics: ['analy*', 'decisionnel*', 'statisti*', 'indicateur*', 'تحليل'], analysis: ['analy*', 'etude*', 'تحليل'], reporting: ['reporting', 'rapport*', 'restitution*', 'indicateur*', 'تقرير', 'تقارير'],
  report: ['rapport*', 'reporting', 'تقرير'], migration: ['migration*', 'migrer', 'reprise* de donnee*', 'ترحيل'], network: ['reseau*', 'شبكة'], cloud: ['cloud', 'nuage*', 'saas', 'سحابي'],
  image: ['image*', 'photo*', 'صورة', 'صور'], manager: ['chef*', 'responsable*', 'directeur*', 'pilote*', 'coordinat*', 'مدير', 'رئيس', 'مسؤول', 'منسق'], project: ['projet*', 'operation*', 'مشروع', 'مشاريع'],
  engineer: ['ingenieur*', 'مهندس'], developer: ['developpeur*', 'programmeur*', 'مطور', 'مبرمج'], architect: ['architect*', 'مهندس'], analyst: ['analyste*', 'محلل'],
  administrator: ['administrat*', 'مسؤول', 'متصرف'], team: ['equipe*', 'moyens humains', 'personnel*', 'فريق'], staff: ['personnel*', 'effectif*', 'moyens humains', 'intervenant*', 'أعوان', 'موظف'],
  methodology: ['methodolog*', 'methode*', 'demarche*', 'approche*', 'منهجية'], method: ['methode*', 'methodolog*', 'demarche*', 'منهجية'], local: ['local*', 'territori*', 'collectivit*', 'محلي'],
  authority: ['collectivit*', 'autorite*', 'administration*', 'etablissement* public*', 'سلطة', 'هيكل'], quality: ['qualite*', 'جودة'], standard: ['norme*', 'referentiel*', 'standard*', 'معيار', 'مواصفات'],
  compliance: ['conform*', 'respect*', 'مطابقة'], regulation: ['reglement*', 'legislation*', 'legal*', 'juridique*', 'rgpd', 'قانون', 'تشريع'], accessibility: ['accessib*', 'rgaa', 'نفاذ'],
  multilingual: ['multilingu*', 'langue*', 'francais', 'anglais', 'arabe', 'لغات', 'لغتين', 'باللغتين'], open: ['open', 'libre*', 'ouvert*', 'مفتوح'], source: ['source*', 'مصدر'],
  vector: ['vector*', 'vectori*'], model: ['modele*', 'نموذج', 'نماذج'], language: ['langage*', 'langue*', 'لغة'], existing: ['exist*', 'actuel*', 'en place', 'حالي', 'موجود'],
  replacement: ['remplac*', 'renouvel*', 'refonte', 'refondre', 'تعويض', 'تجديد'], renewal: ['renouvel*', 'remplac*', 'refonte', 'تجديد'], redesign: ['refonte', 'refondre', 'modernis*', 'تحديث'],
  modernization: ['modernis*', 'refonte', 'evolution*', 'تحديث'], archiving: ['archiv*', 'أرشفة', 'أرشيف'], signature: ['signature*', 'إمضاء', 'توقيع'], custom: ['sur mesure', 'specifique*'],
  functional: ['fonctionnel*', 'وظيفي'], feature: ['fonctionnalite*', 'fonction*', 'وظائف'], function: ['fonction*', 'وظائف'], availability: ['disponib*'], available: ['disponib*', 'متوفر', 'متاح'],
  record: ['dossier*', 'fiche*', 'registre*', 'enregistrement*', 'سجل', 'ملف'], computerized: ['informatis*'], core: ['coeur', 'socle*', 'noyau*'], intelligence: ['intelligen*', 'ذكاء'],
  institution: ['etablissement*', 'organisme*', 'structure*', 'مؤسس'], legacy: ['ancien*', 'existant*', 'actuel*', 'قديم'] };
const eqOf = w => [w, w.replace(/ies$/, 'y'), w.replace(/e?s$/, ''), w.replace(/s$/, ''), w.replace(/(ing|ed)$/, ''), w.replace(/(ing|ed)$/, 'e')].map(x => EQ[x]).find(Boolean);
const cog = (a, b) => { let k = 0; while (k < a.length && a[k] === b[k]) k++; return k >= 5 || (k >= 4 && k === Math.min(a.length, b.length)); };
const latinQuote = s => { const L = String(s).match(/\p{L}/gu) || []; return !L.length || L.filter(c => /\p{Script=Latin}/u.test(c)).length / L.length >= 0.5; };
// one folded word of a line in a folded text: true / false, or null when it can not be judged (grammar, a sector word, or a word with
// no lexicon form against a non-Latin text); a kind of system the folded title T names counts as written
const wordIn = (w, Q, QT, latin, T) => {
  if (!w || /\d/.test(w) || FORM.has(w)) return null;
  const kind = Object.keys(KINDS).find(k => KINDS[k][0].some(f => hasForm(` ${w} `, f)));
  if (kind && SECTORS.has(kind)) return null;
  if (kind && T && kindIn(kind, T)) return true;
  const forms = [...(eqOf(w) || []), ...(SYN[w] || []), ...(kind ? KINDS[kind][1] : [])];
  if (!latin && !forms.length) return QT.includes(w) || null;   // a Latin word written as is in an Arabic quote ("Laravel") counts
  return QT.includes(w) || (latin && QT.some(q => cog(w, q))) || forms.some(f => hasForm(Q, f));
};
// judged words of a line: n judged (names count as stated, checked above), ok stated, miss = the folded words not stated
const judge = (s, quote, title) => {
  const Q = ` ${fold(quote)} `, QT = Q.trim().split(' '), latin = latinQuote(quote), names = namedTerms(s), nameToks = new Set(names.flatMap(w => fold(w).split(' ')));
  const T = ` ${fold(title)} `, miss = [];
  let n = names.length, ok = names.length;
  for (const w of fold(s).split(' ')) { const x = nameToks.has(w) ? null : wordIn(w, Q, QT, latin, T); if (x !== null) { n++; if (x) ok++; else miss.push(w); } }
  return { n, ok, miss, names: names.length };
};
const stated = (s, quote, title) => { const j = judge(s, quote, title); return j.n ? j.ok / j.n : 1; };
// the company's own SERVICES wording ("document intelligence", "data platforms") copied as a line: the model sees it in the prompt.
// It is stated only as a PHRASE of the quote (its words close together: "plateforme de données"), not as words scattered over it
// ("document" in "recherche documentaire", "intelligence" in "intelligence artificielle" 15 words before)
const SVC_TEXT = SVC.map(s => ` ${fold(s)} `);
const wordAt = (w, QT, latin) => {   // token indexes where a folded word of a line is stated in the quote (same tests as wordIn)
  const kind = Object.keys(KINDS).find(k => KINDS[k][0].some(f => hasForm(` ${w} `, f)));
  const forms = [...(eqOf(w) || []), ...(SYN[w] || []), ...(kind ? KINDS[kind][1] : [])];
  return QT.map((q, i) => (q === w || (latin && cog(w, q)) || forms.some(f => hasForm(` ${QT.slice(i, i + f.split(' ').length).join(' ')} `, f)) ? i : -1)).filter(i => i >= 0);
};
const svcPhraseWhy = (s, quote) => {
  const f = fold(s); if (f.split(' ').length < 2 || !SVC_TEXT.some(x => x.includes(` ${f} `))) return '';
  const QT = fold(quote).split(' '), latin = latinQuote(quote);
  const P = f.split(' ').filter(w => w && !/\d/.test(w) && !FORM.has(w)).map(w => wordAt(w, QT, latin)).filter(p => p.length);   // a word not found at all is judged by stated()
  // (within the phrase's length + 6 tokens: a French noun phrase spreads it, "plateforme de gestion et de partage des données")
  return P.length < 2 || P.flat().some(a => P.every(p => p.some(i => i >= a && i - a <= P.length + 6))) ? '' : 'services phrase not in quote';
};
// why a short line can not be sent for this quote ('' = it can); an implicit 1 is fine ("1 project manager" for "un chef de projet").
// A line of 1 or 2 common words (no name) stands on each of them: a word its quote does not state and the model's own translation
// (the requirement's text, unless that is the quote copied) does not use either is a word-for-word mistranslation ("1 chief project"
// for "1 chef de projet", the text saying "1 project manager": half stated was enough, and the RAG then looked for a role nobody has,
// a false blocking team gap)
const lineWhy = (s, quote, inQuote, title, text) => {
  if (s.split(' ').length > 10 || /[<>]/.test(s)) return 'not a skill line';
  const n = textNums(s).filter(x => x !== '1' && !inQuote.has(x)); if (n.length) return `numbers not in quote: ${n.join(',')}`;
  const nm = namedTerms(s).filter(w => !named(w, quote)); if (nm.length) return `names not in quote: ${nm.join(', ')}`;
  const k = kindsNotStated(s, quote, title); if (k.length) return `not in quote: ${k.join(', ')}`;
  const sp = svcPhraseWhy(s, quote); if (sp) return sp;
  const j = judge(s, quote, title); if (j.n && j.ok / j.n < 0.5) return 'words not in quote';
  const T = ` ${fold(text)} `, odd = text && !j.names && j.n <= 2 && !copiesQuote(text, quote) ? j.miss.filter(w => !T.includes(` ${w} `)) : [];
  return odd.length ? `not in quote nor text: ${odd.join(', ')}` : '';
};
// words of a skill line the RAG can not match, which only send it to its reranker (a negative score there turned "REST API exposure",
// "Angular interface" and "Node.js server" into missing / partial although its rules matched the technology): a generic noun next to
// technology names the quote writes as such is dropped ("Angular"), so is "with public or private actors" when the quote names both
// (no constraint: the RAG needs no sector) and a trailing "required"
const FILLER = new Set(('interface interfaces server servers frontend frontends front back end backend backends database databases db hosting exposure layer layers ' +
  'development deployment framework frameworks stack environment technology technologies cloud ' +
  'serveur serveurs base donnees hebergement developpement deploiement couche couches exposition environnement technologie').split(' '));
const PAIR_LINE = /\s*\b(?:(?:with|for|in|from|across|among|by|of|at|aupr[eè]s d[e'’]?|pour|dans|avec|chez)\s*)?(?:(?:both|the|les|des)\s+)?(?:(?:actors?|clients?|acteurs?|organismes?|structures?|secteurs?)\s+)?(?:publi(?:c|cs|ques?)\s+(?:and|or|&|\/|et|ou)\s+priv(?:ate|[ée]e?s?)|priv(?:ate|[ée]e?s?)\s+(?:and|or|&|\/|et|ou)\s+publi(?:c|cs|ques?))(?:[\s-]+sectors?)?(?:\s+(?:actors?|clients?|customers?|organi[sz]ations?|bodies|entities|players?|stakeholders?|partners?|institutions?|structures?|companies|buyers?))?(?![\p{L}])/giu;
const trimLine = (s, quote) => {
  let x = s.replace(/\s+(?:is\s+|are\s+)?(?:required|mandatory|requested|expected|preferred|desired|desirable|needed)$/i, '');
  if (PAIR.test(` ${fold(quote)} `)) x = x.replace(PAIR_LINE, ' ').replace(/\s+/g, ' ').trim().replace(/(?:\s*(?:\b(?:and|or|with|for|in|of|on|by|from|at)|[&,-]))+$/i, '').trim();
  const W = x.split(' '), fill = w => { const f = fold(w); return !!f && f.split(' ').every(y => FILLER.has(y) || FORM.has(y)); };
  const tech = w => /\p{Lu}/u.test(w) && fold(w).split(' ').every(y => !GENERIC.has(y) && !FORM.has(y) && !FILLER.has(y)) && named(w, quote)
    && !Object.keys(KINDS).some(k => KINDS[k][0].some(f => hasForm(` ${fold(w)} `, f)));
  // a generic word that is PART of a name is never cut ("SQL Server", "Google Cloud", "Entity Framework", "Windows Server", "Cloud Act"):
  // written with a capital (not as the line's first word, capitalised anyway), or written next to that name in the quote ("sous SQL server")
  const Q = ` ${fold(quote)} `, part = (k, nb) => (k > 0 && /\p{Lu}/u.test(W[k])) || (!!W[nb] && !FORM.has(fold(W[nb])) && Q.includes(` ${fold(k < nb ? `${W[k]} ${W[nb]}` : `${W[nb]} ${W[k]}`)} `));
  let a = 0, b = W.length, cut = false, keepA = false, keepB = false;
  const filler = w => fold(w).split(' ').some(y => FILLER.has(y));
  while (a < b && fill(W[a])) { if (part(a, a + 1)) { keepA = true; break; } if (filler(W[a])) cut = true; a++; }
  while (b > a && fill(W[b - 1])) { if (part(b - 1, b - 2)) { keepB = true; break; } b--; if (filler(W[b])) cut = true; }
  const rest = W.slice(a, b);
  if (cut && rest.some(tech) && rest.every((w, k) => tech(w) || /^(or|and|ou|et|&|\+|\/)$/i.test(w) || (k === 0 && keepA) || (k === rest.length - 1 && keepB))) x = rest.join(' ');
  return x && toks(x).length ? x : s;
};
// a line that only ADDS a kind of system or a sector keeps what its quote states ("LLM chatbot with RAG" -> "LLM with RAG",
// "Experience in open source data management in public sector" -> "... data management"), when the rest is wholly in the quote
const cutKinds = (s, kinds) => {
  let x = s;
  for (const k of kinds) for (const f of KINDS[k][0]) x = x.replace(new RegExp(`(?:\\b(?:in|for|within|across|from|of)\\s+(?:the\\s+)?)?\\b${f.split(' ').map(w => w.replace(/\*$/, '[a-z]*')).join('[\\s-]+')}\\b(?:\\s+(?:sectors?|organi[sz]ations?|clients?|bodies|entities|domain|field|industry))?`, 'gi'), ' ');
  return x.replace(/\(\s*\)/g, ' ').replace(/\s+/g, ' ').trim().replace(/^(?:(?:(?:and|or|with|for|in|of|on|by|from)\b|[&,-])\s*)+/i, '')
    .replace(/(?:\s*(?:\b(?:and|or|with|for|in|of|on|by|from)|[&,-]))+$/i, '').replace(/\b(and|or|with|for|in|of)\s+(?:and|or|with|for|in|of)\b/gi, '$1').trim();
};
const fixLine = (s0, quote, inQuote, title, text) => {
  const s = trimLine(s0, quote), why = lineWhy(s, quote, inQuote, title, text); if (!why) return { line: s };
  // a trailing "in / with / using <Name>" naming only what the quote does not is cut the same way ("LLM with RAG architecture in
  // Python": Python is asked in another sentence; the long sentence sent instead came back partial)
  if (why.startsWith('names not in quote: ')) {
    const nm = new Set(namedTerms(s).filter(w => !named(w, quote))), W = s.split(' '), k = W.map(w => /^(in|with|using|on|via|under|en|avec|sous)$/i.test(w)).lastIndexOf(true);
    const parts = w => w.split(/[/-]/).map(x => x.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}+#]+$/gu, '')).filter(Boolean);
    const cut = k > 0 && k < W.length - 1 && W.slice(k + 1).every(w => /^(and|or|et|ou|&)$/i.test(w) || parts(w).every(x => nm.has(x))) ? W.slice(0, k).join(' ') : '';
    if (cut && !lineWhy(cut, quote, inQuote, title, text) && stated(cut, quote, title) === 1) return { line: cut, cut: [...nm].join(', ') };
  }
  const kinds = why.startsWith('not in quote: ') ? kindsNotStated(s, quote, title) : [], cut = kinds.length ? cutKinds(s, kinds) : '';
  const content = cut && (namedTerms(cut).length || fold(cut).split(' ').some(w => w && !FORM.has(w) && !/\d/.test(w)));
  return content && cut !== s && !lineWhy(cut, quote, inQuote, title, text) && stated(cut, quote, title) === 1 ? { line: cut, cut: kinds.join(', ') } : { why };
};
// a refused part that COUNTS (people, projects: "1 chief project") falls back to the model's own text for that count ("The bidder must
// propose 1 project manager and 2 data engineers" -> "1 project manager"), checked the same way: the other parts are sent, and this
// requirement was lost with its wording
const countPart = (part, text) => {
  const n = textNums(part); if (!n.length) return '';
  const seg = splitSkill(digitsInText(text)).find(x => { const m = textNums(x); return m.length === n.length && n.every(y => m.includes(y)); });
  const at = seg ? seg.search(/\d/) : -1;
  return at >= 0 ? seg.slice(at).replace(/[.;:]+$/, '').trim() : '';
};
// the full sentence, sent when no skill line is usable: same checks, no length limit
const sentenceWhy = (s, quote, title) => {
  const nm = namedTerms(s).filter(w => !named(w, quote)); if (nm.length) return `names not in quote: ${nm.join(', ')}`;
  const k = kindsNotStated(s, quote, title); if (k.length) return `not in quote: ${k.join(', ')}`;
  return stated(s, quote, title) < 0.5 ? 'words not in quote' : '';
};
// the "translated" requirement is the quote itself (or most of it), still in the tender's language: it is never sent to the RAG
// (a long sentence in another language comes back missing) and never shown as the requirement when a checked skill line exists
const LANG = { english: 'en', french: 'fr', arabic: 'ar', spanish: 'es', german: 'de', italian: 'it', portuguese: 'pt', dutch: 'nl' };
const RAG_LANG = String((cfg.rag && cfg.rag.language) || 'English').toLowerCase(), RAG_CODE = LANG[RAG_LANG] || RAG_LANG.slice(0, 2);
// (a shortened copy too: "Maintenance préventive et corrective des équipements informatiques" for "maintenance préventive et corrective
// de l'ensemble des équipements informatiques" has 7 of the quote's 9 words, all of them the quote's; a translation shares names only,
// and a text of names alone, "React, Node.js, PostgreSQL, Docker", is in no language)
const copiesQuote = (s, quote) => {
  const T = toks(s); if (T.length < 4) return false;
  if (overlap(quote, s) >= 0.8 || (` ${fold(quote)} `.includes(` ${fold(s)} `) && T.length >= 0.5 * toks(quote).length)) return true;
  const nm = new Set(namedTerms(s).flatMap(toks)), W = T.filter(w => !nm.has(w)), Q = new Set(toks(quote));
  return W.length >= 4 && W.length >= 0.5 * toks(quote).length && W.filter(w => Q.has(w)).length >= 0.9 * W.length;
};
// services: numbers ("2", "1, 4"), "4. data platforms...", or a service's name or the start of it; unknown ones dropped
const svcOf = x => { const s = String(x).trim();
  if (/^[\d\s,;/&.-]+$/.test(s)) return (s.match(/\d+/g) || []).map(Number);
  const lead = /^(\d+)\s*[.):-]/.exec(s); if (lead) return [Number(lead[1])];
  const hit = SVC.map((sv, k) => [k + 1, containment(s, sv), nameSim(s, sv)]).filter(h => h[1] >= 0.8).sort((a, b) => b[2] - a[2])[0];
  return hit ? [hit[0]] : []; };
// a service the model only NAMED in its reason is kept when a word that only that service has is written in the tender: a reason
// listing the SERVICES ("web and mobile applications; CRM and enterprise software integration" for a ticketing + CRM notice) is a copy
// ("document": every notice has its "documents de la consultation"; a word naming a KIND of system, "mobile", "web", "chatbots", is
// stated by itself or its kind's forms, never by a word sharing its first letters: "mobiliser au moins 1 ingénieur IA" in the chatbot
// demo and "mobilier" are no mobile app)
const SVC_GENERIC = new Set(['solution', 'solutions', 'application', 'applications', 'platform', 'platforms', 'system', 'systems', 'software', 'custom', 'enterprise', 'service', 'services', 'document', 'documents']);
const SVC_WORDS = SVC.map((s, k) => toks(s).filter(w => !FORM.has(w) && !SVC_GENERIC.has(w) && !SVC.some((o, j) => j !== k && toks(o).includes(w))));
const svcInText = (n, text) => { const Q = ` ${fold(text)} `, QT = Q.trim().split(' '), latin = latinQuote(text);
  return (SVC_WORDS[n - 1] || []).some(w => { const k = Object.keys(KINDS).find(x => KINDS[x][0].some(f => hasForm(` ${w} `, f)));
    return k ? QT.some(q => q.replace(/s$/, '') === w.replace(/s$/, '')) || KINDS[k][1].some(f => hasForm(Q, f)) : wordIn(w, Q, QT, latin); }); };
// the timeline must be a duration the TEXT states. A bare number ("12" read in "Durée du marché (en mois) : 12") takes its unit from
// the text: the label before that number first, else "<n> <unit>" with a duration word shortly before it ("La durée du marché est de
// 24 mois"), never any "<n> <unit>" of the text ("3 ans d'expérience" is no duration); none = no timeline. Any other timeline is
// kept when it is written in the text (3+ words: "du 1er janvier 2027 au 31 décembre 2027"; a single date is a start, no duration),
// or one of its "<n> <unit>" is written in the text in any wording ("disposera de 18 mois", "pour 48 mois", "run for three years"),
// in any unit and in words ("4 years" = "48 mois", "douze mois"), but not as experience ("3 ans d'expérience"), or is the span between
// the start and end dates the text gives ("Date de début: 03/02/2027 ... Date de fin de durée: 01/02/2031" = 4 years); a period "de
// <date> à <date>" when the text gives both dates as such. Else null, flagged timeline_not_in_text ("12 mois", the prompt's example,
// on a notice with no duration; "janvier 2027", a start date)
const UNIT = 'mois|ans?|ann[ée]es?|jours?|semaines?|months?|years?|days?|weeks?|أشهر|شهرا|شهر|سنوات|سنة|أيام|يوما|أسابيع';
const DURATION = /(?<!\p{L})(dur[ée]e|dur(?:e|er|era|eront)|duration|p[ée]riode?|d[ée]lai|ex[ée]cution|execution|conclue?s?|reconductible|renewable|term|validit[ée]|validity|pendant|durant|during)(?!\p{L})|مدة|مدّة|فترة|آجال/iu;   // Arabic glues "لمدة"; not "أجل" (من أجل = in order to)
const EXPERIENCE = /exp[ée]riences?(?!\p{L})|خبر/iu, EXP_AFTER = /^['’]?\s*(?:(?:d['’]|de|of|minimum|au moins|at least)\s*)*(?:l['’]\s*)?exp[ée]rience|^\s*(?:من\s+)?(?:ال)?خبر/iu;
const EXP_BEFORE = /(?:exp[ée]riences?|خبر\p{L}*)\s*:?(?:\s+[^\s.;!?]+){0,4}\s*$/iu;   // "une expérience de 5 ans", "خبرة لا تقل عن 5 سنوات"
const ONE_DATE = /^(?:(?:le|du|au|on|the|from|starting|d[èe]s le|[àa] (?:compter|partir) du)\s+)?(?:\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|(?:\d{1,2}(?:er|st|nd|rd|th)?\s+)?(?:janvier|f[ée]vrier|mars|avril|mai|juin|juillet|ao[uû]t|septembre|octobre|novembre|d[ée]cembre|january|february|march|april|may|june|july|august|september|october|november|december)(?:\s+\d{1,2}(?:st|nd|rd|th)?,?)?\s+\d{4})\s*\.?$/iu;
const MONTHS = u => { const f = fold(u); return /^(mois|months?|اشهر|شهرا|شهر)$/.test(f) ? 1 : /^(ans?|annees?|years?|سنوات|سنه)$/.test(f) ? 12 : /^(semaines?|weeks?|اسابيع)$/.test(f) ? 7 / 30 : /^(jours?|days?|ايام|يوما)$/.test(f) ? 1 / 30 : 0; };
// numbers written in words become digits ("douze mois", "vingt-quatre mois", "trois ans") for the search only
const NUM_RUN = new RegExp(`(?<!\\p{L})(?:${Object.keys(WORDS).sort((a, b) => b.length - a.length).join('|')})(?:(?:[\\s-]+(?:et|and)[\\s-]+|[\\s-]+)(?:${Object.keys(WORDS).sort((a, b) => b.length - a.length).join('|')}))*(?!\\p{L})`, 'giu');
const numText = s => String(s || '').replace(NUM_RUN, w => { const n = wordNums(w, false); return n.length === 1 ? n[0] : w; });
const DATE = /(?<!\d)(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?!\d)/g;
const START = /(?<!\p{L})(d[ée]but|start|commencement|à compter du|from)(?!\p{L})/iu, END = /(?<!\p{L})(fin|end|until|jusqu|expir\p{L}*)(?!\p{L})/iu;
const datesOf = s => [...String(s).matchAll(DATE)].map(d => ({ at: d.index, key: `${Number(d[1])}/${Number(d[2])}/${d[3]}`, m: Number(d[3]) * 12 + Number(d[2]) + Number(d[1]) / 30 }));
const pairsOf = s => [...numText(s).matchAll(new RegExp(`(?<![\\d.,])(\\d+(?:[.,]\\d+)?)\\s*(${UNIT})(?!\\p{L})`, 'giu'))].map(y => ({ at: y.index, end: y.index + y[0].length, months: Number(y[1].replace(',', '.')) * MONTHS(y[2]) }));
const withUnit = (tl, text) => {
  const raw = String(tl ?? '').trim(); if (!raw || /^(null|none|n\/?a|-|unknown|inconnue?|non (pr[ée]cis[ée]e?|indiqu[ée]e?))$/i.test(raw)) return { value: null };
  const s = numText(text), before = (at, re, k = 60) => re.test(s.slice(Math.max(0, at - k), at));
  const m = /^\s*(\d+(?:[.,]\d+)?)\s*$/.exec(raw);
  if (m) {
    const n = m[1].replace(/[.,]/, '[.,]');
    const label = new RegExp(`(?<!\\p{L})(${UNIT})\\s*(?:\\)\\s*:?|:)\\s*${n}(?![\\d])`, 'iu').exec(s);   // "(en mois) : 12", "Durée en mois : 12"
    const x = label || [...s.matchAll(new RegExp(`(?<![\\d.,])${n}\\s*(${UNIT})(?!\\p{L})`, 'giu'))].find(y => before(y.index, DURATION));
    return { value: x ? `${m[1]} ${x[1].toLowerCase()}` : null };
  }
  const claimed = pairsOf(raw), D = datesOf(s);
  if (quoteInText(raw, text) && !ONE_DATE.test(raw) && !EXPERIENCE.test(raw)) return { value: raw };
  const stated = [...pairsOf(s).filter(y => before(y.at, DURATION) || !(EXP_AFTER.test(s.slice(y.end, y.end + 40)) || EXP_BEFORE.test(s.slice(Math.max(0, y.at - 60), y.at)))).map(y => y.months),
    ...[...s.matchAll(new RegExp(`(?<!\\p{L})(${UNIT})\\s*(?:\\)\\s*:?|:)\\s*(\\d+(?:[.,]\\d+)?)(?![\\d])`, 'giu'))].map(y => Number(y[2].replace(',', '.')) * MONTHS(y[1]))];
  const a = D.find(d => before(d.at, START, 40)), b = a && D.find(d => d.at > a.at && before(d.at, END, 40));
  const span = a && b ? b.m - a.m : null;
  if (claimed.some(c => stated.some(x => Math.abs(x - c.months) < 0.5) || (span != null && Math.abs(span - c.months) <= 1))) return { value: raw };
  const own = datesOf(numText(raw));   // "de 03/02/2027 à 01/02/2031": both dates in the text as a start / end / duration
  if (!claimed.length && own.length >= 2 && own.slice(0, 2).every(o => D.some(d => d.key === o.key && (before(d.at, START, 40) || before(d.at, END, 40) || before(d.at, DURATION, 40))))) return { value: raw };
  return { value: null, dropped: true };
};
// obligation / wish sentences no kept requirement quotes (a small model misses some: "L'accès doit être géré par rôles." gave no row,
// and the tender then looked fully covered): listed for a person, never sent (not in the RAG's language). Procedure sentences
// (forms, insurance, signature, amounts, deadlines) are not requirements on the bidder's skills; a count alone ("au moins un des mots"
// in a search-help box) or the buyer's own wish ("La Ville souhaite disposer d'une application") is not an obligation
const MUST = /(?<![\p{L}])(doit|doivent|devra|devront|obligatoire(ment)?|exig[ée]e?s?|imp[ée]rati(f|ve|vement)|requise?s?|indispensables?|must|shall|required|mandatory)(?![\p{L}])|يجب|إجباري|وجوبا/iu;
const WISH = /\b(souhait(é|ée|és|ées|ee|ees)|appr[ée]ci(é|ée|és|ées|ee|ees)|pr[ée]f[ée]rable(ment)?|preferably|preferred|desirable|should)(?![\p{L}])|يفضل|يستحسن/iu;
// (whole words: "signée" is not "désignée" / "consignes", "signed" not "designed"; a quality assurance plan is no insurance)
const PROCEDURE = /(attestation|candidature|\bDC[1-4]\b|\bDUME\b|kbis|(?<!quality )assurance(?! qualit)|sur l.honneur|(?<!\p{L})sign[ée]e?s?(?!\p{L})|\bplis?\b|catalogue [ée]lectronique|variantes?|\bvisite\b|groupement|sous-trait|soumissionner|(?<!\p{L})soumission(?!\p{L})|facturation [ée]lectronique|montant (minimum|maximum)|sans minimum|bons? de commande|date limite|r[ée]ception des (offres|plis)|acte d.engagement|r[èe]glement de (la )?consultation|\b(RC|CCAP|DCE)\b|insurance|(?<!\p{L})signed(?!\p{L})|submission|e-?invoicing|deadline|كراس الشروط|آخر أجل|الضمان)/iu;
// a form field of the notice ("... doivent être mentionnés: Non requises", "Soumission par voie électronique: Requise", "... programmes
// d'emplois protégés: Non"): its "doivent" / "requise" is a label and a yes / no answer, not an obligation on the bidder's skills
const FIELD = /:\s*(non|oui|no|yes|requise?s?|non requise?s?|exig[ée]e?s?|autoris[ée]e?s?|non autoris[ée]e?s?|required|not required|allowed|not allowed|n\/?a)\s*\.?$/i;
// a short sentence whose object is a date ("la plateforme devra être pleinement opérationnelle au 25/01/2027") is a deadline too,
// unless it names something (a standard, a technology: "certifié ISO 27001 au 01/01/2027")
const DATED = /(?<!\d)\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}(?!\d)|(?<!\d)\d{1,2}(?:er|st|nd|rd|th)? (?:janvier|f[ée]vrier|mars|avril|mai|juin|juillet|ao[uû]t|septembre|octobre|novembre|d[ée]cembre|january|february|march|april|may|june|july|august|september|october|november|december) \d{4}|au plus tard le|no later than/iu;
const procedural = x => PROCEDURE.test(x) || FIELD.test(x) || (DATED.test(x) && toks(x).filter(w => !/\d/.test(w)).length <= 15 && !namedTerms(x).length);
const sentencesOf = s => String(s || '').split(/\n+|(?<=[.!?؟;])\s+/).map(x => x.replace(/^[\s\-*•#>]+/, '').trim()).filter(x => { const n = toks(x).length; return n >= 4 && n <= 80; });
const out = [];
const items = $input.all();
for (let i = 0; i < items.length; i++) {
  const base = $('Build Analysis Prompt').itemMatching(i).json;
  const t = { ...base }; delete t._run; delete t._sys; delete t._usr; delete t._title_only; delete t._text;
  if (!base._run) { out.push({ json: t }); continue; }
  const p = parseAnswer(items[i].json, schema, null);
  const text = base._text;                                       // exactly the text the LLM read (source text only)
  const v = p.value || { tender_type: 'other', fit: 'unknown', reason: '', quote: '', requirements: [] };
  // the company services the tender needs (Config company.services); none given: a small model may have put their names in its
  // reason ("web and mobile applications; CRM and enterprise software integration") or cited "service 1" there
  // "reason": "[1, 2]" is the services list written in the wrong field (a small model mixed the two up): moved back, no reason, and
  // flagged (reason_was_service_list: a relapse is seen). Numbers found ONLY there are not trusted as an answer: the second run listed
  // all 5 for 4 tenders and only "web and mobile applications" for an AI chatbot; each must be stated by the tender (svcInText, as for
  // the names a reason gives) and the doubt is shown (services_from_reason; none left = no_service_matched below)
  const checks = [], inText = n => svcInText(n, `${t.title}\n${text}`);
  let fromReason = false;
  if (p.ok && /\d/.test(String(v.reason || '')) && /^[\s[\]\d,;]+$/.test(String(v.reason))) {
    if (!(v.services || []).length) { v.services = String(v.reason).match(/\d+/g); fromReason = true; checks.push('services_from_reason'); }
    v.reason = ''; checks.push('reason_was_service_list');
  }
  let svc = [...new Set((v.services || []).flatMap(svcOf).filter(n => n >= 1 && n <= SVC.length))];
  // EVERY service at once is no answer either (a tender needs one or two): each is kept when the tender states it, as above, so a
  // "plateforme web" notice listing all 5 keeps service 1 (services_all_listed)
  const all = SVC.length >= 3 && svc.length === SVC.length; if (all) checks.push('services_all_listed');
  if (fromReason || all) svc = svc.filter(inText);
  else if (!svc.length && p.ok) svc = [...String(v.reason || '').split(/\s*[;\n]\s*/).filter(x => toks(x).length && toks(x).length <= 8).flatMap(svcOf),
    ...[...String(v.reason || '').matchAll(/\bservices?\s*(?:n[°o]\s*)?(\d+)\b/gi)].map(m => Number(m[1]))].filter(inText);
  const tl = withUnit(v.timeline, text); if (tl.dropped) checks.push('timeline_not_in_text');
  const a = { status: p.ok ? 'ok' : 'failed', tender_type: v.tender_type || 'other', fit_llm: p.ok ? v.fit : null, fit: v.fit, reason: v.reason, quote: v.quote,
              sector: v.sector || null, timeline: tl.value, quote_verified: false, checks,
              matched_services: [...new Set(svc.filter(n => n >= 1 && n <= SVC.length))].map(n => SVC[n - 1]) };
  // no usable answer = fit "unknown" (not a made-up "low"): not researched, and its keys are not stored, so the next run retries it.
  // The call failing (model down, timeout) and the model answering junk are told apart in the export and the summary.
  // a type outside the list and the quote are checked apart: an unknown type ("cloud_migration") once skipped the quote check, so
  // an invented quote kept fit high and the tender went to the research, the RAG and the proposal on the model's word alone
  if (!p.ok) { a.checks.push(String(p.errors[0]).startsWith('llm call failed') ? 'llm_call_failed' : 'llm_invalid'); a.errors = p.errors.slice(0, 3); }
  else {
    if (!v.tender_type) a.checks.push('tender_type_invalid');
    if (v.quote && quoteInText(v.quote, text)) a.quote_verified = true;
    else { a.checks.push(v.quote ? 'quote_not_in_text' : 'quote_missing'); a.fit = DOWN[a.fit]; }
  }
  if (p.ok && TT[a.tender_type] && !TT[a.tender_type].bid && a.fit !== 'none') { a.checks.push('type_not_offered'); a.fit = 'none'; }
  // the sector must be written in THIS tender (title, buyer, text): "tourism" for an LLM-agents notice, or for a theatre's ticketing
  // system, sends the RAG looking for tourism projects. Not found = "public sector" (a public tender), flagged; "public sector" and a
  // Config sector this code has no words for are taken as they are. "Hôtel de ville / de région" are town halls, not hotels
  if (a.sector && a.sector !== 'public sector' && KINDS[a.sector]) {
    const T = ` ${fold([t.title, t.buyer && t.buyer.name, text].join(' ')).replace(/ hotel (de|du|des|d) (ville|region|departement|police|agglomeration|metropole)\b/g, ' ')} `;
    const cpvOk = (t.cpv || []).some(c => (SECTOR_CPV[a.sector] || []).some(d => String(c).startsWith(d)));   // RESAH's lab analysers: CPV 33
    if (!kindIn(a.sector, T) && !cpvOk) { a.checks.push('sector_not_in_text'); a.sector = (cfg.rag.sectors || []).includes('public sector') ? 'public sector' : null; }
  }
  // fit high / medium means the main deliverable is one of the SERVICES: none named is flagged (the model's own answer disagrees)
  if (p.ok && RANK[a.fit] >= 2 && !a.matched_services.length) a.checks.push('no_service_matched');
  t.analysis = a;
  t.survivor = RANK[a.fit] >= 2;
  t.too_late = t.days_left != null && t.days_left < cfg.limits.tooLateDays;
  if (t.too_late) t.flags = [...(t.flags || []), 'too_late'];
  const req = { items: [], dropped: [], low_input: !!base._title_only };
  if (t.survivor) for (const w of p.warnings || []) if (w.startsWith('$.requirements')) req.dropped.push({ text: '', why: `schema: ${w}` });
  const foreign = !!t.language && String(t.language).toLowerCase().slice(0, 2) !== RAG_CODE;   // the tender is not in the RAG's language
  for (const r of v.requirements || []) {
    if (!t.survivor) break;                                    // requirements of a non-fit tender are never used
    if (base._title_only) { req.dropped.push({ text: r.text, why: 'title-only text' }); continue; }
    if (!quoteInText(r.quote, text)) { req.dropped.push({ text: r.text, why: 'quote_not_in_text' }); continue; }
    const inQuote = quoteNums(r.quote), extra = textNums(r.text).filter(n => !inQuote.has(n));   // "Three references" needs a 3 in the quote
    if (extra.length) { req.dropped.push({ text: r.text, why: `numbers not in quote: ${extra.join(',')}` }); continue; }
    // a skill line listing several ("React frontend, PostgreSQL, REST API", "1 project manager and 3 developers") becomes one
    // requirement per part, all with the same quote and its own short English text; each part is checked like a whole line
    const skill = String(r.skill || '').replace(/\s+/g, ' ').trim().replace(/[.;:]+$/, '');
    const parts = skill ? splitSkill(skill) : [];
    const mandatory = OBLIGATION.test(r.quote) && !SCORED.test(r.quote);
    // each part kept as it is, kept without the kind / sector its quote does not state (skill_cut), or refused; several parts: the
    // parts that pass are kept ("CRM integration" stays when "React frontend" or "web and mobile applications" was invented), and a
    // refused part that counts is replaced by the text's own words for that count (skill_dropped = the refused part)
    let fixed = parts.map(s => fixLine(s, r.quote, inQuote, t.title, r.text));
    if (parts.length > 1 && fixed.some(f => f.line)) fixed = fixed.map((f, k) => { if (f.line) return f;
      const alt = countPart(parts[k], r.text), g = alt && alt !== parts[k] ? fixLine(alt, r.quote, inQuote, t.title, r.text) : null; return g && g.line ? { ...g, from: parts[k] } : f; });
    const good = fixed.filter(f => f.line), cutOf = f => ({ ...(f.cut ? { skill_cut: f.cut } : {}), ...(f.from ? { skill_dropped: f.from } : {}) });
    if (parts.length > 1 && good.length && good.length < parts.length) req.dropped.push({ text: parts.filter((x, k) => !fixed[k].line).join(', '), why: `skill part not in quote (${fixed.filter(f => f.why).map(f => f.why).join('; ')})` });
    const copy = foreign && copiesQuote(r.text, r.quote);
    let rows;
    if (parts.length > 1 && good.length) rows = good.map(f => ({ text: f.line, rag_text: f.line, ...cutOf(f) }));
    else if (good.length) rows = [{ text: copy ? good[0].line : r.text, rag_text: good[0].line, ...cutOf(good[0]) }];   // never the untranslated quote as the requirement
    else {
      const skillWhy = skill ? `skill "${skill}": ${fixed.map(f => f.why).join('; ')}` : 'no skill line';
      const why = copy ? `text is the untranslated quote (${skillWhy})` : sentenceWhy(r.text, r.quote, t.title);
      if (why) { req.dropped.push({ text: r.text, why: copy || !skill ? why : `${why} (${skillWhy})` }); continue; }
      rows = [{ text: r.text, rag_text: r.text, ...(skill ? { skill_dropped: skill } : {}) }];
    }
    for (const x of rows) {
      // one tender sentence may give several requirements with the same quote (and a small model may copy that quote as their
      // text): duplicates are judged on what is sent to the RAG
      if (req.items.some(y => y.category === r.category && fold(y.rag_text) === fold(x.rag_text))) { req.dropped.push({ text: x.text, why: 'duplicate' }); continue; }
      req.items.push({ id: `R${req.items.length + 1}`, category: r.category, ...x, text: digitsInText(x.text), rag_text: digitsInText(x.rag_text), quote: r.quote, mandatory });
    }
  }
  // (once each: a page may repeat a whole section, "Texte légal" of every lot)
  if (t.survivor && p.ok && !base._title_only) req.uncovered = sentencesOf(text).filter(x => (MUST.test(x) || WISH.test(x)) && !procedural(x)
    && !req.items.some(r => overlap(x, r.quote) >= 0.6 || overlap(r.quote, x) >= 0.6)).filter((x, k, all) => all.findIndex(y => fold(y) === fold(x)) === k).slice(0, 10).map(x => x.slice(0, 300));
  t.requirements = req;
  out.push({ json: t });
}
return out;
