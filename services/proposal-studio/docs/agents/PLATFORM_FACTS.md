# Platform Facts Verification

Last run: 2026-10-18T18:07:41.908Z
Base URL: http://127.0.0.1:8099

## Results

| Test | Status | Details |
|------|--------|----------|
| 401 without key | ✓ PASS |  |
| 200 on samples/software.json | ✓ PASS | ID: 3b9be036 |
| 400 with errors[] on unknown block kind | ✓ PASS |  |
| 400 on unknown slide field | ✓ PASS |  |
| GET /api/decks/<id> keys | ✓ PASS | Has label and elements |
| 400 when table cell is a number | ✓ PASS |  |
| 5th card is dropped | ✓ PASS | Accepted (silent drop is platform behavior) |
| 25-row table produces (1/3)...(3/3) | ✓ PASS | Long Table (1/3), Long Table (2/3), Long Table (3/3) |
| 14-item bullet list splits | ✗ FAIL | No split occurred |

## Differences from Prompt

(To be filled after verification)

