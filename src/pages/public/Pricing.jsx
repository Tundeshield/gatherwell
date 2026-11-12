import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import PlanCards, { IntervalToggle } from '../../components/PlanCards'
import { LegalFooter } from './Legal'
import { SiteHeader, FaqList } from './site'
import { TRIAL_DAYS } from '../../../shared/plans.js'
import { useSession } from '../../lib/session'

export default function Pricing() {
  const { me } = useSession()
  const [interval, setInterval_] = useState('monthly')
  useEffect(() => { document.title = 'Pricing · GatherHQ'; return () => { document.title = 'GatherHQ' } }, [])
  const cta = me ? '/app/settings?tab=billing' : '/signup'
  return (
    <div className="min-h-screen bg-ivory text-ink">
      <SiteHeader />
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
          <h2 className="mb-6 text-center text-2xl font-semibold">Questions churches ask</h2>
          <FaqList />
        </section>
      </main>
      <LegalFooter />
    </div>
  )
}
