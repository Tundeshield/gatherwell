import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Check, Play, QrCode, HeartHandshake, Baby, Newspaper, CalendarDays, Users, Mail, MessageCircle, BarChart3, ShieldCheck, Building2, KeyRound, FileSearch, Download } from 'lucide-react'
import PlanCards, { IntervalToggle } from '../../components/PlanCards'
import { useSession } from '../../lib/session'
import { TRIAL_DAYS } from '../../../shared/plans.js'
import { SiteHeader, FaqList, Reveal } from './site'
import { LegalFooter } from './Legal'

// Every screenshot on this page is a real GatherHQ screen, captured from the app with demo data.
const SHOT = (name) => `/media/${name}`

function BrowserFrame({ src, alt, w = 1600, h = 813, className = '', priority = false }) {
  return (
    <div className={`overflow-hidden rounded-xl border border-mist-200 bg-white shadow-pop ${className}`}>
      <div className="flex h-7 items-center gap-1.5 border-b border-mist-200 bg-mist-50 px-3" aria-hidden>
        <span className="h-2.5 w-2.5 rounded-full bg-mist-300" /><span className="h-2.5 w-2.5 rounded-full bg-mist-300" /><span className="h-2.5 w-2.5 rounded-full bg-mist-300" />
      </div>
      <img src={SHOT(src)} alt={alt} width={w} height={h} loading={priority ? 'eager' : 'lazy'} decoding="async" className="block h-auto w-full" />
    </div>
  )
}

function PhoneFrame({ src, alt, className = '' }) {
  return (
    <div className={`w-[230px] shrink-0 rounded-[2.2rem] border border-mist-200 bg-white p-2 shadow-pop sm:w-[250px] ${className}`}>
      <img src={SHOT(src)} alt={alt} width={560} height={1149} loading="lazy" decoding="async" className="block h-auto w-full rounded-[1.7rem]" />
    </div>
  )
}

// The product tour. It has no soundtrack, so it never starts on its own: the visitor presses play.
function TourVideo({ playRef }) {
  const video = useRef(null)
  const [started, setStarted] = useState(false)
  const start = () => { setStarted(true); requestAnimationFrame(() => video.current?.play().catch(() => {})) }
  useEffect(() => { if (playRef) playRef.current = start })
  return (
    <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-brand-900 shadow-pop">
      <video ref={video} className="block aspect-video w-full" poster={SHOT('tour-poster.jpg')} preload="none" playsInline controls={started}
        aria-label="GatherHQ product tour, 35 seconds, no sound">
        <source src={SHOT('gatherhq-tour.mp4')} type="video/mp4" />
        Your browser can’t play this video.
      </video>
      {!started && (
        <button type="button" onClick={start} className="group absolute inset-0 flex items-end justify-start p-4 transition-colors hover:bg-brand-900/5 focus-visible:outline-none sm:p-6" aria-label="Play the 35-second product tour">
          <span className="flex items-center gap-3 rounded-full bg-white py-3 pl-3 pr-6 text-[15px] font-semibold text-brand-900 shadow-pop transition-transform group-hover:scale-[1.03] group-focus-visible:ring-4 group-focus-visible:ring-white/50">
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-brand-700 text-white"><Play size={18} fill="currentColor" className="ml-0.5" /></span>
            Watch the tour · 0:35
          </span>
        </button>
      )}
    </div>
  )
}

const BEFORE_AFTER = [
  ['A paper register at the door', 'QR check-in on any phone. Returning people only type their number and first name.'],
  ['Visitor cards that sit in a drawer', 'Every first-time visitor gets a welcome follow-up, assigned to a named person and due within 48 hours.'],
  ['Reminders lost in WhatsApp groups', 'One-tap WhatsApp to each person, and emails with your church’s logo and colours.'],
  ['A members spreadsheet nobody trusts', 'One record per person, with every visit, follow-up and note in one place.'],
  ['A sign-in sheet for the children’s room', 'Name labels with allergy alerts, and a pickup code that must match before a child is released.'],
]

