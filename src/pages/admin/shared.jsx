import { Badge } from '../../components/ui'

export const money = (n, cents = false) => `$${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 })}`

export function planLabel(b) {
  if (!b) return '—'
  const plan = b.plan === 'network' ? 'Network' : 'Church'
  switch (b.state) {
    case 'free': return 'Free (comp)'
    case 'trialing': return `Trial · ${b.daysLeft} day${b.daysLeft === 1 ? '' : 's'} left`
    case 'active': return `${plan} · ${b.interval === 'yearly' ? 'yearly' : 'monthly'}${b.manual ? ' (by hand)' : ''}${b.cancelling ? ' · cancelling' : ''}`
    case 'past_due': return `${plan} · payment due`
    case 'expired': return b.lapsed ? 'Plan ended' : 'Trial ended'
    default: return '—'
  }
}

export function PlanBadge({ billing }) {
  const tone = { free: 'info', trialing: 'gold', active: 'success', past_due: 'danger', expired: 'neutral' }[billing?.state] || 'neutral'
  return <Badge tone={tone}>{planLabel(billing)}</Badge>
}

export function StatusBadge({ status }) {
  return <Badge tone={status === 'active' ? 'success' : status === 'suspended' ? 'warning' : 'neutral'} dot>{status === 'active' ? 'Active' : status === 'suspended' ? 'Suspended' : 'Closed'}</Badge>
}

export function Stat({ label, value, hint, strong }) {
  return (
    <div className="px-5 py-4">
      <div className={`tabular font-semibold text-ink ${strong ? 'text-[28px]' : 'text-2xl'}`}>{value}</div>
      <div className="text-sm text-mist-500">{label}</div>
      {hint && <div className="mt-0.5 text-xs text-mist-400">{hint}</div>}
    </div>
  )
}

