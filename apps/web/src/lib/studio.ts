import { ApiError } from './api'

// The proposal studio (rfp-studio, the team's deck platform): its tender inbox (n8n posts the proposal inputs there), the deck
// agents and the slide editor. The browser calls it directly (it answers CORS *): the Vite /api proxy goes to the RAG service,
// which has its own /api/tenders. No API key here: the calls below need none, and a key in the bundle would be public.
export const STUDIO = (import.meta.env.VITE_STUDIO_URL || 'http://localhost:8091').replace(/\/+$/, '')

const STUDIO_ERROR = 'The proposal studio could not complete this request.'
const UNREACHABLE = `The proposal studio is not reachable at ${STUDIO}. Start it, then retry.`

/** The studio's id of a tender, as its tender_store.safe_id makes it: characters other than A-Z a-z 0-9 _ - become '-', cut
 * to 64, '-' stripped at both ends. A RAG id such as "BOAMP/26-101240" must be sent this way: the studio answers an unknown
 * path without its CORS header, which the browser reports as a network error. */
export const studioId = (id: string) => String(id ?? '').replace(/[^A-Za-z0-9_-]/gu, '-').slice(0, 64).replace(/^-+|-+$/g, '')

export type RunStatus = 'queued' | 'running' | 'done' | 'failed'
/** The last run of a tender, as the studio's tender list gives it. */
export interface Generation { runId: string; status: RunStatus; deckId: string | null; url: string | null; createdAt: string }
export interface StudioTender {
  id: string; title: string; client: string; deadline: string; language: string; project_type: string; matchScore: number | null
  counts: { requirements: number; similarProjects: number; certifications: number | null; engineers: number | null }
  hasResearch: boolean; estimatedValue: string; generation: Generation | null
}
export interface StudioInbox { tenders: StudioTender[]; generationEnabled: boolean; llmModels: string[] }

/** What the gate before Generate reads in the proposal input the studio stored (contract olivesoft.proposal-input.v2). */
export interface MatrixSummary {
  recommendation?: string; recommendation_reason?: string
  blocking?: string[]; mandatory_gaps?: string[]; obligations_not_in_matrix?: string[]; demo_evidence?: string[]
  knowledge_gaps?: { requirement_id?: string | null; requirement?: string | null; mandatory?: boolean | null; gap?: string | null }[]
}
/** The buyer research of n8n's Buyer Research agent. Only a researched buyer has facts (each one checked against the tool
 * result it came from); the contacts of a buyer not researched are those of the notice. */
export interface BuyerProfile {
  name?: string | null; legal_name?: string | null; sector?: string | null; size?: string | null
  organization_description?: string | null; estimated_revenue?: string | null; staff?: string | null; website?: string | null
  contacts?: { emails?: string[]; phones?: string[]; addresses?: string[] } | null
  past_digital_projects?: { title: string; date?: string | null; source?: string | null }[]
  /** Who won this buyer's past contracts (BOAMP award notices). */
  past_winners?: { name: string; wins?: number | null }[]
  key_partners?: string[]
  /** The tender's requirements about hosting, security, accessibility, certifications... */
  domain_requirements?: string[]
  /** researched | research_failed | research_invalid | skipped_demo | skipped_no_buyer_name | not_researched_budget | missing */
  research_status?: string | null
  /** enriched | partial | none | not_researched */
  enrichment_status?: string | null
}
/** An awarded contract the market agent judged comparable (from TED, DECP or TUNEPS). */
export interface Comparable {
  id: string; date?: string | null; amount?: number | null; currency?: string | null; buyer?: string | null; winners?: string[]
  bids?: number | null; framework?: boolean; source?: string | null; title?: string | null
}
/** The market study of n8n's Competitor & Budget agent: figures computed from awarded contracts, never written by the model. */
export interface Competition {
  /** OK | NO_COMPARABLE | NO_DATA | NOT_STUDIED | FAILED; detail is n8n's own status (study_failed, tools_failed...). */
  status?: string; detail?: string | null
  /** The value the notice declares (the buyer's own figure). */
  declared_value?: string | null
  budget_estimate?: {
    low?: number | null; mid?: number | null; high?: number | null; currency?: string | null; confidence?: string | null
    comparables?: number | null; basis?: string | null
  } | null
  competitors?: { name: string; past_wins?: number | null; past_losses?: number | null; avg_amount?: number | null; last_win?: string | null }[]
  median_bids?: number | null
  /** The agent's text; n8n removed its sentences with a figure or a name not found in the chosen contracts. */
  positioning?: string | null; budget_comment?: string | null
  comparables?: Comparable[]
}
export interface StudioInput {
  tender_id?: string; language?: string | null
  tender?: { title?: string; project_type?: string; issuer?: string | null }
  analysis?: { tender_type?: string | null } | null
  matrix?: { status?: string; summary?: MatrixSummary } | null
  buyer_profile?: BuyerProfile | null
  competition?: Competition | null
  /** Added by our n8n before sending: how many demo or weak proofs it removed from the studio's copy, and why (notes). */
  studio_adapter?: { version?: string | number; dropped?: Record<string, number>; notes?: string[] } | null
}

