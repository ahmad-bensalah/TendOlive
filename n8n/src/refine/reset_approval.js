// ============================================================================
// Refine Slide: Reset price approval. The refined slide holds prices (requiresApproval): like the editor after its own
// Regenerate, the deck's price approval (approvals.pricing) is dropped, so the prices must be approved again before export.
// The studio's slide route keeps it, so this node reads the deck (GET /api/save/<id>, no key) and writes it back without
// the approval (POST /api/save) when one is set. Never fatal: the slide is saved already, a failure adds a warning.
// ============================================================================
const req = $('Check request').first().json;
const a = $input.first().json;
const out = { statusCode: a.statusCode, body: { ...a.body, warnings: [...(a.body.warnings || [])] } };
try {
  const h = (typeof this !== 'undefined' && this && this.helpers) || helpers;   // n8n's HTTP client (the agents use it too)
  const deck = await h.httpRequest({ method: 'GET', url: req.deckUrl, json: true, timeout: 15000 });
  // write back only the deck that was read (its id, its slides), never a partial or empty one
  if (deck && deck.id === req.deckId && Array.isArray(deck.slides) && deck.slides.length && deck.approvals && deck.approvals.pricing) {
    delete deck.approvals.pricing;
    delete deck.approvals.at;
    await h.httpRequest({ method: 'POST', url: `${req.studioUrl}/api/save`, body: deck, json: true, timeout: 15000 });
    out.body.warnings.push('The prices changed: approve them again in the editor before export.');
  }
} catch (e) {
  out.body.warnings.push('The price approval could not be reset: check the prices and approve them again in the editor.');
}
return [{ json: out }];
