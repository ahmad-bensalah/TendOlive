import { useCallback, useEffect, useMemo, useState } from 'react'
import { Boxes, Briefcase, Building2, CheckCircle2, Layers, Plus, Search, UserRound, Wrench } from 'lucide-react'
import { Avatar, Badge, Card, Empty, ErrorNote, Loading, Pending, SidePanel, Tabs } from '../components/ui'
import { personName, personRole, type Doc, type RecordItem } from '../lib/data'
import { documents, errorText, peek, records as fetchRecords, saveRecord, type LoadState } from '../lib/api'

type Kind = 'people' | 'past_project' | 'tech_stack' | 'tool' | 'client_portfolio'
const KINDS: { id: Kind; label: string; icon: typeof UserRound }[] = [
  { id: 'people', label: 'People', icon: UserRound }, { id: 'past_project', label: 'Projects', icon: Briefcase },
  { id: 'tech_stack', label: 'Tech stacks', icon: Layers }, { id: 'tool', label: 'Tools', icon: Wrench }, { id: 'client_portfolio', label: 'Clients', icon: Building2 },
]

export default function Knowledge() {
  const [kind, setKind] = useState<Kind>('people')
  const [q, setQ] = useState('')
  const [person, setPerson] = useState<Doc | null>(null)
  const [record, setRecord] = useState<RecordItem | null>(null)
  // Seen before in this session: the last answers show at once and are refreshed quietly (no loading state on every visit).
  const [seen] = useState(() => { const docs = peek.documents(), recs = peek.records(); return docs && recs ? { docs, recs } : null })
  const [livePeople, setLivePeople] = useState<Doc[]>(() => seen ? seen.docs.filter(doc => doc.type === 'cv') : [])
  const [liveRecords, setLiveRecords] = useState<RecordItem[]>(() => seen ? seen.recs : [])
  const [state, setState] = useState<LoadState>(seen ? 'ready' : 'loading')
  const [loadError, setLoadError] = useState('')
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState('')
  // Until the RAG service answers, the counts and the list show a loading state, never "0" / "Nothing found".
  const load = useCallback((quiet = false) => {
    if (!quiet) setState('loading')
    Promise.all([documents(), fetchRecords()]).then(([docs, nextRecords]) => {
      setLivePeople(docs.filter(doc => doc.type === 'cv'))
      setLiveRecords(nextRecords)
      setState('ready')
    }).catch(err => {
      setLoadError(errorText(err, 'Could not load the knowledge base.'))
      setState('error')
    })
  }, [])
  useEffect(() => load(seen !== null), [load, seen])
  const match = (o: object) => JSON.stringify(o).toLowerCase().includes(q.toLowerCase())
  const list = useMemo(() => kind === 'people' ? livePeople.filter(match) : liveRecords.filter(r => r.type === kind).filter(match), [kind, q, livePeople, liveRecords])
  const count = (k: Kind) => state === 'loading' ? <Pending className="h-[22px]" /> : state === 'error' ? '–'
    : k === 'people' ? livePeople.length : liveRecords.filter(r => r.type === k && r.status === 'indexed').length
  const label = KINDS.find(k => k.id === kind)!.label.toLowerCase()

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div><h1 className="text-[28px] font-semibold tracking-tight">Knowledge base</h1><p className="mt-1 text-sm text-ink-muted">Everything the matching can use as proof.</p></div>
        {kind === 'people' ? <span className="text-[13px] text-ink-muted">CVs are read-only</span> : <button className="btn-primary" onClick={() => { setError(''); setAdding(true) }}><Plus size={16} />Add {({ past_project: 'project', tech_stack: 'tech stack', tool: 'tool', client_portfolio: 'client' } as Record<string, string>)[kind]}</button>}
      </div>

      <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
        {KINDS.map(({ id, label, icon: Icon }) => (
          <button key={id} onClick={() => setKind(id)} className={`card flex items-center gap-3 p-4 text-left transition-colors ${kind === id ? '!border-primary ring-2 ring-primary/15' : 'hover:border-primary/40'}`}>
            <span className={`grid h-10 w-10 place-items-center rounded-[10px] ${kind === id ? 'bg-primary text-white' : 'bg-primary-soft text-primary'}`}><Icon size={19} /></span>
            <span><span className="block text-[22px] font-semibold leading-none">{count(id)}</span><span className="text-[13px] text-ink-muted">{label}</span></span>
          </button>
        ))}
      </div>

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 pt-2">
          <Tabs<Kind> value={kind} onChange={setKind} tabs={KINDS.map(k => ({ id: k.id, label: k.label }))} />
          <label className="relative my-2 w-full sm:w-72"><Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint" />
            <input className="input pl-9" placeholder="Search name, skill, technology" value={q} onChange={e => setQ(e.target.value)} aria-label="Search knowledge" /></label>
        </div>
        <div className="p-4">
          {state === 'loading' ? <Loading text="Loading the knowledge base…" /> :
            state === 'error' ? <ErrorNote message={`Could not load the knowledge base from the RAG service: ${loadError}`} onRetry={() => load()} /> :
            list.length === 0 ? (q ? <Empty icon={Boxes} title="Nothing found" text="Change the search." />
              : <Empty icon={Boxes} title={`No ${label} yet`} text={kind === 'people' ? 'CVs come from data/cvs.' : 'Add a record to make it available for matching.'} />) :
            kind === 'people' ? <PeopleGrid list={list as Doc[]} onOpen={setPerson} /> : <RecordGrid kind={kind} list={list as RecordItem[]} people={livePeople} onOpen={setRecord} />}
        </div>
      </Card>

      <SidePanel open={!!person} onClose={() => setPerson(null)} title={person && personName(person.title)} subtitle={person && <span className="text-[13px] text-ink-muted">{personRole(person.title)}</span>}>
        {person && <PersonDetail d={person} />}
      </SidePanel>
      <SidePanel open={!!record} onClose={() => setRecord(null)} title={record?.title} subtitle={record && <Badge tone={record.status === 'indexed' ? 'info' : 'outline'}>{record.status}</Badge>}>
        {record && <RecordDetail r={record} people={livePeople} records={liveRecords} />}
      </SidePanel>
      <SidePanel open={adding} onClose={() => setAdding(false)} title="Add knowledge record" subtitle="Save a draft or index a complete company declaration.">
        <RecordForm kind={kind === 'people' ? 'past_project' : kind} onSaved={async () => {
          setAdding(false)
          setLiveRecords(await fetchRecords())
        }} onError={setError} />
      </SidePanel>
      {error && <p className="rounded-ctl bg-bad-soft px-3 py-2 text-sm text-bad">{error}</p>}
    </div>
  )
}

