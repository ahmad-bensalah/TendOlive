// ============================================================================
// Refine Slide: Answer. The studio's answer to the slide write (POST /api/decks/<id>/slides/<n>: it validates the spec,
// lays it out with the deck's theme and saves it, exactly like its own Regenerate route) -> the interface's answer:
// 200 {status: 'ok', slideIndex, title, warnings[]} or {status: 'error', message} with a 4xx / 5xx code.
// ============================================================================
const req = $('Check request').first().json;
const ok = $('Check slide').first().json;
const r = $input.first().json || {};
const fail = (statusCode, message) => [{ json: { statusCode, _prices: false, body: { status: 'error', message } } }];

if (r.error) return fail(502, 'The proposal studio cannot be reached: the slide was not saved.');
let body = r.body;
if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { /* not JSON: handled below */ } }
const code = Number(r.statusCode) || 0;
const said = body && typeof body === 'object' ? String(body.message || body.error || '') : '';
if (code === 401) return fail(502, 'The proposal studio refused the "Proposal Studio key" credential: the slide was not saved.');
if (code === 404) return fail(404, 'This deck is no longer in the proposal studio.');
if (code === 400 && /out of range/i.test(said)) return fail(400, `This deck has no slide ${req.slideIndex + 1} any more: open the deck again.`);
if (code === 400) {
  const why = body && Array.isArray(body.errors) && body.errors.length ? `: ${String(body.errors[0]).slice(0, 160)}` : '';
  return fail(502, `The proposal studio refused the new slide${why}. The slide was not changed.`);
}
if (code !== 200 || !body || body.status !== 'ok') return fail(502, `The proposal studio could not save the slide (HTTP ${code || '?'}${said ? `: ${said.slice(0, 120)}` : ''}).`);

// a slide that holds prices needs a new approval before export, as after the editor's own Regenerate (next nodes)
return [{ json: { statusCode: 200, _prices: !!(body.slide && body.slide.requiresApproval),
  body: { status: 'ok', slideIndex: req.slideIndex, title: ok.spec.title, warnings: ok.warnings } } }];
