import { ApiError } from './api'

// "Refine with AI" on the deck page: our n8n workflow "RFP - Refine Slide" (webhook cstam/refine-slide) asks the deck agents to
// write one slide again with the user's instruction, then saves it in the proposal studio with the studio key, which stays in
// n8n. The browser calls n8n directly (its webhook must allow this site's origin): no key here.
export const N8N = (import.meta.env.VITE_N8N_URL || 'http://localhost:5679').replace(/\/+$/, '')
const REFINE_PATH = '/webhook/cstam/refine-slide'

/** The instruction's length once trimmed: the agents read at most 200 characters. */
export const INSTRUCTION = { min: 3, max: 200 } as const

const REFINE_ERROR = 'The AI refinement service could not refine this slide.'
const UNREACHABLE = `The AI refinement service (n8n) is not reachable at ${N8N}. Start it, then retry.`
// n8n answers, but not on the refine webhook: the workflow is not active (n8n says so when its answer can be read).
const NO_WEBHOOK = `n8n answers at ${N8N}, but its refine webhook (${REFINE_PATH}) does not: activate the "RFP - Refine Slide" workflow, then retry.`
// n8n answers, but its webhook's answer cannot be read here: the workflow is not active, or this page's address is not in the
// webhook's allowed origins (the browser then hides the answer).
const NO_ANSWER = `n8n answers at ${N8N}, but its refine webhook (${REFINE_PATH}) does not answer this page: activate the "RFP - Refine Slide" workflow, or add this page's address (${window.location.origin}) to the webhook's allowed origins, then retry.`
// The agents usually answer in 30 to 90 s. Past this, the browser stops waiting; n8n may still save the slide afterwards.
const TIMEOUT = 180_000

/** Whether a server answers at the n8n address. n8n's /healthz sends no CORS header, so the request is a no-cors one: it tells
 * that an answer came, never its status. */
export async function n8nAnswers(timeout = 5000): Promise<boolean> {
  const abort = new AbortController()
  const timer = window.setTimeout(() => abort.abort(), timeout)
  try {
    await fetch(`${N8N}/healthz`, { mode: 'no-cors', cache: 'no-store', signal: abort.signal })
    return true
  } catch {
    return false
  } finally {
    window.clearTimeout(timer)
  }
}

/** The refined slide: its place, its new title, and the warnings of the agents and of n8n (prices to approve again...). */
export interface Refined { slideIndex: number; title: string; warnings: string[] }

/** Asks the deck agents to write one slide again (slideIndex 0 = the title slide) following the instruction; n8n saves the new
 * slide in the studio. Returns the agents' warnings; throws a readable error on any failure. */
export async function refineSlide(deckId: string, slideIndex: number, instruction: string): Promise<Refined> {
  const text = instruction.trim()
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(deckId)) throw new ApiError('This deck address is not valid.', 400)
  if (text.length < INSTRUCTION.min || text.length > INSTRUCTION.max) {
    throw new ApiError(`Write an instruction of ${INSTRUCTION.min} to ${INSTRUCTION.max} characters.`, 400)
  }
  const abort = new AbortController()
  const timer = window.setTimeout(() => abort.abort(), TIMEOUT)
  let status: number, body: { status?: unknown; message?: unknown; slideIndex?: unknown; title?: unknown; warnings?: unknown } | null
  try {
    const response = await fetch(N8N + REFINE_PATH, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: abort.signal,
      body: JSON.stringify({ deckId, slideIndex, instruction: text }),
    })
    status = response.status
    const raw = await response.text()
    try { body = raw ? JSON.parse(raw) : null } catch { body = null }
  } catch {
    if (abort.signal.aborted) throw new ApiError('No answer from n8n after 3 minutes. It may still save the slide: reopen the deck in a minute and check it.', 0)
    // No answer at all, or one without a CORS header (an unknown webhook, for one): ask n8n itself which it is.
    throw new ApiError(await n8nAnswers() ? NO_ANSWER : UNREACHABLE, 0)
  } finally {
    window.clearTimeout(timer)
  }
  if (status === 200 && body?.status === 'ok') {
    return {
      slideIndex: typeof body.slideIndex === 'number' ? body.slideIndex : slideIndex, title: typeof body.title === 'string' ? body.title.trim() : '',
      warnings: Array.isArray(body.warnings) ? body.warnings.filter((w): w is string => typeof w === 'string' && !!w.trim()) : [],
    }
  }
  const detail = typeof body?.message === 'string' ? body.message.trim() : ''
  if (status === 404 && /webhook.*not registered/i.test(detail)) throw new ApiError(NO_WEBHOOK, status)
  // A 200 without a result: the webhook answers before the workflow ends (n8n's "Workflow was started").
  if (status === 200) throw new ApiError(`n8n gave no result for this slide${detail ? ` ("${detail}")` : ''}. The "RFP - Refine Slide" workflow must answer once the slide is saved.`, status)
  throw new ApiError(`${detail || REFINE_ERROR} (${status})`, status)
}
