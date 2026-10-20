import type { Analysis, Doc, RecordItem } from './data'

const API_ERROR = 'The RAG service could not complete this request.'
const UNREACHABLE = 'The RAG service is not reachable. Start it (start.bat or ./start.sh), then retry.'

/** An HTTP error from the RAG service; `status` lets callers treat e.g. 404 as "already gone". */
export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

/** Where a page's data stands while it comes from the RAG service. */
export type LoadState = 'loading' | 'ready' | 'error'

export const errorText = (err: unknown, fallback = API_ERROR) => err instanceof Error ? err.message : fallback

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    })
  } catch {
    // fetch only rejects when no answer arrives at all (service stopped, network down).
    throw new ApiError(UNREACHABLE, 0)
  }
  if (!response.ok) {
    let detail = API_ERROR
    const text = await response.text().catch(() => '')
    try {
      const body = JSON.parse(text) as { detail?: unknown }
      const message = (body.detail as { message?: unknown } | null)?.message
      detail = typeof body.detail === 'string' ? body.detail : typeof message === 'string' ? message : detail
    } catch {
      // Keep the user-facing error stable when the server returns non-JSON.
      // The development proxy answers an empty 5xx when the RAG service is stopped.
      if (response.status >= 500 && !text.trim()) throw new ApiError(UNREACHABLE, response.status)
    }
    throw new ApiError(`${detail} (${response.status})`, response.status)
  }
  return response.json() as Promise<T>
}

// The last answer of each read is kept while the app is open: a page visited before shows it at once and refreshes it in
// the background, instead of a loading state on every visit (the records list alone took seconds). Every write drops the
// answers it changes, so a page never shows data older than the user's own last change.
const lastRead = new Map<string, unknown>()

async function read<T>(path: string): Promise<T> {
  const value = await request<T>(path)
  lastRead.set(path, value)
  return value
}

function forget(...prefixes: string[]) {
  for (const key of [...lastRead.keys()]) if (prefixes.some(prefix => key.startsWith(prefix))) lastRead.delete(key)
}

/** The last answer of a read in this session, or undefined when it never ran or a write changed its data since. */
export const peek = {
  documents: (mode: 'company' | 'demo' = 'company') => (lastRead.get(`/api/documents?data_mode=${mode}`) as { documents: Doc[] } | undefined)?.documents,
  records: (mode: 'company' | 'demo' = 'company') => (lastRead.get(`/api/records?data_mode=${mode}`) as { records: RecordItem[] } | undefined)?.records,
  tenders: () => (lastRead.get('/api/tenders') as { tenders: StoredTender[] } | undefined)?.tenders,
  benchmark: () => lastRead.get('/api/benchmark') as Benchmark | undefined,
}

export interface Health {
  status: string
  version: string
  model: string
  reranker: string | null
  index_ready: boolean
}

/** One retrieval system's scores on the labelled retrieval set (benchmark/retrieval_eval.py), over its positive queries. */
export interface RetrievalScores {
  'p@3': number; 'r@5': number; mrr: number; 'ndcg@5': number; 'hit@1': number; queries: number; latency_ms_median?: number
  /** Final system only: the documents it keeps as proof, against the labels. */
  set_precision?: number; set_recall?: number
  /** Final system only: queries that have no right answer, and those it still answered. */
  negatives?: { total: number; false_positives: string[]; false_positive_rate: number }
}
export interface Accuracy { lines: number; correct: number; accuracy: number }
/** Requirement lines n8n sent in one run, labelled by hand (benchmark/real_tenders.py): the status the RAG gives against the
 * label. Real tenders ran in Company mode, the synthetic demo tenders in Demo mode. */
export interface RealTenders {
  tenders: number; lines: number
  summary: Accuracy & {
    by_mode?: Record<string, Accuracy>; by_category?: Record<string, Accuracy>; by_expected?: Record<string, Accuracy>
    over_claims?: string[]; under_claims?: string[]; claimed?: number; right_proof?: number
  }
  per_line?: { id: string; tender_id?: string; data_mode: string; category: string; line: string; expect: string; got: string; ok: boolean }[]
}

