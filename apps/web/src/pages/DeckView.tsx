import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import {
  AlertTriangle, ArrowLeft, CheckCircle2, ChevronDown, ChevronUp, ExternalLink, Info, Loader2, Maximize2, Minimize2, Presentation, Sparkles,
} from 'lucide-react'
import { Card, cx, ErrorNote, Loading, Tip } from '../components/ui'
import { errorText } from '../lib/api'
import { INSTRUCTION, N8N, refineSlide, type Refined } from '../lib/refine'
import { deckEditorUrl, studioDeck, type DeckSlide } from '../lib/studio'

type Outcome = { slide: DeckSlide; refined: Refined } | { slide: DeckSlide; error: string }
/** A slide being refined; done never fails, it gives the outcome. */
interface Refining { slide: DeckSlide; started: number; done: Promise<Outcome> }
// Kept outside the page, by deck: the user may leave the deck page and come back while n8n works, and the editor must stay
// closed until the answer, or its autosave would write its old copy of the slide over the new one. The outcome waits in
// `ended` until a deck page shows it (the user may be on another page when n8n answers).
const inFlight = new Map<string, Refining>()
const ended = new Map<string, Outcome>()

// Reloading or closing the app during a refine would lose it: the deck page would open the editor on the old slide.
function holdPage(e: BeforeUnloadEvent) { e.preventDefault(); e.returnValue = '' }

function startRefine(deckId: string, slide: DeckSlide, instruction: string): Refining {
  const done = refineSlide(deckId, slide.index, instruction)
    .then((refined): Outcome => ({ slide, refined }), (err): Outcome => ({ slide, error: errorText(err) }))
    .then(outcome => {
      inFlight.delete(deckId); ended.set(deckId, outcome)
      if (!inFlight.size) window.removeEventListener('beforeunload', holdPage)
      return outcome
    })
  const job = { slide, started: Date.now(), done }
  inFlight.set(deckId, job); ended.delete(deckId)
  window.addEventListener('beforeunload', holdPage)
  return job
}

/** A deck of the proposal studio, edited inside this app: the studio's own editor in a frame. Editing, the review panel and the
 * PPTX / PDF export (with its placeholder and pricing approval checks) all work there. "Refine with AI" above it asks the deck
 * agents, through our n8n, to write one slide again following an instruction. */
export default function DeckView() {
  const { deckId = '' } = useParams()
  // Another deck is another page: nothing of the last one is kept.
  return <Deck key={deckId} deckId={deckId} />
}

