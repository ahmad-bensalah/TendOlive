import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { AlertTriangle, ArrowLeft, CheckCircle2, FileUp, FolderSync, LayoutTemplate, Loader2, Star, Trash2 } from 'lucide-react'
import { Badge, Card, CardHeader, ConfirmDialog, cx, Empty, ErrorNote, Loading } from '../components/ui'
import { fmtDate } from '../lib/data'
import { ApiError, errorText, type LoadState } from '../lib/api'
import {
  deleteTemplate, rescanTemplates, setDefaultTemplate, templateLibrary, templatePreview, uploadTemplate,
  type ImportedTemplate, type PreviewRole, type Template, type TemplateLibrary,
} from '../lib/studio'

/** How long the list is asked again for the previews the studio renders after an import (10 to 60 s with Playwright; the
 * studio gives up on a render after 90 s). */
const PREVIEW_WAIT = 120_000
const ROLES: PreviewRole[] = ['title', 'content', 'thankyou']
const rendered = (t: Template) => ROLES.every(role => t.previews?.[role])
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
/** When the newest template without previews was imported (0: none). */
const lastImport = (l: TemplateLibrary | null) =>
  Math.max(0, ...(l?.templates ?? []).filter(t => !rendered(t)).map(t => Date.parse(t.importedAt ?? '') || 0))

