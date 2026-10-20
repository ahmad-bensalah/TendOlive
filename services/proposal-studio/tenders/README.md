# Appels d'offres sélectionnés / Selected tenders

**FR** — Un fichier JSON par appel d'offres dans `tenders/inbox/`. Ils apparaissent sur l'écran
d'accueil (« Appels d'offres sélectionnés », bouton **Recharger**), sans redémarrage. Le format est
celui de l'étape RAG (`olivesoft.proposal-input.v2`, exemple : `agents/fixtures/inputs/proposal_v2_example.json`)
ou le format simple des tests (`tests/inputs/*.json`). L'étape RAG pourra écrire directement avec
`POST /api/tenders` (en-tête `X-API-Key`), même format.

**EN** — One JSON file per tender in `tenders/inbox/`. They appear on the main screen without a
restart. Format: the RAG step's `olivesoft.proposal-input.v2` contract or the simple test format
(`tests/inputs/*.json`). The RAG step can also send them with `POST /api/tenders` (header `X-API-Key`).

Required: a tender id (`tender_id`, `tender.id` or `tender.reference`) and `tender.title`. 1 MB per
file. Invalid files are listed as errors on the screen, never a crash. Deleted tenders go to
`tenders/trash/`. Demo data: `python3 tools/seed_demo_tenders.py` copies three test inputs here.
