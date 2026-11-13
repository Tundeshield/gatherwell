// Orders & payments, subscriptions, and revenue & analytics.
import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { RefreshCw, ExternalLink } from 'lucide-react'
import { api } from '../../lib/api'
import { useLoad, Button, Skeleton, ErrorState, EmptyState, Notice, Drawer, Badge, useToast } from '../../components/ui'
import { adminPath } from '../../lib/host'
import { Kpi, Panel, PageTitle, MonthBars, PayStatus, RangePicker, rangeQuery, fmtMoney, fmtDate, fmtWhen, monthLabel, PlanBadge } from './shared'

const sel = 'field !w-auto'

// --- Orders & payments ---------------------------------------------------------------------------
export function AdminPayments() {
  const toast = useToast()
  const [params, setParams] = useSearchParams()
  const [range, setRange] = useState({ range: params.get('range') || 'all', from: '', to: '' })
  const f = { status: params.get('status') || '', kind: params.get('kind') || '', currency: params.get('currency') || '', q: params.get('q') || '', page: Number(params.get('page') || 1), org: params.get('org') || '' }
  const set = (patch) => setParams(Object.fromEntries(Object.entries({ ...f, page: 1, ...patch }).filter(([, v]) => v)))
  const qs = `${rangeQuery(range)}&status=${f.status}&kind=${f.kind}&currency=${f.currency}&org=${f.org}&q=${encodeURIComponent(f.q)}&page=${f.page}`
  const { data, error, loading, reload } = useLoad(() => api.get(`/platform/payments?${qs}`), [qs])
  const [open, setOpen] = useState(null)
  const [syncing, setSyncing] = useState(false)
  const sync = async () => { setSyncing(true); try { const r = await api.post('/platform/payments/sync'); toast(`Synced ${r.invoices} invoices and ${r.charges} one-off payments from Stripe`); reload() } catch (e) { toast(e.message, 'error') } finally { setSyncing(false) } }
  return (
    <div>
      <PageTitle title="Orders & payments" sub="Every payment Stripe has recorded for GatherHQ: subscription invoices and one-off purchases."
        action={<Button variant="secondary" icon={RefreshCw} loading={syncing} onClick={sync}>Sync from Stripe</Button>} />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <RangePicker value={range} onChange={setRange} />
        <select aria-label="Status" className={sel} value={f.status} onChange={e => set({ status: e.target.value })}><option value="">Any status</option><option value="successful">Successful</option><option value="failed">Failed</option><option value="open">Unpaid / open</option><option value="pending">Pending</option><option value="refunded">Refunded</option></select>
        <select aria-label="Type" className={sel} value={f.kind} onChange={e => set({ kind: e.target.value })}><option value="">Any type</option><option value="subscription">Subscription</option><option value="one_off">One-off</option></select>
        {data?.currencies?.length > 1 && <select aria-label="Currency" className={sel} value={f.currency} onChange={e => set({ currency: e.target.value })}><option value="">Any currency</option>{data.currencies.map(c => <option key={c} value={c}>{c.toUpperCase()}</option>)}</select>}
        <input type="search" aria-label="Search" placeholder="Church, invoice or reference" className="field !w-56" defaultValue={f.q} onKeyDown={e => e.key === 'Enter' && set({ q: e.target.value })} />
        {f.org && <Button size="sm" variant="ghost" onClick={() => set({ org: '' })}>Clear church filter</Button>}
      </div>
      {error ? <ErrorState error={error} onRetry={reload} /> : loading ? <Skeleton className="h-64" /> : (
        <>
          {!data.stripe && <Notice tone="warning" className="mb-4">Stripe isn’t connected in this environment.</Notice>}
          {data.synced_at && <p className="mb-2 text-xs text-slate-500">Last synced from Stripe {fmtWhen(data.synced_at)}. New payments also arrive automatically through Stripe’s webhook.</p>}
          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            {(() => { const [c, t] = Object.entries(data.totals)[0] || ['usd', { gross: 0, refunds: 0, net: 0, payments: 0, failed: 0, failed_amount: 0 }]; return [
              <Kpi key="g" label={`Collected (${c.toUpperCase()})`} value={fmtMoney(t.gross, c)} sub={`${t.payments} payments`} />,
              <Kpi key="r" label="Refunded" value={fmtMoney(t.refunds, c)} />,
              <Kpi key="n" label="Net" value={fmtMoney(t.net, c)} />,
              <Kpi key="f" label="Failed" value={t.failed} sub={t.failed ? fmtMoney(t.failed_amount, c) : null} tone={t.failed ? 'bad' : undefined} />] })()}
          </div>
          {data.rows.length ? (
            <Panel>
              <div className="overflow-x-auto"><table className="w-full text-sm">
                <thead><tr className="border-b border-slate-100 text-left text-xs text-slate-500"><th className="px-4 py-2.5 font-medium">Date</th><th className="px-3 py-2.5 font-medium">Church</th><th className="px-3 py-2.5 font-medium">What</th><th className="px-3 py-2.5 text-right font-medium">Amount</th><th className="px-3 py-2.5 font-medium">Status</th><th className="px-4 py-2.5 font-medium">Method</th></tr></thead>
                <tbody className="divide-y divide-slate-100">{data.rows.map(p => (
                  <tr key={p.id} onClick={() => setOpen(p.id)} className="cursor-pointer hover:bg-slate-50">
                    <td className="whitespace-nowrap px-4 py-2.5 text-slate-600">{fmtDate(p.paid_at || p.created_at)}</td>
                    <td className="px-3 py-2.5 font-medium text-slate-900">{p.org_name || <span className="text-slate-400">Unknown</span>}</td>
                    <td className="px-3 py-2.5 text-slate-600">{p.kind === 'subscription' ? `Subscription${p.plan ? ` · ${p.plan} ${p.interval || ''}` : ''}` : p.description}</td>
                    <td className="tabular whitespace-nowrap px-3 py-2.5 text-right">{fmtMoney(p.amount, p.currency)}{p.amount_refunded > 0 && <span className="block text-xs text-slate-500">−{fmtMoney(p.amount_refunded, p.currency)} refunded</span>}</td>
                    <td className="px-3 py-2.5"><PayStatus status={p.status} /></td>
                    <td className="px-4 py-2.5 text-slate-500">{p.method?.brand ? `${p.method.brand} ··${p.method.last4}` : p.method?.type || '—'}</td>
                  </tr>))}</tbody>
              </table></div>
              {data.pages > 1 && <div className="flex items-center justify-between border-t border-slate-100 px-4 py-2.5 text-sm"><span className="text-slate-500">Page {data.page} of {data.pages} · {data.total} payments</span><span className="flex gap-2"><Button size="sm" variant="secondary" disabled={data.page <= 1} onClick={() => set({ page: data.page - 1 })}>Previous</Button><Button size="sm" variant="secondary" disabled={data.page >= data.pages} onClick={() => set({ page: data.page + 1 })}>Next</Button></span></div>}
            </Panel>
          ) : <EmptyState title="No payments match">{data.stripe ? 'Try another filter, or sync from Stripe to pull in past payments.' : 'Payments appear here once Stripe is connected.'}</EmptyState>}
        </>
      )}
      <PaymentDrawer id={open} onClose={() => setOpen(null)} />
    </div>
  )
}