/** The proposal studio's deck templates, managed with its template API: add one, choose the default, delete one. */
export default function Templates() {
  const [params] = useSearchParams()
  const tenderId = params.get('tender')   // opened from the Proposal tab of this tender
  const [lib, setLib] = useState<TemplateLibrary | null>(null)
  const [state, setState] = useState<LoadState>('loading')
  const [loadError, setLoadError] = useState('')
  // A quiet reload (after an action, or while previews are rendered) keeps the list on screen, even when it fails.
  const load = useCallback(async (quiet = false) => {
    if (!quiet) setState('loading')
    try {
      const next = await templateLibrary()
      setLib(next)
      setState('ready')
      return next
    } catch (err) {
      if (!quiet) { setLoadError(errorText(err)); setState('error') }
      return null
    }
  }, [])

  // The studio renders the previews in the background after an import (and at its start): the list is asked again every
  // 4 s while a template has none, for 2 minutes at most, then a last time (watchUntil 0).
  const [watchUntil, setWatchUntil] = useState(0)
  const watch = useCallback((from = Date.now()) => setWatchUntil(until => Math.max(until, from + PREVIEW_WAIT)), [])
  const watching = watchUntil > 0 && !!lib?.templates.some(t => !rendered(t))
  useEffect(() => {
    if (!watching) return
    const timer = window.setInterval(() => { if (Date.now() >= watchUntil) setWatchUntil(0); load(true) }, 4000)
    return () => window.clearInterval(timer)
  }, [watching, watchUntil, load])
  // On page open (and Retry), the previews are waited for only when a template without them was imported a moment ago.
  const loadAndWatch = useCallback(() => load().then(next => {
    const last = lastImport(next)
    if (Date.now() - last < PREVIEW_WAIT) watch(last)
  }), [load, watch])
  useEffect(() => { loadAndWatch() }, [loadAndWatch])

  const [notice, setNotice] = useState('')
  // After a default change or a delete, the button used is gone: focus moves to the notice that says what was done.
  const noticeRef = useRef<HTMLParagraphElement>(null)
  const focusNotice = useRef(false)
  useEffect(() => {
    if (notice && focusNotice.current) noticeRef.current?.focus()
    focusNotice.current = false
  }, [notice])
  const say = (text: string, focus = false) => { focusNotice.current = focus; setNotice(text) }

  const [rescanning, setRescanning] = useState(false)
  const [rescanError, setRescanError] = useState('')
  async function importInbox() {
    const before = lib?.default ?? null
    setRescanning(true); setRescanError(''); setNotice('')
    try {
      const { imported, errors } = await rescanTemplates()
      const next = await load(true)
      const name = (id: string) => next?.templates.find(t => t.id === id)?.name ?? id
      // With no default template, the studio makes one of the imported templates the default.
      const madeDefault = next?.default && next.default !== before ? ` "${name(next.default)}" is the default template now.` : ''
      say(imported.length ? `Imported from the inbox folder: ${imported.map(name).join(', ')}.${madeDefault}`
        : errors.length ? `No template imported: the studio could not import ${plural(errors.length, 'file')} of its templates/inbox/ folder (below).`
        : 'No new file in the studio\'s templates/inbox/ folder.')
      if (imported.length) watch()
    } catch (err) {
      setRescanError(errorText(err))
    } finally {
      setRescanning(false)
    }
  }

  const [acting, setActing] = useState('')   // the template whose default change is being sent
  const [actionError, setActionError] = useState<{ id: string; message: string } | null>(null)
  async function makeDefault(t: Template) {
    setActing(t.id); setActionError(null); setNotice('')
    try {
      await setDefaultTemplate(t.id)
      setLib(l => l && { ...l, default: t.id, templates: l.templates.map(x => ({ ...x, isDefault: x.id === t.id })) })
      say(`"${t.name}" is the default template now.`, true)
      await load(true)
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) {
        // Deleted meanwhile (in the studio or another tab): its card goes, and the list is read again.
        setLib(l => l && { ...l, templates: l.templates.filter(x => x.id !== t.id) })
        say(`Template "${t.name}" was deleted from the proposal studio meanwhile.`, true)
        await load(true)
      } else setActionError({ id: t.id, message: errorText(err) })
    } finally {
      setActing('')
    }
  }

  const [removal, setRemoval] = useState<Template | null>(null)
  const [removing, setRemoving] = useState(false)
  const [removeError, setRemoveError] = useState('')
  const ask = (t: Template) => { setRemoveError(''); setActionError(null); setNotice(''); setRemoval(t) }
  const closeDialog = useCallback(() => setRemoval(null), [])
  async function remove() {
    if (!removal) return
    setRemoving(true); setRemoveError('')
    try {
      const deleted = await deleteTemplate(removal.id)
      say(deleted ? `Template "${removal.name}" deleted. The studio keeps it in its templates/trash/ folder.`
        : `Template "${removal.name}" was already deleted from the proposal studio.`, true)
      setLib(l => l && { ...l, default: l.default === removal.id ? null : l.default, templates: l.templates.filter(x => x.id !== removal.id) })
      setRemoval(null)
      await load(true)
    } catch (err) {
      setRemoveError(errorText(err))
    } finally {
      setRemoving(false)
    }
  }

  const items = lib?.templates ?? []
  return (
    <div className="space-y-6">
      {tenderId && <Link to={`/tenders/${encodeURIComponent(tenderId)}?tab=proposal`} className="inline-flex items-center gap-1.5 text-sm text-ink-muted hover:text-ink"><ArrowLeft size={16} />Back to the tender</Link>}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="max-w-3xl">
          <h1 className="text-[28px] font-semibold tracking-tight">Deck templates</h1>
          <p className="mt-1 text-sm text-ink-muted">The proposal studio keeps a template's design (backgrounds, shapes, pictures and logos) and removes every
            text; its agents write the deck's content in their place. The default template is preselected in a tender's Proposal tab
            and used by n8n's automatic deck. Files dropped in the studio's templates/inbox/ folder are imported at its start, or at
            once with Import from the inbox folder.</p>
        </div>
        <button className="btn-secondary" disabled={state !== 'ready' || rescanning} onClick={importInbox}>
          {rescanning ? <Loader2 size={16} className="animate-spin" /> : <FolderSync size={16} />}Import from the inbox folder</button>
      </div>
      {rescanError && <ErrorNote message={rescanError} />}

      {state === 'error' ? <ErrorNote message={loadError} onRetry={loadAndWatch} /> : <>
        <AddTemplate onAdded={async t => {
          setRescanError(''); watch()
          const next = await load(true)
          say(`Template "${t.name}" added.${next?.default === t.id ? ' It is the default template now.' : ''}${t.warnings.length
            ? ` The import gave ${plural(t.warnings.length, 'warning')}: see its card.` : ''}`)
        }} />
        {notice && <p ref={noticeRef} tabIndex={-1} role="status" className="flex items-center gap-2 text-sm text-ink-muted">
          <CheckCircle2 size={16} className="shrink-0 text-primary" />{notice}</p>}
        {state === 'ready' && items.length > 0 && !lib?.default && (
          <p className="flex gap-2 rounded-ctl bg-warn-soft px-3 py-2 text-sm text-warn"><AlertTriangle size={16} className="mt-0.5 shrink-0" />
            <span><b className="font-semibold">No default template.</b> Decks started without a template choice, n8n's automatic deck included,
              use the tender's colours. Choose one with Set as default.</span></p>
        )}
        {lib && lib.errors.length > 0 && (
          <div className="rounded-ctl bg-warn-soft px-3 py-2 text-sm text-warn">
            <p className="flex items-center gap-2 font-medium"><AlertTriangle size={16} className="shrink-0" />The studio could not import these files of its templates/inbox/ folder:</p>
            <ul className="mt-1 space-y-0.5 pl-6 text-[13px]">{lib.errors.map(e => <li key={e.file} className="break-words"><b className="font-medium">{e.file}</b>: {e.message}</li>)}</ul>
          </div>
        )}
        {state === 'loading' ? <Card><Loading text="Loading the templates…" /></Card>
          : items.length === 0 ? <Card><Empty icon={LayoutTemplate} title="No template yet" text="Add a .pptx or .pdf above. Until then, decks use the tender's colours." /></Card>
          : (
            <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
              {items.map(t => <TemplateCard key={t.id} t={t} rendering={watchUntil > 0} busy={!!acting} setting={acting === t.id}
                error={actionError?.id === t.id ? actionError.message : ''} onDefault={() => makeDefault(t)} onDelete={() => ask(t)} />)}
            </div>
          )}
      </>}

      <ConfirmDialog open={!!removal} busy={removing} error={removeError} onConfirm={remove} onCancel={closeDialog}
        title={`Delete the template "${removal?.name ?? ''}"?`} confirmLabel="Delete template"
        text={removal && <DeleteConsequences t={removal} />} />
    </div>
  )
}

