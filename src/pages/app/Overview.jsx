import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowUpRight, ArrowDownRight, Plus, HeartHandshake, UserPlus, Users, CalendarDays, CalendarCheck, Upload, Building2, UserCog, CheckCircle2, Circle, ChevronRight, Info } from 'lucide-react'
import { api, qs } from '../../lib/api'
import { useSession, useBranchParam } from '../../lib/session'
import { useLoad, PageLoader, ErrorState, Button, Badge } from '../../components/ui'
import { StackedBars, CHART, fillWeeks } from '../../components/Chart'
import { fmtDay, fmtDateTime, fmtNum, pctChange, relative } from '../../lib/format'

function greeting() {
  const h = new Date().getHours()
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'
}

const ACTIVITY = {
  'gathering.created': 'created a session', 'gathering.closed': 'closed a session', 'gathering.open': 'opened a session',
  'person.created': 'added a person', 'people.imported': 'imported people', 'event.created': 'created an event',
  'team.invited': 'invited a team member', 'team.invite_accepted': 'joined the team', 'followup.done': 'completed a follow-up',
  'followup.absence_created': 'started absence follow-ups', 'branch.created': 'added a branch', 'org.created': 'created the church account',
  'person.status_changed': "updated someone's status", 'message.drafted': 'drafted a message', 'followup.created': 'created a follow-up',
  'checkin.removed': 'removed a check-in', 'event.cancelled': 'cancelled an event', 'org.updated': 'updated church settings',
}

