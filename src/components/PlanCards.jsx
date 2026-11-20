import { Check } from 'lucide-react'
import { PLANS, naira } from '../../shared/plans.js'
import { Segmented } from './ui'

export function IntervalToggle({ value, onChange }) {
  return (
    <Segmented value={value} onChange={onChange} options={[
      { value: 'yearly', label: <>Yearly <span className="rounded bg-cyan-100 px-1.5 text-[11px] font-semibold text-cyan-800">2 months free</span></> },
      { value: 'monthly', label: 'Monthly' },
    ]} />
  )
}

// The plans side by side, priced by church size. `action(planKey)` renders each plan's button.
// showFree: include the Free plan (the public pricing page does; the billing screen shows it separately).
export default function PlanCards({ interval, action, current, showFree = true, recommended = 'growing' }) {
  const plans = Object.values(PLANS).filter(p => showFree || p.key !== 'free')
  return (
    <div className={`grid grid-cols-1 gap-4 sm:grid-cols-2 ${plans.length === 4 ? 'xl:grid-cols-4' : 'lg:grid-cols-3'}`}>
      {plans.map(p => {
        const amount = interval === 'yearly' ? p.yearly : p.monthly
        const isCurrent = current === p.key
        const rec = p.key === recommended
        return (
          <div key={p.key} className={`flex flex-col rounded-2xl border bg-white p-6 ${rec ? 'border-brand-300 shadow-card ring-1 ring-brand-100' : 'border-mist-200'}`}>
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-lg font-semibold text-ink">{p.name}</h3>
              {isCurrent ? <span className="rounded-full bg-brand-50 px-2.5 py-0.5 text-xs font-medium text-brand-700">Your plan</span>
                : rec && <span className="rounded-full bg-cyan-100 px-2.5 py-0.5 text-xs font-medium text-cyan-800">Most churches</span>}
            </div>
            <p className="mt-1 text-sm font-medium text-ink-soft">{p.limit ? `Up to ${p.limit.toLocaleString()} people` : 'Any size, any number of branches'}</p>
            <p className="mt-1 min-h-[40px] text-sm text-mist-500">{p.blurb}</p>
            <p className="mt-4 flex items-baseline gap-1.5">
              <span className="text-[34px] font-semibold leading-none tracking-tight text-ink">{amount ? naira(amount) : '₦0'}</span>
              <span className="text-sm text-mist-500">{amount ? `/ ${interval === 'yearly' ? 'year' : 'month'}` : 'forever'}</span>
            </p>
            <p className="mt-1 h-5 text-xs text-mist-500">{!amount ? 'No card needed' : interval === 'yearly' ? `That’s ${naira(p.yearly / 12)} a month` : `Or ${naira(p.yearly)} a year (2 months free)`}</p>
            <ul className="mb-6 mt-5 flex-1 space-y-2.5 text-sm text-ink-soft">
              {p.features.map(f => <li key={f} className="flex gap-2.5"><Check size={17} className="mt-0.5 shrink-0 text-brand-600" />{f}</li>)}
            </ul>
            {action(p.key)}
          </div>
        )
      })}
    </div>
  )
}
