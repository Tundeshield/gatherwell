import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import PlanCards, { IntervalToggle } from '../../components/PlanCards'
import { LegalFooter } from './Legal'
import { SiteHeader, FaqList } from './site'
import { TRIAL_DAYS } from '../../../shared/plans.js'
import { useSession } from '../../lib/session'
import WhatsAppButton from '../../components/WhatsAppButton'

export default function Pricing() {
  const { me } = useSession()
  const [interval, setInterval_] = useState('yearly')
  useEffect(() => { document.title = 'Pricing · GatherHQ'; return () => { document.title = 'GatherHQ' } }, [])
  const cta = me ? '/app/settings?tab=billing' : '/signup'
  return (
    <div className="min-h-screen bg-ivory text-ink">
      <SiteHeader />
      <main className="mx-auto max-w-6xl px-6 pb-20 pt-10">
        <div className="text-center">
          <h1 className="text-[40px] font-semibold leading-tight tracking-[-0.02em]">Priced by the size of your church</h1>
          <p className="mx-auto mt-3 max-w-xl text-[17px] text-mist-600">Free for up to 50 people, for as long as you like. Bigger churches start with a {TRIAL_DAYS}-day free trial of everything, no card needed, and a 30-day money-back guarantee once you pay.</p>
          <div className="mt-7 flex justify-center"><IntervalToggle value={interval} onChange={setInterval_} /></div>
        </div>
        <div className="mt-8">
          <PlanCards interval={interval} action={(key) => (
            <Link to={cta} className={`block rounded-lg px-4 py-2.5 text-center text-sm font-medium ${key === 'growing' ? 'bg-brand-700 text-white hover:bg-brand-800' : 'border border-mist-200 bg-white text-ink hover:bg-mist-50'}`}>
              {me ? (key === 'free' ? 'Go to billing' : 'Choose this plan') : key === 'free' ? 'Start free' : `Start your free ${TRIAL_DAYS} days`}
            </Link>
          )} />
        </div>
        <p className="mt-5 text-center text-sm text-mist-500">Prices in naira. Pay by card, bank transfer or USSD through Paystack. Churches outside Nigeria can pay in naira with an international card. Running a denomination with many churches? <a href="mailto:hello@gatherhq.org" className="link">Talk to us</a>.</p>
        <section className="mx-auto mt-16 max-w-2xl">
          <h2 className="mb-6 text-center text-2xl font-semibold">Questions churches ask</h2>
          <FaqList />
        </section>
      </main>
      <WhatsAppButton />
      <LegalFooter />
    </div>
  )
}