/** What deleting a template does, said before it is done. */
function DeleteConsequences({ t }: { t: Template }) {
  return (
    <div className="space-y-2">
      <p>Decks made with it lose its pictures (backgrounds, logos), in the editor and in exports. A deck being generated with it
        right now fails at its last step.</p>
      <p>It goes to the studio's templates/trash/ folder, where it can be restored. If its file is in the studio's templates/inbox/
        folder, it comes back at the next studio start or import from the inbox folder.</p>
      {t.isDefault && <p className="text-ink">It is the default template: until another default is chosen, decks started without a template
        choice, n8n's automatic deck included, use the tender's colours.</p>}
    </div>
  )
}

function AddTemplate({ onAdded }: { onAdded: (t: ImportedTemplate) => Promise<void> }) {
  const input = useRef<HTMLInputElement>(null)
  const [importing, setImporting] = useState('')   // the name of the file being imported
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState('')
  // A file dropped next to the zone would be opened by the browser, which leaves the app.
  useEffect(() => {
    const block = (e: DragEvent) => {
      if (e.defaultPrevented || !e.dataTransfer?.types.includes('Files')) return
      e.preventDefault()
      if (e.type === 'dragover') e.dataTransfer.dropEffect = 'none'
    }
    window.addEventListener('dragover', block); window.addEventListener('drop', block)
    return () => { window.removeEventListener('dragover', block); window.removeEventListener('drop', block) }
  }, [])

  async function add(files: FileList | null) {
    if (importing || !files?.length) return
    setError('')
    if (files.length > 1) { setError('Add one file at a time.'); return }
    const file = files[0]
    setImporting(file.name)
    try {
      await onAdded(await uploadTemplate(file))
    } catch (err) {
      setError(errorText(err))
    } finally {
      setImporting('')
      if (input.current) input.current.value = ''   // the same file can be chosen again
    }
  }

  return (
    <Card className="p-5">
      <CardHeader icon={FileUp} title="Add a template" />
      <div onDragOver={e => { e.preventDefault(); if (!importing) setDragging(true) }}
        onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false) }}
        onDrop={e => { e.preventDefault(); setDragging(false); add(e.dataTransfer.files) }}
        className={cx('flex flex-col items-center gap-3 rounded-card border-2 border-dashed px-4 py-8 text-center transition-colors',
          dragging ? 'border-primary bg-primary-soft/50' : 'border-line')}>
        <p role="status" className="text-sm font-medium">{importing
          ? <span className="inline-flex items-center gap-2"><Loader2 size={16} className="shrink-0 animate-spin text-primary" />Importing "{importing}" (text removed, design kept)…</span>
          : 'Drop a .pptx or .pdf file here'}</p>
        <button className="btn-secondary" disabled={!!importing} onClick={() => input.current?.click()}><FileUp size={16} />Choose a file</button>
        <p className="text-[12px] text-ink-muted">A 16:9 PowerPoint with 3 slides, up to 60 MB. A PDF is imported approximately. A file with
          the name of an existing template is added as a new template, it does not replace it.</p>
        <input ref={input} type="file" accept=".pptx,.pdf" hidden onChange={e => add(e.target.files)} />
      </div>
      {error && <ErrorNote className="mt-4" message={error} />}
      <details className="mt-4">
        <summary className="cursor-pointer text-sm font-medium text-primary">How to prepare a template</summary>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-[13px] text-ink-muted">
          <li>A 16:9 PowerPoint (.pptx) with exactly 3 slides, in this order: title, content (the layout of every content slide), thank-you.</li>
          <li>Keep the text boxes: their text is removed, but the deck's text goes where they are. Title slide: a title box and a
            subtitle box below it. Content slide: a title box in the top 20 % and one large box over the whole content area.
            Thank-you slide: a box for the message.</li>
          <li>Set the theme colours: Accent 1 is the main brand colour (tables, bars, diagrams), Accent 2 the second one.</li>
          <li>On the content slide, keep the decoration in the margins (top 20 %, bottom 14 %, sides 6 %) and a calm, plain
            background behind the content: decoration in the middle is removed.</li>
          <li>Avoid text drawn as pictures, charts, SmartArt and videos: they are not imported.</li>
          <li>.pptx or .pdf, up to 60 MB (photos 1920 px wide are enough). A PDF is imported approximately: each page becomes a flat
            picture that cannot be edited.</li>
        </ul>
        <p className="mt-2 text-[12px] text-ink-muted">The full guide is templates/TEMPLATE_GUIDE.md in the studio's folder.</p>
      </details>
    </Card>
  )
}

