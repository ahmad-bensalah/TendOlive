import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import {
  AlertTriangle, ArrowLeft, Award, Banknote, Building2, CalendarDays, CheckCircle2, Download, ExternalLink, FileDown, Globe2, Handshake,
  History, Info, Landmark, Lightbulb, Link2, ListChecks, Loader2, Mail, MapPin, Phone, Plus, Presentation, Quote, Scale, ShieldAlert,
  ShieldCheck, Sparkles, Swords, Target, Trophy, Users,
} from 'lucide-react'
import {
  Avatar, Badge, Bar, Card, CardHeader, Chips, ConfirmDialog, cx, DeckBadge, Donut, Empty, ErrorNote, fitTone, Loading, SidePanel, statusTone, Tabs, Tip,
} from '../components/ui'
import {
  analysisFor, daysLeft, deadlineLabel, draftProposal, fmtDate, ORIGIN_LABEL, personRole, rememberTender, STATUS_LABEL, tenderById,
  type Analysis, type Match, type Status, type Tender,
} from '../lib/data'
import { ApiError, errorText, tender as fetchTender, type LoadState } from '../lib/api'
import {
  deckPath, isActive, projectTypeFor, run, runs, startDeck, STEPS, STUDIO, studioId, studioTender, studioTenders, templates,
  type BuyerProfile, type Comparable, type DeckParams, type Run, type RunStep, type StudioInput, type Template,
} from '../lib/studio'

type TabId = 'overview' | 'requirements' | 'team' | 'gaps' | 'prospect' | 'market' | 'proposal'
const FIT = [['technical_fit', 'Technical'], ['team_fit', 'Team'], ['experience_fit', 'Experience'], ['domain_fit', 'Domain'], ['certification_fit', 'Certification']] as const

export default function TenderWorkspace() {
  const { id = '' } = useParams()
  const [remote, setRemote] = useState<{ tender: Tender; analysis?: Analysis } | null>(null)
  // A tender saved in this browser opens at once; any other one is asked from the RAG service first.
  const [state, setState] = useState<LoadState>(() => tenderById(id) ? 'ready' : 'loading')
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (tenderById(id)) { setState('ready'); return }
    setState('loading')
    fetchTender(id).then(item => {
      if (item) setRemote({ tender: rememberTender(item), analysis: item.rag_analysis })
      setState('ready')
    }).catch(err => { setError(errorText(err)); setState('error') })
  }, [id, attempt])
  const t = tenderById(id) || remote?.tender
  const a = analysisFor(id) || remote?.analysis
  // ?tab=proposal: back from the templates page, opened from this tab
  const [params] = useSearchParams()
  const [tab, setTab] = useState<TabId>(() => params.get('tab') === 'proposal' ? 'proposal' : 'overview')
  const studio = useStudio(id)
  const deck = studio.view.state === 'ready' ? studio.view.run : null
  if (!t) {
    if (state === 'loading') return <Loading text="Loading the tender…" />
    if (state === 'error') return <div className="space-y-4"><ErrorNote message={`Could not load this tender from the RAG service: ${error}`} onRetry={() => setAttempt(n => n + 1)} /><Link className="btn-secondary" to="/tenders">Back to tenders</Link></div>
    return <Empty icon={ListChecks} title="Tender not found" text="It may have been deleted from the tender inbox." action={<Link className="btn-secondary" to="/tenders">Back to tenders</Link>} />
  }
  const d = daysLeft(t.deadline)

  return (
    <div className="space-y-5">
      <Link to="/tenders" className="inline-flex items-center gap-1.5 text-sm text-ink-muted hover:text-ink"><ArrowLeft size={16} />Tenders <span className="text-ink-faint">/</span> <span className="font-medium text-primary">{t.id}</span></Link>

      <Card className="p-6">
        <div className="flex flex-wrap items-start justify-between gap-5">
          <div className="flex min-w-0 gap-4">
            <span className="grid h-14 w-14 shrink-0 place-items-center rounded-card bg-primary-soft text-primary"><Building2 size={26} /></span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2"><h1 className="text-[22px] font-semibold leading-tight tracking-tight">{t.title}</h1><Badge tone={statusTone(t.status)}>{STATUS_LABEL[t.status]}</Badge></div>
              <p className="mt-1 text-sm text-ink-muted">{t.client}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <DeckBadge status={deck?.status} />
            {a && <button className="btn-secondary" onClick={() => download(t, a)}><Download size={16} />Export</button>}
            {a && <button className="btn-primary" onClick={() => setTab('proposal')}><Presentation size={16} />Proposal</button>}
          </div>
        </div>
        <dl className="mt-6 grid grid-cols-2 gap-5 border-t border-line pt-5 text-sm md:grid-cols-5">
          <Fact icon={CalendarDays} label="Deadline" value={<span>{d == null ? deadlineLabel(d) : `${fmtDate(t.deadline)} · ${deadlineLabel(d).toLowerCase()}`}</span>} />
          <Fact icon={Target} label="Sector" value={t.sector} />
          <Fact icon={Banknote} label="Budget" value={t.budget} />
          <Fact icon={Globe2} label="Source" value={<a className="inline-flex items-center gap-1 text-primary" href={t.source_url} target="_blank" rel="noreferrer">{t.source}<ExternalLink size={12} /></a>} />
          <Fact icon={Sparkles} label="Relevance" value={`${t.relevance}%`} />
        </dl>
      </Card>

      {!a ? (
        <Card><Empty icon={ShieldAlert} title="Not analysed" text={t.summary} /></Card>
      ) : (
        <>
          <Tabs<TabId> value={tab} onChange={setTab} tabs={[
            { id: 'overview', label: 'Overview' }, { id: 'requirements', label: 'Requirements', count: a.requirements_matrix.length },
            { id: 'team', label: 'Team', count: a.team_proposal?.size }, { id: 'gaps', label: 'Gaps', count: a.knowledge_gaps.length },
            { id: 'prospect', label: 'Prospect' }, { id: 'market', label: 'Market' }, { id: 'proposal', label: 'Proposal' }]} />
          {tab === 'overview' && <Overview t={t} a={a} go={setTab} />}
          {tab === 'requirements' && <Requirements a={a} />}
          {tab === 'team' && <TeamTab a={a} />}
          {tab === 'gaps' && <Gaps a={a} />}
          {tab === 'prospect' && <ProspectTab t={t} studio={studio} />}
          {tab === 'market' && <MarketTab t={t} studio={studio} />}
          {tab === 'proposal' && <ProposalTab t={t} a={a} studio={studio} />}
        </>
      )}
    </div>
  )
}