/** The agents of a run, in order. */
export const STEPS = ['agent1', 'agent5', 'diagrams', 'agent4', 'agent6', 'publish'] as const
export interface RunStep { agent: string; status: 'pending' | 'running' | 'done' | 'degraded' | 'failed'; ms?: number }
export interface DeckParams { language?: 'auto' | 'fr' | 'en'; project_type?: 'auto' | 'software' | 'saas' | 'other'; deckName?: string }
/** One deck generation (GET /api/generations/<runId>). */
export interface Run {
  runId: string; tenderId: string; templateId?: string | null; params?: DeckParams; status: RunStatus; step: string | null
  steps: RunStep[]; createdAt: string; deckId?: string | null; url?: string | null; warnings?: string[]; placeholders?: number
  problemsRemaining?: number; error?: string | null; waitingRateLimit?: unknown
}
/** A deck template of the studio (GET /api/templates): the design of a .pptx or .pdf, every text removed. */
export interface Template {
  id: string; name: string; isDefault: boolean
  /** The imported file's name. */
  source?: string | null; importedAt?: string | null
  /** Imported from a PDF: each page is a flat picture. */
  approximate?: boolean; warnings?: string[]
  stats?: { removedText?: number; keptShapes?: number; keptImages?: number }
  /** Studio paths of the rendered previews; a role is missing until the studio has rendered it. */
  previews?: Partial<Record<PreviewRole, string>>
  theme?: { primary?: string | null; secondary?: string | null; bg?: string | null }
}
export type PreviewRole = 'title' | 'content' | 'thankyou'
/** An inbox file (the studio's templates/inbox/ folder) the studio could not import. */
export interface InboxError { file: string; message: string }
export interface TemplateLibrary { templates: Template[]; default: string | null; errors: InboxError[] }

/** The answer's status and JSON body; only a request that gets no answer throws. */
async function send(path: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  let response: Response
  try {
    response = await fetch(STUDIO + path, init)
  } catch {
    // No answer at all (studio stopped), or one of its error pages, which carry no CORS header.
    throw new ApiError(UNREACHABLE, 0)
  }
  const text = await response.text().catch(() => '')
  try {
    return { status: response.status, body: text ? JSON.parse(text) : null }
  } catch {
    return { status: response.status, body: null }
  }
}

async function get<T>(path: string): Promise<T> {
  const { status, body } = await send(path)
  if (status !== 200 || body == null) throw new ApiError(`${STUDIO_ERROR} (${status})`, status)
  return body as T
}

/** The studio's tender inbox, with the last run of each tender. */
export async function studioTenders(): Promise<StudioInbox> {
  const result = await get<Partial<StudioInbox>>('/api/tenders')
  return { tenders: result.tenders ?? [], generationEnabled: !!result.generationEnabled, llmModels: result.llmModels ?? [] }
}

/** The last run of each tender in the studio, by studio id. Empty when the studio does not answer: the lists then show no deck
 * status and no error, the studio is optional for them. */
export async function studioDecks(): Promise<Map<string, Generation>> {
  try {
    const { tenders } = await studioTenders()
    return new Map(tenders.flatMap(t => t.generation ? [[t.id, t.generation] as const] : []))
  } catch {
    return new Map()
  }
}

/** The proposal input the studio stored for this tender, or null when n8n did not send it there. */
export async function studioTender(id: string): Promise<StudioInput | null> {
  const sid = studioId(id)
  if (!sid) return null
  const { status, body } = await send(`/api/tenders/${sid}`)
  if (status === 404) return null
  if (status !== 200 || body == null) throw new ApiError(`${STUDIO_ERROR} (${status})`, status)
  return body as StudioInput
}

/** The deck runs of one tender, newest first. */
export async function runs(id: string): Promise<Run[]> {
  const sid = studioId(id)
  if (!sid) return []   // no tenderId would list the runs of every tender
  const result = await get<{ generations?: Run[] }>(`/api/generations?tenderId=${sid}`)
  return result.generations ?? []
}