function Feature({ id, eyebrow, icon: Icon, title, body, points, visual, flip = false }) {
  return (
    <Reveal as="section" id={id} className="mx-auto grid max-w-page grid-cols-1 items-center gap-10 px-5 py-14 sm:px-6 lg:grid-cols-2 lg:gap-16 lg:py-20">
      <div className={flip ? 'lg:order-2' : ''}>
        <p className="flex items-center gap-2 text-sm font-semibold text-brand-700"><Icon size={17} />{eyebrow}</p>
        <h3 className="mt-3 text-[28px] font-semibold leading-tight tracking-[-0.015em] text-ink sm:text-[32px]">{title}</h3>
        <p className="mt-4 text-[17px] leading-relaxed text-ink-soft">{body}</p>
        <ul className="mt-6 space-y-3">
          {points.map(p => <li key={p} className="flex gap-3 text-[16px] leading-relaxed text-ink-soft"><Check size={19} className="mt-1 shrink-0 text-brand-600" />{p}</li>)}
        </ul>
      </div>
      <div className={`min-w-0 ${flip ? 'lg:order-1' : ''}`}>{visual}</div>
    </Reveal>
  )
}

const ALSO = [
  [Users, 'Import in minutes', 'Upload your members spreadsheet. GatherHQ previews it and catches duplicates before anything is saved.'],
  [Mail, 'Branded emails', 'Your logo and colours, a preview before sending, and automatic welcome emails for new visitors.'],
  [MessageCircle, 'One-tap WhatsApp', 'Open a ready-written message to each person in a group, one tap at a time, from your own WhatsApp.'],
  [BarChart3, 'Reports and exports', 'Weekly attendance, the visitor journey and follow-ups, with exports for the people you trust.'],
  [KeyRound, 'Roles for every team', 'Ushers, children’s workers, leaders and admins each see only what their role needs.'],
  [Building2, 'One church or many branches', 'Add branches and campuses on the Church network plan, with reports by branch and across the church.'],
]

