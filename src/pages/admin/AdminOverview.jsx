import { Link } from 'react-router-dom'
import { Clock, CreditCard, Moon } from 'lucide-react'
import { api } from '../../lib/api'
import { useLoad, PageLoader, ErrorState } from '../../components/ui'
import { relative, fmtDate } from '../../lib/format'
import { adminPath } from '../../lib/host'
import { money, Stat, WeekBars, PlanBadge } from './shared'

function Attention({ icon: Icon, title, empty, rows, detail }) {
  return (
    <section className="panel overflow-hidden">
      <div className="flex items-center gap-2 border-b border-mist-100 px-4 py-3">
        <Icon size={16} className="text-mist-400" /><h2 className="text-[15px] font-semibold text-ink">{title}</h2>
        <span className="ml-auto rounded-full bg-mist-100 px-2 text-xs font-medium text-mist-600">{rows.length}</span>
      </div>
      {rows.length === 0 ? <p className="px-4 py-6 text-sm text-mist-400">{empty}</p> : (
        <ul className="max-h-80 divide-y divide-mist-100 overflow-y-auto">
          {rows.map(o => (
            <li key={o.id}>
              <Link to={adminPath(`/churches/${o.id}`)} className="block px-4 py-3 hover:bg-mist-50">
                <div className="flex items-center justify-between gap-2"><span className="truncate font-medium text-ink">{o.name}</span><PlanBadge billing={o.billing} /></div>
                <div className="mt-0.5 truncate text-xs text-mist-500">{o.owner_email || 'No owner'} · {detail(o)}</div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export default function AdminOverview() {
  const { data, error, loading, reload } = useLoad(() => api.get('/platform/summary'), [])
  if (loading && !data) return <PageLoader />
  if (error) return <ErrorState error={error} onRetry={reload} />
  const t = data.totals, a = data.attention
  const newThisWeek = data.signups[data.signups.length - 1]?.count || 0
  return (
    <div>
      <h1 className="text-[26px] font-semibold text-ink">Overview</h1>
      <p className="mt-1 text-sm text-mist-500">How GatherHQ is doing. Church member records are never shown here.</p>

      <section className="panel mt-6 grid grid-cols-2 divide-mist-100 sm:grid-cols-3 lg:grid-cols-6 lg:divide-x">
        <Stat strong label="Monthly revenue" value={money(t.mrr, t.mrr % 1 !== 0)} hint={`${money(t.arr)} a year`} />
        <Stat strong label="Paying churches" value={t.paying} hint={t.past_due ? `${t.past_due} with payment due` : 'All payments up to date'} />
        <Stat strong label="On free trial" value={t.trialing} hint={`${a.trials_ending.length} ending this week`} />
        <Stat strong label="New churches" value={t.new_7d} hint={`${t.new_30d} in 30 days`} />
        <Stat strong label="Check-ins, 7 days" value={t.checkins_7d.toLocaleString()} hint={`${t.active_orgs} active ${t.active_orgs === 1 ? "church" : "churches"}`} />
        <Stat strong label="People recorded" value={t.people.toLocaleString()} hint={`${t.users} team logins`} />
      </section>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <section className="panel px-5 py-4">
          <div className="flex items-baseline justify-between"><h2 className="text-[15px] font-semibold text-ink">New churches each week</h2><span className="text-xs text-mist-400">Last 12 weeks · this week {newThisWeek}</span></div>
          <div className="mt-6"><WeekBars data={data.signups} label="New churches each week" /></div>
        </section>
        <section className="panel px-5 py-4">
          <h2 className="text-[15px] font-semibold text-ink">Where churches stand</h2>
          <dl className="mt-3 divide-y divide-mist-100 text-sm">
            {[['Paying', t.paying], ['On free trial', t.trialing], ['Free (comp)', t.free], ['Payment due', t.past_due], ['Trial or plan ended', t.expired], ['Suspended', t.suspended], ['All churches', t.orgs]].map(([l, n]) => (
              <div key={l} className="flex justify-between py-2"><dt className="text-mist-600">{l}</dt><dd className="tabular font-medium text-ink">{n}</dd></div>
            ))}
          </dl>
        </section>
      </div>

      <h2 className="mt-8 text-[17px] font-semibold text-ink">Needs attention</h2>
      <div className="mt-3 grid gap-6 lg:grid-cols-3">
        <Attention icon={Clock} title="Trials ending this week" rows={a.trials_ending} empty="No trials end in the next 7 days." detail={o => `ends ${fmtDate(o.billing.trialEndsAt)} · ${o.people} people`} />
        <Attention icon={CreditCard} title="Payment problems" rows={a.payment_problems} empty="No failed or lapsed payments." detail={o => (o.billing.state === 'past_due' ? `grace ends ${fmtDate(o.billing.graceEnds)}` : 'plan has lapsed')} />
        <Attention icon={Moon} title="Gone quiet" rows={a.quiet} empty="Every church has checked people in recently." detail={o => (o.last_checkin_at ? `last check-in ${relative(o.last_checkin_at)}` : 'never checked anyone in')} />
      </div>
    </div>
  )
}