/** One run: its steps while the agents work, the deck link once it is done. */
export async function run(runId: string): Promise<Run> {
  if (!/^[a-f0-9]{12}$/.test(runId)) throw new ApiError(`${STUDIO_ERROR} (unknown run)`, 404)
  return get<Run>(`/api/generations/${runId}`)
}

/** The studio's deck templates (the default one first), the default's id, and the inbox files it could not import. */
export async function templateLibrary(): Promise<TemplateLibrary> {
  const result = await get<Partial<TemplateLibrary>>('/api/templates')
  return {
    templates: [...(result.templates ?? [])].sort((a, b) => Number(b.isDefault) - Number(a.isDefault)),
    default: result.default ?? null, errors: result.errors ?? [],
  }
}

/** The studio's deck templates, the default one first. */
export async function templates(): Promise<Template[]> {
  return (await templateLibrary()).templates
}

/** A preview picture of a template on the studio, or null while it is not rendered. ?v= changes with each import: a template
 * deleted then imported again can get the same id, and the browser must not show its old picture. */
export function templatePreview(t: Template, role: PreviewRole): string | null {
  const path = t.previews?.[role]
  return path?.startsWith('/') ? `${STUDIO}${path}?v=${encodeURIComponent(t.importedAt ?? '')}` : null
}

// The studio refuses a template upload over 60 MB, form fields included: a little room is kept for them.
const TEMPLATE_LIMIT = 60 * 1024 * 1024 - 64 * 1024
const megabytes = (bytes: number) => (bytes / 1024 / 1024).toFixed(1)

/** Why the studio would refuse this file, checked before sending it; '' when it can be sent. */
function templateFileProblem(file: File): string {
  if (!/\.(pptx|pdf)$/i.test(file.name)) return `"${file.name}" is not a .pptx or .pdf file.`
  if (file.size === 0) return `"${file.name}" is empty.`
  if (file.size > TEMPLATE_LIMIT) return `"${file.name}" is ${megabytes(file.size)} MB; the studio takes templates up to 60 MB. Compress its pictures (1920 px wide is enough).`
  return ''
}

export interface ImportedTemplate { id: string; name: string; warnings: string[]; stats?: Template['stats'] }

/** Imports a .pptx or .pdf as a template: the studio keeps its design and removes every text. It renders the previews
 * afterwards, in the background. The studio's own messages can be French: they are kept after an English sentence. */
export async function uploadTemplate(file: File): Promise<ImportedTemplate> {
  const problem = templateFileProblem(file)
  if (problem) throw new ApiError(problem, 400)
  const form = new FormData()
  form.append('file', file)
  const { status, body } = await send('/api/templates', { method: 'POST', body: form })
  const answer = (body ?? {}) as { template?: ImportedTemplate; message?: unknown }
  if (status === 200 && answer.template?.id) return { ...answer.template, warnings: answer.template.warnings ?? [] }
  const detail = typeof answer.message === 'string' ? answer.message.replace(/^Import impossible\s*:\s*/i, '') : ''
  if (status === 413) throw new ApiError(`"${file.name}" is too large for the proposal studio (60 MB at most)${detail ? `: ${detail}` : '.'}`, status)
  if (status === 400) throw new ApiError(`The proposal studio could not import "${file.name}"${detail ? `: ${detail}` : '.'}`, status)
  throw new ApiError(`${STUDIO_ERROR} (${status})`, status)
}

/** Makes a template the studio's default (null: none). The Proposal tab preselects it; n8n's automatic deck uses it. */
export async function setDefaultTemplate(id: string | null): Promise<void> {
  const { status } = await send('/api/templates/default', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
  })
  if (status === 200) return
  // The studio refuses only an id it does not know (deleted meanwhile, in the studio or another tab).
  throw new ApiError(status === 400 ? 'This template is no longer in the proposal studio (deleted meanwhile).' : `${STUDIO_ERROR} (${status})`, status)
}

/** Deletes a template: the studio moves its folder to templates/trash/, where it can be restored. Returns false when the
 * studio had no such template any more (already deleted). */
export async function deleteTemplate(id: string): Promise<boolean> {
  if (!/^[a-z0-9_-]{1,40}$/.test(id)) throw new ApiError('This template id is not valid.', 400)
  const { status } = await send(`/api/templates/${id}`, { method: 'DELETE' })
  if (status === 404) return false
  if (status !== 200) throw new ApiError(`${STUDIO_ERROR} (${status})`, status)
  return true
}

/** Imports the files of the studio's templates/inbox/ folder that are not in its library yet (as at each studio start). With
 * no default template, the studio then makes the first template (by id) the default. */
