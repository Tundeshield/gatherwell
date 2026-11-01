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
