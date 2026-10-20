# OliveSoft RFP Intelligence: product UX and design system

Version 1 · 18 October 2026 · Frontend first, backend afterwards.

## 1. Users and what they need

| User | Main question | Needs on screen |
|---|---|---|
| Sales / bid manager (primary) | "Which tenders should we answer, and can we win them?" | New relevant tenders, deadlines, fit, gaps, proposal status |
| Delivery / pre-sales lead | "Who goes on the team, and what proof do we have?" | Requirements, evidence, proposed team, missing skills |
| Knowledge owner | "Is our company knowledge complete and correct?" | People, projects, stacks, tools, clients; what to add |
| Jury / management | "Does it work, and how well?" | Pipeline numbers, quality benchmark |

The book's Phase 3 asks the dashboard to let sales managers *view detected leads, inspect matched internal assets,
review prospect research, edit generated parameters, and download proposal decks*. Every item has a home below.

## 2. Journeys

1. **Morning triage:** Dashboard → new relevant tenders and close deadlines → open a tender.
2. **Bid / no-bid decision:** Tender → Overview (fit, blocking gaps, team) → decide.
3. **Prepare the answer:** Tender → Requirements (evidence) → Team → Prospect → Market → Proposal → deck page (edit, Refine with AI) → download PPTX/PDF.
4. **Close a gap:** Tender → Gaps → "Add record" → Knowledge base form → re-run matching.
5. **Maintain knowledge:** Knowledge base → search, filter, edit people, projects, stacks, tools, clients.
6. **Prove quality:** Quality → CV checks, retrieval metrics, tender lines (real and synthetic demo) and tests.

## 3. Navigation (information architecture)

```text
Sidebar                      Tender workspace tabs
- Dashboard                  - Overview      fit score, category bars, blocking gaps, team summary
- Tenders                    - Requirements  matrix, filter chips, evidence side panel
- Knowledge base             - Team          proposed team, unfilled roles
- Proposals                  - Gaps          what is missing, what to add
- Templates                  - Prospect      n8n's buyer research, with its sources
- Quality                    - Market        n8n's market study: budget, competitors, comparable contracts
- Settings                   - Proposal      bid gate, deck generation, win themes, references, risks, downloads
```

Global: data-mode switch (Company / Demo) in the header; search; notifications for new tenders and deadlines.

## 4. Design system

**Principles:** one primary action per screen · numbers before text · status by colour + label, never colour alone ·
details on demand (tabs, side panels, tooltips) · every AI output shows its source.

| Token | Value | Use |
|---|---|---|
| Primary | Blue `#2557F2` (hover `#1D47CC`, soft `#EAF0FF`) | Actions, selection, links, charts |
| Brand accent | Olive `#6B8E23` (soft `#EEF4E2`, deep `#3F5A14`) | Logo, brand moments, "covered" success |
| Ink / muted | `#0F172A` / `#64748B` | Text |
| Canvas / surface / line | `#F3F6FB` / `#FFFFFF` / `#E4E9F2` | Backgrounds, cards, borders |
| Warning / danger / info | `#D97706` / `#DC2626` / `#2557F2` | Partial, missing, information |
| Type | Inter; 28/20/16/14/12 px; weights 400/500/600/700 | Headings to captions |
| Radius | Cards 16 px · controls 10 px · chips full | |
| Spacing | 4-px grid; card padding 20–24 px; section gap 24 px | |
| Elevation | Cards: 1 px line + soft shadow `0 1px 2px rgb(15 23 42 / 4%)` | |
| Icons | Lucide, 18–20 px, inside 36-px soft tiles on card headers | |

**Components:** sidebar, header with mode switch, KPI card, chart card (donut, bars, pipeline), data table
with filter chips, status badge, tabs, side panel, tooltip, empty state, CTA card, person card, form fields.

## 5. Build plan

1. Frontend in `apps/web/` (React + Vite + Tailwind + TypeScript), realistic mock data taken from real RAG output.
2. Review the screens together; adjust.
3. Connect to the FastAPI backend (`/retrieve/tender`, `/api/documents`, `/api/records`, `/api/benchmark`);
   serve the built files from port 8001. No sample data is left: tenders come from n8n (or the New analysis form) through
   the RAG service, the buyer research and the market study from n8n through the proposal studio, the decks from the
   studio.
4. Proposal decks come from the proposal studio (rfp-studio, `VITE_STUDIO_URL`, default `http://localhost:8091`),
   called directly from the browser (`apps/web/src/lib/studio.ts`), never through the `/api` proxy of the RAG service.
   n8n sends the fit, open tenders (top 10) to its inbox. The Proposal tab shows the bid gate from the studio's copy,
   starts the deck (language, project type, template, name), follows the agents and opens the studio's own editor
   inside this app (the deck page `#/decks/<deckId>`: a frame, with a Full screen button; the editor needs about
   1100 px, so a narrower frame scrolls sideways), whose export checks the `[TO FILL]` placeholders and the pricing
   approval. Tenders and Proposals show a "Generating" or "Deck ready" chip and open that page; without the studio
   they work as before. Deleting a tender here does not delete the studio's copy. The Templates page (`#/templates`,
   also linked from Proposals, Settings and the Proposal tab) uses the studio's template API to add a `.pptx` / `.pdf`
   template, import the new files of the studio's `templates/inbox/`, choose the default (preselected in the Proposal
   tab, used by n8n's automatic deck) and delete one. Before a delete it says what breaks: the decks made with the
   template lose its pictures, a deck being generated with it fails at its last step, the studio keeps the folder in
   `templates/trash/`, a template whose file is in its `templates/inbox/` comes back at its next start or inbox import
   (which can also make it the default again), and without a default the decks started without a choice use the
   tender's colours.
5. The Prospect and Market tabs read `buyer_profile` and `competition` from the studio's copy of the tender
   (`GET /api/tenders/<id>`, no key). Prospect shows every researched field ("Not found" where the research found
   nothing), why a buyer was not researched (demo buyer, research budget, failure) and links to the sources (website,
   company registry, BOAMP, DECP). Market shows the declared value, the budget estimate or why n8n left it out of the
   studio's copy, the median offers, the agent's checked positioning, the competitors and the comparable contracts
   (TED ones link to their notice). The deck page has a **Refine with AI** panel: pick a content slide, write an
   instruction (3 to 200 characters), and our n8n workflow "RFP - Refine Slide" (`VITE_N8N_URL`, default
   `http://localhost:5679`, webhook `cstam/refine-slide`, called from `apps/web/src/lib/refine.ts`) has the deck
   agents write that slide again and saves it in the studio; the studio key stays in n8n. The editor frame is removed
   during the call (it saves the whole deck about every 10 s and would write over the new slide) and loaded again
   afterwards; it stays closed when the user leaves the page and comes back before n8n answers, and "Open in a new
   tab" is hidden meanwhile. The panel warns that edits of the last ~10 seconds can be lost and that the agents know
   slides by their place in the generated deck; a slide saved under another title is flagged for checking. Quality
   shows the CV checks, the retrieval metrics per system and the tender lines from `/api/benchmark` (real tenders and
   synthetic demo tenders counted apart), with their set sizes. Settings
   shows the n8n address and whether a server answers there (a no-cors probe: it cannot see whether the workflow is
   active).
