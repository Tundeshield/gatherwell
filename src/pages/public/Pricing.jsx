import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import Logo from '../../components/Logo'
import PlanCards, { IntervalToggle } from '../../components/PlanCards'
import { LegalFooter } from './Legal'
import { TRIAL_DAYS } from '../../../shared/plans.js'
import { useSession } from '../../lib/session'

const FAQ = [
  ['What happens after the free trial?', `You get ${TRIAL_DAYS} days with everything included, no card needed. Then choose a plan to keep using GatherHQ. Nothing is deleted: you can still view and download everything, and pick up where you left off as soon as you choose a plan.`],
  ['Can I cancel any time?', 'Yes. Cancel from Settings › Billing and your plan runs until the end of the period you’ve paid for.'],
  ['Can I get a refund?', 'Yes. If you ask within 30 days of any payment, we refund it in full, no questions asked. See our Refund Policy.'],
  ['Do we need any special equipment?', 'No. Any phone works for QR check-in. For children’s name labels, any 4×2 inch label printer (Dymo, Brother and similar) works; without a printer, the pickup code shows on screen.'],
  ['Is there a limit on people or team members?', 'No. Both plans include unlimited people, check-ins and team members.'],
  ['What’s the difference between the plans?', 'Single church is for one congregation. Church network adds multiple branches or campuses, with branch-level access for your team and reports across the whole church.'],
  ['Who owns our data?', 'Your church does. You can download all of it at any time, and we sign a Data Processing Agreement with every church.'],
  ['How do we pay?', 'By card or other local payment methods, securely through Paddle, our reseller. Prices are in US dollars, and Paddle shows the price in your currency and adds any sales tax or VAT where it applies. Paddle sends the receipts and invoices.'],
]

export default function Pricing() {
  const { me } = useSession()
  const [interval, setInterval_] = useState('monthly')
  useEffect(() => { document.title = 'Pricing · GatherHQ'; return () => { document.title = 'GatherHQ' } }, [])
  const cta = me ? '/app/settings?tab=billing' : '/signup'
  return (
    <div className="min-h-screen bg-ivory text-ink">
      <header className="mx-auto flex max-w-page items-center justify-between px-6 py-5">
        <Link to="/"><Logo size={30} /></Link>
        <nav className="flex items-center gap-2">
          <Link to={me ? '/app' : '/login'} className="rounded-lg px-4 py-2 text-sm font-medium text-ink hover:bg-white">{me ? 'Open GatherHQ' : 'Sign in'}</Link>
          {!me && <Link to="/signup" className="rounded-lg bg-brand-700 px-4 py-2 text-sm font-medium text-white hover:bg-brand-800">Start free</Link>}
        </nav>
      </header>
      <main className="mx-auto max-w-4xl px-6 pb-20 pt-10">
        <div className="text-center">
          <h1 className="text-[40px] font-semibold leading-tight tracking-[-0.02em]">Simple pricing for every church</h1>
          <p className="mx-auto mt-3 max-w-xl text-[17px] text-mist-600">Start with a {TRIAL_DAYS}-day free trial. Everything included, no card needed. And a 30-day money-back guarantee once you pay.</p>
          <div className="mt-7 flex justify-center"><IntervalToggle value={interval} onChange={setInterval_} /></div>
        </div>
        <div className="mt-8">
          <PlanCards interval={interval} action={(key) => (
            <Link to={cta} className={`block rounded-lg px-4 py-2.5 text-center text-sm font-medium ${key === 'church' ? 'bg-brand-700 text-white hover:bg-brand-800' : 'border border-mist-200 bg-white text-ink hover:bg-mist-50'}`}>
              {me ? 'Choose this plan' : `Start your free ${TRIAL_DAYS} days`}
            </Link>
          )} />
        </div>
        <p className="mt-5 text-center text-sm text-mist-500">Prices in US dollars. Running many churches or a denomination? <a href="mailto:hello@gatherhq.org" className="link">Talk to us</a>.</p>
        <section className="mx-auto mt-16 max-w-2xl">
          <h2 className="mb-6 text-center text-2xl font-semibold">Questions</h2>
          <dl className="divide-y divide-mist-200 rounded-2xl border border-mist-200 bg-white">
            {FAQ.map(([q, a]) => (
              <div key={q} className="px-6 py-5"><dt className="font-medium text-ink">{q}</dt><dd className="mt-1.5 text-[15px] leading-relaxed text-mist-600">{a}</dd></div>
            ))}
          </dl>
        </section>
      </main>
      <LegalFooter />
    </div>
  )
}
