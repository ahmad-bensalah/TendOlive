import { ReactNode, useEffect, useRef } from 'react'
import { AlertTriangle, CheckCircle2, HelpCircle, Loader2, RotateCw, X, type LucideIcon } from 'lucide-react'

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ')

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={cx('card', className)}>{children}</section>
}

export function IconTile({ icon: Icon, tone = 'primary' }: { icon: LucideIcon; tone?: 'primary' | 'olive' | 'warn' | 'bad' }) {
  const tones = { primary: 'bg-primary text-white', olive: 'bg-olive text-white', warn: 'bg-warn-soft text-warn', bad: 'bg-bad-soft text-bad' }
  return <span className={cx('grid h-9 w-9 place-items-center rounded-[10px] shrink-0', tones[tone])}><Icon size={18} strokeWidth={2} /></span>
}

export function CardHeader({ icon, title, action, tone, hint }: { icon?: LucideIcon; title: ReactNode; action?: ReactNode; tone?: 'primary' | 'olive' | 'warn' | 'bad'; hint?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 mb-4">
      <div className="flex items-center gap-3 min-w-0">
        {icon && <IconTile icon={icon} tone={tone} />}
        <h2 className="text-[16px] font-semibold truncate">{title}</h2>
        {hint && <Tip text={hint} />}
      </div>
      {action}
    </div>
  )
}

type Tone = 'good' | 'warn' | 'bad' | 'info' | 'neutral' | 'olive' | 'dark' | 'outline'
const TONES: Record<Tone, string> = {
  good: 'bg-olive-soft text-olive-deep', warn: 'bg-warn-soft text-warn', bad: 'bg-bad-soft text-bad',
  info: 'bg-primary-soft text-primary', neutral: 'bg-canvas text-ink-muted', olive: 'bg-olive text-white', dark: 'bg-primary-deep text-white', outline: 'bg-white text-primary ring-1 ring-inset ring-primary/30',
}
export function Badge({ children, tone = 'neutral', className }: { children: ReactNode; tone?: Tone; className?: string }) {
  return <span className={cx('inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[12px] font-medium whitespace-nowrap', TONES[tone], className)}>{children}</span>
}

export const statusTone = (s: string): Tone =>
  ({ covered: 'info', partial: 'outline', missing: 'bad', new: 'outline', review: 'info', proposal: 'dark', nobid: 'neutral', filtered: 'neutral' } as Record<string, Tone>)[s] ?? 'neutral'

/** The proposal studio's deck of a tender: "Generating" while its agents work, "Deck ready" once done, nothing otherwise. */
export function DeckBadge({ status }: { status?: string | null }) {
  if (status === 'done') return <Badge tone="good"><CheckCircle2 size={12} />Deck ready</Badge>
  if (status === 'queued' || status === 'running') return <Badge tone="info"><Loader2 size={12} className="animate-spin" />Generating</Badge>
  return null
}

export function Tip({ text }: { text: string }) {
  return (
    <span className="group relative inline-flex" tabIndex={0} aria-label={text}>
      <HelpCircle size={15} className="text-ink-faint group-hover:text-ink-muted" />
      <span role="tooltip" className="pointer-events-none absolute left-1/2 top-6 z-30 hidden w-64 -translate-x-1/2 rounded-ctl bg-ink px-3 py-2 text-[12px] font-normal leading-snug text-white shadow-pop group-hover:block group-focus:block">{text}</span>
    </span>
  )
}

export function Bar({ value, tone = 'primary', className }: { value: number | null; tone?: 'primary' | 'olive' | 'warn' | 'bad'; className?: string }) {
  const color = { primary: 'bg-primary', olive: 'bg-olive', warn: 'bg-warn', bad: 'bg-bad' }[tone]
  return <div className={cx('h-2 w-full rounded-full bg-canvas overflow-hidden', className)}><div className={cx('h-full rounded-full', color)} style={{ width: `${Math.max(0, Math.min(100, value ?? 0))}%` }} /></div>
}