// A small bar chart: one bar per week.
export function WeekBars({ data, label, height = 120 }) {
  const max = Math.max(1, ...data.map(d => d.count))
  return (
    <div>
      <div className="flex items-end gap-1.5" style={{ height }} role="img" aria-label={label}>
        {data.map((d, i) => (
          <div key={d.week} className="group relative flex h-full flex-1 flex-col justify-end">
            <div className={`rounded-t ${i === data.length - 1 ? 'bg-gold-500' : 'bg-brand-600'} min-h-[2px]`} style={{ height: `${(d.count / max) * 100}%` }} />
            <div className="pointer-events-none absolute -top-7 left-1/2 hidden -translate-x-1/2 whitespace-nowrap rounded bg-ink px-1.5 py-0.5 text-[11px] text-white group-hover:block">{d.count}</div>
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex gap-1.5 text-[10px] text-mist-400">
        {data.map((d, i) => <div key={d.week} className="flex-1 text-center">{i % 2 === (data.length - 1) % 2 ? new Date(d.week).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : ''}</div>)}
      </div>
    </div>
  )
}

export function actionLabel(a) {
  const t = String(a || '').replace(/^platform\./, 'GatherHQ team: ').replace(/[._]/g, ' ')
  return t.charAt(0).toUpperCase() + t.slice(1)
}

// --- business console helpers ---------------------------------------------------------------
export function fmtMoney(n, currency = 'usd', cents = true) {
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: String(currency || 'usd').toUpperCase(), minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 }).format(Number(n || 0)) }
  catch { return `${Number(n || 0).toFixed(2)} ${String(currency).toUpperCase()}` }
}
export const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—')
export const fmtWhen = (d) => (d ? new Date(d).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—')
export const monthLabel = (m) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' })

export const RANGES = [['today', 'Today'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['month', 'This month'], ['last_month', 'Last month'], ['year', 'This year'], ['all', 'All time'], ['custom', 'Custom']]
export function RangePicker({ value, onChange, options = RANGES }) {
  const today = new Date().toISOString().slice(0, 10)
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select aria-label="Date range" className="field !w-auto" value={value.range} onChange={e => onChange({ ...value, range: e.target.value, from: value.from || today.slice(0, 8) + '01', to: value.to || today })}>
        {options.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
      </select>
      {value.range === 'custom' && <>
        <input type="date" aria-label="From" className="field !w-auto" value={value.from} max={value.to} onChange={e => onChange({ ...value, from: e.target.value })} />
        <span className="text-sm text-mist-500">to</span>
        <input type="date" aria-label="To" className="field !w-auto" value={value.to} min={value.from} onChange={e => onChange({ ...value, to: e.target.value })} />
      </>}
    </div>
  )
}
export const rangeQuery = (v) => `range=${v.range}${v.range === 'custom' ? `&from=${v.from}&to=${v.to}` : ''}`

export function Kpi({ label, value, sub, tone }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3.5">
      <div className="text-[13px] text-slate-500">{label}</div>
      <div className={`tabular mt-1 text-[24px] font-semibold tracking-tight ${tone === 'bad' ? 'text-red-700' : tone === 'warn' ? 'text-amber-700' : 'text-slate-900'}`}>{value}</div>
      {sub && <div className="mt-0.5 text-[12px] text-slate-500">{sub}</div>}
    </div>
  )
}

export function Panel({ title, action, children, className = '' }) {
  return (
    <section className={`rounded-xl border border-slate-200 bg-white ${className}`}>
      {title && <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-5 py-3"><h2 className="text-[15px] font-semibold text-slate-900">{title}</h2>{action}</div>}
      {children}
    </section>
  )
}

export function PageTitle({ title, sub, action }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div><h1 className="text-[24px] font-semibold tracking-tight text-slate-900">{title}</h1>{sub && <p className="mt-0.5 text-sm text-slate-500">{sub}</p>}</div>
      {action}
    </div>
  )
}

// Bars per month; series = [{ key, label, color }]; stacked.
export function MonthBars({ data, series, format = (v) => v, height = 180, label }) {
  const total = (d) => series.reduce((a, s) => a + Math.max(0, Number(d[s.key] || 0)), 0)
  const max = Math.max(1, ...data.map(total))
  return (
    <figure aria-label={label}>
      <div className="flex items-end gap-1.5" style={{ height }}>
        {data.map(d => (
          <div key={d.month} className="group relative flex h-full flex-1 flex-col justify-end" title={`${monthLabel(d.month)}: ${series.map(s => `${s.label} ${format(d[s.key] || 0)}`).join(', ')}`}>
            {series.map(s => <div key={s.key} className="w-full first:rounded-t" style={{ height: `${(Math.max(0, d[s.key] || 0) / max) * 100}%`, background: s.color, minHeight: d[s.key] > 0 ? 2 : 0 }} />)}
            <div className="pointer-events-none absolute -top-7 left-1/2 z-10 hidden -translate-x-1/2 whitespace-nowrap rounded bg-slate-900 px-1.5 py-0.5 text-[11px] text-white group-hover:block">{format(total(d))}</div>
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex gap-1.5 text-[10px] text-slate-400">{data.map(d => <div key={d.month} className="flex-1 text-center">{monthLabel(d.month)}</div>)}</div>
      {series.length > 1 && <figcaption className="mt-2 flex gap-4 text-xs text-slate-500">{series.map(s => <span key={s.key} className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />{s.label}</span>)}</figcaption>}
    </figure>
  )
}

const PAY_TONE = { paid: 'success', failed: 'danger', open: 'gold', pending: 'gold', refunded: 'neutral', partially_refunded: 'info', void: 'neutral', uncollectible: 'danger' }
const PAY_LABEL = { paid: 'Paid', failed: 'Failed', open: 'Unpaid', pending: 'Pending', refunded: 'Refunded', partially_refunded: 'Part refunded', void: 'Void', uncollectible: 'Uncollectible' }
export const PayStatus = ({ status }) => <Badge tone={PAY_TONE[status] || 'neutral'}>{PAY_LABEL[status] || status}</Badge>
