import { Link } from 'react-router-dom'
import { api } from '../../lib/api'
import { useLoad, Skeleton, ErrorState, Notice } from '../../components/ui'
import { adminPath } from '../../lib/host'
import { Kpi, Panel, PageTitle, MonthBars, PayStatus, fmtMoney, fmtDate, PlanBadge } from './shared'

export default function AdminOverview() {
  const { data, error, loading, reload } = useLoad(() => api.get('/platform/business?range=month'), [])
  const health = useLoad(() => api.get('/platform/health').catch(() => null), [])
  if (error) return <ErrorState error={error} onRetry={reload} />
  if (loading) return <div className="space-y-4"><Skeleton className="h-10 w-60" /><div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-24" />)}</div></div>
  const c = data.currency, m = (n) => fmtMoney(n, c, false)
  const rv = data.revenue, ch = data.churches, rec = data.recurring
  const change = rv.last_month.net ? Math.round(100 * (rv.month.net - rv.last_month.net) / rv.last_month.net) : null
  const h = health.data
  const issues = h ? [
    !h.scheduler.ok && 'The scheduler hasn’t run in the last 10 minutes.',
    h.scheduler.overdue_items > 0 && `${h.scheduler.overdue_items} scheduled messages or workflow steps are overdue.`,
    h.webhooks.failed > 0 && `${h.webhooks.failed} recent Stripe webhooks failed to process.`,
    h.failures.deliveries_24h > 0 && `${h.failures.deliveries_24h} messages failed in the last 24 hours.`,
    h.errors.length > 0 && `${h.errors.length} recent server errors.`,
    h.providers.sms.some(p => p.down_until && new Date(p.down_until) > new Date()) && 'An SMS provider is paused after repeated failures.',
  ].filter(Boolean) : []

  return (
    <div className="space-y-6">
      <PageTitle title="Overview" sub={`Revenue figures are ${c.toUpperCase()}, from Stripe payment records${data.payments_synced_at ? `, last synced ${fmtDate(data.payments_synced_at)}` : ''}.`} />
      {!data.stripe && <Notice tone="warning">Stripe isn’t connected in this environment, so there are no payment records to show yet.</Notice>}
      {issues.length > 0 && <Notice tone="warning" title="Needs attention"><ul className="list-disc pl-5">{issues.map(i => <li key={i}>{i}</li>)}</ul><Link to={adminPath('/health')} className="link mt-1 inline-block">Platform health</Link></Notice>}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Net revenue this month" value={m(rv.month.net)} sub={change == null ? `Last month ${m(rv.last_month.net)}` : `${change >= 0 ? '+' : ''}${change}% vs last month (${m(rv.last_month.net)})`} />
        <Kpi label="MRR" value={m(rec.mrr)} sub={`ARR ${m(rec.arr)}${rec.manual_mrr ? ` · ${m(rec.manual_mrr)} set by hand` : ''}`} />
        <Kpi label="Paying churches" value={ch.paying} sub={`${m(rec.arppc)} average per month`} />
        <Kpi label="Revenue this year" value={m(rv.year.net)} sub={`${m(rv.total.net)} all time`} />
        <Kpi label="Free trials" value={ch.trialing} sub={`${ch.trials_ending_7d} ending within 7 days`} tone={ch.trials_ending_7d ? 'warn' : undefined} />
        <Kpi label="Failed payments this month" value={rv.month.failed} sub={rv.month.failed ? m(rv.month.failed_amount) : 'None'} tone={rv.month.failed ? 'bad' : undefined} />
        <Kpi label="Churned" value={ch.churned} sub={`${ch.past_due} past due · ${ch.expired_trials} trials ended unpaid`} tone={ch.past_due ? 'warn' : undefined} />
        <Kpi label="Users" value={data.users.total} sub={`${data.users.active_30d} signed in within 30 days`} />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1.6fr_1fr]">
        <Panel title="Net revenue, last 12 months" action={<Link to={adminPath('/revenue')} className="text-sm text-brand-700 hover:underline">Revenue & analytics</Link>}>
          <div className="px-5 py-4"><MonthBars data={data.series.map(x => ({ ...x, subscription_net: Math.max(0, x.subscription - (x.refunds * (x.subscription / (x.gross || 1)))), one_off_net: Math.max(0, x.one_off - (x.refunds * (x.one_off / (x.gross || 1)))) }))}
            series={[{ key: 'subscription_net', label: 'Subscriptions', color: '#0e7490' }, { key: 'one_off_net', label: 'One-off (credit)', color: '#67e8f9' }]} format={m} label="Net revenue per month" /></div>
        </Panel>
        <Panel title="New churches per month">
          <div className="px-5 py-4"><MonthBars data={data.signups} series={[{ key: 'count', label: 'New churches', color: '#334155' }]} label="New churches per month" /></div>
        </Panel>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Panel title="Recent payments" action={<Link to={adminPath('/payments')} className="text-sm text-brand-700 hover:underline">All payments</Link>}>
          {data.recent_payments.length ? <ul className="divide-y divide-slate-100">{data.recent_payments.map(p => (
            <li key={p.id} className="flex items-center gap-3 px-5 py-2.5 text-sm">
              <span className="min-w-0 flex-1"><span className="block truncate font-medium text-slate-900">{p.org_name || 'Unknown church'}</span><span className="text-xs text-slate-500">{p.kind === 'subscription' ? 'Subscription' : p.description} · {fmtDate(p.paid_at || p.created_at)}</span></span>
              <span className="tabular">{fmtMoney(p.amount, p.currency)}</span><PayStatus status={p.status} />
            </li>))}</ul> : <p className="px-5 py-6 text-sm text-slate-500">No payments recorded yet.</p>}
        </Panel>
        <Panel title="Newest churches" action={<Link to={adminPath('/churches')} className="text-sm text-brand-700 hover:underline">All churches</Link>}>
          <ul className="divide-y divide-slate-100">{data.recent_signups.map(o => (
            <li key={o.id}><Link to={adminPath(`/churches/${o.id}`)} className="flex items-center gap-3 px-5 py-2.5 text-sm hover:bg-slate-50">
              <span className="min-w-0 flex-1 truncate font-medium text-slate-900">{o.name}</span><span className="text-xs text-slate-500">{fmtDate(o.created_at)}</span>
              <PlanBadge billing={o.billing} />
            </Link></li>))}</ul>
        </Panel>
      </div>
      <ul className="space-y-1 text-xs text-slate-500">{data.notes.map(n => <li key={n}>{n}</li>)}</ul>
    </div>
  )
}
