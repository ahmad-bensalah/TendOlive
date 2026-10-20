import { useEffect, useReducer } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { Bell, ChevronDown, FileText, Gauge, LayoutDashboard, LayoutTemplate, Library, Presentation, Search, Settings } from 'lucide-react'
import { cx } from './ui'
import { allTenders, daysLeft, TENDERS_CHANGED } from '../lib/data'

const NAV = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/tenders', label: 'Tenders', icon: FileText },
  { to: '/knowledge', label: 'Knowledge base', icon: Library },
  { to: '/proposals', label: 'Proposals', icon: Presentation },
  { to: '/templates', label: 'Templates', icon: LayoutTemplate },
  { to: '/quality', label: 'Quality', icon: Gauge },
]

function Logo() {
  return (
    <div className="flex items-center gap-2.5 px-2">
      <span className="grid h-9 w-9 place-items-center rounded-[10px] bg-olive text-white">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M12 3c4.5 0 8 3.6 8 8.2 0 4.7-3.6 9.8-8 9.8s-8-5.1-8-9.8C4 6.6 7.5 3 12 3z" fill="currentColor" opacity=".35" /><path d="M12 6.5c2.8 0 5 2.3 5 5.2 0 3-2.2 6.3-5 6.3s-5-3.3-5-6.3c0-2.9 2.2-5.2 5-5.2z" fill="currentColor" /></svg>
      </span>
      <div className="leading-tight"><div className="text-[16px] font-bold tracking-tight">Olive<span className="text-olive">Soft</span></div><div className="text-[11px] text-ink-muted">RFP Intelligence</div></div>
    </div>
  )
}

export default function Layout() {
  const { pathname } = useLocation()
  // Recount when the tender inbox changes (loaded, deleted or cleared), not only on navigation.
  const [, refresh] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    window.addEventListener(TENDERS_CHANGED, refresh)
    return () => window.removeEventListener(TENDERS_CHANGED, refresh)
  }, [])
  const urgent = allTenders().filter(t => {
    const d = daysLeft(t.deadline)
    return ['new', 'review', 'proposal'].includes(t.status) && d != null && d >= 0 && d <= 7
  }).length
  return (
    <div className="min-h-screen lg:pl-[248px]">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[248px] flex-col border-r border-line bg-white px-4 py-5 lg:flex">
        <Logo />
        <nav className="mt-8 space-y-1" aria-label="Main">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink key={to} to={to} end={end} className={({ isActive }) => cx('flex items-center gap-3 rounded-ctl px-3 py-2.5 text-sm font-medium transition-colors',
              isActive ? 'bg-primary-soft text-primary' : 'text-ink-muted hover:bg-canvas hover:text-ink')}>
              <Icon size={18} />{label}
              {to === '/tenders' && urgent > 0 && <span className="ml-auto rounded-full bg-primary px-2 text-[11px] font-semibold text-white">{urgent}</span>}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto space-y-1">
          <NavLink to="/settings" className={({ isActive }) => cx('flex items-center gap-3 rounded-ctl px-3 py-2.5 text-sm font-medium', isActive ? 'bg-primary-soft text-primary' : 'text-ink-muted hover:bg-canvas hover:text-ink')}><Settings size={18} />Settings</NavLink>
        </div>
      </aside>

      <header className="sticky top-0 z-20 flex h-16 items-center gap-4 border-b border-line bg-white/85 px-6 backdrop-blur">
        <nav className="flex gap-1 overflow-x-auto lg:hidden" aria-label="Main mobile">
          {NAV.map(({ to, label, end }) => <NavLink key={to} to={to} end={end} className={({ isActive }) => cx('rounded-ctl px-2.5 py-1.5 text-[13px] font-medium whitespace-nowrap', isActive ? 'bg-primary-soft text-primary' : 'text-ink-muted')}>{label}</NavLink>)}
        </nav>
        <label className="relative hidden max-w-md flex-1 md:block">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint" />
          <input className="input pl-9 bg-canvas border-transparent" placeholder="Search tenders, people, projects…" aria-label="Search" />
        </label>
        <div className="ml-auto flex items-center gap-3">
          <span className="hidden items-center gap-2 rounded-full border border-line px-3 py-1.5 text-[12px] font-medium text-ink-muted sm:flex"><span className="h-2 w-2 rounded-full bg-primary" />Company data</span>
          <button className="relative grid h-10 w-10 place-items-center rounded-ctl border border-line text-ink-muted hover:text-ink" aria-label="Notifications">
            <Bell size={18} />{urgent > 0 && <span className="absolute right-2 top-2 h-2 w-2 rounded-full bg-primary" />}
          </button>
          <button className="flex items-center gap-2.5 rounded-ctl border border-line py-1.5 pl-1.5 pr-3">
            <span className="grid h-8 w-8 place-items-center rounded-[8px] bg-primary text-[12px] font-semibold text-white">MA</span>
            <span className="hidden text-left leading-tight sm:block"><span className="block text-[13px] font-semibold">OliveSoft admin</span><span className="block text-[11px] text-ink-muted">Administrator</span></span>
            <ChevronDown size={16} className="text-ink-muted" />
          </button>
        </div>
      </header>

      <main key={pathname} className="mx-auto max-w-[1400px] px-6 py-7"><Outlet /></main>
    </div>
  )
}