function download(t: Tender, a: Analysis) {
  const url = URL.createObjectURL(new Blob([JSON.stringify({ tender: t, ...a }, null, 2)], { type: 'application/json' }))
  Object.assign(document.createElement('a'), { href: url, download: `rag-${t.id}.json` }).click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function Fact({ icon: Icon, label, value }: { icon: typeof Target; label: string; value: React.ReactNode }) {
  return <div className="min-w-0"><dt className="flex items-center gap-1.5 text-[12px] text-ink-muted"><Icon size={14} />{label}</dt><dd className="mt-1 truncate font-medium">{value}</dd></div>
}

// ---------------------------------------------------------------- overview
function Overview({ a, go }: { t: Tender; a: Analysis; go: (t: TabId) => void }) {
  const rows = a.requirements_matrix
  const c = (s: Status) => rows.filter(r => r.status === s).length
  const overall = a.fit_score.overall
  const blocking = a.knowledge_gaps.filter(g => g.mandatory)
  return (
    <div className="grid gap-5 lg:grid-cols-3">
      <Card className="p-5">
        <CardHeader icon={Target} title="Fit score" hint="Recorded coverage of the requirements by OliveSoft knowledge. It is not a probability of winning." />
        <div className="flex items-center gap-6">
          <Donut size={136} stroke={18} segments={[{ value: c('covered'), color: '#2557F2' }, { value: c('partial'), color: '#9DB5FA' }, { value: c('missing'), color: '#DC2626' }]}
            center={<div><div className="text-[28px] font-semibold leading-none">{overall ?? '–'}<span className="text-base">%</span></div><div className="mt-1 text-[11px] text-ink-muted">overall</div></div>} />
          <ul className="space-y-2.5 text-[13px]">
            {([['covered', 'bg-primary', 'Covered'], ['partial', 'bg-[#9DB5FA]', 'Partial'], ['missing', 'bg-bad', 'Missing']] as const).map(([k, color, label]) =>
              <li key={k} className="flex items-center gap-2"><span className={`h-2.5 w-2.5 rounded-full ${color}`} />{label}<b className="ml-auto pl-4">{c(k)}</b></li>)}
          </ul>
        </div>
      </Card>

      <Card className="p-5">
        <CardHeader icon={ListChecks} title="By category" />
        <div className="space-y-3.5">
          {FIT.map(([k, label]) => {
            const v = a.fit_score[k]
            return <div key={k}><div className="mb-1.5 flex justify-between text-[13px]"><span>{label}</span><b className={v == null ? 'font-normal text-ink-faint' : ''}>{v == null ? 'n/a' : `${v}%`}</b></div><Bar value={v} tone={fitTone(v)} /></div>
          })}
        </div>
      </Card>

      <Card className="p-5">
        <CardHeader icon={AlertTriangle} title="Blocking gaps" tone={blocking.length ? 'bad' : 'primary'} action={<button className="text-sm font-semibold text-primary" onClick={() => go('gaps')}>All gaps</button>} />
        {blocking.length === 0 ? <p className="flex items-center gap-2 text-sm text-primary"><CheckCircle2 size={18} />No mandatory gap.</p> : (
          <ul className="space-y-2.5">{blocking.slice(0, 4).map((g, i) => <li key={i} className="rounded-ctl bg-bad-soft/60 px-3 py-2.5 text-[13px]"><div className="font-medium">{g.requirement}</div><div className="text-ink-muted">{g.gap}</div></li>)}</ul>
        )}
      </Card>

      <Card className="p-5 lg:col-span-2">
        <CardHeader icon={Users} title="Proposed team" action={<button className="text-sm font-semibold text-primary" onClick={() => go('team')}>Details</button>} />
        {a.team_proposal?.members.length ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {a.team_proposal.members.map(m => (
              <div key={m.doc_id} className="flex items-center gap-3 rounded-ctl border border-line p-3">
                <Avatar name={m.name} /><div className="min-w-0"><div className="truncate font-medium">{m.name}</div><div className="truncate text-[12px] text-ink-muted">{m.assigned_to.join(' · ')}</div></div>
              </div>
            ))}
          </div>
        ) : <p className="text-sm text-ink-muted">No team requirement, or no CV qualifies.</p>}
      </Card>

      <Card className="p-5">
        <CardHeader icon={Award} title="Strongest evidence" />
        <ul className="space-y-2.5">
          {a.matches.slice(0, 4).map(m => (
            <li key={m.doc_id} className="flex items-start gap-2.5 text-[13px]"><CheckCircle2 size={16} className="mt-0.5 shrink-0 text-primary" /><div className="min-w-0"><div className="truncate font-medium">{m.title}</div><div className="text-ink-muted">{ORIGIN_LABEL[m.origin] ?? m.origin}</div></div></li>
          ))}
        </ul>
      </Card>
    </div>
  )
}

