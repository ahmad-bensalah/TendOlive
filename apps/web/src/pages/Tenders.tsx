import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowRight, ExternalLink, FileText, Plus, Presentation, Search, Trash2 } from 'lucide-react'
import { Badge, Card, Chips, ConfirmDialog, DeckBadge, Empty, ErrorNote, Loading, ScoreRing, SidePanel, statusTone } from '../components/ui'
import {
  allTenders, analysisFor, daysLeft, deadlineLabel, fmtDate, forgetAllTenders, forgetTender, MANUAL_SOURCE, rememberTender,
  STATUS_LABEL, syncTenders, TENDERS_CHANGED, type Tender, type TenderStatus,
} from '../lib/data'
import { analyzeTender, clearTenders, deleteTender, errorText, peek, tenders, type LoadState, type TenderInput } from '../lib/api'
import { deckPath, studioDecks, studioId, type Generation } from '../lib/studio'

type F = 'all' | TenderStatus
/** What the confirmation dialog is about to delete. */
type Removal = { kind: 'all' } | { kind: 'one'; tender: Tender }

export default function Tenders() {
  const nav = useNavigate()
  const [params, setParams] = useSearchParams()
  const [filter, setFilter] = useState<F>('all')
  const [q, setQ] = useState('')
  const [currentTenders, setCurrentTenders] = useState(allTenders)
  // Loaded before in this session: the list shows at once and is refreshed quietly (no loading state on every visit).
  const [seen] = useState(() => peek.tenders() !== undefined)
  const [state, setState] = useState<LoadState>(seen ? 'ready' : 'loading')
  const [loadError, setLoadError] = useState('')
  const [removal, setRemoval] = useState<Removal | null>(null)
  const [removing, setRemoving] = useState(false)
  const [removeError, setRemoveError] = useState('')
  // The RAG service holds the inbox; the browser copy is only shown when the service cannot answer.
  // A quiet reload (after a delete) keeps the list on screen instead of showing the loading state.
  const load = useCallback(async (quiet = false) => {
    if (!quiet) setState('loading')
    try {
      syncTenders(await tenders())
      setLoadError('')
      setState('ready')
    } catch (err) {
      setLoadError(errorText(err))
      setState('error')
    }
    setCurrentTenders(allTenders())
  }, [])
  useEffect(() => { load(seen) }, [load, seen])
  useEffect(() => {  // a new analysis or a change made elsewhere in the app shows up at once
    const refresh = () => setCurrentTenders(allTenders())
    window.addEventListener(TENDERS_CHANGED, refresh)
    return () => window.removeEventListener(TENDERS_CHANGED, refresh)
  }, [])
  // The decks of the proposal studio, by studio id; none when the studio does not answer (the list works without it).
  const [decks, setDecks] = useState<Map<string, Generation>>(() => new Map())
  useEffect(() => { studioDecks().then(setDecks) }, [])
  const newOpen = params.get('new') === '1'
  const list = useMemo(() => currentTenders
    .filter(t => filter === 'all' || t.status === filter)
    .filter(t => (t.title + t.client + t.sector + t.id).toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => b.relevance - a.relevance), [filter, q, currentTenders])
  const loading = state === 'loading'
  const n = (s: TenderStatus) => loading ? undefined : currentTenders.filter(t => t.status === s).length
  const ask = (next: Removal) => { setRemoveError(''); setRemoval(next) }
  const closeDialog = useCallback(() => setRemoval(null), [])

  async function remove() {
    if (!removal) return
    setRemoving(true); setRemoveError('')
    try {
      if (removal.kind === 'all') {
        await clearTenders()
        forgetAllTenders()
      } else {
        await deleteTender(removal.tender.id)
        forgetTender(removal.tender.id)
      }
      setCurrentTenders(allTenders())
      setRemoval(null)
      await load(true)
    } catch (err) {
      setRemoveError(errorText(err))
    } finally {
      setRemoving(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div><h1 className="text-[28px] font-semibold tracking-tight">Tenders</h1><p className="mt-1 text-sm text-ink-muted">Detected from public portals, ranked by relevance.</p></div>
        <div className="flex flex-wrap gap-2">
          <button className="btn-secondary" disabled={loading || (state === 'ready' && currentTenders.length === 0)} onClick={() => ask({ kind: 'all' })}>
            <Trash2 size={16} />Clear tenders</button>
          <button className="btn-primary" onClick={() => setParams({ new: '1' })}><Plus size={16} />New analysis</button>
        </div>
      </div>

      {state === 'error' && <ErrorNote onRetry={() => load()}
        message={`Could not load the tenders from the RAG service: ${loadError}${currentTenders.length ? ' Showing the copy saved in this browser.' : ''}`} />}

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3 p-4">
          <Chips<F> value={filter} onChange={setFilter} items={[
            { id: 'all', label: 'All', count: loading ? undefined : currentTenders.length }, { id: 'new', label: 'New', count: n('new') }, { id: 'review', label: 'In review', count: n('review') },
            { id: 'proposal', label: 'Proposal ready', count: n('proposal') }, { id: 'nobid', label: 'No-bid', count: n('nobid') }, { id: 'filtered', label: 'Filtered out', count: n('filtered') }]} />
          <label className="relative w-full sm:w-72"><Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint" />
            <input className="input pl-9" placeholder="Search tenders" value={q} onChange={e => setQ(e.target.value)} aria-label="Search tenders" /></label>
        </div>
        {loading ? <Loading text="Loading tenders…" /> :
          currentTenders.length === 0 ? (state === 'error'
            ? <Empty icon={FileText} title="No tenders to show" text="The RAG service did not answer and this browser has no saved copy." />
            : <Empty icon={FileText} title="No tenders yet" text="Tenders sent by n8n and your new analyses appear here."
                action={<button className="btn-secondary" onClick={() => setParams({ new: '1' })}><Plus size={16} />New analysis</button>} />) :
          list.length === 0 ? <Empty icon={FileText} title="No tenders match" text="Change the filter or the search." /> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr><th className="th">Tender</th><th className="th">Source</th><th className="th">Relevance</th><th className="th">Fit</th><th className="th">Deadline</th><th className="th">Status</th><th className="th w-20"><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {list.map(t => {
                  const a = analysisFor(t.id), d = daysLeft(t.deadline), closed = ['nobid', 'filtered'].includes(t.status)
                  const deck = decks.get(studioId(t.id)), deckUrl = deck?.status === 'done' ? deckPath(deck, t.id) : null
                  return (
                    <tr key={t.id} className="cursor-pointer hover:bg-canvas/60" onClick={() => nav(`/tenders/${t.id}`)}>
                      <td className="td max-w-[340px]">
                        <div className="flex items-center gap-2"><span className="truncate font-medium">{t.title}</span>{t.data_mode === 'demo' && <Badge tone="warn">Demo data</Badge>}</div>
                        <div className="truncate text-[12px] text-ink-muted">{t.id} · {t.client}</div>
                      </td>
                      <td className="td whitespace-nowrap text-[13px] text-ink-muted">{t.source.replace(" (sample)", "").replace(" (team contract example)", "")}</td>
                      <td className="td"><div className="flex items-center gap-2"><div className="h-1.5 w-16 overflow-hidden rounded-full bg-canvas"><div className="h-full rounded-full bg-primary" style={{ width: `${t.relevance}%` }} /></div><span className="text-[12px] font-medium">{t.relevance}%</span></div></td>
                      <td className="td"><ScoreRing value={a?.fit_score.overall ?? null} size={40} /></td>
                      <td className="td whitespace-nowrap"><div className={d == null || d < 0 || closed ? 'text-ink-faint' : 'font-medium'}>{deadlineLabel(d)}</div>{d != null && <div className="text-[12px] text-ink-muted">{fmtDate(t.deadline)}</div>}</td>
                      <td className="td"><div className="flex flex-wrap items-center gap-1.5"><Badge tone={statusTone(t.status)}>{STATUS_LABEL[t.status]}</Badge><DeckBadge status={deck?.status} /></div></td>
                      <td className="td whitespace-nowrap text-right">
                        {deckUrl && <button className="btn-ghost btn-sm !px-2" aria-label={`Open the deck of tender ${t.id}`} title="Open deck"
                          onClick={e => { e.stopPropagation(); nav(deckUrl) }}><Presentation size={16} /></button>}
                        <button className="btn-ghost btn-sm !px-2 hover:!bg-bad-soft hover:!text-bad" aria-label={`Delete tender ${t.id}`} title="Delete tender"
                          onClick={e => { e.stopPropagation(); ask({ kind: 'one', tender: t }) }}><Trash2 size={16} /></button>
                        <ArrowRight size={16} className="ml-1 inline text-ink-faint" />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <ConfirmDialog open={!!removal} busy={removing} error={removeError} onConfirm={remove} onCancel={closeDialog}
        title={removal?.kind === 'all' ? 'Clear all tenders?' : 'Delete this tender?'}
        confirmLabel={removal?.kind === 'all' ? 'Clear tenders' : 'Delete tender'}
        text={removal?.kind === 'one'
          ? <><b className="font-medium text-ink">{removal.tender.title}</b> ({removal.tender.id}) and its analysis are deleted from the RAG service. The knowledge base and the proposal studio's copy are not changed.</>
          : <>Every tender stored by the RAG service{currentTenders.length ? ` (${currentTenders.length})` : ''} and its analysis is deleted. The knowledge base and the proposal studio are not changed. n8n adds a tender again the next time it sends it.</>} />

      <SidePanel open={newOpen} onClose={() => setParams({})} title="New analysis" subtitle={<span className="text-[13px] text-ink-muted">One requirement per line.</span>}>
        <NewAnalysisForm onComplete={() => setParams({})} />
      </SidePanel>
    </div>
  )
}

function NewAnalysisForm({ onComplete }: { onComplete: () => void }) {
  const nav = useNavigate()
  const [form, setForm] = useState({ title: '', client: '', sector: '', technical: '', team: '', experience: '', mode: 'company' as 'company' | 'demo' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [sent, setSent] = useState(false)
  const field = (key: 'technical' | 'team' | 'experience', label: string, rows: number, ph: string) => (
    <label className="block"><span className="mb-1.5 block text-[13px] font-medium">{label}</span>
      <textarea rows={rows} className="input h-auto py-2" placeholder={ph} value={form[key]}
        onChange={e => setForm({ ...form, [key]: e.target.value })} /></label>
  )
  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setError(''); setSent(false)
    // The title, source and date are stored with the analysis, so the tender keeps them after a reload.
    const input: TenderInput = {
      tender_id: `LIVE-${Date.now()}`, title: form.title.trim(), client: form.client, sector: form.sector,
      source: MANUAL_SOURCE, published: new Date().toISOString().slice(0, 10), data_mode: form.mode,
      requirements: {
        technical: form.technical.split('\n').map(x => x.trim()).filter(Boolean),
        team: form.team.split('\n').map(x => x.trim()).filter(Boolean),
        experience: form.experience.split('\n').map(x => x.trim()).filter(Boolean),
        client: form.client, sector: form.sector,
      },
    }
    if (!form.title.trim() || !Object.values(input.requirements).some(value => Array.isArray(value) && value.length)) {
      setError('Enter a tender title and at least one requirement.')
      setBusy(false)
      return
    }
    try {
      const analysis = await analyzeTender(input)
      const id = input.tender_id!
      // Same record as the RAG service stored; no deadline is invented (the form has none).
      rememberTender({ ...input, tender_id: id, rag_analysis: analysis })
      onComplete()  // closes the panel (a navigation to /tenders): it must come before opening the tender
      nav(`/tenders/${id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Analysis failed.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <form className="space-y-4" onSubmit={submit}>
      <label className="block"><span className="mb-1.5 block text-[13px] font-medium">Tender title</span><input className="input" placeholder="e.g. Plateforme CRM omnicanal" required value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} /></label>
      <div className="grid grid-cols-2 gap-3">
        <label className="block"><span className="mb-1.5 block text-[13px] font-medium">Client</span><input className="input" value={form.client} onChange={e => setForm({ ...form, client: e.target.value })} /></label>
        <label className="block"><span className="mb-1.5 block text-[13px] font-medium">Sector</span><input className="input" placeholder="e.g. retail" value={form.sector} onChange={e => setForm({ ...form, sector: e.target.value })} /></label>
      </div>
      {field('technical', 'Technical', 4, 'e.g. Power BI dashboards')}
      {field('team', 'Team', 3, 'e.g. 2 data engineers')}
      {field('experience', 'Experience', 2, 'e.g. 2 projects in retail')}
      <label className="block"><span className="mb-1.5 block text-[13px] font-medium">Data mode</span><select className="input" value={form.mode} onChange={e => setForm({ ...form, mode: e.target.value as 'company' | 'demo' })}><option value="company">Company CVs and records</option><option value="demo">Demo records</option></select></label>
      <button className="btn-primary w-full" disabled={busy}>{busy ? 'Analysing…' : 'Analyse with RAG'}</button>
      {error && <p className="rounded-ctl bg-bad-soft px-3 py-2 text-[13px] text-bad">{error}</p>}
      {sent && <p className="rounded-ctl bg-primary-soft px-3 py-2 text-[13px] text-primary">Analysis complete.</p>}
      <a href="https://domainetat.tn/?cat=9" target="_blank" rel="noreferrer" className="flex items-center gap-1.5 text-[13px] font-medium text-primary">Browse source portal <ExternalLink size={14} /></a>
    </form>
  )
}