function PaymentDrawer({ id, onClose }) {
  const { data, loading } = useLoad(() => (id ? api.get(`/platform/payments/${encodeURIComponent(id)}`) : Promise.resolve(null)), [id])
  const Row = ({ k, v }) => <div className="grid grid-cols-[140px_1fr] gap-3 py-1.5 text-sm"><dt className="text-slate-500">{k}</dt><dd className="min-w-0 break-words text-slate-900">{v ?? '—'}</dd></div>
  return (
    <Drawer open={!!id} onClose={onClose} title="Payment">
      {loading || !data ? <Skeleton className="h-48" /> : (
        <div>
          <div className="mb-4 flex items-center gap-3"><span className="tabular text-[26px] font-semibold">{fmtMoney(data.amount, data.currency)}</span><PayStatus status={data.status} /></div>
          <dl className="divide-y divide-slate-100">
            <Row k="Church" v={data.org_id ? <Link to={adminPath(`/churches/${data.org_id}`)} className="link">{data.org_name || data.org_id}</Link> : 'Not matched to a church'} />
            <Row k="Type" v={data.kind === 'subscription' ? 'Subscription' : 'One-off'} />
            <Row k="Description" v={data.description} />
            {data.plan && <Row k="Plan" v={`${data.plan} · ${data.interval || ''}`} />}
            <Row k="Created" v={fmtWhen(data.created_at)} />
            <Row k="Paid" v={data.paid_at ? fmtWhen(data.paid_at) : null} />
            {data.amount_refunded > 0 && <Row k="Refunded" v={`${fmtMoney(data.amount_refunded, data.currency)}${data.refunded_at ? ` on ${fmtDate(data.refunded_at)}` : ''}`} />}
            {data.failure_reason && <Row k="Why it failed" v={data.failure_reason} />}
            {data.attempt_count > 1 && <Row k="Attempts" v={data.attempt_count} />}
            <Row k="Method" v={data.method?.brand ? `${data.method.brand} ending ${data.method.last4}` : data.method?.type} />
            <Row k="Invoice" v={data.invoice_number || data.invoice_id} />
            <Row k="Payment reference" v={<span className="font-mono text-xs">{data.payment_intent || data.charge_id || data.id}</span>} />
            <Row k="Stripe mode" v={data.mode} />
          </dl>
          <div className="mt-4 flex flex-wrap gap-2">
            {Object.entries(data.links).filter(([, u]) => u).map(([k, u]) => <a key={k} href={u} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-sm hover:border-slate-300"><ExternalLink size={14} />Stripe {k}</a>)}
          </div>
          <p className="mt-4 text-xs text-slate-500">Refunds and charges are done in Stripe, not here, so every money movement stays in one place.</p>
        </div>
      )}
    </Drawer>
  )
}

// --- Subscriptions -----------------------------------------------------------------------------
const SUB_FILTERS = [['', 'All'], ['paying', 'Paying'], ['renewing', 'Renewing in 30 days'], ['trialing', 'In trial'], ['expired_trial', 'Trial ended'], ['past_due', 'Past due'], ['cancelling', 'Cancelling'], ['churned', 'Churned'], ['free', 'Free']]
export function AdminSubscriptions() {
  const [state, setState] = useState('')
  const { data, error, loading, reload } = useLoad(() => api.get(`/platform/subscriptions${state ? `?state=${state}` : ''}`), [state])
  if (error) return <ErrorState error={error} onRetry={reload} />
  if (loading && !data) return <Skeleton className="h-64" />
  const c = data.counts
  return (
    <div className="space-y-6">
      <PageTitle title="Subscriptions" sub="From each church’s billing record, kept in sync by Stripe." />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Active" value={c.active} sub={`${c.monthly} monthly · ${c.yearly} yearly${c.manual ? ` · ${c.manual} by hand` : ''}`} />
        <Kpi label="In trial" value={c.trialing} sub={`${c.expired_trial} trials ended unpaid`} />
        <Kpi label="Renewing in 30 days" value={c.renewing_30d} sub={`${c.cancelling} cancelling at period end`} />
        <Kpi label="Retention" value={data.retention.rate == null ? '—' : `${data.retention.rate}%`} sub={`${data.retention.still_paying} of ${data.retention.ever_paid} who ever paid · ${c.churned} churned · ${c.past_due} past due`} tone={c.past_due ? 'warn' : undefined} />
      </div>
      <Panel title="Plans">
        <div className="overflow-x-auto"><table className="w-full text-sm">
          <thead><tr className="text-left text-xs text-slate-500"><th className="px-5 py-2 font-medium">Plan</th><th className="px-3 py-2 text-right font-medium">Price</th><th className="px-3 py-2 text-right font-medium">Monthly subs</th><th className="px-3 py-2 text-right font-medium">Yearly subs</th><th className="px-5 py-2 text-right font-medium">MRR</th></tr></thead>
          <tbody className="divide-y divide-slate-100">{data.plans.map(p => <tr key={p.plan}><td className="px-5 py-2.5 font-medium">{p.name}</td><td className="tabular px-3 py-2.5 text-right">${p.monthly_price}/mo · ${p.yearly_price}/yr</td><td className="tabular px-3 py-2.5 text-right">{p.monthly}</td><td className="tabular px-3 py-2.5 text-right">{p.yearly}</td><td className="tabular px-5 py-2.5 text-right">{fmtMoney(p.mrr)}</td></tr>)}</tbody>
        </table></div>
        <p className="border-t border-slate-100 px-5 py-2.5 text-xs text-slate-500">Prices come from the plan list in the app and the matching Stripe prices{data.stripe ? ` (${data.stripe} mode)` : ''}. Nothing here creates or changes prices.</p>
      </Panel>
      <Panel title="Subscriptions" action={<select aria-label="Show" className={sel} value={state} onChange={e => setState(e.target.value)}>{SUB_FILTERS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>}>
        {data.rows.length ? <div className="overflow-x-auto"><table className="w-full text-sm">
          <thead><tr className="text-left text-xs text-slate-500"><th className="px-5 py-2 font-medium">Church</th><th className="px-3 py-2 font-medium">Plan</th><th className="px-3 py-2 font-medium">Renews / trial ends</th><th className="px-3 py-2 text-right font-medium">MRR</th><th className="px-5 py-2 font-medium">Stripe</th></tr></thead>
          <tbody className="divide-y divide-slate-100">{data.rows.map(x => <tr key={x.id}>
            <td className="px-5 py-2.5"><Link to={adminPath(`/churches/${x.id}`)} className="font-medium text-slate-900 hover:underline">{x.name}</Link>{x.last_error && <span className="block text-xs text-red-700">{x.last_error}</span>}</td>
            <td className="px-3 py-2.5"><PlanBadge billing={{ state: x.state, plan: x.plan, interval: x.interval, daysLeft: x.days_left, manual: x.manual, cancelling: x.cancelling, lapsed: x.ever_paid }} /></td>
            <td className="px-3 py-2.5 text-slate-600">{fmtDate(x.renews_at || x.trial_ends_at)}</td>
            <td className="tabular px-3 py-2.5 text-right">{x.mrr ? fmtMoney(x.mrr) : '—'}</td>
            <td className="px-5 py-2.5">{x.subscription_id ? <a href={`${data.links.base}subscriptions/${x.subscription_id}`} target="_blank" rel="noreferrer" className="link">Open</a> : <span className="text-slate-400">—</span>}</td>
          </tr>)}</tbody></table></div> : <p className="px-5 py-6 text-sm text-slate-500">None.</p>}
      </Panel>
      <Panel title="Recent changes">
        {data.changes.length ? <ul className="divide-y divide-slate-100 text-sm">{data.changes.map((x, i) => <li key={i} className="flex flex-wrap gap-x-3 px-5 py-2.5"><span className="text-slate-500">{fmtDate(x.at)}</span><Link to={adminPath(`/churches/${x.org_id}`)} className="font-medium hover:underline">{x.org_name}</Link><Badge tone={{ started: 'success', upgraded: 'success', reactivated: 'success', cancelled: 'danger', downgraded: 'gold' }[x.kind] || 'neutral'}>{x.kind.replace('_', ' ')}</Badge><span className="text-slate-600">{x.from?.plan ? `${x.from.plan} ${x.from.interval || ''} → ` : ''}{x.to?.plan} {x.to?.interval}</span></li>)}</ul>
          : <p className="px-5 py-6 text-sm text-slate-500">Starts, upgrades, downgrades and cancellations appear here as Stripe reports them.</p>}
      </Panel>
    </div>
  )
}

// --- Revenue & analytics ---------------------------------------------------------------------------
export function AdminRevenue() {
  const [range, setRange] = useState({ range: 'month', from: '', to: '' })
  const { data, error, loading, reload } = useLoad(() => api.get(`/platform/business?${rangeQuery(range)}`), [range.range, range.from, range.to])
  if (error) return <ErrorState error={error} onRetry={reload} />
  if (loading && !data) return <Skeleton className="h-64" />
  const c = data.currency, m = (n) => fmtMoney(n, c)
  const r = data.revenue.range
  return (
    <div className="space-y-6">
      <PageTitle title="Revenue & analytics" sub={`${data.range.label} · ${c.toUpperCase()}`} action={<RangePicker value={range} onChange={setRange} />} />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Gross revenue" value={m(r.gross)} sub={`${r.payments} payments`} />
        <Kpi label="Refunds" value={m(r.refunds)} />
        <Kpi label="Net revenue" value={m(r.net)} />
        <Kpi label="New churches" value={data.churches.new_in_range} />
        <Kpi label="From subscriptions" value={m(r.subscription)} />
        <Kpi label="From one-off purchases" value={m(r.one_off)} sub="Messaging credit and other one-off payments" />
        <Kpi label="Failed payments" value={r.failed} sub={r.failed ? m(r.failed_amount) : null} tone={r.failed ? 'bad' : undefined} />
        <Kpi label="Unpaid invoices (now)" value={r.open} sub={r.open ? m(r.open_amount) : 'None outstanding'} tone={r.open ? 'warn' : undefined} />
      </div>
      {Object.keys(data.revenue.other_currencies).length > 0 && <Notice>Also in this period: {Object.entries(data.revenue.other_currencies).map(([k, v]) => `${fmtMoney(v.net, k)} net`).join(', ')}. Currencies are never added together.</Notice>}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Kpi label="MRR" value={m(data.recurring.mrr)} sub={`From Stripe ${m(data.recurring.stripe_mrr)} · by hand ${m(data.recurring.manual_mrr)}`} />
        <Kpi label="ARR" value={m(data.recurring.arr)} sub="MRR × 12" />
        <Kpi label="Average per paying church" value={m(data.recurring.arppc)} sub={`${data.recurring.paying} paying churches, per month`} />
      </div>
      <Panel title="Gross revenue and refunds by month">
        <div className="px-5 py-4"><MonthBars data={data.series} series={[{ key: 'subscription', label: 'Subscriptions', color: '#0e7490' }, { key: 'one_off', label: 'One-off', color: '#67e8f9' }]} format={m} label="Gross revenue by month" /></div>
        <div className="overflow-x-auto border-t border-slate-100"><table className="w-full text-sm">
          <thead><tr className="text-left text-xs text-slate-500"><th className="px-5 py-2 font-medium">Month</th><th className="px-3 py-2 text-right font-medium">Subscriptions</th><th className="px-3 py-2 text-right font-medium">One-off</th><th className="px-3 py-2 text-right font-medium">Gross</th><th className="px-3 py-2 text-right font-medium">Refunds</th><th className="px-5 py-2 text-right font-medium">Net</th></tr></thead>
          <tbody className="divide-y divide-slate-100">{[...data.series].reverse().map(x => <tr key={x.month}><td className="px-5 py-2">{monthLabel(x.month)} {x.month.slice(0, 4)}</td><td className="tabular px-3 py-2 text-right">{m(x.subscription)}</td><td className="tabular px-3 py-2 text-right">{m(x.one_off)}</td><td className="tabular px-3 py-2 text-right">{m(x.gross)}</td><td className="tabular px-3 py-2 text-right">{x.refunds ? `−${m(x.refunds)}` : '—'}</td><td className="tabular px-5 py-2 text-right font-medium">{m(x.net)}</td></tr>)}</tbody>
        </table></div>
      </Panel>
      <ul className="space-y-1 text-xs text-slate-500">{data.notes.map(n => <li key={n}>{n}</li>)}</ul>
    </div>
  )
}
