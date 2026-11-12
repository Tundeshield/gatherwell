import { Suspense } from 'react'
import { lazyPage } from './lib/lazyPage'
import PageErrorBoundary from './components/PageErrorBoundary'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { SessionProvider, useSession } from './lib/session'
import { ToastProvider, ConfirmProvider, PageLoader } from './components/ui'
import AppShell from './components/AppShell'

const Landing = lazyPage(() => import('./pages/public/Landing'))
const Login = lazyPage(() => import('./pages/public/Login'))
const Signup = lazyPage(() => import('./pages/public/Signup'))
const AcceptInvite = lazyPage(() => import('./pages/public/AcceptInvite'))
const CheckIn = lazyPage(() => import('./pages/public/CheckIn'))
const EventRegister = lazyPage(() => import('./pages/public/EventRegister'))
const NoOrg = lazyPage(() => import('./pages/public/NoOrg'))
const Legal = lazyPage(() => import('./pages/public/Legal'))
const Pricing = lazyPage(() => import('./pages/public/Pricing'))

const Overview = lazyPage(() => import('./pages/app/Overview'))
const People = lazyPage(() => import('./pages/app/People'))
const PersonDetail = lazyPage(() => import('./pages/app/PersonDetail'))
const Attendance = lazyPage(() => import('./pages/app/Attendance'))
const SessionDetail = lazyPage(() => import('./pages/app/SessionDetail'))
const Events = lazyPage(() => import('./pages/app/Events'))
const EventDetail = lazyPage(() => import('./pages/app/EventDetail'))
const FollowUps = lazyPage(() => import('./pages/app/FollowUps'))
const Reports = lazyPage(() => import('./pages/app/Reports'))
const CommsLayout = lazyPage(() => import('./pages/app/comms/shared').then(m => ({ default: m.CommsLayout })))
const CommsOverview = lazyPage(() => import('./pages/app/comms/CommsOverview'))
const Compose = lazyPage(() => import('./pages/app/comms/Compose'))
const MessagesList = lazyPage(() => import('./pages/app/comms/Messages').then(m => ({ default: m.MessagesList })))
const MessageDetail = lazyPage(() => import('./pages/app/comms/Messages').then(m => ({ default: m.MessageDetail })))
const WorkflowsList = lazyPage(() => import('./pages/app/comms/Workflows').then(m => ({ default: m.WorkflowsList })))
const WorkflowBuilder = lazyPage(() => import('./pages/app/comms/Workflows').then(m => ({ default: m.WorkflowBuilder })))
const Templates = lazyPage(() => import('./pages/app/comms/Templates'))
const Channels = lazyPage(() => import('./pages/app/comms/Channels'))
const WhatsAppSend = lazyPage(() => import('./pages/app/WhatsAppSend'))
const Settings = lazyPage(() => import('./pages/app/Settings'))
const AdminApp = lazyPage(() => import('./pages/admin/AdminApp'))
const Children = lazyPage(() => import('./pages/app/Children'))
const ChildrenCheckin = lazyPage(() => import('./pages/app/ChildrenCheckin'))
const ChildrenRoom = lazyPage(() => import('./pages/app/ChildrenRoom'))
const ChildrenPickup = lazyPage(() => import('./pages/app/ChildrenPickup'))
import { isAdminHost } from './lib/host'
import EnvBanner from './components/EnvBanner'

function MessageRedirect() {
  const id = useLocation().pathname.split('/').pop()
  return <Navigate to={`/app/communications/messages/${id}`} replace />
}

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

// Children's church pages exist only when the church has switched it on.
function RequireChildren({ children, cap = 'children.view' }) {
  const { me, can } = useSession()
  if (!me?.org?.childrenEnabled || !can(cap)) return <Navigate to="/app" replace />
  return children
}

// The children's team only uses children's church, so they land there.
function Home() {
  const { me, can } = useSession()
  if (me.org?.childrenEnabled && can('children.view') && !can('reports.view') && !can('attendance.view')) return <Navigate to="/app/children" replace />
  return <Overview />
}

function AdminGuest({ children }) {
  const { me } = useSession()
  if (me === undefined) return <div className="flex min-h-screen items-center justify-center"><PageLoader /></div>
  if (me) return <Navigate to="/" replace />
  return children
}

function GuestOnly({ children }) {
  const { me } = useSession()
  if (me === undefined) return <div className="flex min-h-screen items-center justify-center"><PageLoader /></div>
  if (me) return <Navigate to={me.org ? '/app' : '/welcome'} replace />
  return children
}

