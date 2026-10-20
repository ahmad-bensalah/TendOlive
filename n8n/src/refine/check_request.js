// ============================================================================
// Refine Slide: Check request. A sales person prompt-edits ONE slide of a deck (Human-in-the-Loop AI refinement):
// body {deckId, slideIndex, instruction} from the CSTAM interface. slideIndex = the slide's place in the studio's editor,
// 0-based, the same index the studio's own Regenerate button sends (0 = title slide; the last slide is the closing one:
// both are fixed). A bad request is answered 400 here, before any agent or studio call.
// ============================================================================
// where the two services are, as seen from inside n8n
const REGENERATE_URL = 'http://127.0.0.1:5678/webhook/rfp/regenerate';   // the deck agents' "RFP 60 Regenerate one slide", same n8n (not localhost: IPv6 first)
const STUDIO_URL = 'http://host.docker.internal:8091';                   // the proposal studio (Main's Config STUDIO_URL)
const MIN_CHARS = 3, MAX_CHARS = 200;                                     // the agents keep at most 200 characters of an instruction

const raw = $input.first().json.body;
let req = raw;
if (typeof raw === 'string') { try { req = JSON.parse(raw); } catch (e) { req = null; } }   // sent as text/plain
if (!req || typeof req !== 'object' || Array.isArray(req)) req = {};
const bad = message => [{ json: { _ok: false, statusCode: 400, body: { status: 'error', message } } }];

const deckId = typeof req.deckId === 'string' ? req.deckId.trim() : '';
if (!/^[A-Za-z0-9_-]{1,64}$/.test(deckId)) return bad('deckId is missing or invalid (letters, digits, _ and -, at most 64).');
const n = typeof req.slideIndex === 'string' && /^\s*\d+\s*$/.test(req.slideIndex) ? Number(req.slideIndex) : req.slideIndex;
if (n === 0) return bad('The title slide cannot be refined.');
if (!Number.isInteger(n) || n < 1 || n > 999) return bad('slideIndex must be a whole number from 1 (0 is the title slide).');
const instruction = typeof req.instruction === 'string' ? req.instruction.replace(/\s+/g, ' ').trim() : '';
if (instruction.length < MIN_CHARS) return bad(`Write an instruction of at least ${MIN_CHARS} characters.`);
if (instruction.length > MAX_CHARS) return bad(`The instruction is too long (${instruction.length} characters, at most ${MAX_CHARS}).`);

return [{ json: { _ok: true, deckId, slideIndex: n, instruction, regenerateUrl: REGENERATE_URL, studioUrl: STUDIO_URL,
  saveUrl: `${STUDIO_URL}/api/decks/${deckId}/slides/${n}`, deckUrl: `${STUDIO_URL}/api/save/${deckId}` } }];
