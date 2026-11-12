import { adminUrl } from '../lib/host'
import { Suspense, useEffect, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { LayoutDashboard, Users, CalendarCheck, HeartHandshake, CalendarDays, MessageSquare, BarChart3, Settings, LogOut, Menu, X, ChevronsUpDown, Check, Building2, ShieldCheck, Baby } from 'lucide-react'
import { useSession } from '../lib/session'
import { PageLoader } from './ui'
import Logo from './Logo'
import PageErrorBoundary from './PageErrorBoundary'

const NAV = [
  { to: '/app', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: '/app/people', label: 'People', icon: Users, cap: 'people.view' },
  { to: '/app/attendance', label: 'Attendance', icon: CalendarCheck, cap: 'attendance.view' },
  { to: '/app/children', label: 'Children', icon: Baby, cap: 'children.view', children: true },
  { to: '/app/follow-ups', label: 'Follow-ups', icon: HeartHandshake, cap: 'followups.view' },
  { to: '/app/events', label: 'Events', icon: CalendarDays, cap: 'events.view' },
  { to: '/app/communications', label: 'Communications', icon: MessageSquare, cap: 'messages.manage' },
  { to: '/app/reports', label: 'Reports', icon: BarChart3, cap: 'reports.view' },
]

function BranchSwitcher() {
  const { branches, branch, setBranch, multiBranch, me } = useSession()
  const [open, setOpen] = useState(false)
  if (!multiBranch) return null
  const scoped = !!me.membership?.branchIds
  const label = branch === 'all' ? (scoped ? 'All my branches' : 'All branches') : branches.find(b => b.id === branch)?.name
  return (
    <div className="relative px-3 pb-2">
      <button type="button" onClick={() => setOpen(o => !o)} aria-haspopup="listbox" aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-lg border border-mist-200 bg-white px-3 py-2 text-left text-sm hover:border-mist-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
        <Building2 size={15} className="shrink-0 text-mist-400" />
        <span className="min-w-0 flex-1 truncate font-medium text-ink">{label}</span>
        <ChevronsUpDown size={14} className="text-mist-400" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <ul role="listbox" className="animate-in absolute left-3 right-3 z-20 mt-1 max-h-72 overflow-auto rounded-lg border border-mist-200 bg-white py-1 shadow-pop">
            {[{ id: 'all', name: scoped ? 'All my branches' : 'All branches' }, ...branches].map(b => (
              <li key={b.id}>
                <button type="button" role="option" aria-selected={branch === b.id} onClick={() => { setBranch(b.id); setOpen(false) }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-mist-50">
                  <span className="flex-1 truncate">{b.name}{b.status === 'archived' && <span className="ml-1 text-xs text-mist-400">(archived)</span>}</span>
                  {branch === b.id && <Check size={15} className="text-brand-700" />}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

function OrgSwitcher() {
  const { me, refresh } = useSession()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const multi = me.orgs.length > 1
  async function switchTo(id) {
    setOpen(false)
    await fetch('/api/me/switch-org', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ orgId: id }) })
    await refresh()
    navigate('/app')
  }
  return (
    <div className="relative">
      <button type="button" disabled={!multi} onClick={() => setOpen(o => !o)}
        className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left enabled:hover:bg-mist-50">
        <Logo size={30} showName={false} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-semibold text-ink">{me.org.name}</span>
          <span className="block truncate text-xs text-mist-400">GatherHQ</span>
        </span>
        {multi && <ChevronsUpDown size={14} className="text-mist-400" />}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="animate-in absolute left-0 right-0 z-20 mt-1 rounded-lg border border-mist-200 bg-white py-1 shadow-pop">
            {me.orgs.map(o => (
              <button key={o.id} type="button" onClick={() => switchTo(o.id)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-mist-50">
                <span className="flex-1 truncate">{o.name}</span>
                {o.id === me.org.id && <Check size={15} className="text-brand-700" />}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function SidebarContent({ onNavigate }) {
  const { me, can, logout } = useSession()
  const navigate = useNavigate()
  const items = NAV.filter(i => (!i.cap || can(i.cap)) && (!i.children || me.org?.childrenEnabled) && !(i.end && !can('reports.view') && !can('attendance.view') && can('children.view')))
  const link = ({ isActive }) =>
    `flex items-center gap-3 rounded-lg px-3 py-2 text-[14px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${isActive ? 'bg-brand-50 text-brand-700' : 'text-mist-600 hover:bg-mist-50 hover:text-ink'}`
  return (
    <div className="flex h-full flex-col">
      <div className="px-3 pb-3 pt-4"><OrgSwitcher /></div>
      <BranchSwitcher />
      <nav className="flex-1 space-y-0.5 overflow-y-auto px-3 py-2" aria-label="Main">
        {items.map(({ to, label, icon: Icon, end }) => (
          <NavLink key={to} to={to} end={end} className={link} onClick={onNavigate}>
            <Icon size={18} strokeWidth={1.9} />{label}
          </NavLink>
        ))}
      </nav>
      <div className="space-y-0.5 border-t border-mist-200 px-3 py-3">
        {me.user.isPlatformAdmin && <a href={adminUrl()} className={link({ isActive: false })}><ShieldCheck size={18} strokeWidth={1.9} />GatherHQ admin</a>}
        <NavLink to="/app/settings" className={link} onClick={onNavigate}><Settings size={18} strokeWidth={1.9} />Settings</NavLink>
        <div className="flex items-center gap-2 px-3 pt-2">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-ink">{me.user.name}</div>
            <div className="truncate text-xs text-mist-400">{me.membership?.roleLabel}</div>
          </div>
          <button type="button" onClick={async () => { await logout(); navigate('/login') }} aria-label="Sign out" title="Sign out"
            className="rounded-lg p-2 text-mist-400 hover:bg-mist-100 hover:text-ink"><LogOut size={17} /></button>
        </div>
      </div>
    </div>
  )
}

export default function AppShell() {
  const { me, can } = useSession()
  const [open, setOpen] = useState(false)
  const location = useLocation()
  useEffect(() => setOpen(false), [location.pathname])

  return (
    <div className="min-h-screen bg-ivory">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 border-r border-mist-200 bg-white lg:block">
        <SidebarContent />
      </aside>
      <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-mist-200 bg-white/95 px-4 py-3 backdrop-blur lg:hidden">
        <button type="button" onClick={() => setOpen(true)} aria-label="Open menu" className="rounded-lg p-1.5 text-mist-600 hover:bg-mist-100"><Menu size={22} /></button>
        <span className="truncate text-[15px] font-semibold text-ink">{me.org.name}</span>
      </header>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-ink/40" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 bg-white shadow-pop" style={{ animation: 'gw-in .15s ease-out' }}>
            <button type="button" onClick={() => setOpen(false)} aria-label="Close menu" className="absolute right-3 top-4 z-10 rounded-lg p-1.5 text-mist-500 hover:bg-mist-100"><X size={20} /></button>
            <SidebarContent onNavigate={() => setOpen(false)} />
          </aside>
        </div>
      )}
      <main className="lg:pl-64">
        <BillingBanner billing={me.org.billing} owner={can('org.manage')} />
        <div className="mx-auto max-w-page px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          <PageErrorBoundary resetKey={location.pathname}>
            <Suspense fallback={<PageLoader />}><Outlet /></Suspense>
          </PageErrorBoundary>
        </div>
      </main>
    </div>
  )
}

// Reminds the church about its trial or a payment problem. Only shown once payments are connected.
function BillingBanner({ billing, owner }) {
  if (!billing?.ready) return null
  const { state, daysLeft } = billing
  let tone = 'bg-gold-50 border-gold-200 text-gold-700', text = null
  if (state === 'trialing' && daysLeft <= 7) text = `Your free trial ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'}.`
  else if (state === 'trialing') { text = `Free trial: ${daysLeft} days left, with everything included.`; tone = 'bg-brand-50 border-brand-100 text-brand-800' }
  else if (state === 'past_due') { text = 'We couldn’t take your last payment. Please update your card to keep GatherHQ running.'; tone = 'bg-red-50 border-red-200 text-red-800' }
  else if (state === 'expired') { text = `${billing.lapsed ? 'Your subscription has ended.' : 'Your free trial has ended.'} Check-in and changes are paused until you choose a plan. Everything you’ve recorded is safe, and you can still view and download it.`; tone = 'bg-red-50 border-red-200 text-red-800' }
  if (!text) return null
  return (
    <div className={`border-b px-6 py-2.5 text-center text-sm ${tone}`}>
      {text}{' '}
      {owner ? <NavLink to="/app/settings?tab=billing" className="font-semibold underline">{state === 'past_due' ? 'Update payment' : 'Choose a plan'}</NavLink> : <span>Ask your church owner to choose a plan.</span>}
    </div>
  )
}