export interface Benchmark {
  available: boolean
  updated?: string
  meta?: { finished_at: string; documents: number; real_cv_tests: number; embedding_model: string; reranker: string }
  real_cvs?: Record<string, { passed: number; total: number; rows: { q: string; expect: string; got: string; pass: boolean; found: number }[] }>
  retrieval?: {
    queries: number; positives: number; negatives: number; french_positives?: number; corpus?: Record<string, number>
    systems: Record<string, RetrievalScores>
  }
  real_tenders?: RealTenders
  tests?: { summary: string; counts: Record<string, number> }
}

export async function health(): Promise<Health> {
  return request<Health>('/health')
}

export async function benchmark(): Promise<Benchmark> {
  return read<Benchmark>('/api/benchmark')
}

export async function documents(mode: 'company' | 'demo' = 'company'): Promise<Doc[]> {
  const result = await read<{ documents: Doc[] }>(`/api/documents?data_mode=${mode}`)
  return result.documents
}

export async function records(mode: 'company' | 'demo' = 'company'): Promise<RecordItem[]> {
  const result = await read<{ records: RecordItem[] }>(`/api/records?data_mode=${mode}`)
  return result.records
}

export interface StoredTender {
  tender_id: string
  title?: string
  client?: string
  sector?: string
  country?: string
  source?: string
  source_url?: string
  published?: string
  deadline?: string
  estimated_budget?: string
  data_mode?: 'company' | 'demo'
  requirements?: TenderInput['requirements']
  rag_analysis?: Analysis
}

export async function tenders(): Promise<StoredTender[]> {
  const result = await read<{ tenders: StoredTender[] }>('/api/tenders')
  return result.tenders
}

/** One stored tender, or null when the RAG service has none with this ID. */
export async function tender(id: string): Promise<StoredTender | null> {
  try {
    return await request<StoredTender>(`/api/tenders/${encodeURIComponent(id)}`)
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null
    throw err
  }
}

/** Deletes one stored tender and its analysis. A tender that is already gone counts as deleted. */
export async function deleteTender(id: string): Promise<void> {
  forget('/api/tenders')
  try {
    await request(`/api/tenders/${encodeURIComponent(id)}`, { method: 'DELETE' })
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 404)) throw err
  }
}

/** Deletes every stored tender; returns how many the RAG service removed. */
export async function clearTenders(): Promise<number> {
  forget('/api/tenders')
  const result = await request<{ deleted: number }>('/api/tenders', { method: 'DELETE' })
  return result.deleted
}

export interface TenderInput {
  tender_id?: string
  title?: string
  client?: string
  sector?: string
  source?: string
  published?: string
  data_mode: 'company' | 'demo'
  requirements: {
    technical: string[]
    team: string[]
    experience: string[]
    sector?: string
    client?: string
  }
}

export async function analyzeTender(input: TenderInput): Promise<Analysis> {
  forget('/api/tenders')   // the RAG service stores every analysed tender in its inbox
  return request<Analysis>('/retrieve/tender', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export type RecordPayload = {
  type: RecordItem['type']
  title: string
  description: string
  client?: string
  sector?: string
  company_role?: string
  scope?: string
  technologies?: string[]
  delivery_status?: string
  use_cases?: string
  relationship?: string
  country?: string
  year?: number
  outcomes?: string
  budget?: number
  currency?: string
  linked_ids?: string[]
  team_cv_ids?: string[]
  tool_kind?: string
  licence_details?: string
  source?: string
  action: 'draft' | 'index'
}

export async function saveRecord(payload: RecordPayload): Promise<{ record: RecordItem }> {
  forget('/api/records', '/api/documents')
  return request<{ record: RecordItem }>('/api/records', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export async function updateRecord(id: string, payload: RecordPayload): Promise<{ record: RecordItem }> {
  forget('/api/records', '/api/documents')
  return request<{ record: RecordItem }>(`/api/records/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  })
}

export async function deleteRecord(id: string, confirmLinks = false): Promise<void> {
  forget('/api/records', '/api/documents')
  await request(`/api/records/${encodeURIComponent(id)}?confirm_links=${confirmLinks}`, { method: 'DELETE' })
}