function PeopleGrid({ list, onOpen }: { list: Doc[]; onOpen: (d: Doc) => void }) {
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {list.map(d => {
        const p = d.profile, certs = p.certifications ?? []
        return (
          <button key={d.doc_id} onClick={() => onOpen(d)} className="rounded-card border border-line p-4 text-left transition-colors hover:border-primary/40 hover:bg-canvas/40">
            <div className="flex items-center gap-3"><Avatar name={personName(d.title)} size={42} /><div className="min-w-0"><div className="truncate font-semibold">{personName(d.title)}</div><div className="truncate text-[13px] text-ink-muted">{personRole(d.title)}</div></div></div>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {p.seniority && p.seniority !== 'unknown' && <Badge tone="info" className="capitalize">{p.seniority}{p.years != null ? ` · ${p.years}y` : ''}</Badge>}
              {certs.slice(0, 2).map(c => <Badge key={c} tone="neutral">{c}</Badge>)}{certs.length > 2 && <Badge>+{certs.length - 2}</Badge>}
            </div>
            <div className="mt-3 flex items-center gap-1.5 text-[12px] text-ink-muted"><Briefcase size={13} />{d.projects?.length ?? 0} company projects</div>
          </button>
        )
      })}
    </div>
  )
}

function RecordGrid({ kind, list, people, onOpen }: { kind: Kind; list: RecordItem[]; people: Doc[]; onOpen: (r: RecordItem) => void }) {
  const personById = (id: string) => people.find(p => p.doc_id === id)
  return (
    <div className={`grid gap-4 md:grid-cols-2 ${kind === 'client_portfolio' ? 'xl:grid-cols-4' : 'xl:grid-cols-3'}`}>
      {list.map(r => (
        <button key={r.id} onClick={() => onOpen(r)} className="flex flex-col rounded-card border border-line p-4 text-left transition-colors hover:border-primary/40 hover:bg-canvas/40">
          <div className="flex items-start gap-3">
            {kind === 'client_portfolio' ? <Avatar name={r.title} size={40} /> : null}
            <div className="min-w-0 flex-1"><div className="line-clamp-2 font-semibold leading-snug">{r.title}</div>
              <div className="mt-0.5 truncate text-[12px] text-ink-muted">{kind === 'past_project' ? (r.client && !/not named/i.test(r.client) ? r.client : (r.year ? String(r.year) : '')) : kind === 'tool' ? (r.tool_kind ?? '').replace('_', ' ') : kind === 'client_portfolio' ? (r.sector || 'Sector unknown') : `${r.technologies?.length ?? 0} technologies`}</div></div>
            {r.status === 'draft' && <Badge tone="outline">Draft</Badge>}
          </div>
          {kind === 'past_project' && <div className="mt-3 flex flex-wrap gap-1.5">{r.delivery_status && <Badge tone={r.delivery_status === 'completed' ? 'info' : 'outline'} className="capitalize">{r.delivery_status}</Badge>}{r.sector && <Badge className="capitalize">{r.sector}</Badge>}</div>}
          {kind !== 'client_portfolio' && r.technologies?.length ? <div className="mt-3 flex flex-wrap gap-1.5">{r.technologies.slice(0, 5).map(x => <span key={x} className="rounded-md bg-canvas px-2 py-0.5 text-[12px] text-ink-muted">{x}</span>)}{r.technologies.length > 5 && <span className="text-[12px] text-ink-faint">+{r.technologies.length - 5}</span>}</div> : null}
          {kind === 'past_project' && r.team_cv_ids?.length ? <div className="mt-auto flex -space-x-2 pt-3">{r.team_cv_ids.map(id => { const p = personById(id); return p ? <span key={id} title={personName(p.title)} className="rounded-full ring-2 ring-white"><Avatar name={personName(p.title)} size={28} /></span> : null })}</div> : null}
        </button>
      ))}
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <div><div className="mb-2 text-[12px] font-medium uppercase tracking-wide text-ink-muted">{title}</div>{children}</div>
}

function PersonDetail({ d }: { d: Doc }) {
  const p = d.profile
  return (
    <>
      <p className="text-sm">{d.summary}</p>
      <Section title="Roles">{<div className="flex flex-wrap gap-1.5">{(p.roles ?? []).map(r => <Badge key={r} tone="info" className="capitalize">{r}</Badge>)}<Badge className="capitalize">{p.seniority}{p.years != null ? ` · ${p.years} years` : ''}</Badge></div>}</Section>
      <Section title="Certifications">{p.certifications?.length ? <div className="flex flex-wrap gap-1.5">{p.certifications.map(c => <Badge key={c} tone="neutral">{c}</Badge>)}</div> : <span className="text-sm text-ink-muted">None listed</span>}</Section>
      <Section title="Skills"><div className="flex flex-wrap gap-1.5">{(p.skills ?? []).map(s => <span key={s} className="rounded-md bg-canvas px-2 py-0.5 text-[12px]">{s}</span>)}</div></Section>
      <Section title="Company projects">{d.projects?.length ? <ul className="space-y-1.5">{d.projects.map(x => <li key={x.doc_id} className="flex gap-2 text-sm"><CheckCircle2 size={16} className="mt-0.5 shrink-0 text-primary" />{x.title}</li>)}</ul> : <span className="text-sm text-ink-muted">None recorded</span>}</Section>
      <p className="text-[12px] text-ink-faint">Source: {d.doc_id} (read-only CV)</p>
    </>
  )
}

function RecordDetail({ r, people, records }: { r: RecordItem; people: Doc[]; records: RecordItem[] }) {
  const rows: [string, React.ReactNode][] = [
    ['Client', r.client], ['Sector', r.sector], ['Status', r.delivery_status], ['Kind', r.tool_kind?.replace('_', ' ')],
    ['Use cases', r.use_cases], ['Relationship', r.relationship], ['Outcomes', r.outcomes],
  ]
  const personById = (id: string) => people.find(p => p.doc_id === id)
  const linked = records.filter(x => x.type === 'past_project' && x.client === r.title)
  return (
    <>
      <p className="text-sm">{r.description}</p>
      <dl className="space-y-3 text-sm">{rows.filter(([, v]) => v).map(([k, v]) => <div key={k}><dt className="text-[12px] text-ink-muted">{k}</dt><dd className="mt-0.5">{v}</dd></div>)}</dl>
      {r.technologies?.length ? <Section title="Technologies"><div className="flex flex-wrap gap-1.5">{r.technologies.map(x => <span key={x} className="rounded-md bg-canvas px-2 py-0.5 text-[12px]">{x}</span>)}</div></Section> : null}
      {r.team_cv_ids?.length ? <Section title="Assigned engineers"><div className="space-y-2">{r.team_cv_ids.map(id => { const p = personById(id); return p && <div key={id} className="flex items-center gap-2.5"><Avatar name={personName(p.title)} size={30} /><div><div className="text-sm font-medium">{personName(p.title)}</div><div className="text-[12px] text-ink-muted">{personRole(p.title)}</div></div></div> })}</div></Section> : null}
      {linked.length ? <Section title="Projects for this client"><ul className="space-y-1">{linked.map(x => <li key={x.id} className="text-sm">{x.title}</li>)}</ul></Section> : null}
      {r.source && <p className="break-words text-[12px] text-ink-faint">Source: {r.source}</p>}
      <p className="rounded-ctl bg-primary-soft px-3 py-2 text-[12px] text-primary">Company declaration — not a document quote.</p>
    </>
  )
}

function RecordForm({ kind, onSaved, onError }: { kind: Exclude<Kind, 'people'>; onSaved: () => Promise<void>; onError: (message: string) => void }) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [technologies, setTechnologies] = useState('')
  const [useCases, setUseCases] = useState('')
  const [client, setClient] = useState('')
  const [sector, setSector] = useState('')
  const [busy, setBusy] = useState(false)
  async function submit(action: 'draft' | 'index') {
    setBusy(true)
    try {
      await saveRecord({
        action, type: kind, title, description, client, sector, technologies: technologies.split(',').map(x => x.trim()).filter(Boolean),
        use_cases: useCases, delivery_status: '', company_role: '', scope: '', relationship: '', country: '', year: undefined,
        outcomes: '', budget: undefined, currency: '', linked_ids: [], team_cv_ids: [], tool_kind: kind === 'tool' ? 'software' : '', licence_details: '', source: 'React knowledge base',
      })
      await onSaved()
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not save this record.')
    } finally {
      setBusy(false)
    }
  }
  return <div className="space-y-4">
    <label className="block"><span className="mb-1.5 block text-[13px] font-medium">Name</span><input className="input" value={title} onChange={e => setTitle(e.target.value)} /></label>
    <label className="block"><span className="mb-1.5 block text-[13px] font-medium">Description</span><textarea className="input h-auto py-2" rows={4} value={description} onChange={e => setDescription(e.target.value)} /></label>
    {kind === 'past_project' && <label className="block"><span className="mb-1.5 block text-[13px] font-medium">Client</span><input className="input" value={client} onChange={e => setClient(e.target.value)} /></label>}
    {kind !== 'tech_stack' && <label className="block"><span className="mb-1.5 block text-[13px] font-medium">Sector</span><input className="input" value={sector} onChange={e => setSector(e.target.value)} /></label>}
    <label className="block"><span className="mb-1.5 block text-[13px] font-medium">Technologies (comma-separated)</span><input className="input" value={technologies} onChange={e => setTechnologies(e.target.value)} /></label>
    <label className="block"><span className="mb-1.5 block text-[13px] font-medium">Use cases</span><textarea className="input h-auto py-2" rows={3} value={useCases} onChange={e => setUseCases(e.target.value)} /></label>
    <div className="flex gap-2"><button className="btn-secondary flex-1" disabled={busy} onClick={() => submit('draft')}>Save draft</button><button className="btn-primary flex-1" disabled={busy} onClick={() => submit('index')}>Save and index</button></div>
  </div>
}
