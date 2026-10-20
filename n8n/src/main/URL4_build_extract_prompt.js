// URL4 - Build Extract Prompt (URL lane). ONE schema-fill prompt per tender page, for any portal and any language
// (replaces per-site regex parsers). Values are copied "as written"; URL5 and Clean check and normalise them.
// Failed / empty pages are skipped (Run Summary reports them from the Firecrawl node).
/*@lib INVIS hostOfUrl pageError*/
const cfg = $('00 - Config').first().json;
const MAX = cfg.limits.extractMaxChars || 10000;
const toText = md => String(md || '')
  .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')                                                   // images
  .replace(/\[([^\]]*)\]\((mailto:|tel:)?([^)\s]*)[^)]*\)/g, (m, t, scheme, u) =>           // links -> visible text (+ mailto/tel targets)
    (scheme ? `${t} ${u}` : t).trim())
  .replace(INVIS, '').replace(/[\u00A0\u202F]/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
const system = 'You extract facts from ONE public procurement notice. Copy values exactly as written in the text. If a value is not in the text, use null. Answer with ONE JSON object only.';
const out = [];
const items = $input.all();
for (let i = 0; i < items.length; i++) {
  const link = $('URL3 - Links to URLs').itemMatching(i).json;
  const r = items[i].json || {};
  if (pageError(r)) continue;
  const text = toText(r.data.markdown);
  const user = `NOTICE TEXT (from ${hostOfUrl(link.url)}):
"""${text.slice(0, MAX)}"""

Fill this JSON. Rules:
- title: the notice's own title / object (not the site name, not a "read more" label, without notice-type labels such as "Avis rectificatif", "Rectificatif", "Corrigendum").
- buyer: the organisation that buys (contracting authority), as written.
- description: what is being bought, in the notice's words (2-6 sentences; ignore menus, share buttons, related posts).
- publication_date, deadline: copy the WHOLE date text exactly as written, with its day, month and year (any format or language). deadline = last day to submit offers.
- rectified_deadline: only if this notice changes or extends the deadline: the NEW deadline as written, else null.
- notice_type: "open" (call for bids still to answer), "award" (result / attribution / winner), "rectification" (modifies an earlier notice), "cancelled" (cancelled or unsuccessful), "other".
- contacts: only values written in the text. cpv: 8-digit CPV codes written in the text, else []. estimated_value: budget / value as written, else null.
- language: ISO code of the notice text (fr, en, ar, ...). country: ISO-2 code of the buyer's country if written or obvious from its address, else null.
{"title":null,"buyer":null,"description":null,"publication_date":null,"deadline":null,"rectified_deadline":null,"place":null,"cpv":[],"estimated_value":null,"contacts":{"email":null,"phone":null,"website":null,"address":null},"notice_type":null,"language":null,"country":null}`;
  out.push({ json: { ...link, page_title: (r.data.metadata && r.data.metadata.title) || '', text: text.slice(0, 20000), _sys: system, _usr: user } });
}
return out;
