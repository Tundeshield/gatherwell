import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Menu, X } from 'lucide-react'
import Logo from '../../components/Logo'
import { useSession } from '../../lib/session'
import { TRIAL_DAYS, PLANS, naira } from '../../../shared/plans.js'

// Questions shared by the home page and the pricing page. Every answer must match how the product works today.
export const FAQ = [
  ['Is it really free for small churches?', `Yes. The Free plan covers up to ${PLANS.free.limit} people for as long as you like, with check-in, attendance, first-timer records and children’s check-in. No card needed.`],
  ['What happens after the free trial?', `Every church gets ${TRIAL_DAYS} days with everything included and no limit on size. After that you move to the Free plan unless you choose a paid one. Check-in always keeps working. If you have more than ${PLANS.free.limit} people, automatic follow-ups and the Monday Pastor’s Brief pause, and you can’t add more people, until you choose a plan. Nothing is ever deleted.`],
  ['How long does setup take?', 'You can be ready in an afternoon. Import your members from a spreadsheet (we check for duplicates first), print or display the QR code for your next service, and invite your team.'],
  ['Do members need to download an app?', 'No. People scan the QR code with their phone camera and check in on a web page. First-time visitors share their details once; next time they only need their phone number.'],
  ['Do we need special equipment?', 'No. Any phone or tablet works for check-in. For children’s name labels, any 4×2 inch label printer (Dymo, Brother and similar) works; without a printer, the pickup code shows on screen.'],
  ['How are plans priced?', `By the number of people in your church: Free up to ${PLANS.free.limit}, Growing up to ${PLANS.growing.limit}, Established up to ${PLANS.established.limit.toLocaleString()}, and Network for any size with several branches or campuses. Team members and check-ins are unlimited on every plan, and visitors can always check in, even if you go over your plan’s size.`],
  ['How do we pay, and can we cancel?', `In naira, by card, bank transfer or USSD, through Paystack. Yearly plans cost the same as 10 months (from ${naira(PLANS.growing.yearly)} a year). Pay by card and we renew automatically; pay by transfer or USSD and we remind you before your renewal date. Turn off renewal any time in Settings › Billing; your plan runs to the end of the period you paid for.`],
  ['Can we get a refund?', 'Yes. Ask within 30 days of any payment and we refund it in full. See our Refund Policy.'],
  ['Who owns our data, and who can see it?', 'Your church does. Each church’s records are kept separate on our servers, team members only see what their role allows, and you can export your data at any time or ask us to delete it. We sign a Data Processing Agreement with every church.'],
]

export function FaqList({ items = FAQ }) {
  return (
    <div className="divide-y divide-mist-200 rounded-2xl border border-mist-200 bg-white">
      {items.map(([q, a]) => (
        <details key={q} className="group px-6 py-5 [&_summary::-webkit-details-marker]:hidden">
          <summary className="flex cursor-pointer list-none items-start justify-between gap-4 text-[16px] font-semibold text-ink">
            <span>{q}</span>
            <span aria-hidden className="mt-0.5 text-xl leading-none text-mist-400 transition-transform group-open:rotate-45">+</span>
          </summary>
          <p className="mt-2 text-[15px] leading-relaxed text-mist-600">{a}</p>
        </details>
      ))}
    </div>
  )
}

// Fades a section in as it scrolls into view. Skipped for people who prefer less motion.
export function Reveal({ as: Tag = 'div', className = '', children, ...rest }) {
  const ref = useRef(null)
  const [shown, setShown] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined' || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { setShown(true); return }
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setShown(true); io.disconnect() } }, { rootMargin: '0px 0px -8% 0px' })
    io.observe(el)
    return () => io.disconnect()
  }, [])
  return <Tag ref={ref} className={`transition-[opacity,transform] duration-700 ease-out ${shown ? 'translate-y-0 opacity-100' : 'translate-y-4 opacity-0'} ${className}`} {...rest}>{children}</Tag>
}

// One header for every public marketing page.
export function SiteHeader({ dark = false, links = true }) {
  const { me } = useSession()
  const [open, setOpen] = useState(false)
  const [scrolled, setScrolled] = useState(false)
  useEffect(() => { const f = () => setScrolled(window.scrollY > 8); f(); window.addEventListener('scroll', f, { passive: true }); return () => window.removeEventListener('scroll', f) }, [])
  const nav = [['/#product', 'Product'], ['/#tour', 'Tour'], ['/#children', 'Children’s church'], ['/pricing', 'Pricing'], ['/#about', 'About'], ['/#faq', 'Questions']]
  const solid = scrolled || open
  const tone = dark && !solid
  const linkCls = `rounded-lg px-3 py-2 text-[15px] font-medium transition-colors ${tone ? 'text-white/80 hover:text-white' : 'text-ink-soft hover:text-ink'}`
  return (
    <header className={`sticky top-0 z-40 transition-colors ${solid ? 'border-b border-mist-200 bg-white/95 backdrop-blur' : dark ? 'bg-brand-900' : 'bg-ivory'}`}>
      <div className="mx-auto flex h-16 max-w-page items-center justify-between gap-4 px-5 sm:px-6">
        <Link to="/" aria-label="GatherHQ home" onClick={() => setOpen(false)}><Logo size={30} onDark={tone} /></Link>
        {links && (
          <nav className="hidden items-center gap-1 md:flex" aria-label="Main">
            {nav.map(([to, label]) => <a key={to} href={to} className={linkCls}>{label}</a>)}
          </nav>
        )}
        <div className="flex items-center gap-2">
          {me ? (
            <Link to="/app" className="rounded-lg bg-brand-700 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-800">Open GatherHQ</Link>
          ) : (
            <>
              <Link to="/login" className={`hidden sm:inline-flex ${linkCls}`}>Sign in</Link>
              <Link to="/signup" className={`rounded-lg px-4 py-2 text-sm font-semibold ${tone ? 'bg-white text-brand-900 hover:bg-brand-50' : 'bg-brand-700 text-white hover:bg-brand-800'}`}>Start free trial</Link>
            </>
          )}
          {links && (
            <button type="button" className={`rounded-lg p-2 md:hidden ${tone ? 'text-white' : 'text-ink'}`} aria-label={open ? 'Close menu' : 'Open menu'} aria-expanded={open} onClick={() => setOpen(o => !o)}>
              {open ? <X size={22} /> : <Menu size={22} />}
            </button>
          )}
        </div>
      </div>
      {links && open && (
        <nav className="border-t border-mist-200 bg-white px-5 py-3 md:hidden" aria-label="Mobile">
          {nav.map(([to, label]) => <a key={to} href={to} onClick={() => setOpen(false)} className="block rounded-lg px-3 py-3 text-[16px] font-medium text-ink hover:bg-mist-50">{label}</a>)}
          {!me && <Link to="/login" onClick={() => setOpen(false)} className="block rounded-lg px-3 py-3 text-[16px] font-medium text-ink hover:bg-mist-50">Sign in</Link>}
        </nav>
      )}
    </header>
  )
}