function Deck({ deckId }: { deckId: string }) {
  const [params] = useSearchParams()
  const tenderId = params.get('tender')
  const nav = useNavigate()
  const [state, setState] = useState<'checking' | 'ready' | 'error'>('checking')
  const [error, setError] = useState('')
  const [slides, setSlides] = useState<DeckSlide[]>([])
  // Full screen: the editor over the whole window (the sidebar hidden), for small screens. Escape leaves it while the focus
  // is on this page (inside the frame, the editor keeps its own keys).
  const [full, setFull] = useState(false)
  useEffect(() => {
    if (!full) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFull(false) }
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey)
  }, [full])
  // A frame of a stopped studio stays blank: ask the studio for the deck first, so a clear message can show instead.
  const check = useCallback(() => {
    setState('checking')
    studioDeck(deckId).then(list => { setSlides(list); setState('ready') }).catch(err => { setError(errorText(err)); setState('error') })
  }, [deckId])
  useEffect(check, [check])

  // While the agents refine a slide, the editor is closed (unmounted): it saves the whole deck about every 10 s and would write
  // its old copy of the slide over the new one. It opens again afterwards, freshly loaded (a new key), with the new slide.
  const [panel, setPanel] = useState(() => inFlight.has(deckId) || ended.has(deckId))
  const [refining, setRefining] = useState<Refining | null>(() => inFlight.get(deckId) ?? null)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [frame, setFrame] = useState(0)
  const [started, setStarted] = useState(0)
  // Follows the deck's refine: started on this page (started changes) or on an earlier visit of it, or ended while the user
  // was on another page (its outcome is shown once).
  useEffect(() => {
    const job = inFlight.get(deckId)
    if (!job) {
      const last = ended.get(deckId)
      if (last) { ended.delete(deckId); setOutcome(last); setPanel(true) }
      return
    }
    setRefining(job); setPanel(true)
    let live = true
    job.done.then(result => {
      if (!live) return
      ended.delete(deckId)
      setRefining(null); setOutcome(result); setFrame(n => n + 1)
      // The agents may have given the slide another title.
      studioDeck(deckId).then(list => { if (live) setSlides(list) }).catch(() => {})
    })
    return () => { live = false }
  }, [deckId, started])
  const refine = useCallback(async (slide: DeckSlide, instruction: string) => {
    if (inFlight.has(deckId)) return false
    const job = startRefine(deckId, slide, instruction)
    setRefining(job); setOutcome(null); setStarted(n => n + 1)
    return 'refined' in await job.done
  }, [deckId])

  const url = deckEditorUrl(deckId)
  return (
    <div className={cx('flex flex-col gap-3', full ? 'fixed inset-0 z-50 bg-canvas p-3' : 'h-[calc(100vh-7.5rem)] min-h-[560px]')}>
      <div className="flex flex-wrap items-center gap-3">
        <button className="btn-secondary btn-sm" onClick={() => (tenderId ? nav(`/tenders/${encodeURIComponent(tenderId)}`) : nav(-1))}>
          <ArrowLeft size={14} />{tenderId ? 'Back to the tender' : 'Back'}</button>
        <div className="flex items-center gap-2 font-semibold"><Presentation size={16} />Proposal deck</div>
        <span className="ml-auto flex items-center gap-3">
          {/* Another editor open meanwhile would save the old slide over the new one. */}
          {refining ? <span className="inline-flex items-center gap-1 text-[12px] text-ink-muted/60" title="Available when the slide is refined">
              Open in a new tab<ExternalLink size={12} /></span>
            : <a className="inline-flex items-center gap-1 text-[12px] text-ink-muted hover:text-primary" href={url} target="_blank" rel="noreferrer">
              Open in a new tab<ExternalLink size={12} /></a>}
          {state === 'ready' && <button className="btn-secondary btn-sm" onClick={() => setPanel(p => !p)} aria-expanded={panel} disabled={!!refining}>
            <Sparkles size={14} />Refine with AI{panel ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</button>}
          <button className="btn-secondary btn-sm" onClick={() => setFull(f => !f)} aria-pressed={full}>
            {full ? <><Minimize2 size={14} />Exit full screen</> : <><Maximize2 size={14} />Full screen</>}</button>
        </span>
      </div>
      {state === 'ready' && (panel || refining) && <RefinePanel slides={slides} refining={refining?.slide ?? null} outcome={outcome} onRefine={refine} />}
      {state === 'checking' ? <Card><Loading text="Opening the deck…" /></Card>
        : state === 'error' ? <ErrorNote message={`Could not open this deck from the proposal studio: ${error}`} onRetry={check} />
        : refining ? <RefiningNote job={refining} />
        // The editor needs about 1100 px for its toolbar (Save and Export sit at its right end, and it does not scroll):
        // narrower, the frame keeps that width and this box scrolls sideways.
        : <div className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden rounded-[14px] border border-line bg-white">
            <iframe key={frame} title="Proposal deck editor" src={url} className="block h-full w-full min-w-[1100px]" />
          </div>}
    </div>
  )
}

/** Slide number as the editor's slide list shows it (#1 = the title slide). */
const slideName = (s: DeckSlide) => `#${s.index + 1} · ${s.title}`
/** How the agents match a slide to its title (their registry's key): the first 25 characters, without a "(k/n)" part number. */
const titleKey = (title: string) => title.replace(/\s*\(\d+\/\d+\)\s*$/, '').slice(0, 25).toLowerCase().trim()

