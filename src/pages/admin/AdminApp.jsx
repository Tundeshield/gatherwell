import { Navigate, NavLink, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { LayoutDashboard, Building2, Users, LogOut, ExternalLink } from 'lucide-react'
import { useSession } from '../../lib/session'
import { PageLoader } from '../../components/ui'
import Logo from '../../components/Logo'
import { isAdminHost, adminPath, appUrl } from '../../lib/host'
import AdminOverview from './AdminOverview'
import AdminChurches from './AdminChurches'
import AdminChurch from './AdminChurch'
import AdminUsers from './AdminUsers'
import AdminUser from './AdminUser'

function Layout() {
  const { me, logout } = useSession()
  const navigate = useNavigate()
  const link = ({ isActive }) => `flex items-center gap-3 rounded-lg px-3 py-2 text-[14px] font-medium transition-colors ${isActive ? 'bg-white/10 text-white' : 'text-brand-100 hover:bg-white/5 hover:text-white'}`
  const items = [
    { to: adminPath('/'), label: 'Overview', icon: LayoutDashboard, end: true },
    { to: adminPath('/churches'), label: 'Churches', icon: Building2 },
    { to: adminPath('/users'), label: 'Users', icon: Users },
  ]
  return (
    <div className="min-h-screen bg-ivory lg:flex">
      <aside className="bg-brand-900 text-white lg:fixed lg:inset-y-0 lg:flex lg:w-60 lg:flex-col">
        <div className="flex items-center justify-between px-5 py-4 lg:block lg:py-5">
          <Logo size={28} onDark subtitle="Admin console" />
          <button type="button" onClick={async () => { await logout(); navigate(isAdminHost ? '/login' : '/login') }} className="rounded-lg p-2 text-brand-100 hover:bg-white/10 lg:hidden" aria-label="Sign out"><LogOut size={17} /></button>
        </div>
        <nav className="flex gap-1 overflow-x-auto px-3 pb-3 lg:flex-1 lg:flex-col lg:gap-0.5 lg:pb-0" aria-label="Admin">
          {items.map(({ to, label, icon: Icon, end }) => (
            <NavLink key={label} to={to} end={end} className={link}><Icon size={18} strokeWidth={1.9} />{label}</NavLink>
          ))}
        </nav>
        <div className="hidden border-t border-white/10 px-3 py-3 lg:block">
          <a href={appUrl()} className={link({ isActive: false })}><ExternalLink size={17} />Open GatherHQ</a>
          <div className="flex items-center gap-2 px-3 pt-2">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{me.user.name}</div>
              <div className="truncate text-xs text-brand-200">{me.user.email}</div>
            </div>
            <button type="button" onClick={async () => { await logout(); navigate('/login') }} aria-label="Sign out" title="Sign out" className="rounded-lg p-2 text-brand-100 hover:bg-white/10 hover:text-white"><LogOut size={17} /></button>
          </div>
        </div>
      </aside>
      <main className="min-w-0 flex-1 lg:pl-60">
        <div className="mx-auto max-w-[1180px] px-4 py-6 sm:px-6 lg:py-8"><Outlet /></div>
      </main>
    </div>
  )
}

function NotAllowed() {
  const { me, logout } = useSession()
  const navigate = useNavigate()
  return (
    <div className="flex min-h-screen items-center justify-center bg-ivory px-4">
      <div className="panel max-w-md px-7 py-8 text-center">
        <Logo size={30} className="justify-center" />
        <h1 className="mt-5 text-lg font-semibold text-ink">This area is for the GatherHQ team</h1>
        <p className="mt-2 text-sm text-mist-500">You’re signed in as {me.user.email}, which doesn’t have admin access.</p>
        <div className="mt-5 flex justify-center gap-2">
          <a href={appUrl()} className="rounded-lg bg-brand-700 px-4 py-2 text-sm font-medium text-white hover:bg-brand-800">Go to my church</a>
          <button type="button" onClick={async () => { await logout(); navigate('/login') }} className="rounded-lg border border-mist-200 px-4 py-2 text-sm font-medium text-ink hover:border-mist-300">Sign out</button>
        </div>
      </div>
    </div>
  )
}

export default function AdminApp() {
  const { me } = useSession()
  const location = useLocation()
  if (me === undefined) return <div className="flex min-h-screen items-center justify-center"><PageLoader /></div>
  if (!me) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />
  if (!me.user.isPlatformAdmin) return <NotAllowed />
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<AdminOverview />} />
        <Route path="churches" element={<AdminChurches />} />
        <Route path="churches/:id" element={<AdminChurch />} />
        <Route path="users" element={<AdminUsers />} />
        <Route path="users/:id" element={<AdminUser />} />
        <Route path="*" element={<Navigate to={adminPath('/')} replace />} />
      </Route>
    </Routes>
  )
}
