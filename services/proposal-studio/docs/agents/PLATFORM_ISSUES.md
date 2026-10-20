# Platform Issues (Pre-existing)

This document tracks issues found in the platform that existed before agent development began.

## Known Issues

### 1. Archive File in Project Root

**Issue:** Test `test_docs_paths.TestDocsPaths.test_no_archives_in_project_root` fails

**Details:**
- File: `rfp-slide-deck-studio-claude-source.tar.gz` (179 KB)
- Test expects: Archives should be in `../dist/` not project root
- Status: Pre-existing (part of original v1.0.0 handoff)
- Impact: None on functionality, cosmetic test failure

**Evidence:**
```
FAIL: test_no_archives_in_project_root
AssertionError: Lists differ: ['rfp-slide-deck-studio-claude-source.tar.gz'] != []
```

**Resolution Options:**
1. Move file to `../dist/` (breaks guard check - file was in original manifest)
2. Update test to allow this specific archive
3. Accept as known cosmetic issue

**Current Status:** RESOLVED - File moved to `../dist/rfp-slide-deck-studio-claude-source-from-root.tar.gz` per user request.

**Resolution:** User directed move to dist directory. Test now passes. Manifest updated to reflect intentional cleanup.

---

## Testing Baseline

**Platform tests:** 97 total
- **Pass:** 96
- **Fail:** 1 (archive file location - documented above)
- **Skip:** 9

**Agent work impact:** No new failures introduced. Baseline preserved.

## PLATFORM ISSUE: a 13 to 16 item bullet list does not get a continuation slide (2026-10-18)

- **What:** `split_slide_blocks` cuts a bullets block with more than 12 items into chunks of 12,
  but when the chunks fit together (for example 12 + 2 items) they stay on the same slide as two
  stacked lists, with no "Title (1/2)" slide. Tables were fixed for the same case in v1.0.0;
  bullets were not.
- **Evidence:** `agents/tools/platform_facts.js` check "14-item bullet list splits" fails
  (see `PLATFORM_FACTS.md`).
- **Proposed fix:** in `layout_engine.py`, mark bullet chunks after the first as
  `_continuation: True`, like the table chunks, so they start a new slide.
- **Workaround in the agents:** in real mode the slide builders keep at most 6 bullets per list
  (`buildAgent1Slides`, `buildAgent5Slides`), so agent decks never reach 13 items. `merge.js`
  only warns above 12.