export default function App() {
  const { pathname } = useLocation()
  return (
    <SessionProvider>
      <EnvBanner />
      <ToastProvider>
        <ConfirmProvider>
          <PageErrorBoundary resetKey={pathname}>
          <Suspense fallback={<div className="flex min-h-screen items-center justify-center"><PageLoader /></div>}>
            {isAdminHost ? (
              <Routes>
                <Route path="/login" element={<AdminGuest><Login /></AdminGuest>} />
                <Route path="/*" element={<AdminApp />} />
              </Routes>
            ) : (
            <Routes>
              <Route path="/" element={<Landing />} />
              <Route path="/legal/:doc" element={<Legal />} />
              <Route path="/pricing" element={<Pricing />} />
              <Route path="/privacy" element={<Navigate to="/legal/privacy" replace />} />
              <Route path="/terms" element={<Navigate to="/legal/terms" replace />} />
              <Route path="/login" element={<GuestOnly><Login /></GuestOnly>} />
              <Route path="/signup" element={<GuestOnly><Signup /></GuestOnly>} />
              <Route path="/invite/:token" element={<AcceptInvite />} />
              <Route path="/c/:token" element={<CheckIn />} />
              <Route path="/e/:token" element={<EventRegister />} />
              <Route path="/welcome" element={<NoOrg />} />
              <Route path="/platform" element={<Navigate to="/admin" replace />} />
              <Route path="/admin/*" element={<AdminApp />} />

              <Route path="/app/children/checkin" element={<RequireAuth><RequireChildren cap="children.checkin"><ChildrenCheckin /></RequireChildren></RequireAuth>} />
              <Route path="/app/children/pickup" element={<RequireAuth><RequireChildren cap="children.checkin"><ChildrenPickup /></RequireChildren></RequireAuth>} />
              <Route path="/app/children/rooms/:id" element={<RequireAuth><RequireChildren><ChildrenRoom /></RequireChildren></RequireAuth>} />
              <Route path="/app" element={<RequireAuth><AppShell /></RequireAuth>}>
                <Route index element={<Home />} />
                <Route path="children" element={<RequireChildren><Children /></RequireChildren>} />
                <Route path="people" element={<RequireAuth cap="people.view"><People /></RequireAuth>} />
                <Route path="people/:id" element={<RequireAuth cap="people.view"><PersonDetail /></RequireAuth>} />
                <Route path="attendance" element={<RequireAuth cap="attendance.view"><Attendance /></RequireAuth>} />
                <Route path="attendance/:id" element={<RequireAuth cap="attendance.view"><SessionDetail /></RequireAuth>} />
                <Route path="events" element={<RequireAuth cap="events.view"><Events /></RequireAuth>} />
                <Route path="events/:id" element={<RequireAuth cap="events.view"><EventDetail /></RequireAuth>} />
                <Route path="follow-ups" element={<RequireAuth cap="followups.view"><FollowUps /></RequireAuth>} />
                <Route path="reports" element={<RequireAuth cap="reports.view"><Reports /></RequireAuth>} />
                <Route path="communications" element={<RequireAuth cap="messages.manage"><CommsLayout /></RequireAuth>}>
                  <Route index element={<CommsOverview />} />
                  <Route path="messages" element={<MessagesList />} />
                  <Route path="workflows" element={<WorkflowsList />} />
                  <Route path="templates" element={<Templates />} />
                  <Route path="channels" element={<Channels />} />
                </Route>
                <Route path="communications/send" element={<RequireAuth cap="messages.manage"><Compose /></RequireAuth>} />
                <Route path="communications/messages/:id" element={<RequireAuth cap="messages.manage"><MessageDetail /></RequireAuth>} />
                <Route path="communications/messages/:id/edit" element={<RequireAuth cap="messages.manage"><Compose /></RequireAuth>} />
                <Route path="communications/workflows/:id" element={<RequireAuth cap="messages.manage"><WorkflowBuilder /></RequireAuth>} />
                <Route path="messages" element={<Navigate to="/app/communications/messages" replace />} />
                <Route path="messages/new" element={<Navigate to="/app/communications/send" replace />} />
                <Route path="messages/:id" element={<MessageRedirect />} />
                <Route path="messages/:id/whatsapp" element={<RequireAuth cap="messages.manage"><WhatsAppSend /></RequireAuth>} />
                <Route path="settings" element={<Settings />} />
              </Route>
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
            )}
          </Suspense>
          </PageErrorBoundary>
        </ConfirmProvider>
      </ToastProvider>
    </SessionProvider>
  )
}
