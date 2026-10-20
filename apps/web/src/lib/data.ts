export type Status = 'covered' | 'partial' | 'missing'
export type TenderStatus = 'new' | 'review' | 'proposal' | 'nobid' | 'filtered'

export interface Evidence { kind: string; quote: string | null; line: number | null; statement?: string }
export interface Match {
  doc_id: string; type: string; title: string; origin: string; summary: string
  similarity_score: number | null; matched_on?: string[]; evidence: Evidence | null
}
export interface MatrixRow {
  requirement: string; category: string; mandatory: boolean; status: Status
  found: number; needed: number; method: string; best_doc: string | null; origin: string | null; percent: number
}
export interface TeamMember {
  doc_id: string; name: string; title: string; seniority: string; years: number | null; roles: string[]
  certifications: string[]; assigned_to: string[]; also_qualifies_for: string[]
  company_projects: { doc_id: string; title: string; matches_tender: boolean }[]
}
export interface Team {
  size: number; method: string; members: TeamMember[]; places_filled: number; places_needed: number
  unfilled: { requirement: string; needed: number; available: number; mandatory: boolean }[]; notes: string[]
}
export interface Gap { requirement: string; category: string; status: string; mandatory: boolean; kind: string; gap: string; suggestion: string }
export interface Analysis {
  data_mode: string; matches: Match[]
  requirement_matches: { requirement: string; category: string; method: string; matches: Match[]; closest: Match | null }[]
  requirements_matrix: MatrixRow[]
  fit_score: Record<string, number | null>
  team_proposal: Team | null; knowledge_gaps: Gap[]; knowledge_counts: Record<string, number>; warnings: string[]
}
export interface Tender {
  id: string; title: string; client: string; sector: string; country: string; source: string; source_url: string
  published: string; deadline: string; budget: string; relevance: number; status: TenderStatus; summary: string
  data_mode?: 'company' | 'demo'
}

function live<T>(key: string): T | undefined {
  try {
    const value = localStorage.getItem(`cstam:${key}`)
    return value ? JSON.parse(value) as T : undefined
  } catch {
    return undefined
  }
}

/** The cached analysis of a tender; an entry that is not a RAG analysis (old or damaged) is ignored, not shown. */
export const analysisFor = (id: string): Analysis | undefined => {
  const analysis = live<Analysis>(`analysis:${id}`)
  return analysis && typeof analysis.fit_score === 'object' && analysis.fit_score && Array.isArray(analysis.requirements_matrix) ? analysis : undefined
}
export const tenderById = (id: string) => live<Tender>(`tender:${id}`)
export const allTenders = () => {
  const liveTenders: Tender[] = []
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i)
    if (!key?.startsWith('cstam:tender:')) continue
    const tender = live<Tender>(key.slice('cstam:'.length))
    if (tender) liveTenders.push(tender)
  }

  return liveTenders
}

/** `source` of the tenders analysed from the New analysis form. */
export const MANUAL_SOURCE = 'Manual analysis'

type StoredTenderItem = {
  tender_id: string; title?: string; client?: string; sector?: string; country?: string
  source?: string; source_url?: string; published?: string; deadline?: string
  estimated_budget?: string; data_mode?: 'company' | 'demo'; rag_analysis?: Analysis
}

export function storedTenderToTender(item: StoredTenderItem): Tender {
  const analysis = item.rag_analysis
  return {
    id: item.tender_id, title: item.title || item.tender_id, client: item.client || 'Unknown client',
    sector: item.sector || 'Unknown', country: item.country || '', source: item.source || 'n8n',
    source_url: item.source_url || '', published: item.published || '', deadline: item.deadline || '',
    budget: item.estimated_budget || 'Not specified', relevance: analysis?.fit_score.overall ?? 0,
    status: 'review', data_mode: item.data_mode,
    summary: item.source === MANUAL_SOURCE ? 'Manual analysis by the RAG service.' : 'Tender received from n8n and analysed by the RAG service.',
  }
}

// ---------------------------------------------------------------- browser cache of the tender inbox
// The RAG service stores the tenders (GET /api/tenders). The browser keeps a copy so a tender page opens
// at once; the service's list is the reference, and the copy follows it after every load.
/** Window event sent when the cached tenders change (the sidebar counts listen to it). */
export const TENDERS_CHANGED = 'cstam:tenders-changed'
const CACHE_PREFIXES = ['cstam:tender:', 'cstam:analysis:']

function cachedTenderKeys(): string[] {
  const keys: string[] = []
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i)
    if (key && CACHE_PREFIXES.some(prefix => key.startsWith(prefix))) keys.push(key)
  }
  return keys
}

function changed() {
  window.dispatchEvent(new Event(TENDERS_CHANGED))
}

function cacheTender(item: StoredTenderItem) {
  const tender = storedTenderToTender(item)
  localStorage.setItem(`cstam:tender:${tender.id}`, JSON.stringify(tender))
  if (item.rag_analysis) localStorage.setItem(`cstam:analysis:${tender.id}`, JSON.stringify(item.rag_analysis))
  else localStorage.removeItem(`cstam:analysis:${tender.id}`)
  return tender
}

/** Stores one tender (and its analysis) in the browser cache. */
export function rememberTender(item: StoredTenderItem) {
  const tender = cacheTender(item)
  changed()
  return tender
}