export const fitTone = (_v: number | null): 'primary' => 'primary'

export function Donut({ segments, size = 128, stroke = 18, center }: { segments: { value: number; color: string }[]; size?: number; stroke?: number; center: ReactNode }) {
  const r = (size - stroke) / 2, c = 2 * Math.PI * r
  const total = segments.reduce((s, x) => s + x.value, 0) || 1
  let offset = 0
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#EEF2F8" strokeWidth={stroke} />
        {segments.filter(s => s.value > 0).map((s, i) => {
          const len = (s.value / total) * c
          const el = <circle key={i} cx={size / 2} cy={size / 2} r={r} fill="none" stroke={s.color} strokeWidth={stroke}
            strokeDasharray={`${Math.max(len - 3, 0)} ${c}`} strokeDashoffset={-offset} strokeLinecap="butt" />
          offset += len
          return el
        })}
      </svg>
      <div className="absolute inset-0 grid place-items-center text-center">{center}</div>
    </div>
  )
}

export function ScoreRing({ value, size = 44 }: { value: number | null; size?: number }) {
  const v = value ?? 0
  const color = '#2557F2'
  return <Donut size={size} stroke={5} segments={[{ value: v, color }, { value: 100 - v, color: 'transparent' }]}
    center={<span className="text-[12px] font-semibold">{value == null ? '–' : v}</span>} />
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: string; count?: number }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div role="tablist" className="flex gap-1 overflow-x-auto border-b border-line">
      {tabs.map(t => (
        <button key={t.id} role="tab" aria-selected={value === t.id} onClick={() => onChange(t.id)}
          className={cx('relative -mb-px whitespace-nowrap px-4 py-3 text-sm font-medium transition-colors',
            value === t.id ? 'text-primary after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:rounded-full after:bg-primary' : 'text-ink-muted hover:text-ink')}>
          {t.label}{t.count != null && <span className={cx('ml-2 rounded-full px-2 py-0.5 text-[11px]', value === t.id ? 'bg-primary-soft' : 'bg-canvas')}>{t.count}</span>}
        </button>
      ))}
    </div>
  )
}

export function Chips<T extends string>({ items, value, onChange }: { items: { id: T; label: string; count?: number }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      {items.map(i => (
        <button key={i.id} onClick={() => onChange(i.id)}
          className={cx('h-8 rounded-full border px-3 text-[13px] font-medium transition-colors',
            value === i.id ? 'border-primary bg-primary text-white' : 'border-line bg-white text-ink-muted hover:border-primary/40 hover:text-ink')}>
          {i.label}{i.count != null && <span className="ml-1.5 opacity-80">{i.count}</span>}
        </button>
      ))}
    </div>
  )
}