// ---------------------------------------------------------------- requirements
function Requirements({ a }: { a: Analysis }) {
  const [filter, setFilter] = useState<'all' | Status>('all')
  const [open, setOpen] = useState<number | null>(null)
  const rows = a.requirements_matrix.map((r, i) => ({ r, i })).filter(({ r }) => filter === 'all' || r.status === filter)
  const c = (s: Status) => a.requirements_matrix.filter(r => r.status === s).length
  const sel = open != null ? a.requirements_matrix[open] : null, selM = open != null ? a.requirement_matches[open] : null
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3 p-4">
        <Chips value={filter} onChange={setFilter} items={[{ id: 'all', label: 'All', count: a.requirements_matrix.length }, { id: 'missing', label: 'Missing', count: c('missing') }, { id: 'partial', label: 'Partial', count: c('partial') }, { id: 'covered', label: 'Covered', count: c('covered') }]} />
        <span className="flex items-center gap-1.5 text-[12px] text-ink-muted">Click a row to see its evidence</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr><th className="th">Requirement</th><th className="th">Category</th><th className="th"><span className="inline-flex items-center gap-1">Coverage <Tip text="Covered: enough qualifying evidence. Partial: some or weak evidence. Missing: nothing qualifies." /></span></th><th className="th">Found / needed</th><th className="th"><span className="inline-flex items-center gap-1">Basis <Tip text="CV evidence is quoted from a CV. A company record is a declaration, not a document quote." /></span></th></tr></thead>
          <tbody>
            {rows.map(({ r, i }) => (
              <tr key={i} onClick={() => setOpen(i)} className={`cursor-pointer ${open === i ? 'bg-primary-soft/60' : 'hover:bg-canvas/60'}`}>
                <td className="td"><div className="font-medium">{r.requirement}</div>{!r.mandatory && <div className="text-[12px] text-ink-muted">Optional</div>}</td>
                <td className="td capitalize text-ink-muted">{r.category}</td>
                <td className="td"><Badge tone={statusTone(r.status)}>{r.status}</Badge></td>
                <td className="td"><div className="flex items-center gap-2"><Bar value={Math.min(100, (r.found / r.needed) * 100)} tone={r.status === 'missing' ? 'bad' : 'primary'} className="w-16" /><span className="text-[12px]">{r.found}/{r.needed}</span></div></td>
                <td className="td"><Badge tone={r.origin === 'cv_document' ? 'info' : 'neutral'}>{r.origin ? ORIGIN_LABEL[r.origin] : 'None'}</Badge></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <SidePanel open={!!sel} onClose={() => setOpen(null)} title={sel?.requirement}
        subtitle={sel && <div className="flex flex-wrap items-center gap-2"><Badge tone={statusTone(sel.status)}>{sel.status}</Badge><Badge>{sel.found} of {sel.needed}</Badge><span className="text-[12px] capitalize text-ink-muted">{sel.category}</span></div>}>
        {selM?.matches.map(m => <EvidenceCard key={m.doc_id} m={m} />)}
        {selM?.closest && <div className="rounded-ctl border border-line bg-canvas px-4 py-3 text-[13px]"><div className="font-semibold">Closest, not qualifying</div><div className="mt-0.5">{selM.closest.title}</div></div>}
        {selM && !selM.matches.length && !selM.closest && <Empty icon={ShieldAlert} title="No evidence" text="Nothing in the knowledge base qualifies." />}
      </SidePanel>
    </Card>
  )
}

function EvidenceCard({ m }: { m: Match }) {
  const e = m.evidence
  return (
    <div className="rounded-card border border-line p-4">
      <div className="flex items-start justify-between gap-2"><div className="font-semibold leading-snug">{m.title}</div><Badge tone={m.origin === 'cv_document' ? 'info' : 'neutral'}>{ORIGIN_LABEL[m.origin] ?? m.origin}</Badge></div>
      {m.matched_on?.length ? <div className="mt-2 flex flex-wrap gap-1.5">{m.matched_on.map(x => <Badge key={x}>{x}</Badge>)}</div> : null}
      {e?.quote ? (
        <blockquote className="mt-3 rounded-ctl border-l-[3px] border-primary bg-primary-soft/50 px-3 py-2.5 text-[13px]"><Quote size={14} className="mb-1 text-primary" />{e.quote}<div className="mt-1.5 text-[11px] text-ink-muted">{m.doc_id}{e.line ? ` · line ${e.line}` : ''}</div></blockquote>
      ) : e?.statement ? (
        <div className="mt-3 rounded-ctl border-l-[3px] border-line bg-canvas px-3 py-2.5 text-[13px]">
          <p>{m.summary}</p>
          <details className="mt-2"><summary className="cursor-pointer text-[12px] font-medium text-primary">Full record</summary>
            <div className="mt-2 whitespace-pre-line text-[12px] text-ink-muted">{e.statement}</div></details>
        </div>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------- team
function TeamTab({ a }: { a: Analysis }) {
  const t = a.team_proposal
  if (!t) return <Card><Empty icon={Users} title="No team requirements" /></Card>
  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-3">
        <Card className="p-5"><div className="text-sm text-ink-muted">Team size</div><div className="mt-2 text-[28px] font-semibold">{t.size}</div></Card>
        <Card className="p-5"><div className="text-sm text-ink-muted">Places filled</div><div className="mt-2 text-[28px] font-semibold">{t.places_filled}<span className="text-lg text-ink-muted">/{t.places_needed}</span></div><Bar className="mt-3" value={(t.places_filled / (t.places_needed || 1)) * 100} /></Card>
        <Card className="p-5"><div className="flex items-center gap-1.5 text-sm text-ink-muted">Method <Tip text={t.notes.join(' ')} /></div><div className="mt-2 text-lg font-semibold">{t.method === 'exact minimum' ? 'Smallest possible team' : 'Best effort'}</div></Card>
      </div>
      {t.unfilled.map(u => <div key={u.requirement} className="flex items-center gap-3 rounded-card border border-bad/20 bg-bad-soft px-4 py-3 text-sm"><AlertTriangle size={18} className="text-bad" /><span><b>Cannot fill:</b> {u.requirement} — {u.available} of {u.needed} available in the CV bank</span></div>)}
      <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
        {t.members.map(m => (
          <Card key={m.doc_id} className="p-5">
            <div className="flex items-center gap-3"><Avatar name={m.name} size={44} /><div className="min-w-0"><div className="truncate font-semibold">{m.name}</div><div className="truncate text-[13px] text-ink-muted">{personRole(m.title)}</div></div>
              <Badge tone="info" className="ml-auto capitalize">{m.seniority}{m.years != null ? ` · ${m.years}y` : ''}</Badge></div>
            <div className="mt-4 text-[12px] font-medium uppercase tracking-wide text-ink-muted">Fills</div>
            <ul className="mt-1.5 space-y-1">{m.assigned_to.map(x => <li key={x} className="flex gap-2 text-[13px]"><CheckCircle2 size={15} className="mt-0.5 shrink-0 text-primary" />{x}</li>)}</ul>
            {m.certifications.length > 0 && <div className="mt-3 flex flex-wrap gap-1.5">{m.certifications.slice(0, 4).map(c => <Badge key={c} tone="neutral">{c}</Badge>)}</div>}
            {m.company_projects.length > 0 && <div className="mt-4 border-t border-line pt-3"><div className="text-[12px] font-medium uppercase tracking-wide text-ink-muted">Company projects</div>
              <ul className="mt-1.5 space-y-1 text-[13px]">{m.company_projects.slice(0, 3).map(p => <li key={p.doc_id} className="truncate">{p.matches_tender && <Badge tone="info" className="mr-1.5">match</Badge>}{p.title}</li>)}</ul></div>}
          </Card>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- gaps
function Gaps({ a }: { a: Analysis }) {
  const c = a.knowledge_counts
  if (!a.knowledge_gaps.length) return <Card><Empty icon={CheckCircle2} title="No knowledge gaps" text="Every requirement is backed by recorded knowledge." /></Card>
  return (
    <div className="space-y-4">
      <p className="text-sm text-ink-muted">Indexed: {c.cv} CVs · {c.completed_projects}/{c.past_project} projects completed · {c.tech_stack} stacks · {c.tool} tools · {c.client_portfolio} clients</p>
      <div className="grid gap-4 md:grid-cols-2">
        {a.knowledge_gaps.map((g, i) => (
          <Card key={i} className="p-5">
            <div className="flex flex-wrap items-center gap-2"><Badge tone="bad" className="capitalize">{g.kind}</Badge>{g.mandatory ? <Badge tone="dark">Mandatory</Badge> : <Badge>Optional</Badge>}<span className="text-[12px] capitalize text-ink-muted">{g.category}</span></div>
            <h3 className="mt-3 font-semibold">{g.requirement}</h3>
            <p className="mt-1 text-sm text-ink-muted">{g.gap}</p>
            <div className="mt-4 flex gap-2.5 rounded-ctl bg-primary-soft/60 p-3 text-[13px]"><Lightbulb size={16} className="mt-0.5 shrink-0 text-primary" /><span>{g.suggestion}</span></div>
            <Link to="/knowledge" className="btn-secondary btn-sm mt-4"><Plus size={14} />Add knowledge</Link>
          </Card>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- prospect and market: n8n's research, from the studio's copy
/** The Prospect and Market tabs read n8n's buyer research and market study in the copy of the tender that n8n sent to the
 * proposal studio (the RAG service does not keep them). */
function StudioCopy({ t, studio, what, children }: { t: Tender; studio: Studio; what: string; children: (input: StudioInput) => React.ReactNode }) {
  const { view, retry } = studio
  if (view.state === 'loading') return <Card><Loading text="Reading n8n's research from the proposal studio…" /></Card>
  if (view.state === 'down') return <ErrorNote message={`Could not read the ${what} from the proposal studio: ${view.error}`} onRetry={retry} />
  if (view.state === 'missing') {
    return <Card><Empty icon={Info} title={`No ${what}`} text={t.id.startsWith('LIVE-')
      ? 'A manual analysis does not go through n8n, so it has no research.'
      : 'n8n researches the buyer and the market of the fit, open tenders it sends to the proposal studio (top 10). This tender is not in the studio.'} /></Card>
  }
  return <>{children(view.input)}</>
}

type Tone = 'good' | 'warn' | 'bad' | 'neutral'
/** Why a buyer has no research, from n8n's research_status. */
const RESEARCH: Record<string, { label: string; tone: Tone; why: string }> = {
  research_failed: { label: 'Research failed', tone: 'bad', why: 'The research agent stopped on an error (a tool or the AI model): nothing below comes from it.' },
  research_invalid: { label: 'Research unusable', tone: 'bad', why: 'The research agent gave no usable answer: nothing below comes from it.' },
  skipped_demo: { label: 'Demo buyer · not researched', tone: 'neutral', why: 'No research for this buyer: demo record. n8n does not research the fictional buyers of the demo feed.' },
  skipped_no_buyer_name: { label: 'Not researched', tone: 'neutral', why: 'Not researched: the notice gives no buyer name.' },
  not_researched_budget: { label: 'Not researched', tone: 'neutral', why: 'Not researched: each n8n run researches a few buyers only (MAX_BUYERS), the best-ranked first.' },
  missing: { label: 'Not researched', tone: 'neutral', why: 'Not researched: n8n has no research row for this buyer.' },
}
/** How much a researched buyer's research found (enrichment_status: the sources with facts, out of registry, BOAMP history,
 * DECP awards, official site and Wikidata). */
const ENRICHED: Record<string, { label: string; tone: Tone }> = {
  enriched: { label: 'Researched', tone: 'good' }, partial: { label: 'Researched · one source', tone: 'warn' }, none: { label: 'Researched · nothing found', tone: 'warn' },
}
const SIZE: Record<string, string> = { small: 'Small', medium: 'Medium', large: 'Large' }
const host = (url: string) => { try { return new URL(url).host.replace(/^www\./, '') } catch { return url } }
const httpUrl = (url: string | null | undefined) => (url && /^https?:\/\//i.test(url) ? url : null)
const money = (n: number | null | undefined, currency?: string | null) => n == null ? null : `${Math.round(n).toLocaleString('en-GB')} ${currency || ''}`.trim()

/** Where the research's facts come from, as links: the buyer's site, and the public sources named in its fields. */
function buyerSources(bp: BuyerProfile) {
  const out: { label: string; href: string }[] = []
  const site = httpUrl(bp.website)
  if (site) out.push({ label: `Official website (${host(site)})`, href: site })
  const facts = `${bp.staff ?? ''} ${bp.estimated_revenue ?? ''}`
  if (bp.legal_name || /registry/i.test(facts)) {
    out.push({ label: 'French company registry (Annuaire des entreprises)', href: `https://annuaire-entreprises.data.gouv.fr/rechercher?terme=${encodeURIComponent(bp.legal_name || bp.name || '')}` })
  }
  if (/wikidata/i.test(facts)) out.push({ label: 'Wikidata', href: `https://www.wikidata.org/w/index.php?search=${encodeURIComponent(bp.legal_name || bp.name || '')}` })
  const named = new Set((bp.past_digital_projects ?? []).map(p => (p.source ?? '').toUpperCase()))
  if (named.has('BOAMP') || bp.past_winners?.length) out.push({ label: 'BOAMP: the buyer\'s past notices and award notices', href: 'https://www.boamp.fr' })
  if (named.has('DECP')) out.push({ label: 'DECP: contracts the buyer awarded (data.gouv.fr)', href: 'https://www.data.gouv.fr' })
  return out
}

function ProspectTab({ t, studio }: { t: Tender; studio: Studio }) {
  return <StudioCopy t={t} studio={studio} what="buyer research">{input => {
    const bp = input.buyer_profile ?? {}
    const status = bp.research_status ?? 'missing'
    const researched = status === 'researched'
    const missing = researched ? null : RESEARCH[status] ?? { label: 'Not researched', tone: 'neutral' as Tone, why: `Not researched (${status}).` }
    const badge = missing ?? ENRICHED[bp.enrichment_status ?? ''] ?? { label: 'Researched', tone: 'good' as Tone }
    // A researched buyer shows every field, "Not found" included; another buyer only what its notice gave.
    const fields = ([['Legal name', bp.legal_name], ['Sector', bp.sector], ['Size', bp.size ? SIZE[bp.size] ?? bp.size : null], ['Staff', bp.staff],
      ['Estimated revenue', bp.estimated_revenue]] as const).filter(([, v]) => researched || v)
    const site = httpUrl(bp.website)
    const contacts = bp.contacts ?? {}
    const hasContacts = !!(contacts.emails?.length || contacts.phones?.length || contacts.addresses?.length)
    const projects = bp.past_digital_projects ?? [], winners = bp.past_winners ?? [], partners = bp.key_partners ?? []
    const domain = bp.domain_requirements ?? []
    const sources = buyerSources(bp)
    const list = (items: string[]) => <ul className="space-y-2">{items.map(x => <li key={x} className="rounded-ctl bg-canvas px-3 py-2 text-[13px]">{x}</li>)}</ul>
    const side = (
      <div className="space-y-5">
        <Card className="p-5">
          <CardHeader icon={Mail} title="Contacts" hint={researched ? 'Found by the research, or written in the notice.' : 'Written in the notice.'} />
          {hasContacts ? (
            <ul className="space-y-1.5 text-[13px]">
              {contacts.emails?.map(x => <li key={x} className="flex items-center gap-2 break-all"><Mail size={14} className="shrink-0 text-ink-muted" /><a className="text-primary" href={`mailto:${x}`}>{x}</a></li>)}
              {contacts.phones?.map(x => <li key={x} className="flex items-center gap-2"><Phone size={14} className="shrink-0 text-ink-muted" />{x}</li>)}
              {contacts.addresses?.map(x => <li key={x} className="flex items-start gap-2"><MapPin size={14} className="mt-0.5 shrink-0 text-ink-muted" />{x}</li>)}
            </ul>
          ) : <p className="text-sm text-ink-muted">None found.</p>}
        </Card>
        <Card className="p-5">
          <CardHeader icon={ShieldCheck} title="Domain requirements" hint="The tender's requirements about hosting, security, accessibility, data protection, certifications or cloud." />
          {domain.length ? <div className="flex flex-wrap gap-1.5">{domain.map(x => <Badge key={x}>{x}</Badge>)}</div> : <p className="text-sm text-ink-muted">None in the tender's requirements.</p>}
        </Card>
        {sources.length > 0 && <Card className="p-5">
          <CardHeader icon={Link2} title="Sources" />
          <ul className="space-y-1.5 text-[13px]">{sources.map(s => <li key={s.href + s.label}><a className="inline-flex items-start gap-1 text-primary hover:underline" href={s.href} target="_blank" rel="noreferrer">{s.label}<ExternalLink size={12} className="mt-1 shrink-0" /></a></li>)}</ul>
        </Card>}
      </div>
    )
    return (
      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Card className="p-5">
            <CardHeader icon={Building2} title={bp.name || input.tender?.issuer || t.client} action={<Badge tone={badge.tone}>{badge.label}</Badge>} />
            {missing && <p className="mb-4 flex gap-2 rounded-ctl bg-canvas px-3 py-2.5 text-[13px] text-ink-muted"><Info size={16} className="mt-0.5 shrink-0" />{missing.why}</p>}
            {researched && bp.enrichment_status === 'none' && <p className="mb-4 flex gap-2 rounded-ctl bg-warn-soft px-3 py-2.5 text-[13px] text-warn"><AlertTriangle size={16} className="mt-0.5 shrink-0" />The research ran but found no checked fact about this buyer.</p>}
            {(fields.length > 0 || site || researched) && (
              <dl className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
                {fields.map(([label, value]) => <div key={label} className="min-w-0"><dt className="text-[12px] text-ink-muted">{label}</dt><dd className={cx('mt-1', value ? 'font-medium' : 'text-ink-faint')}>{value || 'Not found'}</dd></div>)}
                {(site || researched) && <div className="min-w-0"><dt className="text-[12px] text-ink-muted">Website</dt><dd className="mt-1 truncate">{site
                  ? <a className="inline-flex items-center gap-1 font-medium text-primary" href={site} target="_blank" rel="noreferrer">{host(site)}<ExternalLink size={12} /></a>
                  : <span className="text-ink-faint">Not found</span>}</dd></div>}
              </dl>
            )}
            {bp.organization_description && <div className="mt-5"><div className="flex items-center gap-1 text-[12px] text-ink-muted">Summary
              <Tip text="Written by the research agent. n8n removed its sentences with a number not found in the tool results, and those about the website." /></div>
              <p className="mt-1 text-sm">{bp.organization_description}</p></div>}
            {!researched && <p className="mt-4 text-[13px] text-ink-muted">Without research, these are missing: legal name, sector, size, staff, estimated revenue,
              {site ? '' : ' website,'} past digital projects, past winners and key partners.</p>}
          </Card>
          {researched && <>
            <Card className="p-5">
              <CardHeader icon={History} title="Past digital projects" hint="The buyer's past notices (BOAMP) and awarded contracts (DECP) about software, web, data or IT." />
              {projects.length ? (
                <ul className="space-y-2">{projects.map((p, i) => (
                  <li key={i} className="flex items-start justify-between gap-3 rounded-ctl bg-canvas px-3 py-2.5 text-[13px]">
                    <span className="min-w-0">{p.title}{p.date && <span className="mt-0.5 block text-[12px] text-ink-muted">{fmtDate(p.date)}</span>}</span>
                    {p.source && <Badge>{p.source}</Badge>}</li>))}</ul>
              ) : <p className="text-sm text-ink-muted">None found among the buyer's past notices and contracts.</p>}
            </Card>
            <div className="grid gap-5 md:grid-cols-2">
              <Card className="p-5">
                <CardHeader icon={Trophy} title="Past winners" hint="Who won this buyer's past contracts (BOAMP award notices)." />
                {winners.length ? <ul className="space-y-2">{winners.map(w => <li key={w.name} className="flex items-center justify-between gap-2 rounded-ctl bg-canvas px-3 py-2 text-[13px]"><span className="min-w-0 truncate">{w.name}</span>{w.wins != null && <Badge>{w.wins} win{w.wins === 1 ? '' : 's'}</Badge>}</li>)}</ul>
                  : <p className="text-sm text-ink-muted">No award notice found.</p>}
              </Card>
              <Card className="p-5">
                <CardHeader icon={Handshake} title="Key partners" />
                {partners.length ? list(partners) : <p className="text-sm text-ink-muted">None recorded by the research.</p>}
              </Card>
            </div>
          </>}
        </div>
        {side}
      </div>
    )
  }}</StudioCopy>
}

/** The market study's state, from n8n's competition.status (detail: its own status, for a failed study). */
const MARKET: Record<string, { label: string; tone: Tone; why?: string }> = {
  OK: { label: 'Studied', tone: 'good' },
  NO_COMPARABLE: { label: 'No comparable contract', tone: 'warn', why: 'Awarded contracts were found, but the market agent judged none of them comparable to this tender.' },
  NO_DATA: { label: 'No award data', tone: 'warn', why: 'No awarded contract was found in TED, DECP or TUNEPS for this market.' },
  NOT_STUDIED: { label: 'Not studied', tone: 'neutral', why: 'Not studied: each n8n run studies the market of a few fit tenders only (limits.maxMarketStudies), the best-ranked first.' },
}
const FAILED_WHY: Record<string, string> = {
  study_failed: 'The market agent stopped on an error (a tool or the AI model).',
  tools_failed: 'The award sources (TED, DECP, TUNEPS) did not answer.',
  answer_invalid: 'The market agent gave no usable answer.',
}
/** A comparable contract's public page, when its source has one per notice (TED ids are "T" + the publication number). */
const comparableUrl = (c: Comparable) => /^T\d+-\d{4}$/.test(c.id) && (c.source ?? '').toUpperCase() === 'TED' ? `https://ted.europa.eu/en/notice/-/detail/${c.id.slice(1)}` : null
const SOURCE_HOME: Record<string, string> = { TED: 'https://ted.europa.eu', DECP: 'https://www.data.gouv.fr', TUNEPS: 'https://www.tuneps.tn' }

function MarketTab({ t, studio }: { t: Tender; studio: Studio }) {
  const [all, setAll] = useState(false)
  return <StudioCopy t={t} studio={studio} what="market study">{input => {
    const c = input.competition ?? {}
    const status = c.status ?? 'NOT_STUDIED'
    const state = MARKET[status] ?? { label: 'Study failed', tone: 'bad' as Tone, why: FAILED_WHY[c.detail ?? ''] ?? `The market study did not complete (${c.detail || status}).` }
    const b = c.budget_estimate
    // n8n's adapter passes a budget estimate to the studio only when the study stands behind it; its notes say why it did not.
    const leftOut = (input.studio_adapter?.notes ?? []).map(n => /^budget estimate left out:\s*(.+)$/i.exec(n)?.[1]).find(Boolean)
    const dropped = !!input.studio_adapter?.dropped?.budget_estimate
    const budgetWhy = b ? '' : dropped || leftOut
      ? `n8n left its budget estimate out of the studio's copy${leftOut ? ` (${leftOut})` : ''}: it passes one on only from 3 or more priced comparable contracts, with a confidence above "very low".`
      : status === 'OK' ? 'The comparable contracts give no usable price (framework ceilings, outliers and other currencies are left out).'
      : 'No budget estimate without comparable contracts.'
    const competitors = c.competitors ?? [], comparables = c.comparables ?? []
    const shown = all ? comparables : comparables.slice(0, 8)
    const sources = [...new Set(comparables.map(x => (x.source ?? '').toUpperCase()).filter(s => SOURCE_HOME[s]))]
    const fact = (label: string, value: React.ReactNode, tip?: string) => (
      <div className="min-w-0"><dt className="flex items-center gap-1 text-[12px] text-ink-muted">{label}{tip && <Tip text={tip} />}</dt><dd className="mt-1 font-medium">{value}</dd></div>
    )
    return (
      <div className="space-y-5">
        <Card className="p-5">
          <CardHeader icon={Scale} title="Market study" hint="n8n's Competitor & Budget agent: it picks comparable awarded contracts (TED, DECP, TUNEPS); n8n computes every figure from them." action={<Badge tone={state.tone}>{state.label}</Badge>} />
          {state.why && <p className="mb-4 flex gap-2 rounded-ctl bg-canvas px-3 py-2.5 text-[13px] text-ink-muted"><Info size={16} className="mt-0.5 shrink-0" />{state.why}</p>}
          <dl className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
            {fact('Declared value', c.declared_value || <span className="font-normal text-ink-faint">Not in the notice</span>, 'The value the notice declares: the buyer\'s own figure.')}
            {fact('Budget estimate', b ? `${money(b.low, b.currency)} – ${money(b.high, b.currency)}` : <span className="font-normal text-ink-faint">None</span>,
              'The 25th to 75th percentile of the comparable contracts\' amounts.')}
            {fact('Median of comparables', b ? money(b.mid, b.currency) : <span className="font-normal text-ink-faint">None</span>)}
            {fact('Median offers received', c.median_bids ?? <span className="font-normal text-ink-faint">Unknown</span>, 'Offers per comparable contract: how strong the competition is.')}
          </dl>
          {b ? <p className="mt-3 text-[13px] text-ink-muted">Confidence <Badge tone={b.confidence === 'medium' ? 'good' : 'warn'}>{b.confidence ?? 'unknown'}</Badge>{b.basis ? ` · ${b.basis}` : ''}</p>
            : <p className="mt-3 text-[13px] text-ink-muted">{budgetWhy}</p>}
          {(c.positioning || c.budget_comment) && (
            <div className="mt-4 space-y-2 border-t border-line pt-4 text-sm">
              <div className="flex items-center gap-1 text-[12px] text-ink-muted">Positioning<Tip text="The agent's text. n8n removed its sentences with a figure or a name not found in the chosen contracts." /></div>
              {c.positioning && <p>{c.positioning}</p>}
              {c.budget_comment && <p className="text-ink-muted">{c.budget_comment}</p>}
            </div>
          )}
        </Card>

        <Card>
          <div className="p-5 pb-0"><CardHeader icon={Swords} title="Competitors" hint="Who won the comparable contracts, most wins first. Losses are known only where the source lists the other bidders (TUNEPS)." /></div>
          {competitors.length ? (
            <div className="overflow-x-auto"><table className="w-full text-sm">
              <thead><tr><th className="th">Company</th><th className="th">Wins</th><th className="th">Losses</th><th className="th">Average amount won</th><th className="th">Last win</th></tr></thead>
              <tbody>{competitors.map(x => <tr key={x.name}><td className="td font-medium">{x.name}</td><td className="td">{x.past_wins ?? '–'}</td>
                <td className="td">{x.past_losses ?? <span className="text-ink-faint">unknown</span>}</td><td className="td">{money(x.avg_amount, b?.currency ?? comparables[0]?.currency) ?? <span className="text-ink-faint">no price</span>}</td>
                <td className="td">{x.last_win ? fmtDate(x.last_win) : '–'}</td></tr>)}</tbody>
            </table></div>
          ) : <p className="px-5 pb-5 text-sm text-ink-muted">{status === 'OK' ? 'The comparable contracts name no winner.' : 'None: no comparable contract.'}</p>}
        </Card>

        <Card>
          <div className="p-5 pb-0"><CardHeader icon={Landmark} title={`Comparable contracts${comparables.length ? ` · ${comparables.length}` : ''}`} hint="Awarded contracts the agent judged comparable. A framework agreement's amount is a ceiling: it is left out of the budget." /></div>
          {comparables.length ? (<>
            <div className="overflow-x-auto"><table className="w-full text-sm">
              <thead><tr><th className="th">Date</th><th className="th">Contract</th><th className="th">Amount</th><th className="th">Winners</th><th className="th">Offers</th><th className="th">Source</th></tr></thead>
              <tbody>{shown.map(x => {
                const href = comparableUrl(x)
                return <tr key={x.id}><td className="td whitespace-nowrap">{x.date ? fmtDate(x.date) : '–'}</td>
                  <td className="td"><div className="font-medium">{x.title || x.id}</div>{x.buyer && <div className="text-[12px] text-ink-muted">{x.buyer}</div>}</td>
                  <td className="td whitespace-nowrap">{money(x.amount, x.currency) ?? <span className="text-ink-faint">not given</span>}{x.framework && <div className="text-[12px] text-ink-muted">ceiling (framework)</div>}</td>
                  <td className="td">{x.winners?.length ? x.winners.join(', ') : '–'}</td><td className="td">{x.bids ?? '–'}</td>
                  <td className="td whitespace-nowrap">{href ? <a className="inline-flex items-center gap-1 text-primary" href={href} target="_blank" rel="noreferrer">{x.source}<ExternalLink size={12} /></a> : <span title={x.id}>{x.source || '–'}</span>}</td></tr>
              })}</tbody>
            </table></div>
            <div className="flex flex-wrap items-center gap-3 px-5 py-3 text-[12px] text-ink-muted">
              {comparables.length > 8 && <button className="font-semibold text-primary" onClick={() => setAll(v => !v)}>{all ? 'Show fewer' : `Show all ${comparables.length}`}</button>}
              {sources.length > 0 && <span className="flex flex-wrap items-center gap-x-3 gap-y-1">Sources:{sources.map(s => <a key={s} className="inline-flex items-center gap-1 text-primary" href={SOURCE_HOME[s]} target="_blank" rel="noreferrer">{s}<ExternalLink size={12} /></a>)}</span>}
            </div>
          </>) : <p className="px-5 pb-5 text-sm text-ink-muted">None.</p>}
        </Card>
      </div>
    )
  }}</StudioCopy>
}

// ---------------------------------------------------------------- proposal (Person 5)
function ProposalTab({ t, a, studio }: { t: Tender; a: Analysis; studio: Studio }) {
  const p = draftProposal(t, a)
  const block = (icon: typeof Target, title: string, items: string[], tone?: 'primary' | 'bad') => (
    <Card className="p-5"><CardHeader icon={icon} title={title} tone={tone} />
      {items.length ? <ul className="space-y-2">{items.map(x => <li key={x} className="rounded-ctl bg-canvas px-3 py-2.5 text-[13px]">{x}</li>)}</ul> : <p className="text-sm text-ink-muted">None.</p>}</Card>
  )
  return (
    <div className="space-y-5">
      <StudioPanel t={t} studio={studio} />
      <p className="text-sm text-ink-muted"><b className="font-semibold text-ink">Draft</b> built in this browser from the RAG result. The deck itself is written by the proposal studio.</p>
      <div className="grid gap-5 lg:grid-cols-2">
        {block(Sparkles, 'Win themes', p.win_themes)}
        {block(Users, 'Recommended team', p.recommended_team)}
        {block(Award, 'References', p.references)}
        {block(AlertTriangle, 'Risks', p.risks, 'bad')}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- proposal deck (the proposal studio, rfp-studio)
/** Where this tender stands in the proposal studio. */
type StudioView =
  | { state: 'loading' }
  | { state: 'down'; error: string }
  | { state: 'missing' }
  | { state: 'ready'; input: StudioInput; enabled: boolean; run: Run | null }

async function loadStudio(id: string): Promise<StudioView> {
  if (id.startsWith('LIVE-')) return { state: 'missing' }   // a manual analysis never goes through n8n
  try {
    const input = await studioTender(id)
    if (!input) return { state: 'missing' }
    const [history, inbox] = await Promise.all([runs(id), studioTenders()])
    return { state: 'ready', input, enabled: inbox.generationEnabled, run: history[0] ?? null }
  } catch (err) {
    return { state: 'down', error: errorText(err) }
  }
}

/** The tender's copy in the proposal studio and its last deck run. A run in progress is polled every 3 s, then every 10 s after
 * 2 minutes, on every tab of the workspace: the header shows "Deck ready" when it ends. */
function useStudio(id: string) {
  const [view, setView] = useState<StudioView>({ state: 'loading' })
  const [stale, setStale] = useState(false)   // the last status request got no answer
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let live = true
    setView({ state: 'loading' })
    setStale(false)   // another tender, or a retry: no note left over from the previous status requests
    loadStudio(id).then(next => { if (live) setView(next) })
    return () => { live = false }
  }, [id, attempt])
  const active = view.state === 'ready' && view.run && isActive(view.run.status) ? view.run : null
  const runId = active?.runId, since = active?.createdAt
  useEffect(() => {
    if (!runId) return
    let live = true, timer = 0
    const started = Date.parse(since ?? '') || Date.now()
    const show = (patch: (rec: Run) => Run) => setView(v => v.state === 'ready' && v.run?.runId === runId ? { ...v, run: patch(v.run) } : v)
    const poll = async () => {
      try {
        const rec = await run(runId)
        if (!live) return
        setStale(false)
        show(() => rec)
        if (!isActive(rec.status)) return
      } catch (err) {
        if (!live) return
        if (err instanceof ApiError && err.status === 404) {
          show(rec => ({ ...rec, status: 'failed', error: 'The proposal studio no longer has this run.' }))
          return
        }
        setStale(true)   // no answer: keep the last status and ask again
      }
      timer = window.setTimeout(poll, Date.now() - started > 120_000 ? 10_000 : 3_000)
    }
    poll()
    return () => { live = false; window.clearTimeout(timer) }
  }, [runId])   // one polling loop per run; `since` belongs to it
  return {
    view, stale,
    retry: () => setAttempt(n => n + 1),
    /** Shows a run that was just started, until its first status arrives. */
    started: (rec: Run) => { setStale(false); setView(v => v.state === 'ready' ? { ...v, run: rec } : v) },
  }
}
type Studio = ReturnType<typeof useStudio>

const STEP_LABEL: Record<string, string> = { agent1: 'Requirements', agent5: 'Strengths', diagrams: 'Diagrams', agent4: 'Budget', agent6: 'Review', publish: 'Assembly' }
const STEP_STATUS: Record<RunStep['status'], { label: string; tone: 'neutral' | 'info' | 'good' | 'warn' | 'bad' }> = {
  pending: { label: 'waiting', tone: 'neutral' }, running: { label: 'running', tone: 'info' }, done: { label: 'done', tone: 'good' },
  degraded: { label: 'done, with warnings', tone: 'warn' }, failed: { label: 'failed', tone: 'bad' },
}
const RECOMMENDATION: Record<string, { label: string; tone: 'good' | 'warn' | 'bad' }> = {
  bid: { label: 'Bid', tone: 'good' }, review: { label: 'Review first', tone: 'warn' },
  bid_with_partner: { label: 'Bid with a partner', tone: 'warn' }, no_bid: { label: 'No-bid', tone: 'bad' },
}
const pendingSteps = () => STEPS.map((agent): RunStep => ({ agent, status: 'pending' }))

function StudioPanel({ t, studio }: { t: Tender; studio: Studio }) {
  const { view, stale, retry } = studio
  const [composing, setComposing] = useState(false)   // a new deck asked for after one is done
  const rec = view.state === 'ready' ? view.run : null
  const nav = useNavigate()
  const deck = rec?.status === 'done' ? deckPath(rec, t.id) : null
  // Both formats come from the editor (shown inside this app): its export dialog checks the [TO FILL] placeholders and the
  // pricing approval first.
  const exportButton = (format: string) => (
    <button className="btn-secondary btn-sm" disabled={!deck} onClick={() => deck && nav(deck)}
      title={deck ? `Opens the deck editor: export the ${format} there, after its placeholder and pricing approval checks` : 'Available when the deck is generated'}>
      <FileDown size={14} />{format}</button>
  )
  return (
    <Card className="p-5">
      <CardHeader icon={Presentation} title="Proposal deck" hint={`Written by the agents of the proposal studio (${STUDIO}) from the copy of this tender that n8n sent it.`}
        action={<div className="flex gap-2">{exportButton('PPTX')}{exportButton('PDF')}</div>} />
      {view.state === 'loading' ? <Loading text="Checking the proposal studio…" className="py-6" />
        : view.state === 'down' ? <ErrorNote message={view.error} onRetry={retry} />
        : view.state === 'missing' ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="flex items-center gap-2 text-sm text-ink-muted"><Info size={16} className="shrink-0" />Not in the proposal studio yet: n8n sends fit, open tenders (top 10).</p>
            <button className="btn-primary" disabled><Sparkles size={16} />Generate deck</button>
          </div>
        )
        : rec && isActive(rec.status) ? <RunProgress rec={rec} stale={stale} />
        : rec?.status === 'done' && !composing ? <DeckReady rec={rec} url={deck} onNew={() => setComposing(true)} />
        : <DeckForm t={t} input={view.input} enabled={view.enabled} failed={rec?.status === 'failed' ? rec : null}
            onCancel={rec?.status === 'done' ? () => setComposing(false) : undefined}
            onStarted={next => { setComposing(false); studio.started(next) }} />}
    </Card>
  )
}

/** The template select's value when the studio's template list is not available: the studio then uses its default. */
const STUDIO_DEFAULT = '*'
type Language = NonNullable<DeckParams['language']>
type ProjectType = NonNullable<DeckParams['project_type']>

function DeckForm({ t, input, enabled, failed, onCancel, onStarted }: {
  t: Tender; input: StudioInput; enabled: boolean; failed: Run | null; onCancel?: () => void; onStarted: (rec: Run) => void
}) {
  const s = input.matrix?.summary
  const verdict = RECOMMENDATION[s?.recommendation ?? '']
  const [options, setOptions] = useState(() => ({
    language: 'auto' as Language, project_type: projectTypeFor(input) as ProjectType, template: STUDIO_DEFAULT,
    deckName: `Proposal: ${input.tender?.title || t.title}`.slice(0, 80),
  }))
  const [list, setList] = useState<Template[] | null>(null)
  useEffect(() => {
    let live = true
    templates().then(items => {
      if (!live) return
      setList(items)
      // The studio's default template; with none, no template, as the studio does when the choice is left to it.
      const preset = items.find(x => x.isDefault)?.id ?? ''
      if (items.length) setOptions(o => o.template === STUDIO_DEFAULT ? { ...o, template: preset } : o)
    }).catch(() => { if (live) setList([]) })
    return () => { live = false }
  }, [])
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const closeConfirm = useCallback(() => setConfirming(false), [])
  // Before opening the templates page, this address gets ?tab=proposal, so the browser's Back button returns to this tab.
  const [, setParams] = useSearchParams()

  async function start() {
    setConfirming(false); setBusy(true); setError('')
    try {
      const runId = await startDeck(t.id, {
        templateId: options.template === STUDIO_DEFAULT ? undefined : options.template,
        params: { language: options.language, project_type: options.project_type, deckName: options.deckName.trim() || undefined },
      })
      onStarted({ runId, tenderId: studioId(t.id), status: 'queued', step: null, steps: pendingSteps(), createdAt: new Date().toISOString() })
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  // The gate: what the RAG matrix says about this bid, read from the studio's own copy of the tender
  const blocking = s?.blocking?.length ? s.blocking : s?.mandatory_gaps ?? []
  const gaps = (s?.knowledge_gaps ?? []).map(g => `${g.requirement || g.requirement_id || 'Requirement'}${g.mandatory ? ' (mandatory)' : ''}${g.gap ? `: ${g.gap}` : ''}`)
  const obligations = s?.obligations_not_in_matrix ?? []
  const demo = s?.demo_evidence ?? []
  const adapter = input.studio_adapter
  const dropped = Object.entries(adapter?.dropped ?? {}).filter(([, n]) => typeof n === 'number' && n > 0).map(([k, n]) => `${n} ${k.replace(/_/g, ' ')}`)
  return (
    <div className="space-y-5">
      {failed && <ErrorNote message={`The last deck generation failed: ${failed.error || 'no reason given'}`} />}
      <div className="space-y-4 rounded-ctl border border-line p-4">
        <div>
          <div className="flex flex-wrap items-center gap-2 text-sm"><span className="font-semibold">Bid recommendation</span>
            {verdict ? <Badge tone={verdict.tone}>{verdict.label}</Badge> : <Badge>None</Badge>}</div>
          {s?.recommendation_reason && <p className="mt-1 text-[13px] text-ink-muted">{s.recommendation_reason}</p>}
        </div>
        <GateList title="Blocking: mandatory requirements without evidence" items={blocking} tone="bad" />
        <GateList title="Knowledge gaps" items={gaps} />
        <GateList title="Obligations of the notice not in the matrix (never checked)" items={obligations} />
        {!blocking.length && !gaps.length && !obligations.length && <p className="flex items-center gap-2 text-sm text-primary"><CheckCircle2 size={18} />No blocking gap, knowledge gap or unchecked obligation.</p>}
        {demo.length > 0 && <p className="flex gap-2 rounded-ctl bg-warn-soft px-3 py-2 text-[13px] text-warn"><AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <span>Rows proved only by fictional demo records: {demo.join(', ')}.{adapter ? '' : ' The studio\'s copy came without the n8n adapter: the deck may present them as references.'}</span></p>}
        {adapter && <p className="flex gap-2 text-[13px] text-ink-muted"><Info size={16} className="mt-0.5 shrink-0" />
          {dropped.length ? `Removed by n8n from the studio's copy (demo records, weak proofs): ${dropped.join(', ')}.` : 'n8n removed nothing from the studio\'s copy.'}</p>}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Field label="Language">
          <select className="input" value={options.language} onChange={e => setOptions({ ...options, language: e.target.value as Language })}>
            <option value="auto">Tender language</option><option value="fr">French</option><option value="en">English</option>
          </select>
        </Field>
        <Field label="Project type" tip="Preselected from the tender type: software build and AI / data give Software, integration / SaaS gives SaaS, other types Other. Software adds the class-diagram slide.">
          <select className="input" value={options.project_type} onChange={e => setOptions({ ...options, project_type: e.target.value as ProjectType })}>
            <option value="software">Software</option><option value="saas">SaaS</option><option value="other">Other</option>
          </select>
        </Field>
        <div>
          <div className="mb-1.5 flex items-center justify-between gap-2 text-[13px]"><label htmlFor="deck-template" className="font-medium">Template</label>
            <Link to={`/templates?tender=${encodeURIComponent(t.id)}`} onClick={() => setParams({ tab: 'proposal' }, { replace: true })}
              className="text-[12px] font-medium text-primary hover:underline">Manage templates</Link></div>
          <select id="deck-template" className="input" value={options.template} disabled={list == null} onChange={e => setOptions({ ...options, template: e.target.value })}>
            {list == null ? <option value={STUDIO_DEFAULT}>Loading templates…</option>
              : list.length === 0 ? <option value={STUDIO_DEFAULT}>Studio default</option>
              : list.map(x => <option key={x.id} value={x.id}>{x.name}{x.isDefault ? ' (default)' : ''}</option>)}
            <option value="">No template (tender colours)</option>
          </select>
        </div>
        <Field label="Deck name">
          <input className="input" maxLength={80} value={options.deckName} onChange={e => setOptions({ ...options, deckName: e.target.value })} />
        </Field>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button className="btn-primary" disabled={busy || !enabled} onClick={() => s?.recommendation === 'bid' ? start() : setConfirming(true)}>
          {busy ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}{busy ? 'Starting…' : 'Generate deck'}</button>
        {onCancel && <button className="btn-secondary" disabled={busy} onClick={onCancel}>Cancel</button>}
        <span className="text-[12px] text-ink-muted">{enabled
          ? 'The studio makes one deck at a time; with the AI provider\'s free tier a deck takes a few minutes.'
          : 'Deck generation is not configured in the proposal studio (GENERATE_MODE=cli, or GENERATE_WEBHOOK_URL for its n8n).'}</span>
      </div>
      {error && <ErrorNote message={error} />}

      <ConfirmDialog open={confirming} onConfirm={start} onCancel={closeConfirm} title="Generate the deck anyway?" confirmLabel="Generate anyway"
        text={<>{verdict
          ? <>The recommendation is <b className="font-medium text-ink">{verdict.label}</b>{s?.recommendation_reason ? `: ${s.recommendation_reason}` : ''}.</>
          : 'The studio\'s copy of this tender has no bid recommendation.'} Check the points above before you spend a deck run on it.</>} />
    </div>
  )
}

function Field({ label, tip, children }: { label: string; tip?: string; children: React.ReactNode }) {
  return <label className="block"><span className="mb-1.5 flex items-center gap-1 text-[13px] font-medium">{label}{tip && <Tip text={tip} />}</span>{children}</label>
}

function GateList({ title, items, tone }: { title: string; items: string[]; tone?: 'bad' }) {
  if (!items.length) return null
  return (
    <div>
      <div className={`text-[12px] font-medium uppercase tracking-wide ${tone === 'bad' ? 'text-bad' : 'text-ink-muted'}`}>{title} · {items.length}</div>
      <ul className="mt-1.5 space-y-1.5">{items.slice(0, 5).map((x, i) => <li key={i} className="rounded-ctl bg-canvas px-3 py-2 text-[13px]">{x}</li>)}</ul>
      {items.length > 5 && <p className="mt-1.5 text-[12px] text-ink-muted">+{items.length - 5} more</p>}
    </div>
  )
}

const duration = (seconds: number) => seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`

function RunProgress({ rec, stale }: { rec: Run; stale: boolean }) {
  const steps = rec.steps?.length ? rec.steps : pendingSteps()
  const finished = steps.filter(s => s.status === 'done' || s.status === 'degraded').length
  const elapsed = Math.max(0, Math.round((Date.now() - (Date.parse(rec.createdAt) || Date.now())) / 1000))
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-sm"><Loader2 size={16} className="animate-spin text-primary" />
        <span className="font-semibold">{rec.status === 'queued' ? 'Starting the deck agents…' : 'Generating the deck…'}</span>
        <span className="ml-auto text-[12px] text-ink-muted">{duration(elapsed)}</span></div>
      <Bar value={(finished / steps.length) * 100} />
      <ol className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {steps.map(step => {
          const st = STEP_STATUS[step.status] ?? STEP_STATUS.pending
          return <li key={step.agent} className="flex items-center justify-between gap-2 rounded-ctl bg-canvas px-3 py-2 text-[13px]"><span>{STEP_LABEL[step.agent] ?? step.agent}</span>
            <Badge tone={st.tone}>{st.label}{step.ms ? ` · ${duration(Math.round(step.ms / 1000))}` : ''}</Badge></li>
        })}
      </ol>
      <p className="text-[13px] text-ink-muted">{rec.waitingRateLimit ? 'Waiting for the AI provider\'s rate limit…' : 'The agents are working; the AI provider\'s free tier can slow them down.'}</p>
      {stale && <p className="text-[13px] text-warn">Status not refreshed: the proposal studio does not answer. Asking again…</p>}
    </div>
  )
}

function DeckReady({ rec, url, onNew }: { rec: Run; url: string | null; onNew: () => void }) {
  const stat = (value: number | undefined, label: string) => <div className="rounded-ctl bg-canvas py-2"><b className="block text-[16px]">{value ?? '–'}</b>{label}</div>
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <CheckCircle2 size={20} className="shrink-0 text-olive" />
        <div className="min-w-0"><div className="font-semibold">Deck ready</div><div className="truncate text-[12px] text-ink-muted">{rec.params?.deckName || rec.deckId} · {fmtDate(rec.createdAt)}</div></div>
        <div className="ml-auto flex gap-2">
          <button className="btn-secondary" onClick={onNew}><Plus size={16} />New deck</button>
          {url ? <Link className="btn-primary" to={url}><Presentation size={16} />Open deck</Link>
            : <button className="btn-primary" disabled title="The studio gave no editor link for this deck"><ExternalLink size={16} />Open deck</button>}
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2 text-center text-[12px]">
        {stat(rec.placeholders, 'placeholders to fill')}
        {stat(rec.warnings?.length, 'warnings')}
        {stat(rec.problemsRemaining, 'review notes left')}
      </div>
      <p className="text-[12px] text-ink-muted">Fill the [TO FILL] placeholders in the editor. Its PPTX and PDF export checks them and the pricing approval first.</p>
    </div>
  )
}