function Warnings({ items, className }: { items?: string[]; className?: string }) {
  if (!items?.length) return null
  return (
    <ul className={cx('space-y-1.5', className)}>
      {items.map((w, i) => <li key={i} className="flex gap-2 rounded-ctl bg-warn-soft px-3 py-2 text-[12px] text-warn"><AlertTriangle size={14} className="mt-0.5 shrink-0" />{w}</li>)}
    </ul>
  )
}

function TemplateCard({ t, rendering, busy, setting, error, onDefault, onDelete }: {
  t: Template; rendering: boolean; busy: boolean; setting: boolean; error: string; onDefault: () => void; onDelete: () => void
}) {
  const s = t.stats ?? {}
  const kept = [s.keptImages ? plural(s.keptImages, 'picture') : '', s.keptShapes ? plural(s.keptShapes, 'shape') : ''].filter(Boolean)
  return (
    <Card className={cx('flex flex-col p-5', t.isDefault && '!border-primary ring-2 ring-primary/15')}>
      <Previews t={t} rendering={rendering} />
      <div className="mt-4 flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-semibold" title={t.name}>{t.name}</h3>
          <p className="truncate text-[12px] text-ink-muted">{[t.source, t.importedAt && `imported ${fmtDate(t.importedAt)}`].filter(Boolean).join(' · ')}</p>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
          {t.isDefault && <Badge tone="info"><Star size={12} />Default</Badge>}
          {t.approximate && <Badge tone="warn">Approximate</Badge>}
        </div>
      </div>
      {s.removedText != null && <p className="mt-2 text-[13px] text-ink-muted">{plural(s.removedText, 'text')} removed{kept.length ? `; ${kept.join(' and ')} kept` : ''}.</p>}
      <Warnings items={t.warnings} className="mt-3" />
      <div className="mt-auto flex flex-wrap gap-2 pt-4">
        {!t.isDefault && <button className="btn-secondary btn-sm" aria-label={`Set as default: ${t.name}`} disabled={busy} onClick={onDefault}>
          {setting ? <Loader2 size={14} className="animate-spin" /> : <Star size={14} />}Set as default</button>}
        <button className="btn-ghost btn-sm hover:!bg-bad-soft hover:!text-bad" aria-label={`Delete template ${t.name}`} disabled={busy}
          onClick={onDelete}><Trash2 size={14} />Delete</button>
      </div>
      {error && <ErrorNote className="mt-3" message={error} />}
    </Card>
  )
}

