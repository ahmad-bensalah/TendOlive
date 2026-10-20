// 02 - Collect Known IDs. Rows come from the optional Google Sheet (columns canonical_id / pair_key written by "Rank & Export").
// Sheet node disabled -> this receives the Config item and the key list stays empty.
// The output is also wired into "Merge Sources" as a run marker, so the pipeline always reaches Run Summary.
const keys = new Set(), pair_deadlines = {};
let sheet_error = null;
for (const it of $input.all()) {
  const j = it.json || {};
  // "01" has On Error: continue: a failed read (403, sheet renamed, quota) gives ONE item with `error` and no row. That is not a
  // first run: every tender exported before would be processed and handed off again, so it is reported (Run Summary warns)
  if (j.error && !j.canonical_id && !j.pair_key && !j.tender_id) { sheet_error = String(j.error.message || j.error.description || j.error).slice(0, 200); continue; }
  for (const k of ['canonical_id', 'pair_key']) { const v = j[k]; if (v) keys.add(String(v)); }
  // the exported deadline per title + buyer key: the same notice reached again under another URL with the SAME deadline is a
  // copy of an exported tender, a different deadline a relaunch (ISO dates only: a date the sheet reformatted is not guessed)
  const d = String(j.deadline || '').match(/^\d{4}-\d{2}-\d{2}/);
  if (j.pair_key && d && !(pair_deadlines[j.pair_key] ||= []).includes(d[0])) pair_deadlines[j.pair_key].push(d[0]);
}
const note = sheet_error ? `sheet read FAILED (${sheet_error}): no known keys, so tenders exported by previous runs are processed and handed off again`
  : keys.size ? `${keys.size} known keys from the sheet` : 'no known keys (first run or sheet disabled)';
return [{ json: { _type: 'run_marker', keys: [...keys], pair_deadlines, note, ...(sheet_error ? { sheet_error } : {}) } }];