/** Makes the browser cache match the tenders stored by the RAG service: deleted tenders disappear. */
export function syncTenders(items: StoredTenderItem[]) {
  const ids = new Set(items.map(item => item.tender_id))
  for (const key of cachedTenderKeys()) {
    const id = key.slice(key.indexOf(':', 'cstam:'.length) + 1)  // "cstam:tender:<id>" -> "<id>"
    if (!ids.has(id)) localStorage.removeItem(key)
  }
  items.forEach(cacheTender)
  changed()
}

/** Removes one tender and its analysis from the browser cache. */
export function forgetTender(id: string) {
  CACHE_PREFIXES.forEach(prefix => localStorage.removeItem(prefix + id))
  changed()
}

/** Removes every cached tender and analysis. */
export function forgetAllTenders() {
  cachedTenderKeys().forEach(key => localStorage.removeItem(key))
  changed()
}

export interface Doc {
  doc_id: string; type: string; title: string; summary: string; origin: string; path: string
  projects?: { doc_id: string; title: string; delivery_status?: string }[]
  profile: { name?: string; roles?: string[]; seniority?: string; years?: number; skills?: string[]; certifications?: string[]; sectors?: string[] }
}
export interface RecordItem {
  id: string; type: string; title: string; description: string; status: string; origin: string
  client?: string; sector?: string; technologies?: string[]; delivery_status?: string; use_cases?: string
  relationship?: string; tool_kind?: string; outcomes?: string; source?: string; team_cv_ids?: string[]; year?: number
}
export const people: Doc[] = []
export const records: RecordItem[] = []
export const recordsOf = (type: string) => records.filter(r => r.type === type)
export const personById = (id: string) => people.find(p => p.doc_id === id)

export const quality: {
  meta: { finished_at: string; documents: number; real_cv_tests: number; embedding_model: string; reranker: string }
  real_cvs: Record<string, { passed: number; total: number; rows: { q: string; expect: string; got: string; pass: boolean; found: number }[] }>
  tests?: { summary: string; counts: Record<string, number> }
} = { meta: { finished_at: '', documents: 0, real_cv_tests: 0, embedding_model: '', reranker: '' }, real_cvs: {} }

// ---------------------------------------------------------------- helpers
export const TODAY = new Date()
/** Reads "2026-11-20" (local day) or a timestamp such as "2026-11-20T23:59:00+01:00"; null when missing or unreadable. */
export function parseDate(value: string | undefined): Date | null {
  if (!value) return null
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? value + 'T00:00:00' : value)
  return Number.isNaN(date.getTime()) ? null : date
}
const dayNumber = (d: Date) => Math.round(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 86400000)
/** Calendar days from today to the date (0 = today, negative = passed); null when the date is unknown. */
export const daysLeft = (iso: string): number | null => {
  const date = parseDate(iso)
  return date ? dayNumber(date) - dayNumber(TODAY) : null
}
export const fmtDate = (iso: string) => parseDate(iso)?.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) ?? 'Not specified'
/** "12 days left", "Today", "Closed" or "No deadline". */
export const deadlineLabel = (d: number | null) => d == null ? 'No deadline' : d < 0 ? 'Closed' : d === 0 ? 'Today' : `${d} day${d === 1 ? '' : 's'} left`
export const personName = (title: string) => title.split(' - ')[0]
export const personRole = (title: string) => title.split(' - ').slice(1).join(' - ')
export const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase()

export const STATUS_LABEL: Record<TenderStatus, string> = {
  new: 'New', review: 'In review', proposal: 'Proposal ready', nobid: 'No-bid', filtered: 'Filtered out',
}

export const ORIGIN_LABEL: Record<string, string> = {
  cv_document: 'CV evidence', user_entered: 'Company record', demo: 'Demo sample',
}

// Draft proposal content in Person 5's schema, derived from the RAG result.
// The real Proposal Strategy service (Person 5) will replace this.
export function draftProposal(t: Tender, a: Analysis) {
  const covered = a.requirements_matrix.filter(r => r.status === 'covered')
  const projects = a.matches.filter(m => m.type === 'past_project')
  const themes: string[] = []
  if (projects.length) themes.push(`Proven delivery: ${projects.slice(0, 2).map(p => p.title.replace(/\s*\(.*\)$/, '')).join(' · ')}`)
  const tech = a.fit_score.technical_fit
  if (tech != null) themes.push(`${tech}% coverage of the technical requirements with recorded OliveSoft capabilities`)
  const certs = [...new Set((a.team_proposal?.members ?? []).flatMap(m => m.certifications))].slice(0, 3)
  if (certs.length) themes.push(`Certified team: ${certs.join(', ')}`)
  return {
    win_themes: themes,
    recommended_team: (a.team_proposal?.members ?? []).map(m => `${m.name} – ${personRole(m.title) || m.title}`),
    references: projects.slice(0, 4).map(p => p.title),
    risks: a.knowledge_gaps.filter(g => g.mandatory).slice(0, 4).map(g => g.gap),
    covered: covered.length,
    rendered_files: { pptx_path: `output/OliveSoft_Proposal_${t.id}.pptx`, pdf_path: `output/OliveSoft_Proposal_${t.id}.pdf` },
  }
}
