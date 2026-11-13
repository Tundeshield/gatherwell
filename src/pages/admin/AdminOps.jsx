// Messaging economics, platform health, audit log and settings.
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { CheckCircle2, AlertTriangle, XCircle } from 'lucide-react'
import { api } from '../../lib/api'
import { useLoad, Button, Input, Skeleton, ErrorState, Notice, Badge, useToast, useConfirm } from '../../components/ui'
import { adminPath } from '../../lib/host'
import { countryName } from '../../../shared/comms.js'
import { Kpi, Panel, PageTitle, RangePicker, rangeQuery, fmtMoney, fmtWhen, fmtDate, actionLabel } from './shared'

// --- Messaging --------------------------------------------------------------------------------------
export function AdminMessaging() {
  const [range, setRange] = useState({ range: '30d', from: '', to: '' })
  const { data, error, loading, reload } = useLoad(() => api.get(`/platform/messaging?${rangeQuery(range)}`), [range.range, range.from, range.to])
  if (error) return <ErrorState error={error} onRetry={reload} />
  if (loading && !data) return <Skeleton className="h-64" />
  const e = data.email, s = data.sms
  return (
    <div className="space-y-6">
      <PageTitle title="Messaging" sub={`${data.range.label}, across every church.`} action={<div className="flex gap-2"><RangePicker value={range} onChange={setRange} options={[['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['month', 'This month'], ['last_month', 'Last month'], ['year', 'This year'], ['custom', 'Custom']]} /><Link to={adminPath('/providers')} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm hover:border-slate-300">Providers</Link></div>} />
      <Panel title="Email" action={<span className="text-sm text-slate-500">{e.provider ? `${e.provider.name} · ${e.provider.domain}` : 'No email provider configured'}</span>}>
        <div className="grid grid-cols-2 gap-3 p-4 lg:grid-cols-5">
          <Kpi label="Sent" value={e.sent} /><Kpi label="Delivered" value={e.delivered} sub={e.rate == null ? 'No reports yet' : `${e.rate}% delivery rate`} />
          <Kpi label="Failed" value={e.failed} tone={e.failed ? 'bad' : undefined} /><Kpi label="Bounced" value={e.bounced} /><Kpi label="Unsubscribed (all time)" value={e.unsubscribes} />
        </div>
      </Panel>
      <Panel title="SMS">
        <div className="grid grid-cols-2 gap-3 p-4 lg:grid-cols-4">
          <Kpi label="Texts sent" value={s.sent} sub={`${s.segments} parts charged`} /><Kpi label="Delivered" value={s.delivered} sub={s.rate == null ? 'No reports yet' : `${s.rate}% delivery rate`} />
          <Kpi label="Failed" value={s.failed} tone={s.failed ? 'bad' : undefined} /><Kpi label="Credit bought" value={fmtMoney(s.purchases)} sub={`${s.purchase_count} purchases`} />
          <Kpi label="SMS revenue (credit used)" value={fmtMoney(s.net_revenue)} sub={s.refunds ? `after ${fmtMoney(s.refunds)} refunded` : null} />
          <Kpi label="Provider costs" value={s.cost_known ? fmtMoney(s.provider_cost) : '—'} sub={s.cost_unknown ? `${s.cost_unknown} texts without a reported cost` : null} />
          <Kpi label="Estimated margin" value={s.margin == null ? '—' : fmtMoney(s.margin)} sub={s.margin == null ? 'Needs every provider cost' : 'Revenue less provider costs'} />
          <Kpi label="Unused credit held" value={fmtMoney(data.balances.total)} sub={`${data.balances.churches} churches with a balance`} />
        </div>
        <p className="border-t border-slate-100 px-5 py-2.5 text-xs text-slate-500">Sender names: {Object.entries(s.sender_ids).map(([k, v]) => `${v} ${k}`).join(' · ') || 'none requested'}</p>
      </Panel>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Panel title="SMS by country">{data.by_country.length ? <table className="w-full text-sm"><tbody className="divide-y divide-slate-100">{data.by_country.map(x => <tr key={x.country}><td className="px-5 py-2">{countryName(x.country)}</td><td className="tabular px-3 py-2 text-right">{x.count} texts · {x.segments} parts</td><td className="tabular px-5 py-2 text-right">{fmtMoney(x.revenue)}</td></tr>)}</tbody></table> : <p className="px-5 py-6 text-sm text-slate-500">No texts in this period.</p>}</Panel>
        <Panel title="SMS by provider">{data.by_provider.length ? <table className="w-full text-sm"><tbody className="divide-y divide-slate-100">{data.by_provider.map(x => <tr key={x.id}><td className="px-5 py-2">{x.id}</td><td className="tabular px-3 py-2 text-right">{x.count} texts</td><td className="tabular px-3 py-2 text-right">{fmtMoney(x.revenue)} revenue</td><td className="tabular px-5 py-2 text-right">{x.cost_unknown ? 'cost not reported' : `${fmtMoney(x.provider_cost)} cost`}</td></tr>)}</tbody></table> : <p className="px-5 py-6 text-sm text-slate-500">No texts in this period.</p>}</Panel>
      </div>
      <Panel title="By church">{data.by_church.length ? <div className="overflow-x-auto"><table className="w-full text-sm">
        <thead><tr className="text-left text-xs text-slate-500"><th className="px-5 py-2 font-medium">Church</th><th className="px-3 py-2 text-right font-medium">Emails</th><th className="px-3 py-2 text-right font-medium">Texts</th><th className="px-3 py-2 text-right font-medium">SMS revenue</th><th className="px-5 py-2 text-right font-medium">Credit balance</th></tr></thead>
        <tbody className="divide-y divide-slate-100">{data.by_church.map(x => <tr key={x.id}><td className="px-5 py-2"><Link to={adminPath(`/churches/${x.id}`)} className="hover:underline">{x.name}</Link></td><td className="tabular px-3 py-2 text-right">{x.email}</td><td className="tabular px-3 py-2 text-right">{x.sms}</td><td className="tabular px-3 py-2 text-right">{fmtMoney(x.sms_revenue)}</td><td className="tabular px-5 py-2 text-right">{fmtMoney(x.balance)}</td></tr>)}</tbody></table></div>
        : <p className="px-5 py-6 text-sm text-slate-500">No messages in this period.</p>}</Panel>
      <Panel title="WhatsApp"><div className="px-5 py-4 text-sm text-slate-600"><p><Badge>{data.whatsapp.automation}</Badge></p><p className="mt-2">{data.whatsapp.note}</p></div></Panel>
      <ul className="space-y-1 text-xs text-slate-500">{data.notes.map(n => <li key={n}>{n}</li>)}</ul>
    </div>
  )
}

// --- Platform health ----------------------------------------------------------------------------------
const Light = ({ ok, warn }) => ok ? <CheckCircle2 size={18} className="text-green-700" /> : warn ? <AlertTriangle size={18} className="text-amber-600" /> : <XCircle size={18} className="text-red-700" />
export function AdminHealth() {
  const { data, error, loading, reload } = useLoad(() => api.get('/platform/health'), [])
  if (error) return <ErrorState error={error} onRetry={reload} />
  if (loading && !data) return <Skeleton className="h-64" />
  const h = data
  const checks = [
    ['Application', true, false, `${h.app.env} · build ${String(h.app.commit || '').slice(0, 7) || 'unknown'}`],
    ['Database', h.database.ok, false, `Responded in ${h.database.ms} ms`],
    ['Scheduler', h.scheduler.ok, false, h.scheduler.last_run_at ? `Last ran ${fmtWhen(h.scheduler.last_run_at)}${h.scheduler.overdue_items ? ` · ${h.scheduler.overdue_items} items overdue` : ''}` : 'No runs recorded'],
    ['Stripe webhooks', h.webhooks.failed === 0, !!h.webhooks.failed, h.webhooks.last_at ? `Last event ${fmtWhen(h.webhooks.last_at)}${h.webhooks.failed ? ` · ${h.webhooks.failed} failed` : ''}` : 'No events received yet'],
    ['Email provider', h.providers.email === 'configured', false, h.providers.email],
    ['Message delivery (24h)', h.failures.deliveries_24h === 0, h.failures.deliveries_24h > 0, `${h.failures.deliveries_24h} failed`],
  ]
  return (
    <div className="space-y-6">
      <PageTitle title="Platform health" action={<Button variant="secondary" onClick={reload}>Refresh</Button>} />
      <Panel><ul className="divide-y divide-slate-100">{checks.map(([l, ok, warn, d]) => <li key={l} className="flex items-center gap-3 px-5 py-3"><Light ok={ok} warn={warn} /><span className="w-48 font-medium text-slate-900">{l}</span><span className="text-sm text-slate-600">{d}</span></li>)}</ul></Panel>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Panel title="SMS providers">{h.providers.sms.length ? <ul className="divide-y divide-slate-100 text-sm">{h.providers.sms.map(p => <li key={p.id} className="px-5 py-2.5"><span className="font-medium">{p.label}</span> <span className="text-slate-500">· {p.ok} ok · {p.failed} failed{p.failures ? ` · ${p.failures} in a row` : ''}</span>{p.down_until && new Date(p.down_until) > new Date() && <Badge tone="danger" className="ml-2">Paused until {fmtWhen(p.down_until)}</Badge>}{p.last_error && <span className="block text-xs text-slate-500">Last error {fmtWhen(p.last_error_at)}: {p.last_error}</span>}</li>)}</ul> : <p className="px-5 py-5 text-sm text-slate-500">No SMS sent yet.</p>}</Panel>
        <Panel title="Scheduler runs">
          <ul className="max-h-72 divide-y divide-slate-100 overflow-y-auto text-sm">{h.scheduler.runs.map((r, i) => <li key={i} className="flex justify-between px-5 py-2"><span>{fmtWhen(r.at)} · {r.kind}</span><span className={r.errors ? 'text-red-700' : 'text-slate-500'}>{r.errors ? `${r.errors} errors · ` : ''}{r.ms ?? '?'} ms</span></li>)}</ul>
        </Panel>
        <Panel title="Stripe webhook events">
          <ul className="max-h-72 divide-y divide-slate-100 overflow-y-auto text-sm">{h.webhooks.events.map(e => <li key={e.id} className="px-5 py-2"><span className="font-mono text-xs">{e.type}</span> <span className="text-slate-500">· {fmtWhen(e.at)}</span> {e.ok === false ? <Badge tone="danger">Failed</Badge> : e.ok ? <span className="text-xs text-slate-500">{e.result}</span> : null}{e.error && <span className="block text-xs text-red-700">{e.error}</span>}</li>)}{!h.webhooks.events.length && <li className="px-5 py-5 text-slate-500">None yet.</li>}</ul>
        </Panel>
        <Panel title="Recent server errors">
          <ul className="max-h-72 divide-y divide-slate-100 overflow-y-auto text-sm">{h.errors.map((e, i) => <li key={i} className="px-5 py-2"><span className="text-slate-500">{fmtWhen(e.at)}</span> <span className="font-mono text-xs">{e.method} {e.path}</span><span className="block text-xs text-red-700">{e.message}</span></li>)}{!h.errors.length && <li className="px-5 py-5 text-slate-500">No errors recorded.</li>}</ul>
        </Panel>
        <Panel title="Recent sign-ups">
          <ul className="divide-y divide-slate-100 text-sm">{h.recent.signups.map(o => <li key={o.id}><Link to={adminPath(`/churches/${o.id}`)} className="flex justify-between px-5 py-2 hover:bg-slate-50"><span>{o.name}</span><span className="text-slate-500">{fmtDate(o.at)}</span></Link></li>)}</ul>
        </Panel>
        <Panel title="Recent admin actions" action={<Link to={adminPath('/audit')} className="text-sm text-brand-700 hover:underline">Audit log</Link>}>
          <ul className="divide-y divide-slate-100 text-sm">{h.recent.admin_actions.map((a, i) => <li key={i} className="px-5 py-2"><span className="font-medium">{actionLabel(a.action)}</span>{a.target && <span className="text-slate-600"> · {a.target}</span>}<span className="block text-xs text-slate-500">{a.by} · {fmtWhen(a.at)}</span></li>)}{!h.recent.admin_actions.length && <li className="px-5 py-5 text-slate-500">None yet.</li>}</ul>
        </Panel>
      </div>
      <p className="text-xs text-slate-500">Server errors show the route and message only, never request contents or personal data.</p>
    </div>
  )
}

// --- Audit log ------------------------------------------------------------------------------------
export function AdminAudit() {
  const [before, setBefore] = useState('')
  const [q, setQ] = useState('')
  const { data, error, loading, reload } = useLoad(() => api.get(`/platform/audit?before=${encodeURIComponent(before)}&q=${encodeURIComponent(q)}`), [before, q])
  return (
    <div>
      <PageTitle title="Audit log" sub="Everything done in this console: sign-ins, church changes, provider and pricing settings, admin access, expenses and syncs." />
      <input type="search" placeholder="Filter by action, person or church" className="field mb-4 !w-72" onKeyDown={e => e.key === 'Enter' && (setBefore(''), setQ(e.target.value))} aria-label="Filter" />
      {error ? <ErrorState error={error} onRetry={reload} /> : loading && !data ? <Skeleton className="h-64" /> : (
        <Panel>
          <ul className="divide-y divide-slate-100 text-sm">{data.rows.map(a => (
            <li key={a.id} className="grid grid-cols-1 gap-1 px-5 py-2.5 sm:grid-cols-[160px_1fr_220px]">
              <span className="text-slate-500">{fmtWhen(a.at)}</span>
              <span><span className="font-medium text-slate-900">{actionLabel(a.action)}</span>{(a.target_name || a.target_id) && <span className="text-slate-600"> · {a.target_type === 'church' ? <Link to={adminPath(`/churches/${a.target_id}`)} className="hover:underline">{a.target_name || a.target_id}</Link> : a.target_name || a.target_id}</span>}
                {Object.keys(a.meta || {}).length > 0 && <span className="block text-xs text-slate-500">{Object.entries(a.meta).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ')}</span>}</span>
              <span className="truncate text-slate-500">{a.by}</span>
            </li>))}
            {!data.rows.length && <li className="px-5 py-6 text-slate-500">No entries.</li>}</ul>
          {(data.next || before) && <div className="flex justify-between border-t border-slate-100 px-5 py-2.5"><Button size="sm" variant="secondary" disabled={!before} onClick={() => setBefore('')}>Newest</Button><Button size="sm" variant="secondary" disabled={!data.next} onClick={() => setBefore(data.next)}>Older</Button></div>}
        </Panel>
      )}
    </div>
  )
}

// --- Settings ------------------------------------------------------------------------------------------
export function AdminSettings() {
  const toast = useToast()
  const confirm = useConfirm()
  const admins = useLoad(() => api.get('/platform/admins'), [])
  const pricing = useLoad(() => api.get('/platform/pricing'), [])
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const grant = async () => {
    if (!(await confirm({ title: `Give ${email} full admin access?`, message: 'They’ll be able to see every church, payment and setting in this console. They need a GatherHQ account already.', confirmLabel: 'Give access', danger: true }))) return
    setBusy(true)
    try { await api.post('/platform/admins', { email, confirm: email.trim().toLowerCase() }); toast('Access granted'); setEmail(''); admins.reload() } catch (e) { toast(e.message, 'error') } finally { setBusy(false) }
  }
  return (
    <div className="space-y-6">
      <PageTitle title="Settings" />
      <Panel title="Platform administrators">
        {admins.loading ? <Skeleton className="m-5 h-20" /> : admins.error ? <ErrorState error={admins.error} onRetry={admins.reload} /> : (
          <div className="px-5 py-4 text-sm">
            <p className="text-slate-600">Set in Netlify (PLATFORM_ADMIN_EMAILS): {admins.data.from_settings.join(', ') || 'none'}. Change these in Netlify.</p>
            <ul className="mt-3 divide-y divide-slate-100 rounded-lg border border-slate-100">{admins.data.granted.map(g => <li key={g.user_id} className="flex items-center justify-between px-3 py-2"><span>{g.email}<span className="block text-xs text-slate-500">Granted by {g.granted_by} · {fmtDate(g.granted_at)}</span></span><Button size="sm" variant="danger-ghost" onClick={async () => { if (await confirm({ title: `Remove ${g.email}?`, message: 'They lose access to this console straight away.', confirmLabel: 'Remove', danger: true })) { try { await api.del(`/platform/admins/${g.user_id}`); admins.reload() } catch (e) { toast(e.message, 'error') } } }}>Remove</Button></li>)}
              {!admins.data.granted.length && <li className="px-3 py-2 text-slate-500">No one else has been given access here.</li>}</ul>
            <div className="mt-3 flex flex-wrap items-end gap-2"><div className="w-72"><Input label="Give access to (email)" type="email" value={email} onChange={e => setEmail(e.target.value)} /></div><Button loading={busy} disabled={!email} onClick={grant}>Give access</Button></div>
            <p className="text-xs text-slate-500">Church owners and admins never get access here. Only these people can sign in to this console.</p>
          </div>
        )}
      </Panel>
      <Panel title="Pricing">
        {pricing.data ? <div className="px-5 py-4 text-sm">
          <ul className="space-y-1">{pricing.data.plans.map(p => <li key={p.key}><strong>{p.name}</strong>: ${p.monthly}/month or ${p.yearly}/year ({pricing.data.currency})</li>)}</ul>
          <p className="mt-2 text-slate-600">Stripe {pricing.data.stripe ? `(${pricing.data.stripe} mode)` : 'not connected'}: {Object.keys(pricing.data.stripe_prices).length ? Object.keys(pricing.data.stripe_prices).join(', ') : 'prices are created the first time someone subscribes'}.</p>
          <p className="mt-1 text-slate-600">Messaging credit packs: {pricing.data.credit_packs.map(p => `$${p}`).join(', ')}. <Link to={adminPath('/providers')} className="link">Change in Providers › SMS</Link></p>
          <p className="mt-2 text-xs text-slate-500">Plan prices are part of the app (and its Stripe prices), so changing them is a code change, not a setting, to keep Stripe and the app in step.</p>
        </div> : <Skeleton className="m-5 h-16" />}
      </Panel>
      <Panel title="More settings">
        <ul className="divide-y divide-slate-100 text-sm">
          <li className="px-5 py-2.5"><Link to={adminPath('/providers')} className="link">Providers</Link>: email provider, SMS providers, credentials, country routing, sender names</li>
          <li className="px-5 py-2.5"><Link to={adminPath('/audit')} className="link">Audit log</Link>: every action taken in this console</li>
          <li className="px-5 py-2.5 text-slate-500">Notification settings (alerts by email for failed payments or outages) aren’t built yet.</li>
        </ul>
      </Panel>
    </div>
  )
}
