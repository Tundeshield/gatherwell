import { lazy, Suspense } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { SessionProvider, useSession } from './lib/session'
import { ToastProvider, ConfirmProvider, PageLoader } from './components/ui'
import AppShell from './components/AppShell'

const Landing = lazy(() => import('./pages/public/Landing'))
const Login = lazy(() => import('./pages/public/Login'))
const Signup = lazy(() => import('./pages/public/Signup'))
const AcceptInvite = lazy(() => import('./pages/public/AcceptInvite'))
const CheckIn = lazy(() => import('./pages/public/CheckIn'))
const EventRegister = lazy(() => import('./pages/public/EventRegister'))
const NoOrg = lazy(() => import('./pages/public/NoOrg'))

const Overview = lazy(() => import('./pages/app/Overview'))
const People = lazy(() => import('./pages/app/People'))
const PersonDetail = lazy(() => import('./pages/app/PersonDetail'))
const Attendance = lazy(() => import('./pages/app/Attendance'))
const SessionDetail = lazy(() => import('./pages/app/SessionDetail'))
const Events = lazy(() => import('./pages/app/Events'))
const EventDetail = lazy(() => import('./pages/app/EventDetail'))
const FollowUps = lazy(() => import('./pages/app/FollowUps'))
const Reports = lazy(() => import('./pages/app/Reports'))
const Messages = lazy(() => import('./pages/app/Messages'))
const MessageEditor = lazy(() => import('./pages/app/MessageEditor'))
const Settings = lazy(() => import('./pages/app/Settings'))
const Platform = lazy(() => import('./pages/app/Platform'))

function RequireAuth({ children, cap, platform = false }) {
  const { me, can } = useSession()
  const location = useLocation()
  if (me === undefined) return <div className="flex min-h-screen items-center justify-center"><PageLoader /></div>
  if (!me) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />
  if (platform) return me.user.isPlatformAdmin ? children : <Navigate to="/app" replace />
  if (!me.org) return <Navigate to="/welcome" replace />
  if (cap && !can(cap)) return <Navigate to="/app" replace />
  return children
}

function GuestOnly({ children }) {
  const { me } = useSession()
  if (me === undefined) return <div className="flex min-h-screen items-center justify-center"><PageLoader /></div>
  if (me) return <Navigate to={me.org ? '/app' : '/welcome'} replace />
  return children
}

export default function App() {
  return (
    <SessionProvider>
      <ToastProvider>
        <ConfirmProvider>
          <Suspense fallback={<div className="flex min-h-screen items-center justify-center"><PageLoader /></div>}>
            <Routes>
              <Route path="/" element={<Landing />} />
              <Route path="/login" element={<GuestOnly><Login /></GuestOnly>} />
              <Route path="/signup" element={<GuestOnly><Signup /></GuestOnly>} />
              <Route path="/invite/:token" element={<AcceptInvite />} />
              <Route path="/c/:token" element={<CheckIn />} />
              <Route path="/e/:token" element={<EventRegister />} />
              <Route path="/welcome" element={<NoOrg />} />
              <Route path="/platform" element={<RequireAuth platform><Platform /></RequireAuth>} />

              <Route path="/app" element={<RequireAuth><AppShell /></RequireAuth>}>
                <Route index element={<Overview />} />
                <Route path="people" element={<RequireAuth cap="people.view"><People /></RequireAuth>} />
                <Route path="people/:id" element={<RequireAuth cap="people.view"><PersonDetail /></RequireAuth>} />
                <Route path="attendance" element={<RequireAuth cap="attendance.view"><Attendance /></RequireAuth>} />
                <Route path="attendance/:id" element={<RequireAuth cap="attendance.view"><SessionDetail /></RequireAuth>} />
                <Route path="events" element={<RequireAuth cap="events.view"><Events /></RequireAuth>} />
                <Route path="events/:id" element={<RequireAuth cap="events.view"><EventDetail /></RequireAuth>} />
                <Route path="follow-ups" element={<RequireAuth cap="followups.view"><FollowUps /></RequireAuth>} />
                <Route path="reports" element={<RequireAuth cap="reports.view"><Reports /></RequireAuth>} />
                <Route path="messages" element={<RequireAuth cap="messages.manage"><Messages /></RequireAuth>} />
                <Route path="messages/new" element={<RequireAuth cap="messages.manage"><MessageEditor /></RequireAuth>} />
                <Route path="messages/:id" element={<RequireAuth cap="messages.manage"><MessageEditor /></RequireAuth>} />
                <Route path="settings" element={<Settings />} />
              </Route>
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
        </ConfirmProvider>
      </ToastProvider>
    </SessionProvider>
  )
}
