// The GatherHQ team's business console. Its own sign-in and session (separate from any church account).
import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { Navigate, NavLink, Outlet, Route, Routes, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { LayoutDashboard, Building2, Users, Receipt, Repeat, LineChart, Wallet, MessagesSquare, PlugZap, Activity, ScrollText, Settings, LogOut, Menu, X } from 'lucide-react'
import { api } from '../../lib/api'
import { signInWithPassword, sendReset } from '../../lib/firebase'
import { Button, Input, Notice, PageLoader } from '../../components/ui'
import Logo from '../../components/Logo'
import { adminPath, appUrl } from '../../lib/host'
import AdminOverview from './AdminOverview'
import AdminChurches from './AdminChurches'
import AdminChurch from './AdminChurch'
import AdminUsers from './AdminUsers'
import AdminUser from './AdminUser'
import AdminComms from './AdminComms'
import { AdminPayments, AdminSubscriptions, AdminRevenue } from './AdminMoney'
import AdminExpenses from './AdminExpenses'
import { AdminMessaging, AdminHealth, AdminAudit, AdminSettings } from './AdminOps'

const AdminContext = createContext(null)
export const useAdmin = () => useContext(AdminContext)

function AdminSession({ children }) {
  const [me, setMe] = useState(undefined)
  const refresh = useCallback(async () => {
    try { const d = await api.get('/admin/me'); setMe(d); return d } catch (e) { if (e.status === 401 || e.status === 403 || e.status === 404) { setMe(null); return null } throw e }
  }, [])
  useEffect(() => {
    refresh().catch(() => setMe(null))
    const off = () => setMe(null)
    window.addEventListener('gw:unauthorized', off)
    return () => window.removeEventListener('gw:unauthorized', off)
  }, [refresh])
  const logout = async () => { await api.post('/admin/auth/logout').catch(() => {}); setMe(null) }
  return <AdminContext.Provider value={{ me, refresh, logout }}>{children}</AdminContext.Provider>
}

function AdminLogin() {
  const { refresh } = useAdmin()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  async function submit(e) {
    e.preventDefault(); setBusy(true); setError(''); setNotice('')
    try {
      await signInWithPassword(email, password, '/admin/auth/session')
      await refresh()
      const next = params.get('next')
      navigate(next && next.startsWith('/') && !next.startsWith('//') ? next : adminPath('/'), { replace: true })
    } catch (err) { setError(err.message); setPassword('') } finally { setBusy(false) }
  }
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#0b1220] px-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl bg-white px-7 py-8 shadow-xl">
        <Logo size={30} subtitle="Admin console" />
        <h1 className="mt-6 text-xl font-semibold text-ink">Sign in</h1>
        <p className="mt-1 text-sm text-mist-500">For authorised GatherHQ administrators only. Church accounts can’t sign in here.</p>
        {error && <Notice tone="danger" className="mt-4">{error}</Notice>}
        {notice && <Notice tone="success" className="mt-4">{notice}</Notice>}
        <div className="mt-5">
          <Input label="Email" type="email" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} required />
          <Input label="Password" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required />
        </div>
        <Button type="submit" className="w-full" loading={busy}>Sign in</Button>
        <button type="button" className="mt-3 w-full text-center text-sm text-mist-500 hover:text-ink" onClick={async () => { if (!email) return setError('Enter your email first.'); await sendReset(email).catch(() => {}); setNotice('If that account exists, a reset link is on its way.') }}>Forgot password?</button>
        <p className="mt-5 text-center text-xs text-mist-400">Sessions end after 12 hours. Every sign-in is recorded.</p>
      </form>
    </div>
  )
}

const NAV = [
  ['/', 'Overview', LayoutDashboard, true], ['/churches', 'Churches', Building2], ['/users', 'Users', Users],
  ['/payments', 'Orders & payments', Receipt], ['/subscriptions', 'Subscriptions', Repeat], ['/revenue', 'Revenue & analytics', LineChart],
  ['/expenses', 'Expenses', Wallet], ['/messaging', 'Messaging', MessagesSquare], ['/providers', 'Providers', PlugZap],
  ['/health', 'Platform health', Activity], ['/audit', 'Audit log', ScrollText], ['/settings', 'Settings', Settings],
]