function RefinePanel({ slides, refining, outcome, onRefine }: {
  slides: DeckSlide[]; refining: DeckSlide | null; outcome: Outcome | null; onRefine: (slide: DeckSlide, instruction: string) => Promise<boolean>
}) {
  // The agents write only the content slides. The title slide, the last one (thanks and contact) and the slides the studio adds
  // from the template (contents, about us) are fixed.
  const middle = slides.filter(s => s.index > 0 && s.index < slides.length - 1 && s.type !== 'title' && s.type !== 'thankyou')
  const content = middle.filter(s => s.type === 'content')
  const choices = content.length ? content : middle
  const [picked, setPicked] = useState<number | null>(null)
  const slide = choices.find(s => s.index === picked) ?? choices[0] ?? null
  const [instruction, setInstruction] = useState('')
  const sending = useRef(false)   // one request at a time, even on a double click
  const length = instruction.trim().length
  const valid = length >= INSTRUCTION.min && length <= INSTRUCTION.max

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (sending.current || refining || !slide || !valid) return
    sending.current = true
    try {
      if (await onRefine(slide, instruction)) setInstruction('')
    } finally {
      sending.current = false
    }
  }

  const result = outcome && 'refined' in outcome ? { slide: outcome.slide, ...outcome.refined } : null
  // The agents keep the slide as it was when they cannot do better in time: they say so in a warning ("slide inchangée";
  // n8n answers that case as an error, this is a second check).
  const unchanged = result?.warnings.some(w => /inchang|unchanged/i.test(w))
  // Another title can be the agents' own rewording, or another slide: the agents know the slides by their place in the
  // generated deck, so after slides are added, moved or deleted in the editor they may write another one in this place.
  const retitled = !!result?.title && titleKey(result.title) !== titleKey(result.slide.title)
  return (
    <Card className="p-4">
      <form onSubmit={submit} className="space-y-3">
        <div className="grid gap-3 md:grid-cols-[minmax(0,280px)_minmax(0,1fr)_auto] md:items-end">
          <label className="block">
            <span className="mb-1.5 flex items-center gap-1 text-[13px] font-medium">Slide
              <Tip text="Content slides only: the title, contents, about us and closing slides are fixed." /></span>
            <select className="input" value={slide?.index ?? ''} disabled={!!refining || !choices.length} onChange={e => setPicked(Number(e.target.value))}>
              {choices.length ? choices.map(s => <option key={s.index} value={s.index}>{slideName(s)}</option>) : <option value="">No content slide in this deck</option>}
            </select>
          </label>
          <label className="block">
            <span className="mb-1.5 flex items-center justify-between gap-2 text-[13px] font-medium">Instruction
              <span className={cx('text-[12px] font-normal', instruction && !valid ? 'text-bad' : 'text-ink-muted')}>{instruction.length}/{INSTRUCTION.max}</span></span>
            <input className="input" value={instruction} maxLength={INSTRUCTION.max} disabled={!!refining} onChange={e => setInstruction(e.target.value)}
              placeholder="e.g. More concise: three short bullet points" aria-describedby="refine-help" />
          </label>
          <button type="submit" className="btn-primary" disabled={!!refining || !slide || !valid}>
            {refining ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}{refining ? 'Refining…' : 'Refine slide'}</button>
        </div>
        <ul id="refine-help" className="space-y-1 text-[12px] text-ink-muted">
          <li className="flex gap-1.5"><Info size={14} className="mt-0.5 shrink-0" />
            The editor closes while the agents work (often 30 to 90 s, through n8n at {N8N}) and reopens with the new slide.</li>
          <li className="flex gap-1.5 text-warn"><AlertTriangle size={14} className="mt-0.5 shrink-0" />
            Changes made in the editor in the last ~10 seconds may be lost: wait until the editor shows "Enregistré" first, and close other tabs open on this deck.</li>
          <li className="flex gap-1.5 text-warn"><AlertTriangle size={14} className="mt-0.5 shrink-0" />
            The agents know the slides by their place in the generated deck: if slides were added, moved or deleted in the editor since, they may rewrite another slide.</li>
          <li className="flex gap-1.5"><Info size={14} className="mt-0.5 shrink-0" />
            The agents write the slide again from the tender data, with its facts checked: edits made by hand to this slide are replaced.</li>
        </ul>
      </form>
      {outcome && 'error' in outcome && <ErrorNote className="mt-3" message={`${slideName(outcome.slide)} was not refined: ${outcome.error}`} />}
      {result && (
        <div className={cx('mt-3 rounded-ctl px-3 py-2 text-[13px]', unchanged || retitled ? 'bg-warn-soft text-warn' : 'bg-olive-soft text-olive-deep')} role="status">
          <p className="flex gap-2">{unchanged || retitled ? <AlertTriangle size={16} className="mt-0.5 shrink-0" /> : <CheckCircle2 size={16} className="mt-0.5 shrink-0" />}
            {unchanged ? `The agents kept ${slideName(result.slide)} unchanged.`
              : retitled ? `The agents saved a slide titled "${result.title}" in place of ${slideName(result.slide)}. They may have reworded the title, or written another slide here (if slides were added, moved or deleted since the deck was generated): open slide #${result.slide.index + 1} in the editor's slide list and check it.`
              : `${slideName(result.slide)} was refined and saved in the studio. Open slide #${result.slide.index + 1} in the editor's slide list to see it.`}</p>
          {result.warnings.length > 0 && <>
            <div className="mt-1.5 font-medium">Notes</div>
            <ul className="mt-0.5 list-disc space-y-0.5 pl-5">{result.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
          </>}
        </div>
      )}
    </Card>
  )
}

/** Shown in place of the editor while a slide is refined. */
function RefiningNote({ job: { slide, started } }: { job: Refining }) {
  const [, tick] = useState(0)
  useEffect(() => {
    const timer = window.setInterval(() => tick(n => n + 1), 1000)
    return () => window.clearInterval(timer)
  }, [])
  const seconds = Math.round((Date.now() - started) / 1000)
  return (
    <Card className="grid min-h-0 flex-1 place-items-center p-6">
      <div role="status" className="max-w-md text-center">
        <Loader2 size={22} className="mx-auto animate-spin text-primary" />
        <div className="mt-3 font-semibold">Refining slide {slide.index + 1} with AI…</div>
        <div className="mt-0.5 text-[13px] text-ink-muted">{slide.title} · {seconds} s</div>
        <p className="mt-3 text-[13px] text-ink-muted">The editor is closed meanwhile, so it cannot save over the new slide: do not open this deck in another tab until then. It reopens when the agents answer.</p>
      </div>
    </Card>
  )
}