function Attention({ to, icon: Icon, count, label, tone = 'neutral', description }) {
  const tones = { danger: 'bg-red-50 text-red-700', warning: 'bg-amber-50 text-amber-800', brand: 'bg-brand-50 text-brand-700', gold: 'bg-gold-100 text-gold-700', neutral: 'bg-mist-100 text-mist-600' }
  return (
    <Link to={to} className="group flex items-center gap-3.5 px-5 py-3.5 transition-colors hover:bg-mist-50 focus-visible:bg-mist-50 focus-visible:outline-none">
      <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${tones[tone]}`}><Icon size={18} /></span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-ink"><span className="tabular">{fmtNum(count)}</span> {label}</span>
        {description && <span className="block truncate text-xs text-mist-500">{description}</span>}
      </span>
      <ChevronRight size={16} className="text-mist-300 transition-transform group-hover:translate-x-0.5" />
    </Link>
  )
}

function GettingStarted({ data }) {
  const { can, multiBranch } = useSession()
  const steps = [
    can('attendance.manage') && { done: !!data.latest || data.upcomingSessions?.length > 0, label: 'Create your first attendance session', hint: 'Get a QR code people scan to check in.', to: '/app/attendance?new=1', icon: CalendarCheck },
    can('people.edit') && { done: (data.people?.members || 0) + (data.people?.visitors || 0) > 0, label: 'Add or import your people', hint: 'Upload a spreadsheet — duplicates are caught for you.', to: '/app/people?import=1', icon: Upload },
    can('team.manage') && { done: false, label: 'Invite your team', hint: 'Give ushers and leaders just the access they need.', to: '/app/settings?tab=team', icon: UserCog },
    can('branches.create') && { done: multiBranch, label: 'Add your other branches', hint: 'Each branch gets its own sessions and reports.', to: '/app/settings?tab=branches', icon: Building2 },
  ].filter(Boolean)
  if (!steps.length || steps.every(s => s.done)) return null
  return (
    <section className="panel mb-6 overflow-hidden">
      <div className="border-b border-mist-100 px-5 py-4">
        <h2 className="text-[15px] font-semibold text-ink">Set up your church</h2>
        <p className="text-sm text-mist-500">{steps.filter(s => s.done).length} of {steps.length} done</p>
      </div>
      <ul className="divide-y divide-mist-100">
        {steps.map(s => (
          <li key={s.label}>
            <Link to={s.to} className="flex items-center gap-3.5 px-5 py-3.5 hover:bg-mist-50">
              {s.done ? <CheckCircle2 size={20} className="text-brand-600" /> : <Circle size={20} className="text-mist-300" />}
              <span className="flex-1">
                <span className={`block text-sm font-medium ${s.done ? 'text-mist-400 line-through' : 'text-ink'}`}>{s.label}</span>
                {!s.done && <span className="block text-xs text-mist-500">{s.hint}</span>}
              </span>
              {!s.done && <ChevronRight size={16} className="text-mist-300" />}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}

function LatestService({ data, tz }) {
  const { latest, previous, today } = data
  if (!latest) return null
  const change = previous ? pctChange(latest.attendance, previous.attendance) : null
  const up = change !== null && change >= 0
  return (
    <section className="panel mb-6 grid gap-0 overflow-hidden md:grid-cols-[1.6fr_1fr]">
      <Link to={`/app/attendance/${latest.id}`} className="group block px-6 py-6 hover:bg-mist-50/50">
        <div className="flex items-center gap-2 text-sm text-mist-500">
          <span>Latest session</span><span aria-hidden>·</span><span>{fmtDay(latest.starts_at, tz)}</span>
          {data.multiBranch && <><span aria-hidden>·</span><span>{latest.branch_name}</span></>}
        </div>
        <h2 className="mt-1 text-lg font-semibold text-ink group-hover:text-brand-700">{latest.name}</h2>
        <div className="mt-4 flex flex-wrap items-end gap-x-6 gap-y-3">
          <div>
            <div className="tabular text-[44px] font-semibold leading-none tracking-tight text-ink">{fmtNum(latest.attendance)}</div>
            <div className="mt-1.5 text-sm text-mist-500">checked in</div>
          </div>
          {change !== null && (
            <div className="pb-1">
              <div className={`inline-flex items-center gap-1 text-sm font-medium ${up ? 'text-green-800' : 'text-red-700'}`}>
                {up ? <ArrowUpRight size={16} /> : <ArrowDownRight size={16} />}{Math.abs(change)}%
              </div>
              <div className="text-xs text-mist-500">vs {fmtNum(previous.attendance)} at {previous.name}, {fmtDay(previous.starts_at, tz)}</div>
            </div>
          )}
        </div>
      </Link>
      <div className="grid grid-cols-2 border-t border-mist-100 md:grid-cols-1 md:border-l md:border-t-0">
        <div className="border-r border-mist-100 px-6 py-5 md:border-b md:border-r-0">
          <div className="tabular text-2xl font-semibold text-ink">{fmtNum(latest.first_timers)}</div>
          <div className="text-sm text-mist-500">first-time visitors at this session</div>
        </div>
        <div className="px-6 py-5">
          <div className="tabular text-2xl font-semibold text-ink">{fmtNum(today)}</div>
          <div className="text-sm text-mist-500">check-ins today, all sessions</div>
        </div>
      </div>
    </section>
  )
}

export default function Overview() {
  const { me, can, tz, multiBranch, branch, branchName } = useSession()
  const branchParam = useBranchParam()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const { data, error, loading, reload } = useLoad(() => api.get(`/overview${qs({ branch: branchParam })}`), [branchParam])

  if (loading && !data) return <PageLoader />
  if (error) return <ErrorState error={error} onRetry={reload} />

  const weeks = data.trend ? fillWeeks(data.trend, 12) : []
  const fu = data.followups
  const scopeLabel = branch === 'all' ? (multiBranch ? 'All branches' : me.branches[0]?.name) : branchName(branch)

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[26px] font-semibold leading-tight text-ink">{greeting()}, {me.user.name.split(' ')[0]}</h1>
          <p className="mt-1 text-sm text-mist-500">{me.org.name}{scopeLabel ? ` — ${scopeLabel}` : ''}</p>
        </div>
        {can('attendance.manage') && <Button icon={Plus} onClick={() => navigate('/app/attendance?new=1')}>New session</Button>}
      </div>

      {(params.get('welcome') || !data.latest) && <GettingStarted data={data} />}
      <LatestService data={{ ...data, multiBranch }} tz={tz} />

      <div className="grid gap-6 lg:grid-cols-[1.6fr_1fr]">
        <div className="space-y-6">
          {(fu || data.people) && (
            <section className="panel overflow-hidden">
              <div className="flex items-center justify-between border-b border-mist-100 px-5 py-4">
                <h2 className="text-[15px] font-semibold text-ink">Needs attention</h2>
                {fu?.mine > 0 && <Link to="/app/follow-ups?assignee=me" className="text-sm text-brand-700 hover:underline">{fu.mine} assigned to you</Link>}
              </div>
              <div className="divide-y divide-mist-100">
                {fu && fu.overdue > 0 && <Attention to="/app/follow-ups?bucket=overdue" icon={HeartHandshake} tone="danger" count={fu.overdue} label={`overdue follow-up${fu.overdue === 1 ? '' : 's'}`} description="Past their due date" />}
                {fu && <Attention to="/app/follow-ups?bucket=today" icon={HeartHandshake} tone={fu.due - fu.overdue > 0 ? 'warning' : 'neutral'} count={fu.due - fu.overdue} label={`follow-up${fu.due - fu.overdue === 1 ? '' : 's'} due today`} description={`${fu.open} open in total`} />}
                {data.firstTimers !== undefined && <Attention to="/app/people?firstVisit=7&sort=first_visit" icon={UserPlus} tone="gold" count={data.firstTimers} label={`first-time visitor${data.firstTimers === 1 ? '' : 's'} this week`} description={data.definitions.firstTimers} />}
                {data.returning !== undefined && data.returning > 0 && <Attention to="/app/people?status=visitor&attendance=recent&sort=last_seen" icon={Users} tone="brand" count={data.returning} label="returning visitors this week" description="Visitors on their second visit or more" />}
                {data.absent !== undefined && <Attention to="/app/follow-ups?review=absence" icon={Users} tone={data.absent > 0 ? 'warning' : 'neutral'} count={data.absent} label={`member${data.absent === 1 ? '' : 's'} not seen for ${me.org.settings?.absenceWeeks || 3}+ weeks`} description="Review and assign a caring check-in" />}
              </div>
            </section>
          )}

          {data.trend && (
            <section className="panel px-5 py-5">
              <div className="mb-4 flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-[15px] font-semibold text-ink">Attendance, last 12 weeks</h2>
                  <p className="text-sm text-mist-500">All sessions per week{scopeLabel ? `, ${scopeLabel.toLowerCase() === 'all branches' ? 'all branches' : scopeLabel}` : ''}</p>
                </div>
                {can('reports.view') && <Link to="/app/reports" className="text-sm text-brand-700 hover:underline">Reports</Link>}
              </div>
              <StackedBars
                data={weeks.map(w => ({ label: w.date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }), title: `Week of ${w.date.toLocaleDateString(undefined, { day: 'numeric', month: 'long' })}`, values: [w.attendance - w.first_timers, w.first_timers] }))}
                series={[{ name: 'Returning', color: CHART.primary }, { name: 'First-time', color: CHART.accent }]}
                emptyText="Weekly attendance will appear here after your first sessions."
              />
            </section>
          )}
        </div>

        <div className="space-y-6">
          {data.people && (
            <section className="panel grid grid-cols-2 divide-x divide-mist-100">
              <Link to="/app/people?status=member" className="px-5 py-4 hover:bg-mist-50">
                <div className="tabular text-2xl font-semibold text-ink">{fmtNum(data.people.members)}</div>
                <div className="text-sm text-mist-500">members</div>
                <div className="mt-1 text-xs text-mist-400">{fmtNum(data.people.regulars)} seen recently</div>
              </Link>
              <Link to="/app/people?status=visitor" className="px-5 py-4 hover:bg-mist-50">
                <div className="tabular text-2xl font-semibold text-ink">{fmtNum(data.people.visitors)}</div>
                <div className="text-sm text-mist-500">visitors</div>
                <div className="mt-1 text-xs text-mist-400">not yet members</div>
              </Link>
            </section>
          )}

          {(data.upcomingSessions || data.upcomingEvents) && (
            <section className="panel overflow-hidden">
              <h2 className="border-b border-mist-100 px-5 py-4 text-[15px] font-semibold text-ink">Coming up</h2>
              {[...(data.upcomingSessions || []).map(s => ({ ...s, type: 'session' })), ...(data.upcomingEvents || []).map(e => ({ ...e, type: 'event' }))]
                .sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at)).slice(0, 6).map(item => (
                  <Link key={item.type + item.id} to={item.type === 'session' ? `/app/attendance/${item.id}` : `/app/events/${item.id}`} className="flex items-center gap-3 border-b border-mist-100 px-5 py-3 last:border-0 hover:bg-mist-50">
                    <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${item.type === 'event' ? 'bg-gold-100 text-gold-700' : 'bg-brand-50 text-brand-700'}`}>
                      {item.type === 'event' ? <CalendarDays size={16} /> : <CalendarCheck size={16} />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-ink">{item.name}</span>
                      <span className="block text-xs text-mist-500">{fmtDateTime(item.starts_at, tz)}</span>
                    </span>
                    {item.type === 'event' && <span className="tabular text-xs text-mist-500">{item.registered}{item.capacity ? `/${item.capacity}` : ''} registered</span>}
                  </Link>
                ))}
              {!(data.upcomingSessions?.length || data.upcomingEvents?.length) && <p className="px-5 py-6 text-sm text-mist-500">Nothing scheduled yet.</p>}
            </section>
          )}

          {data.activity?.length > 0 && (
            <section className="panel overflow-hidden">
              <h2 className="border-b border-mist-100 px-5 py-4 text-[15px] font-semibold text-ink">Recent activity</h2>
              <ul className="divide-y divide-mist-100">
                {data.activity.map((a, i) => (
                  <li key={i} className="px-5 py-3 text-sm">
                    <span className="font-medium text-ink">{a.user_name || 'Someone'}</span> <span className="text-mist-600">{ACTIVITY[a.action] || a.action.replace(/[._]/g, ' ')}</span>
                    {a.meta?.name && <span className="text-mist-600"> — {a.meta.name}</span>}
                    <div className="text-xs text-mist-400">{relative(a.created_at)}</div>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}