function Layout() {
  const { me, logout } = useAdmin()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const [open, setOpen] = useState(false)
  useEffect(() => setOpen(false), [pathname])
  const link = ({ isActive }) => `flex items-center gap-3 rounded-lg px-3 py-2 text-[14px] font-medium transition-colors ${isActive ? 'bg-white/10 text-white' : 'text-slate-300 hover:bg-white/5 hover:text-white'}`
  return (
    <div className="min-h-screen bg-[#f4f6f9] lg:flex">
      <aside className={`bg-[#0b1220] text-white lg:fixed lg:inset-y-0 lg:flex lg:w-60 lg:flex-col ${open ? '' : ''}`}>
        <div className="flex items-center justify-between px-5 py-4 lg:py-5">
          <Logo size={26} onDark subtitle="Business console" />
          <button type="button" onClick={() => setOpen(o => !o)} className="rounded-lg p-2 text-slate-300 hover:bg-white/10 lg:hidden" aria-label={open ? 'Close menu' : 'Open menu'} aria-expanded={open}>{open ? <X size={18} /> : <Menu size={18} />}</button>
        </div>
        <nav className={`${open ? 'block' : 'hidden'} space-y-0.5 px-3 pb-3 lg:block lg:flex-1 lg:overflow-y-auto`} aria-label="Admin">
          {NAV.map(([to, label, Icon, end]) => <NavLink key={to} to={adminPath(to)} end={end} className={link}><Icon size={17} strokeWidth={1.9} />{label}</NavLink>)}
        </nav>
        <div className={`${open ? 'block' : 'hidden'} border-t border-white/10 px-3 py-3 lg:block`}>
          {me.env !== 'production' && <p className="mb-2 rounded-md bg-amber-400/15 px-3 py-1.5 text-xs text-amber-200">{me.env} · Stripe {me.stripe || 'not connected'}</p>}
          <div className="flex items-center gap-2 px-3">
            <div className="min-w-0 flex-1"><div className="truncate text-sm font-medium">{me.user.name}</div><div className="truncate text-xs text-slate-400">{me.user.email}</div></div>
            <button type="button" onClick={async () => { await logout(); navigate(adminPath('/login')) }} aria-label="Sign out" title="Sign out" className="rounded-lg p-2 text-slate-300 hover:bg-white/10 hover:text-white"><LogOut size={17} /></button>
          </div>
          <a href={appUrl()} className="mt-2 block px-3 text-xs text-slate-400 hover:text-white">Open the church app →</a>
        </div>
      </aside>
      <main className="min-w-0 flex-1 lg:pl-60">
        <div className="mx-auto max-w-[1240px] px-4 py-6 sm:px-6 lg:py-8"><Outlet /></div>
      </main>
    </div>
  )
}

function Gate() {
  const { me } = useAdmin()
  const location = useLocation()
  if (me === undefined) return <div className="flex min-h-screen items-center justify-center"><PageLoader /></div>
  if (location.pathname.endsWith('/login')) return me ? <Navigate to={adminPath('/')} replace /> : <AdminLogin />
  if (!me) return <Navigate to={`${adminPath('/login')}?next=${encodeURIComponent(location.pathname + location.search)}`} replace />
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<AdminOverview />} />
        <Route path="churches" element={<AdminChurches />} />
        <Route path="churches/:id" element={<AdminChurch />} />
        <Route path="users" element={<AdminUsers />} />
        <Route path="users/:id" element={<AdminUser />} />
        <Route path="payments" element={<AdminPayments />} />
        <Route path="subscriptions" element={<AdminSubscriptions />} />
        <Route path="revenue" element={<AdminRevenue />} />
        <Route path="expenses" element={<AdminExpenses />} />
        <Route path="messaging" element={<AdminMessaging />} />
        <Route path="providers" element={<AdminComms />} />
        <Route path="health" element={<AdminHealth />} />
        <Route path="audit" element={<AdminAudit />} />
        <Route path="settings" element={<AdminSettings />} />
        <Route path="*" element={<Navigate to={adminPath('/')} replace />} />
      </Route>
    </Routes>
  )
}

export default function AdminApp() {
  return <AdminSession><Gate /></AdminSession>
}