export function SidePanel({ open, onClose, title, subtitle, children }: { open: boolean; onClose: () => void; title: ReactNode; subtitle?: ReactNode; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  if (!open) return null
  return (
    <aside className="fixed inset-y-0 right-0 z-40 flex w-full max-w-[480px] flex-col border-l border-line bg-white shadow-pop" aria-label="Details">
      <header className="flex items-start justify-between gap-3 border-b border-line px-6 py-5">
        <div className="min-w-0"><h2 className="text-[17px] font-semibold leading-snug">{title}</h2>{subtitle && <div className="mt-1.5">{subtitle}</div>}</div>
        <button onClick={onClose} className="btn-ghost btn-sm !px-2" aria-label="Close"><X size={18} /></button>
      </header>
      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">{children}</div>
    </aside>
  )
}

export function Empty({ icon: Icon, title, text, action }: { icon: LucideIcon; title: string; text?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-12 text-center">
      <span className="mb-3 grid h-12 w-12 place-items-center rounded-full bg-canvas text-ink-faint"><Icon size={22} /></span>
      <h3 className="font-semibold">{title}</h3>
      {text && <p className="mt-1 max-w-sm text-sm text-ink-muted">{text}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

/** Shown in place of a list while the RAG service answers. */
export function Loading({ text = 'Loading…', className }: { text?: string; className?: string }) {
  return (
    <div role="status" className={cx('flex items-center justify-center gap-2.5 px-6 py-12 text-sm text-ink-muted', className)}>
      <Loader2 size={18} className="animate-spin text-primary" />{text}
    </div>
  )
}

/** Stands for a number that is still loading, so a count never reads "0" before the answer. */
export function Pending({ className }: { className?: string }) {
  return <span role="status" aria-label="Loading" className={cx('inline-block h-[0.9em] w-8 animate-pulse rounded-md bg-canvas align-middle', className)} />
}

/** A failed request: what happened, and a way to try again. */
export function ErrorNote({ message, onRetry, className }: { message: string; onRetry?: () => void; className?: string }) {
  return (
    <div role="alert" className={cx('flex flex-wrap items-center gap-3 rounded-ctl bg-bad-soft px-3 py-2 text-sm text-bad', className)}>
      <AlertTriangle size={16} className="shrink-0" /><span className="min-w-0 flex-1">{message}</span>
      {onRetry && <button className="btn-ghost btn-sm !text-bad hover:!bg-white/60" onClick={onRetry}><RotateCw size={14} />Retry</button>}
    </div>
  )
}

/** Asks before an action that cannot be undone. Escape or Cancel closes it. */
export function ConfirmDialog({ open, title, text, confirmLabel, busy, error, onConfirm, onCancel }: {
  open: boolean; title: string; text: ReactNode; confirmLabel: string; busy?: boolean; error?: string
  onConfirm: () => void; onCancel: () => void
}) {
  const cancel = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    // Focus Cancel (the safe choice), and give focus back to the button that opened the dialog on close.
    const opener = document.activeElement as HTMLElement | null
    cancel.current?.focus()
    return () => opener?.focus()
  }, [open])
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onCancel()
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey)
  }, [open, busy, onCancel])
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-ink/30 p-4" onClick={() => !busy && onCancel()}>
      <div role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-text"
        className="card max-h-[calc(100dvh-2rem)] w-full max-w-[420px] overflow-y-auto p-6 shadow-pop" onClick={e => e.stopPropagation()}>
        <div className="flex items-start gap-3">
          <IconTile icon={AlertTriangle} tone="bad" />
          <div className="min-w-0">
            <h2 id="confirm-title" className="text-[16px] font-semibold leading-snug">{title}</h2>
            <div id="confirm-text" className="mt-1.5 text-sm text-ink-muted">{text}</div>
          </div>
        </div>
        {error && <ErrorNote className="mt-4" message={error} />}
        <div className="mt-6 flex justify-end gap-2">
          <button ref={cancel} className="btn-secondary" onClick={onCancel} disabled={busy}>Cancel</button>
          <button className="btn-danger" onClick={onConfirm} disabled={busy}>{busy ? 'Deleting…' : confirmLabel}</button>
        </div>
      </div>
    </div>
  )
}

export function Avatar({ name, size = 36, tone = 'primary' }: { name: string; size?: number; tone?: 'primary' | 'olive' }) {
  const ini = name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase()
  return <span className={cx('grid shrink-0 place-items-center rounded-full font-semibold', tone === 'olive' ? 'bg-olive-soft text-olive-deep' : 'bg-primary-soft text-primary')}
    style={{ width: size, height: size, fontSize: size * 0.36 }}>{ini}</span>
}

export function Kpi({ label, value, sub, icon, tone }: { label: string; value: ReactNode; sub?: ReactNode; icon: LucideIcon; tone?: 'primary' | 'olive' | 'warn' | 'bad' }) {
  return (
    <Card className="p-5">
      <div className="flex items-center gap-3"><IconTile icon={icon} tone={tone} /><span className="text-sm font-medium text-ink-muted">{label}</span></div>
      <div className="mt-4 text-[28px] font-semibold leading-none tracking-tight">{value}</div>
      {sub && <div className="mt-2 text-[13px] text-ink-muted">{sub}</div>}
    </Card>
  )
}