export async function rescanTemplates(): Promise<{ imported: string[]; errors: InboxError[] }> {
  const { status, body } = await send('/api/templates/rescan', { method: 'POST' })
  if (status !== 200 || body == null) throw new ApiError(`${STUDIO_ERROR} (${status})`, status)
  const answer = body as { imported?: string[]; errors?: Record<string, string> }
  return { imported: answer.imported ?? [], errors: Object.entries(answer.errors ?? {}).map(([file, message]) => ({ file, message })) }
}

const START_ERROR: Record<number, string> = {
  404: 'This tender is not in the proposal studio. n8n sends fit, open tenders (top 10).',
  409: 'Another deck is being generated. The studio makes one deck at a time: wait until it is done, then retry.',
  503: 'Deck generation is not configured in the proposal studio (GENERATE_MODE=cli, or GENERATE_WEBHOOK_URL for its n8n).',
  502: 'The proposal studio could not reach its agent service, so no deck was started. Check the studio, then retry.',
}

/** Starts the deck agents for one tender and returns the run id. templateId: omitted = the studio's default template, '' = none. */
export async function startDeck(id: string, { templateId, params }: { templateId?: string; params: DeckParams }): Promise<string> {
  const { status, body } = await send('/api/generations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenderId: studioId(id), params, ...(templateId === undefined ? {} : { templateId }) }),
  })
  const answer = (body ?? {}) as { runId?: unknown; message?: unknown }
  if (status === 202 && typeof answer.runId === 'string') return answer.runId
  if (status === 400) {
    // The studio names an unknown template in French; its parameter errors are English.
    const detail = typeof answer.message === 'string' ? answer.message : ''
    throw new ApiError(templateId && detail.includes(templateId)
      ? `The template "${templateId}" is no longer in the proposal studio. Choose another template.`
      : `The proposal studio refused these deck options${detail ? `: ${detail}` : '.'}`, status)
  }
  throw new ApiError(START_ERROR[status] ?? `${STUDIO_ERROR} (${status})`, status)
}

/** The studio's editor for one deck. It runs on the studio's own address (it loads its files from /static and /api), shown
 * inside this app by the deck page (DeckView). */
export const deckEditorUrl = (deckId: string) => `${STUDIO}/editor.html?id=${encodeURIComponent(deckId)}`

/** The in-app address of a finished deck (the deck page, not another tab); null while no deck exists. */
export function deckPath(rec: { deckId?: string | null } | null | undefined, tenderId?: string): string | null {
  if (!rec?.deckId) return null
  return `/decks/${encodeURIComponent(rec.deckId)}${tenderId ? `?tender=${encodeURIComponent(tenderId)}` : ''}`
}

/** One slide of a deck: its position (0 = the title slide), the studio's slide type (title, content, blank, thankyou) and its
 * title as the editor's slide list shows it. */
export interface DeckSlide { index: number; type: string; title: string }

/** The slides of a deck, as last saved in the studio (GET /api/save/<id> needs no key). Throws a clear error when the studio
 * does not answer or has no such deck. */
export async function studioDeck(deckId: string): Promise<DeckSlide[]> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(deckId)) throw new ApiError('This deck address is not valid.', 400)
  const { status, body } = await send(`/api/save/${deckId}`)
  if (status === 404) throw new ApiError('The studio has no deck with this id (it may have been deleted).', 404)
  if (status !== 200 || body == null) throw new ApiError(`${STUDIO_ERROR} (${status})`, status)
  const slides = (body as { slides?: unknown }).slides
  return (Array.isArray(slides) ? slides : []).map((s: { type?: unknown; label?: unknown } | null, index) => ({
    index, type: typeof s?.type === 'string' ? s.type : '',
    title: typeof s?.label === 'string' && s.label.trim() ? s.label.trim() : `Slide ${index + 1}`,
  }))
}

/** The editor of a finished deck, on the studio's own address (the editor loads its files from /static and /api). */
export function editorUrl(rec: { url?: string | null } | null | undefined): string | null {
  const url = rec?.url
  if (!url) return null
  if (/^https?:\/\//i.test(url)) return url
  return url.startsWith('/') ? STUDIO + url : null
}

export const isActive = (status: RunStatus | undefined) => status === 'queued' || status === 'running'

/** The deck's project_type from the analysis' tender type. The studio's own reading makes ai_data 'other', which drops the
 * class-diagram slide. */
export function projectTypeFor(input: StudioInput): 'software' | 'saas' | 'other' {
  const type = input.analysis?.tender_type ?? input.tender?.project_type ?? ''
  if (type === 'software_build' || type === 'ai_data' || type === 'software') return 'software'
  if (type === 'integration_saas' || type === 'saas') return 'saas'
  return 'other'
}