export default function Landing() {
  const { me } = useSession()
  const signedIn = !!me
  const [interval, setInterval_] = useState('monthly')
  const playTour = useRef(null)
  const primary = signedIn ? '/app' : '/signup'
  const watch = () => { document.getElementById('tour')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); playTour.current?.() }
  useEffect(() => { document.title = 'GatherHQ: check-in, visitor follow-up and children’s check-in for churches' }, [])

  return (
    <div className="min-h-screen bg-ivory text-ink">
      <SiteHeader dark />

      {/* Hero */}
      <section className="bg-brand-900 text-white">
        <div className="mx-auto max-w-page px-5 pb-16 pt-12 sm:px-6 lg:pt-20">
          <div className="max-w-3xl">
            <p className="text-sm font-semibold uppercase tracking-[0.12em] text-brand-200">For churches of every size</p>
            <h1 className="mt-4 text-[40px] font-semibold leading-[1.06] tracking-[-0.03em] sm:text-[60px]">Know your people. Welcome every visitor. Follow through.</h1>
            <p className="mt-6 max-w-2xl text-[18px] leading-relaxed text-brand-100 sm:text-[20px]">GatherHQ replaces the paper register, the visitor spreadsheet and the WhatsApp reminders with one simple system: QR check-in, visitor follow-up, children’s check-in and events, for one church or every branch.</p>
            <div className="mt-9 flex flex-col gap-3 sm:flex-row sm:items-center">
              <Link to={primary} className="rounded-lg bg-white px-6 py-3.5 text-center text-[16px] font-semibold text-brand-900 hover:bg-brand-50">{signedIn ? 'Open your workspace' : `Start your free ${TRIAL_DAYS}-day trial`}</Link>
              <button type="button" onClick={watch} className="flex items-center justify-center gap-2.5 rounded-lg border border-white/25 px-6 py-3.5 text-[16px] font-semibold text-white hover:bg-white/10">
                <Play size={17} fill="currentColor" />Watch the 35-second tour
              </button>
            </div>
            <p className="mt-5 text-[15px] text-brand-200">No card needed to start · Unlimited people and team members · From $19 a month</p>
          </div>
        </div>
        <div className="mx-auto max-w-page px-5 sm:px-6">
          <div className="relative -mb-24 sm:-mb-40">
            <BrowserFrame src="overview.webp" priority alt="The GatherHQ overview: the latest Sunday Service with 48 people checked in, follow-ups that need attention, and attendance for the last 12 weeks." />
            <PhoneFrame src="checkin-m.webp" alt="The check-in page a member sees after scanning the QR code: Sunday Service, enter your phone number." className="absolute -bottom-8 right-6 hidden md:block lg:right-10" />
          </div>
        </div>
      </section>

      {/* Tour */}
      <section id="tour" className="scroll-mt-24 px-5 pb-16 pt-36 sm:px-6 sm:pt-56">
        <Reveal className="mx-auto max-w-4xl">
          <div className="mb-8 text-center">
            <h2 className="text-[30px] font-semibold leading-tight tracking-[-0.02em] text-ink sm:text-[36px]">See a Sunday in GatherHQ</h2>
            <p className="mx-auto mt-3 max-w-xl text-[17px] text-mist-600">From the QR code at the door to the follow-up call on Tuesday, in 35 seconds. No sound needed.</p>
          </div>
          <TourVideo playRef={playTour} />
        </Reveal>
      </section>

      {/* The problem, and what replaces it */}
      <section id="product" className="scroll-mt-20 border-y border-mist-200 bg-white">
        <Reveal className="mx-auto max-w-page px-5 py-16 sm:px-6 lg:py-24">
          <div className="max-w-2xl">
            <h2 className="text-[30px] font-semibold leading-tight tracking-[-0.02em] text-ink sm:text-[36px]">Sunday shouldn’t run on five disconnected tools</h2>
            <p className="mt-4 text-[17px] leading-relaxed text-mist-600">Each one works on its own. Together they lose people: the visitor nobody called back, the member who quietly stopped coming, the register nobody totals. GatherHQ puts the whole loop in one place.</p>
          </div>
          <div className="mt-10 overflow-hidden rounded-2xl border border-mist-200">
            <div className="hidden grid-cols-2 bg-mist-50 text-sm font-semibold text-mist-500 sm:grid">
              <div className="px-6 py-3">Instead of</div><div className="border-l border-mist-200 px-6 py-3 text-brand-700">With GatherHQ</div>
            </div>
            {BEFORE_AFTER.map(([before, after]) => (
              <div key={before} className="grid grid-cols-1 border-t border-mist-200 sm:grid-cols-2 sm:first-of-type:border-t">
                <div className="px-6 pb-1 pt-5 text-[16px] text-mist-500 line-through decoration-mist-300 sm:py-5">{before}</div>
                <div className="flex gap-3 px-6 pb-5 pt-1 text-[16px] leading-relaxed text-ink sm:border-l sm:border-mist-200 sm:py-5"><Check size={19} className="mt-1 shrink-0 text-brand-600" />{after}</div>
              </div>
            ))}
          </div>
        </Reveal>
      </section>

      {/* How it works, feature by feature */}
      <div className="pt-6">
        <Feature eyebrow="Check-in" icon={QrCode} title="Check-in that takes seconds, not a clipboard"
          body="Put the QR code on a screen or a printed card. People scan it with their phone camera: no app, no account."
          points={['First-time visitors fill a short form once', 'Returning people type their phone number and first name', 'Ushers can add anyone without a phone, and leaders see the count live']}
          visual={<div className="flex justify-center"><PhoneFrame src="checkin-m.webp" alt="Member check-in page for Sunday Service" /></div>} />

        <Feature flip eyebrow="Follow-up" icon={HeartHandshake} title="Every visitor gets a call back from a real person"
          body="When someone checks in for the first time, GatherHQ creates a welcome follow-up and sends them a welcome email the same day. People who have been away for three weeks or more show up too, so a leader can check in with them."
          points={['Assign each follow-up to someone on your team, with a due date', 'Message the person on WhatsApp in one tap, then record how it went', 'See what is overdue, due today and coming up at a glance']}
          visual={<BrowserFrame src="followups.webp" h={688} alt="The follow-ups list: welcome follow-ups for first-time visitors and for families new to children’s church, each with a due date." />} />

        <Feature id="children" eyebrow="Children’s church" icon={Baby} title="Children’s check-in your team and parents can rely on"
          body="Parents check their children in with their phone number. Each child gets a name label, and the parent keeps a pickup tag with a matching code. Teachers see their class live, including allergy alerts and first visits."
          points={['Name labels print on any 4×2 inch label printer, or the code shows on screen', 'A pickup code must match before a child is released', 'Each class shows when it needs another adult, based on the ratio you set', 'Allergy and medical notes are visible only to people with children’s ministry access']}
          visual={<div className="relative"><BrowserFrame src="children.webp" alt="Children’s Church today: 7 children checked in across four classes, with each class showing its places and the adults needed." /><PhoneFrame src="kids-m.webp" alt="A parent choosing which children to check in. One child has an egg allergy noted." className="absolute -bottom-10 -right-2 hidden w-[170px] sm:block sm:w-[190px]" /></div>} />

        <Feature flip eyebrow="The Monday Pastor’s Brief" icon={Newspaper} title="Start every week knowing where your church stands"
          body="Every Monday at 7am in your church’s timezone, leaders get one email: who came, who is new, who is drifting away and which follow-ups are overdue. The overview and reports are a tap away when you want more."
          points={['Weekly attendance for the last 12 weeks, split into returning and first-time', 'The visitor journey: who came back once, three times, and who became a member', 'For church networks: every branch together, or one at a time']}
          visual={<BrowserFrame src="reports.webp" alt="GatherHQ reports: 667 check-ins over 12 weeks, weekly attendance chart and the visitor journey." />} />

        <Feature eyebrow="Events" icon={CalendarDays} title="Events with registration, tickets and a waitlist"
          body="Publish a registration page for a conference, camp or breakfast. When it fills, new sign-ups join the waitlist and move up when a place opens."
          points={['A shareable registration page with your own questions', 'QR tickets and a check-in list for the door that works on a phone', 'Capacity limits, so you never oversell a room']}
          visual={<div className="flex justify-center"><PhoneFrame src="event-m.webp" alt="Registration page for Youth Camp 2026 with 22 of 60 places left" /></div>} />
      </div>

      {/* Also included */}
      <section className="border-y border-mist-200 bg-white">
        <Reveal className="mx-auto max-w-page px-5 py-16 sm:px-6 lg:py-20">
          <h2 className="text-[26px] font-semibold tracking-[-0.015em] text-ink sm:text-[30px]">Also in every plan</h2>
          <div className="mt-10 grid grid-cols-1 gap-x-10 gap-y-9 sm:grid-cols-2 lg:grid-cols-3">
            {ALSO.map(([Icon, t, b]) => (
              <div key={t}><Icon size={22} className="text-brand-700" /><h3 className="mt-3 text-[17px] font-semibold text-ink">{t}</h3><p className="mt-1.5 text-[15px] leading-relaxed text-mist-600">{b}</p></div>
            ))}
          </div>
        </Reveal>
      </section>

      {/* Who it's for */}
      <Reveal as="section" className="mx-auto max-w-page px-5 py-16 sm:px-6 lg:py-24">
        <h2 className="max-w-2xl text-[30px] font-semibold leading-tight tracking-[-0.02em] text-ink sm:text-[36px]">Made for one congregation, ready for many branches</h2>
        <div className="mt-10 grid grid-cols-1 gap-5 md:grid-cols-2">
          <div className="rounded-2xl border border-mist-200 bg-white p-7">
            <h3 className="text-[19px] font-semibold text-ink">A single church</h3>
            <p className="mt-2 text-[16px] leading-relaxed text-mist-600">One congregation that wants to know who came, welcome every visitor and run children’s church without paper. Your pastor, administrator, ushers and children’s team each get the access they need.</p>
          </div>
          <div className="rounded-2xl border border-mist-200 bg-white p-7">
            <h3 className="text-[19px] font-semibold text-ink">A church with branches or campuses</h3>
            <p className="mt-2 text-[16px] leading-relaxed text-mist-600">Headquarters sees every branch together. Branch pastors see and manage only their own branch. Reports work across the whole church or one branch at a time, and you add branches whenever you open one.</p>
          </div>
        </div>
      </Reveal>

      {/* Pricing */}
      <section id="pricing" className="scroll-mt-20 border-t border-mist-200 bg-white">
        <Reveal className="mx-auto max-w-4xl px-5 py-16 sm:px-6 lg:py-24">
          <div className="text-center">
            <h2 className="text-[30px] font-semibold leading-tight tracking-[-0.02em] text-ink sm:text-[36px]">Simple pricing, everything included</h2>
            <p className="mx-auto mt-3 max-w-xl text-[17px] text-mist-600">Try every feature free for {TRIAL_DAYS} days, no card needed. After that, pay monthly or yearly, and get a full refund if you ask within 30 days of a payment.</p>
            <div className="mt-7 flex justify-center"><IntervalToggle value={interval} onChange={setInterval_} /></div>
          </div>
          <div className="mt-8">
            <PlanCards interval={interval} action={(key) => (
              <Link to={signedIn ? '/app/settings?tab=billing' : '/signup'} className={`block rounded-lg px-4 py-3 text-center text-[15px] font-semibold ${key === 'church' ? 'bg-brand-700 text-white hover:bg-brand-800' : 'border border-mist-300 bg-white text-ink hover:bg-mist-50'}`}>
                {signedIn ? 'Choose this plan' : `Start your free ${TRIAL_DAYS} days`}
              </Link>
            )} />
          </div>
          <p className="mt-5 text-center text-sm text-mist-500">Prices in US dollars, paid by card through Stripe. <Link to="/pricing" className="link">Full pricing details</Link></p>
        </Reveal>
      </section>

      {/* Trust */}
      <section className="bg-brand-900 text-white">
        <Reveal className="mx-auto grid max-w-page grid-cols-1 gap-12 px-5 py-16 sm:px-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] lg:py-24">
          <div>
            <h2 className="text-[30px] font-semibold leading-tight tracking-[-0.02em] sm:text-[34px]">Your members’ details, handled with care</h2>
            <p className="mt-4 max-w-md text-[17px] leading-relaxed text-brand-100">Church records are personal, and children’s records most of all. GatherHQ is built so the right people see the right things, and nothing more.</p>
          </div>
          <ul className="grid grid-cols-1 gap-8 sm:grid-cols-2">
            {[[ShieldCheck, 'Each church is kept separate', 'Every request is checked on our servers against the church it belongs to, not just hidden in the screen.'],
              [KeyRound, 'Access by role', 'Ushers can check people in without browsing the directory. Children’s allergy and medical notes are limited to roles with children’s ministry access.'],
              [FileSearch, 'Exports are permissioned and logged', 'Only roles you allow can download personal data, and every export is recorded.'],
              [Download, 'Your data stays yours', 'Your church owns its records. Export them at any time, or ask us to delete them. A Data Processing Agreement is available to every church.']].map(([Icon, t, b]) => (
              <li key={t}><Icon size={22} className="text-brand-200" /><h3 className="mt-3 text-[17px] font-semibold">{t}</h3><p className="mt-1.5 text-[15px] leading-relaxed text-brand-100">{b}</p></li>
            ))}
          </ul>
        </Reveal>
      </section>

      {/* FAQ */}
      <section id="faq" className="scroll-mt-20">
        <Reveal className="mx-auto max-w-3xl px-5 py-16 sm:px-6 lg:py-24">
          <h2 className="mb-8 text-center text-[30px] font-semibold tracking-[-0.02em] text-ink sm:text-[36px]">Questions churches ask</h2>
          <FaqList />
          <p className="mt-6 text-center text-[15px] text-mist-600">Something else? Email <a href="mailto:hello@gatherhq.org" className="link">hello@gatherhq.org</a> and a person will reply.</p>
        </Reveal>
      </section>

      {/* Final call to action */}
      <section className="px-5 pb-20 sm:px-6">
        <div className="mx-auto max-w-page rounded-3xl bg-brand-800 px-6 py-14 text-center text-white sm:px-12">
          <h2 className="mx-auto max-w-2xl text-[30px] font-semibold leading-tight tracking-[-0.02em] sm:text-[38px]">Be ready for this Sunday</h2>
          <p className="mx-auto mt-4 max-w-xl text-[17px] leading-relaxed text-brand-100">Create your church account, import your members and put the QR code at the door. You can be ready in an afternoon.</p>
          <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
            <Link to={primary} className="rounded-lg bg-white px-6 py-3.5 text-[16px] font-semibold text-brand-900 hover:bg-brand-50">{signedIn ? 'Open your workspace' : `Start your free ${TRIAL_DAYS}-day trial`}</Link>
            <a href="mailto:hello@gatherhq.org" className="rounded-lg border border-white/25 px-6 py-3.5 text-[16px] font-semibold text-white hover:bg-white/10">Talk to us</a>
          </div>
        </div>
      </section>

      <LegalFooter />
    </div>
  )
}
