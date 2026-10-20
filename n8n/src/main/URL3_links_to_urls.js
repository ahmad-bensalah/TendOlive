// URL3 - Links to URLs (URL lane). The Tender Scout Agent answers with link IDS; this node maps them back to the URLs that
// open_page really returned (the agent never writes a tender URL). Unknown ids are dropped, and a page the agent navigated
// FROM (home page, menu, page 1 of the list) is never a tender. If the start page is ONE notice, that page is the tender.
// With skipKnown (production preset) the known URLs are skipped before Firecrawl is paid: notices a previous run exported, and URL
// notices it found expired (deadline passed), awarded, cancelled or superseded (Rank & Export writes them as "dropped" rows);
// per-source cap from Config.
/*@lib canonicalId scoutRun*/
const cfg = $('00 - Config').first().json;
const known = new Set((() => { try { return $('02 - Collect Known IDs').first().json.keys || []; } catch { return []; } })());
const cap = cfg.limits.maxTendersPerUrlSource || 40;
const out = [];
const items = $input.all();
for (let i = 0; i < items.length; i++) {
  const task = $('URL1 - Scout Tasks').itemMatching(i).json;
  const run = scoutRun(items[i].json);
  const labels = [...new Set(run.pages.flatMap(p => p.repeated))];
  const fresh = cfg.limits.skipKnown ? run.picks.filter(l => !known.has(canonicalId(cfg, l.url))) : run.picks;
  for (const l of fresh.slice(0, cap)) out.push({ json: { source: task.source, ...l, onlyMainContent: task.onlyMainContent, repeated_labels: labels } });
}
return out;
