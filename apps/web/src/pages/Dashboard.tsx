import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ArrowRight, CalendarClock, FileSearch, Filter, Target, TrendingUp, Users } from 'lucide-react'
import { Badge, Card, CardHeader, Donut, Empty, ErrorNote, Loading, Pending, ScoreRing, statusTone } from '../components/ui'
import { allTenders, analysisFor, daysLeft, deadlineLabel, fmtDate, parseDate, STATUS_LABEL, syncTenders, TODAY } from '../lib/data'
import { documents, errorText, peek, records as fetchRecords, tenders as fetchTenders, type LoadState } from '../lib/api'

const PIPE = [
  { key: 'detected', label: 'Detected', color: 'bg-primary/25 text-primary' },
  { key: 'relevant', label: 'Relevant', color: 'bg-primary/55 text-white' },
  { key: 'analysed', label: 'Analysed', color: 'bg-primary text-white' },
  { key: 'proposal', label: 'Proposal ready', color: 'bg-ink text-white' },
]

export default function Dashboard() {
  const nav = useNavigate()
  // Seen before in this session: the last answers show at once and are refreshed quietly (no loading state on every visit).
  const [seen] = useState(() => {
    const docs = peek.documents(), liveRecords = peek.records()
    return docs && liveRecords && peek.tenders() ? { docs, liveRecords } : null
  })
  const [peopleCount, setPeopleCount] = useState<number | null>(() => seen ? seen.docs.filter(doc => doc.type === 'cv').length : null)
  const [projectCount, setProjectCount] = useState<number | null>(() => seen ? seen.liveRecords.filter(record => record.type === 'past_project' && record.status === 'indexed').length : null)
  const [tenders, setTenders] = useState(allTenders)
  const [state, setState] = useState<LoadState>(seen ? 'ready' : 'loading')
  const [error, setError] = useState('')
  const load = useCallback((quiet = false) => {
    if (!quiet) setState('loading')
    Promise.all([documents(), fetchRecords(), fetchTenders()]).then(([docs, liveRecords, stored]) => {
      setPeopleCount(docs.filter(doc => doc.type === 'cv').length)
      setProjectCount(liveRecords.filter(record => record.type === 'past_project' && record.status === 'indexed').length)
      syncTenders(stored)
      setTenders(allTenders())
      setState('ready')
    }).catch(err => {
      // Tenders saved in this browser stay visible; the knowledge counts are unknown.
      setPeopleCount(null)
      setProjectCount(null)
      setTenders(allTenders())
      setError(errorText(err))
      setState('error')
    })
  }, [])
  useEffect(() => load(seen !== null), [load, seen])
  const loading = state === 'loading'
  /** A number from the RAG service: a placeholder while it loads, "–" when it is unknown (the service failed and the
   * browser has no saved copy of the tenders, so a count of 0 would be a guess). */
  const unknown = state === 'error' && tenders.length === 0
  const num = (value: number | null) => loading ? <Pending /> : unknown ? '–' : value ?? '–'
  const active = tenders.filter(t => ['new', 'review', 'proposal'].includes(t.status))
  const counts = {
    detected: tenders.length,
    relevant: tenders.filter(t => t.status !== 'filtered').length,
    analysed: tenders.filter(t => analysisFor(t.id)).length,
    proposal: tenders.filter(t => t.status === 'proposal').length,
  }
  const avgFit = Math.round(active.reduce((s, t) => s + (analysisFor(t.id)?.fit_score.overall ?? 0), 0) / (active.length || 1))
  // Tenders without a deadline come last.
  const byDeadline = [...active].sort((a, b) => (a.deadline || '9999').localeCompare(b.deadline || '9999'))
  const upcoming = byDeadline.filter(t => (daysLeft(t.deadline) ?? -1) >= 0)
  const byStatus = (s: string) => tenders.filter(t => t.status === s).length
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm text-ink-muted">{TODAY.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}</p>
          <h1 className="mt-1 text-[28px] font-semibold tracking-tight">Welcome back, OliveSoft admin</h1>
        </div>
        <Link to="/tenders" className="btn-secondary"><Filter size={16} />Review new tenders</Link>
      </div>

      {state === 'error' && <ErrorNote onRetry={() => load()}
        message={`Could not load the dashboard from the RAG service: ${error}${tenders.length ? ' Tenders come from the copy saved in this browser.' : ''}`} />}

      <div className="grid gap-5 md:grid-cols-3">
        <Card className="p-5">
          <CardHeader icon={FileSearch} title="Tenders" />
          <div className="flex items-center gap-5">
            <Donut size={112} stroke={16} center={<div><div className="text-2xl font-semibold">{num(tenders.length)}</div><div className="text-[11px] text-ink-muted">total</div></div>}
              segments={loading ? [] : [{ value: byStatus('new') + byStatus('review'), color: '#2557F2' }, { value: byStatus('proposal'), color: '#16348F' }, { value: byStatus('nobid') + byStatus('filtered'), color: '#C9D3E3' }]} />
            <ul className="space-y-2 text-[13px]">
              <li className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full bg-primary" />Active <b className="ml-auto pl-3">{num(byStatus('new') + byStatus('review'))}</b></li>
              <li className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full bg-primary-deep" />Proposal <b className="ml-auto pl-3">{num(byStatus('proposal'))}</b></li>
              <li className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full bg-[#C9D3E3]" />Closed <b className="ml-auto pl-3">{num(byStatus('nobid') + byStatus('filtered'))}</b></li>
            </ul>
          </div>
        </Card>

        <Card className="p-5">
          <CardHeader icon={TrendingUp} title="Pipeline" />
          <div className="space-y-2.5">
            {PIPE.map(p => {
              const n = counts[p.key as keyof typeof counts]
              return <div key={p.key} className="h-7 rounded-[8px] bg-canvas"><div className={`flex h-full items-center whitespace-nowrap rounded-[8px] px-3 text-[12px] font-medium ${p.color}`} style={{ width: `${Math.max(52, (n / (counts.detected || 1)) * 100)}%` }}>{p.label}<b className="ml-2">{num(n)}</b></div></div>
            })}
          </div>
        </Card>

        <Card className="p-5">
          <CardHeader icon={Target} title="Average fit" />
          <div className="text-[34px] font-semibold leading-none tracking-tight">{loading ? <Pending className="w-24" /> : active.length ? `${avgFit}%` : '–'}</div>
          <p className="mt-2 text-[13px] text-ink-muted">{loading ? 'Loading tenders…' : `Recorded coverage across ${active.length} active tender${active.length === 1 ? '' : 's'}`}</p>
          <div className="mt-4 grid grid-cols-2 gap-2 text-[12px]">
            <div className="rounded-ctl bg-canvas px-3 py-2"><div className="text-ink-muted">People</div><b className="text-[15px]">{num(peopleCount)}</b></div>
            <div className="rounded-ctl bg-canvas px-3 py-2"><div className="text-ink-muted">Projects</div><b className="text-[15px]">{num(projectCount)}</b></div>
          </div>
        </Card>

      </div>

      <div className="grid gap-5 xl:grid-cols-3">
        <Card className="p-5 xl:col-span-2">
          <CardHeader icon={FileSearch} title="Active tenders" action={<Link to="/tenders" className="text-sm font-semibold text-primary">View all</Link>} />
          {loading ? <Loading text="Loading tenders…" /> : byDeadline.length === 0 ? <Empty icon={FileSearch} title="No active tenders" text="Tenders sent by n8n and new analyses appear here." /> : (
          <div className="-mx-5 overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr><th className="th">Tender</th><th className="th">Fit</th><th className="th">Deadline</th><th className="th">Status</th><th className="th" /></tr></thead>
              <tbody>
                {byDeadline.map(t => {
                  const a = analysisFor(t.id), d = daysLeft(t.deadline)
                  return (
                    <tr key={t.id} className="cursor-pointer hover:bg-canvas/60" onClick={() => nav(`/tenders/${t.id}`)}>
                      <td className="td max-w-[360px]"><div className="truncate font-medium">{t.title}</div><div className="truncate text-[12px] text-ink-muted">{t.client}</div></td>
                      <td className="td"><ScoreRing value={a?.fit_score.overall ?? null} size={40} /></td>
                      <td className="td whitespace-nowrap"><div className={d == null || d < 0 ? 'text-ink-faint' : 'font-medium'}>{deadlineLabel(d)}</div>{d != null && <div className="text-[12px] text-ink-muted">{fmtDate(t.deadline)}</div>}</td>
                      <td className="td"><Badge tone={statusTone(t.status)}>{STATUS_LABEL[t.status]}</Badge></td>
                      <td className="td text-right"><ArrowRight size={16} className="inline text-ink-faint" /></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          )}
        </Card>

        <Card className="p-5">
          <CardHeader icon={CalendarClock} title="Upcoming deadlines" />
          {loading ? <Loading text="Loading deadlines…" /> : upcoming.length === 0 ? <p className="py-6 text-center text-sm text-ink-muted">No upcoming deadline.</p> : (
          <ol className="space-y-3">
            {upcoming.map(t => {
              const d = daysLeft(t.deadline) ?? 0, date = parseDate(t.deadline)!
              return (
                <li key={t.id}>
                  <Link to={`/tenders/${t.id}`} className="flex gap-3 rounded-ctl border border-line p-3 hover:border-primary/40">
                    <div className="grid w-12 shrink-0 place-items-center rounded-[8px] bg-canvas py-1 text-center leading-tight">
                      <span className="text-[11px] uppercase text-ink-muted">{date.toLocaleDateString('en-GB', { month: 'short' })}</span>
                      <span className="text-[18px] font-semibold">{date.getDate()}</span>
                    </div>
                    <div className="min-w-0">
                      <div className="truncate text-[13px] font-medium">{t.title}</div>
                      <Badge tone="info" className="mt-1">{d === 0 ? 'Today' : `In ${d} day${d === 1 ? '' : 's'}`}</Badge>
                    </div>
                  </Link>
                </li>
              )
            })}
          </ol>
          )}
          <Link to="/knowledge" className="mt-4 flex items-center gap-2 rounded-ctl bg-primary-soft px-3 py-2.5 text-[13px] font-medium text-primary"><Users size={16} />{num(peopleCount)} people ready to staff</Link>
        </Card>
      </div>
    </div>
  )
}
