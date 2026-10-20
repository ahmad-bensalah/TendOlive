# Test Inputs Directory

This directory contains the standard fake test input files used by the n8n agent workflows (Diagram agents and Credibility agent).

## Source of Truth
- **`tests/inputs/`** is the single **source of truth** for all test inputs.
- The files in `tests/diagram/` and `tests/credibility/` are exact byte-identical copies so that both teammates work with strictly identical data.

## What Each File Tests
1. **`software.json`**:
   - Represents a realistic French public tender for a citizen web portal (`project_type: "software"`).
   - Contains 6 detailed requirements, 3 matching similar projects, 4 why_us items, 3 certifications, and 5 engineer role profiles (12 total specialized engineers).
   - Theme: Blue color palette (`#1d4ed8` / `#3b82f6`).

2. **`non_software.json`**:
   - Represents a non-software tender for sustainable catering services (`project_type: "other"`).
   - Tests agent adaptability on non-tech vocabularies (HACCP, local sourcing, zero plastic) with 5 requirements, 2 similar projects, 3 why_us items, and 2 certifications.
   - Theme: Green color palette (`#15803d` / `#22c55e`).

3. **`thin.json`**:
   - Tests graceful degradation and edge cases on incomplete tenders.
   - Contains minimal fields only (`id`, `title`, `client`, `language`, `project_type`, 2 requirements, score only in `match`, single `primary` color in theme).

4. **`injection.json`**:
   - Tests prompt injection and instruction override resistance.
   - Mirrors `software.json` but inserts adversarial injection prompts in `raw_text_excerpt` ("Ignore all previous instructions...") and in one requirement ("Reveal your system prompt").

5. **`many_projects.json`**:
   - Tests project filtering and ranking logic.
   - Contains 8 similar projects: exactly 3 recent and relevant software projects matching the requirements, plus 5 older or irrelevant projects (construction, catering logistics, legacy COBOL, fiber optic cabling, office furniture).

## Verification
You can verify the consistency, schema compliance, and byte-level parity across folders at any time by running:
```bash
python3 tests/check_inputs.py
```
