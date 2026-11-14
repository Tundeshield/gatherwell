// Website visitors: who comes to gatherhq.org, where from, on what, and what they do.
import { useEffect, useState } from 'react'
import { RefreshCw, X, Smartphone, Monitor, Tablet, ArrowRight } from 'lucide-react'
import { api } from '../../lib/api'
import { useLoad, Button, Modal, Skeleton, ErrorState, EmptyState, Notice, Badge } from '../../components/ui'
import { Kpi, Panel, PageTitle, RangePicker, rangeQuery, fmtWhen } from './shared'

const RANGES = [['today', 'Today'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['month', 'This month'], ['last_month', 'Last month'], ['year', 'This year'], ['all', 'All time'], ['custom', 'Custom']]
const FILTER_LABEL = { source: 'Source', channel: 'Channel', country: 'Country', city: 'City', device: 'Device', browser: 'Browser', os: 'System', page: 'Viewed page', landing: 'Landing page', campaign: 'Campaign', language: 'Language', outcome: 'Outcome' }
const OUTCOME = { signed_up: 'Created a church account', started: 'Opened the sign-up page', customers: 'Existing customers' }
const PAGE = { '/': 'Home', '/pricing': 'Pricing', '/signup': 'Sign up', '/login': 'Sign in' }
const pageName = (p) => PAGE[p] || (p?.startsWith('/legal/') ? `Legal: ${p.slice(7)}` : p)

export const flag = (code) => (code && /^[A-Z]{2}$/i.test(code) ? String.fromCodePoint(...[...code.toUpperCase()].map(c => 0x1f1a5 + c.charCodeAt(0))) : '🌐')
export function dur(s) {
  s = Math.round(s || 0)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`
}
const DeviceIcon = ({ d, size = 15 }) => { const I = d === 'Mobile' ? Smartphone : d === 'Tablet' ? Tablet : Monitor; return <I size={size} className="text-slate-400" aria-label={d} /> }
const place = (v) => [v.city, v.country].filter(Boolean).join(', ') || 'Unknown location'

function DayBars({ data, monthly }) {
  const max = Math.max(1, ...data.map(d => d.visitors))
  const label = (k) => monthly ? new Date(`${k}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' }) : new Date(`${k}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
  const every = Math.ceil(data.length / 10)
  return (
    <figure aria-label="Unique visitors over time">
      <div className="flex items-end gap-[3px]" style={{ height: 170 }}>
        {data.map(d => (
          <div key={d.key} className="group relative flex h-full flex-1 flex-col justify-end">
            <div className="w-full rounded-t bg-cyan-600/85 group-hover:bg-cyan-700" style={{ height: `${(d.visitors / max) * 100}%`, minHeight: d.visitors ? 2 : 0 }} />
            <div className="pointer-events-none absolute -top-12 left-1/2 z-10 hidden -translate-x-1/2 whitespace-nowrap rounded bg-slate-900 px-2 py-1 text-[11px] leading-tight text-white group-hover:block">{label(d.key)}<br />{d.visitors} visitors · {d.pageviews} views{d.signups ? ` · ${d.signups} signups` : ''}</div>
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex gap-[3px] text-[10px] text-slate-400">{data.map((d, i) => <div key={d.key} className="flex-1 overflow-visible whitespace-nowrap text-center">{i % every === 0 ? label(d.key) : ''}</div>)}</div>
    </figure>
  )
}

function HourBars({ data }) {
  const max = Math.max(1, ...data.map(d => d.visitors))
  return (
    <figure aria-label="Visitors by hour of day">
      <div className="flex items-end gap-[3px]" style={{ height: 90 }}>
        {data.map(d => <div key={d.hour} title={`${String(d.hour).padStart(2, '0')}:00 – ${d.visitors} visitors`} className="flex-1 rounded-t bg-slate-300 hover:bg-slate-500" style={{ height: `${(d.visitors / max) * 100}%`, minHeight: d.visitors ? 2 : 0 }} />)}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-slate-400"><span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>23:00</span></div>
    </figure>
  )
}

function Breakdown({ title, rows, field, onPick, render = (k) => k, extra, empty = 'No data yet.' }) {
  return (
    <Panel title={title}>
      {rows?.length ? <ul className="px-3 py-2 text-[13.5px]">
        {rows.map(r => (
          <li key={r.key}>
            <button type="button" onClick={() => onPick(field, r.key)} className="group relative flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left hover:bg-slate-50" title="Show only these visitors">
              <span className="absolute inset-y-1 left-0 rounded bg-cyan-50" style={{ width: `${Math.max(2, r.pct)}%` }} aria-hidden />
              <span className="relative min-w-0 flex-1 truncate text-slate-800">{render(r.key, r)}</span>
              {extra && <span className="relative text-xs text-slate-400">{extra(r)}</span>}
              <span className="tabular relative w-10 text-right font-medium text-slate-900">{r.count}</span>
              <span className="tabular relative w-12 text-right text-xs text-slate-400">{r.pct}%</span>
            </button>
          </li>
        ))}
      </ul> : <p className="px-5 py-4 text-sm text-slate-500">{empty}</p>}
    </Panel>
  )
}

function VisitorDetail({ v, onClose }) {
  if (!v) return null
  const Row = ({ k, children }) => children ? <div className="flex gap-3 py-1.5 text-sm"><dt className="w-36 shrink-0 text-slate-500">{k}</dt><dd className="min-w-0 break-words text-slate-900">{children}</dd></div> : null
  const utm = Object.entries(v.utm || {}).filter(([, x]) => x)
  return (
    <Modal open onClose={onClose} title={`${flag(v.country_code)} Visitor from ${place(v)}`} description={`${fmtWhen(v.first_at)} · ${v.pageviews} page${v.pageviews === 1 ? '' : 's'} · ${dur(v.engaged_s)} on site`} size="lg" footer={<Button variant="secondary" onClick={onClose}>Close</Button>}>
      {v.converted && <Notice tone="success" className="mb-4">Created a church account: <b>{v.converted.name}</b> ({fmtWhen(v.converted.at)})</Notice>}
      <h3 className="mb-2 text-sm font-semibold text-slate-900">Pages, in order</h3>
      <ol className="mb-5 space-y-1">
        {v.pages.map((p, i) => <li key={i} className="flex items-center gap-3 rounded-md bg-slate-50 px-3 py-1.5 text-sm"><span className="tabular w-12 text-xs text-slate-500">{new Date(p.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</span><span className="flex-1 font-medium text-slate-800">{pageName(p.path)}</span><span className="tabular text-xs text-slate-500">{p.seconds ? dur(p.seconds) : '—'}</span></li>)}
      </ol>
      <dl className="divide-y divide-slate-100">
        <Row k="How they arrived">{v.source}{v.channel && v.channel !== v.source ? ` (${v.channel})` : ''}</Row>
        <Row k="Referring page">{v.referrer}</Row>
        <Row k="Campaign tags">{utm.length ? utm.map(([k, x]) => `${k}: ${x}`).join(' · ') : null}</Row>
        <Row k="Location">{[v.city, v.region, v.country].filter(Boolean).join(', ') || null}</Row>
        <Row k="Time zone">{v.browser_timezone || v.geo_timezone}</Row>
        <Row k="Device">{v.device}{v.touch ? ' (touch screen)' : ''}</Row>
        <Row k="System">{[v.os, v.os_version].filter(Boolean).join(' ')}</Row>
        <Row k="Browser">{[v.browser, v.browser_version].filter(Boolean).join(' ')}</Row>
        <Row k="Screen">{v.screen ? `${v.screen}${v.viewport ? ` (window ${v.viewport})` : ''}${v.dpr ? ` · ${v.dpr}× pixels` : ''}` : null}</Row>
        <Row k="Language">{v.languages?.length ? v.languages.join(', ') : v.language}</Row>
        <Row k="Landing / exit page">{`${pageName(v.landing)} → ${pageName(v.exit)}`}</Row>
        <Row k="Last seen">{fmtWhen(v.last_at)}</Row>
        <Row k="Notes">{[v.signed_in && 'Already a customer (signed in)', v.internal && 'Your own visit (signed in to this console)', v.bounce && 'Left after one page'].filter(Boolean).join(' · ') || null}</Row>
      </dl>
      <p className="mt-4 text-xs text-slate-500">Visitors are counted once per day without cookies, so the same person on another day appears as a new visitor. IP addresses are never stored.</p>
    </Modal>
  )
}

export default function AdminVisitors() {
  const [range, setRange] = useState({ range: '7d', from: '', to: '' })
  const [filters, setFilters] = useState({})
  const [internal, setInternal] = useState(false)
  const [open, setOpen] = useState(null)
  const fq = Object.entries(filters).map(([k, v]) => `&f_${k}=${encodeURIComponent(v)}`).join('')
  const { data, error, loading, reload } = useLoad(() => api.get(`/platform/visitors?${rangeQuery(range)}${fq}${internal ? '&internal=1' : ''}`), [range.range, range.from, range.to, fq, internal])
  useEffect(() => { const t = setInterval(() => { if (document.visibilityState === 'visible') reload() }, 60_000); return () => clearInterval(t) }, [reload])
  const pick = (k, v) => setFilters(f => ({ ...f, [k]: v }))

  if (error) return <ErrorState error={error} onRetry={reload} />
  if (!data) return <Skeleton className="h-96" />
  const k = data.kpis, b = data.breakdowns
  return (
    <div className="space-y-6">
      <PageTitle title="Website visitors" sub="People visiting gatherhq.org: where they come from, what they look at, and who signs up."
        action={<div className="flex flex-wrap items-center gap-2"><RangePicker value={range} onChange={setRange} options={RANGES} /><Button variant="secondary" icon={RefreshCw} loading={loading} onClick={reload}>Refresh</Button></div>} />

      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-2 rounded-full bg-emerald-50 px-3 py-1 text-sm font-medium text-emerald-800"><span className="relative flex h-2 w-2"><span className={`absolute inline-flex h-full w-full rounded-full bg-emerald-500 ${k.live_5m ? 'animate-ping opacity-60' : 'opacity-0'}`} /><span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" /></span>{k.live_5m} on the site now</span>
        <span className="text-sm text-slate-500">{k.live_30m} in the last 30 minutes</span>
        <span className="flex-1" />
        {Object.entries(filters).map(([f, v]) => <button key={f} type="button" onClick={() => setFilters(({ [f]: _, ...rest }) => rest)} className="inline-flex items-center gap-1 rounded-full bg-slate-900 px-3 py-1 text-xs font-medium text-white">{FILTER_LABEL[f]}: {f === 'outcome' ? OUTCOME[v] : f === 'page' || f === 'landing' ? pageName(v) : v}<X size={13} /></button>)}
        <label className="inline-flex items-center gap-2 text-xs text-slate-500"><input type="checkbox" checked={internal} onChange={e => setInternal(e.target.checked)} />Include my own visits{data.internal_excluded ? ` (${data.internal_excluded} hidden)` : ''}</label>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Kpi label="Unique visitors" value={k.visitors.toLocaleString()} sub={data.range.label} />
        <Kpi label="Page views" value={k.pageviews.toLocaleString()} sub={`${k.pages_per_visitor} per visitor`} />
        <Kpi label="Time on site" value={dur(k.avg_engaged_s)} sub={`Average · median ${dur(k.median_engaged_s)}`} />
        <Kpi label="Bounce rate" value={`${k.bounce_rate}%`} sub="Left after one page, under 10s" tone={k.bounce_rate > 70 ? 'warn' : undefined} />
        <Kpi label="Opened sign-up" value={k.signup_page} sub={k.visitors ? `${Math.round((k.signup_page / k.visitors) * 1000) / 10}% of visitors` : '—'} />
        <Kpi label="New churches" value={k.signups} sub={`${k.conversion}% of visitors signed up`} />
      </div>

      {data.capped && <Notice tone="warning">Showing the most recent 8,000 visitor-days in this period. Choose a shorter range for exact figures.</Notice>}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1.6fr_1fr]">
        <Panel title={`Unique visitors per ${data.range.monthly ? 'month' : 'day'}`}><div className="px-5 py-4">{k.visitors ? <DayBars data={data.series} monthly={data.range.monthly} /> : <p className="py-10 text-center text-sm text-slate-500">No visitors in this period yet.</p>}</div></Panel>
        <div className="space-y-6">
          <Panel title="From visit to sign-up">
            <ul className="px-5 py-3 text-sm">
              {[['Visited the site', k.visitors, null], ['Looked at pricing', b.page.find(p => p.key === '/pricing')?.count || 0, null], ['Opened the sign-up page', k.signup_page, 'started'], ['Created a church account', k.signups, 'signed_up']].map(([l, c, f]) => (
                <li key={l} className="py-1.5"><button type="button" disabled={!f} onClick={() => f && pick('outcome', f)} className="w-full text-left disabled:cursor-default">
                  <div className="flex justify-between"><span className="text-slate-700">{l}</span><span className="tabular font-semibold text-slate-900">{c}</span></div>
                  <div className="mt-1 h-1.5 rounded bg-slate-100"><div className="h-1.5 rounded bg-cyan-600" style={{ width: `${k.visitors ? (c / k.visitors) * 100 : 0}%` }} /></div>
                </button></li>))}
            </ul>
          </Panel>
          <Panel title="Time of day (Lagos time)"><div className="px-5 py-4"><HourBars data={data.hours} /></div></Panel>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3">
        <Breakdown title="How they found us" rows={b.channel} field="channel" onPick={pick} />
        <Breakdown title="Sources" rows={b.source} field="source" onPick={pick} />
        <Breakdown title="Referring pages" rows={b.referrer} field="source" onPick={() => {}} empty="No other websites have sent visitors yet." />
        <Breakdown title="Countries" rows={b.country} field="country" onPick={pick} render={(key, r) => <>{flag(r.code)} {key}</>} />
        <Breakdown title="Cities" rows={b.city} field="city" onPick={(f, v) => pick('city', v.replace(/, [A-Z]{2}$/, ''))} />
        <Breakdown title="Campaigns (UTM)" rows={b.campaign} field="campaign" onPick={pick} empty="Add ?utm_campaign=… to links you share to track them here." />
        <Breakdown title="Pages viewed" rows={b.page} field="page" onPick={pick} render={pageName} extra={(r) => `${r.views} views · ${dur(r.avg_s)}`} />
        <Breakdown title="Landing pages" rows={b.landing} field="landing" onPick={pick} render={pageName} />
        <Breakdown title="Devices" rows={b.device} field="device" onPick={pick} render={(key) => <span className="inline-flex items-center gap-2"><DeviceIcon d={key} />{key}</span>} />
        <Breakdown title="Browsers" rows={b.browser} field="browser" onPick={pick} />
        <Breakdown title="Systems" rows={b.os} field="os" onPick={pick} />
        <Breakdown title="Languages" rows={b.language} field="language" onPick={pick} render={(key) => { try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(key) || key } catch { return key } }} />
      </div>

      <Panel title={`Visitor log${data.visitors.length >= 300 ? ' (latest 300)' : ''}`} action={<span className="text-xs text-slate-500">Click a visitor for every detail</span>}>
        {data.visitors.length ? <div className="overflow-x-auto"><table className="w-full text-sm">
          <thead><tr className="text-left text-xs text-slate-500"><th className="px-5 py-2 font-medium">Last seen</th><th className="px-3 py-2 font-medium">Location</th><th className="px-3 py-2 font-medium">Came from</th><th className="px-3 py-2 font-medium">Device</th><th className="px-3 py-2 font-medium">Pages</th><th className="px-3 py-2 text-right font-medium">Time</th><th className="px-5 py-2 font-medium">Outcome</th></tr></thead>
          <tbody className="divide-y divide-slate-100">{data.visitors.map(v => (
            <tr key={v.id} onClick={() => setOpen(v)} className="cursor-pointer hover:bg-slate-50">
              <td className="whitespace-nowrap px-5 py-2.5 text-slate-600">{fmtWhen(v.last_at)}</td>
              <td className="px-3 py-2.5"><span className="mr-1.5">{flag(v.country_code)}</span><span className="text-slate-900">{v.city || v.country || 'Unknown'}</span>{v.city && v.country_code && <span className="text-slate-400">, {v.country_code}</span>}</td>
              <td className="px-3 py-2.5 text-slate-700">{v.source}{v.utm?.campaign && <span className="block text-xs text-slate-400">{v.utm.campaign}</span>}</td>
              <td className="px-3 py-2.5"><span className="inline-flex items-center gap-1.5 text-slate-700"><DeviceIcon d={v.device} />{v.os} · {v.browser}</span></td>
              <td className="px-3 py-2.5"><span className="flex flex-wrap items-center gap-1 text-xs text-slate-600">{v.pages.slice(0, 4).map((p, i) => <span key={i} className="inline-flex items-center gap-1">{i > 0 && <ArrowRight size={11} className="text-slate-300" />}{pageName(p.path)}</span>)}{v.pages.length > 4 && <span className="text-slate-400">+{v.pages.length - 4}</span>}</span></td>
              <td className="tabular whitespace-nowrap px-3 py-2.5 text-right text-slate-600">{dur(v.engaged_s)}</td>
              <td className="px-5 py-2.5">{v.converted ? <Badge tone="success">Signed up</Badge> : v.events.includes('signup_page') ? <Badge tone="warning">Opened sign-up</Badge> : v.signed_in ? <Badge tone="info">Customer</Badge> : v.bounce ? <Badge>Bounced</Badge> : <Badge tone="brand">Browsed</Badge>}{v.internal && <Badge className="ml-1">You</Badge>}</td>
            </tr>))}</tbody></table></div>
          : <EmptyState title="No visitors yet">Visits to the home page, pricing, sign-up and legal pages appear here within a few seconds.</EmptyState>}
      </Panel>
      <p className="text-xs text-slate-500">Counted without cookies: each visitor once per day, using a code made from their connection and browser that changes daily, so IP addresses are never stored. Bots, automated browsers and people who ask not to be tracked aren’t counted. Church check-in and event pages are never tracked. Kept for 13 months.</p>
      <VisitorDetail v={open} onClose={() => setOpen(null)} />
    </div>
  )
}