/** The studio's previews: the content slide large, title and thank-you beside it. Until they are rendered, the theme colours. */
function Previews({ t, rendering }: { t: Template; rendering: boolean }) {
  if (!templatePreview(t, 'content')) return (
    <div className="relative">
      <Swatch t={t} className="aspect-video rounded-[8px] border border-line" />
      <div className="absolute inset-0 grid place-items-center p-4">
        <span className="inline-flex items-center gap-2 rounded-ctl bg-white/90 px-3 py-1.5 text-center text-[12px] text-ink-muted shadow-card">
          {rendering ? <><Loader2 size={13} className="shrink-0 animate-spin text-primary" />Preview being rendered…</>
            : 'No preview yet (the studio renders it after an import, with Playwright).'}</span>
      </div>
    </div>
  )
  return (
    <div className="grid grid-cols-3 gap-1.5">
      <Thumb t={t} role="content" label="Content" className="col-span-2 row-span-2" />
      <Thumb t={t} role="title" label="Title" className="aspect-video" />
      <Thumb t={t} role="thankyou" label="Thank-you" className="aspect-video" />
    </div>
  )
}

function Thumb({ t, role, label, className }: { t: Template; role: PreviewRole; label: string; className?: string }) {
  const src = templatePreview(t, role)
  // A picture read while the studio still writes it comes broken: it is asked again, twice at most, then the colours show.
  const [tries, setTries] = useState(0)
  return (
    <figure className={cx('relative overflow-hidden rounded-[8px] border border-line bg-canvas', className)}>
      {src && tries < 3 ? <a href={src} target="_blank" rel="noreferrer" className="block h-full" title={`Open the ${label.toLowerCase()} slide preview`}>
          <img src={tries ? `${src}&r=${tries}` : src} alt={`${label} slide of ${t.name}`} className="h-full w-full object-cover"
            onError={() => window.setTimeout(() => setTries(n => n + 1), 1500)} /></a>
        : <Swatch t={t} className="h-full" />}
      <figcaption className="pointer-events-none absolute bottom-1 left-1 rounded bg-ink/60 px-1.5 text-[10px] font-medium text-white">{label}</figcaption>
    </figure>
  )
}

/** The template's background, main and second colours. */
function Swatch({ t, className }: { t: Template; className?: string }) {
  const colours = [t.theme?.bg, t.theme?.primary, t.theme?.secondary].filter((c): c is string => !!c && /^#[0-9a-f]{3,8}$/i.test(c))
  return (
    <div className={cx('flex overflow-hidden bg-canvas', className)}>
      {colours.map((c, i) => <span key={i} className="flex-1" style={{ background: c }} />)}
    </div>
  )
}
