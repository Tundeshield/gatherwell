import { Check } from 'lucide-react'
import { PLANS } from '../../shared/plans.js'
import { Segmented } from './ui'

export function IntervalToggle({ value, onChange }) {
  return (
    <Segmented value={value} onChange={onChange} options={[
      { value: 'monthly', label: 'Monthly' },
      { value: 'yearly', label: <>Yearly <span className="rounded bg-gold-100 px-1.5 text-[11px] font-semibold text-gold-700">2 months free</span></> },
    ]} />
  )
}

// The two plans side by side. `action(planKey)` renders the button for each plan.
export default function PlanCards({ interval, action, current }) {
  return (
    <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
      {Object.values(PLANS).map(p => {
        const amount = interval === 'yearly' ? p.yearly : p.monthly
        const isCurrent = current === p.key
        return (
          <div key={p.key} className={`flex flex-col rounded-2xl border bg-white p-6 ${p.key === 'church' ? 'border-brand-300 shadow-card ring-1 ring-brand-100' : 'border-mist-200'}`}>
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-lg font-semibold text-ink">{p.name}</h3>
              {isCurrent ? <span className="rounded-full bg-brand-50 px-2.5 py-0.5 text-xs font-medium text-brand-700">Your plan</span>
                : p.key === 'church' && <span className="rounded-full bg-gold-100 px-2.5 py-0.5 text-xs font-medium text-gold-700">Recommended</span>}
            </div>
            <p className="mt-1 text-sm text-mist-500">{p.blurb}</p>
            <p className="mt-5 flex items-baseline gap-1.5">
              <span className="text-[40px] font-semibold leading-none tracking-tight text-ink">${amount}</span>
              <span className="text-sm text-mist-500">/ {interval === 'yearly' ? 'year' : 'month'}</span>
            </p>
            <p className="mt-1 h-5 text-xs text-mist-500">{interval === 'yearly' ? `That’s $${(p.yearly / 12).toFixed(2)} a month, billed yearly` : 'Billed monthly. Cancel any time.'}</p>
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
