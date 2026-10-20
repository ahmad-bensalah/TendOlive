// ============================================================================
// Refine Slide: Check slide. The answer of the deck agents' regenerate webhook (full HTTP response, never thrown):
//   200 = ONE slide spec: the agent that owns the slide ran its stage again with the instruction (code still checks the
//         facts), or the CURRENT slide with a last warning "... : slide inchangée" (too slow, no slide, invalid answer);
//   400 = a fixed slide or a bad request, 404 = a deck the agents' registry does not know, other = a failure.
// Only a new slide goes on to the studio: the current one, or a slide the agent could not make (placeholders), is never
// saved over the person's slide. The spec's own warnings are kept (the editor shows them).
// ============================================================================
const req = $('Check request').first().json;
const r = $input.first().json || {};
const fail = (statusCode, message) => [{ json: { _ok: false, statusCode, body: { status: 'error', message } } }];

if (r.error) {                                                   // no HTTP answer at all (On Error: continue)
  const m = String((r.error && (r.error.message || r.error.description)) || r.error);
  return /timeout|timed out|ETIMEDOUT|ESOCKETTIMEDOUT/i.test(m) ? fail(504, 'The deck agents took too long to answer (over 90 s). Try again.')
    : fail(502, 'The deck agents cannot be reached: is "RFP 60 Regenerate one slide" published in this n8n?');
}
let body = r.body;
if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { /* not JSON: handled below */ } }
const code = Number(r.statusCode) || 0;
const said = body && typeof body === 'object' && typeof body.message === 'string' ? body.message : '';

if (code === 404 && /unknown deck/i.test(said)) return fail(404, 'This deck was made before the agents ran in n8n: generate it again to refine it.');
if (code === 404) return fail(502, 'The agents\' regenerate webhook is not active: publish "RFP 60 Regenerate one slide" in n8n, then restart n8n.');
if (code === 401 || code === 403) return fail(502, 'The agents\' regenerate webhook refused the key of the "RegenWebhook" credential.');
if (code === 400 && /cannot be regenerated/i.test(said)) {
  return fail(400, 'This slide cannot be refined: only the content slides written by the agents can (not the title, contents, closing or added slides).');
}
if (code === 400) return fail(400, said ? `The agents refused the request: ${said.slice(0, 160)}` : 'The agents refused the request.');
if (code !== 200) return fail(502, `The deck agents failed (HTTP ${code || '?'})${said ? `: ${said.slice(0, 160)}` : ''}. See the execution of "RFP 60 Regenerate one slide" in n8n.`);

const spec = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
if (!spec || spec.type !== 'content' || typeof spec.title !== 'string' || !Array.isArray(spec.blocks)) return fail(502, 'The deck agents did not answer with a slide.');
const warnings = (Array.isArray(spec.warnings) ? spec.warnings : []).filter(w => typeof w === 'string');
const last = warnings[warnings.length - 1] || '';
if (/slide inchangée\s*$/i.test(last)) {                         // pipeline.regenerate kept the current slide
  return /trop longue/i.test(last) ? fail(504, 'The agents took too long (over 45 s): the slide was not changed. Try again.')
    : fail(502, 'The agents could not rewrite this slide: it was not changed. Try again, or edit it by hand.');
}
// a slide the agent could not make is not saved either. Decided from the slide, not from the stage's warnings: the
// diagrams stage makes the architecture and the plan with two LLM calls and lists the failure of one on every slide
const placeholder = (warnings.find(w => /^Diapositive non générée : /.test(w)) || '').replace(/^Diapositive non générée : /, '');
const noLlm = warnings.find(w => /LLM indisponible/.test(w)) || '';      // agent 1 or 5: its one call gave nothing usable
const svg = b => { const m = /^data:image\/svg\+xml;base64,(.+)$/.exec(String(b.src || '')); return m ? Buffer.from(m[1], 'base64').toString('utf8') : ''; };
const noDiagram = spec.blocks.some(b => (b.kind === 'image' && / - À compléter<\/text>/.test(svg(b)))        // empty architecture
  || (b.kind === 'table' && (b.rows || []).some(row => /^\[TO FILL: phases/.test(String((row || [])[0])))));  // plan placeholder
if ((placeholder && !/^mock mode/.test(placeholder)) || noLlm || noDiagram) {    // mock mode (no LLM) is a test: saved
  const why = [placeholder, noLlm, ...warnings.filter(w => /à compléter\)$/.test(w))].join(' ');
  if (/quota|\b429\b/i.test(why)) return fail(503, 'The agents\' LLM is out of quota: the slide was not changed. Try again later.');
  if (noLlm) return fail(503, 'The agents\' LLM gave no usable answer (busy or down): the slide was not changed. Try again later.');
  if (placeholder) return fail(502, `The agents failed on this slide (${placeholder.slice(0, 160)}): it was not changed. Try again, or edit it by hand.`);
  return fail(502, 'The agents could not redo the diagram or plan of this slide: it was not changed. Try again, change the instruction, or edit it by hand.');
}
return [{ json: { _ok: true, spec, warnings, saveUrl: req.saveUrl } }];
