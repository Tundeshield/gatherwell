import { Link } from 'react-router-dom'
import { Check, QrCode, HeartHandshake, Building2, CalendarDays, BarChart3, ShieldCheck, Lock, FileSearch, Users } from 'lucide-react'
import Logo, { LogoMark } from '../../components/Logo'
import { useSession } from '../../lib/session'
import { BRAND } from '../../brand'

function PhoneMock() {
  return (
    <div className="relative mx-auto w-[280px] sm:w-[300px]">
      <div className="rounded-[2.6rem] border border-mist-200 bg-white p-3 shadow-pop">
        <div className="rounded-[2rem] bg-ivory px-5 pb-8 pt-10">
          <div className="text-center text-[13px] font-semibold text-ink">Grace Community Church</div>
          <div className="text-center text-xs text-mist-500">Ikeja campus</div>
          <div className="mt-5 rounded-2xl bg-white px-5 py-7 text-center shadow-card">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-brand-700 text-white"><Check size={28} strokeWidth={2.5} /></div>
            <div className="mt-4 text-[19px] font-semibold text-ink">Welcome back, Chidi!</div>
            <div className="mt-1.5 text-[13px] text-mist-500">You're checked in for Sunday Service.</div>
          </div>
          <div className="mt-6 flex items-center justify-center gap-1 text-[11px] text-mist-400"><LogoMark size={12} />Powered by GatherHQ</div>
        </div>
      </div>
      <div className="absolute -bottom-12 -left-4 w-[240px] rounded-xl border border-mist-200 bg-white px-4 py-3 shadow-pop sm:-left-16">
        <div className="flex items-center gap-2 text-xs font-medium text-gold-700"><HeartHandshake size={14} />Follow-up created</div>
        <div className="mt-1 text-[13px] font-medium text-ink">Dayo Bello — first visit</div>
        <div className="text-xs text-mist-500">Welcome call due Tuesday · Ada</div>
      </div>
    </div>
  )
}

const FEATURES = [
  { icon: QrCode, title: 'QR check-in that recognises people', body: 'Visitors fill a short form once. Next time they enter their phone number and first name — no apps, no accounts.' },
  { icon: HeartHandshake, title: 'Follow-ups that actually happen', body: 'First-time visitors get a welcome task automatically. Members who have been away surface for a caring check-in, assigned to a real person.' },
  { icon: Building2, title: 'Every branch, one church', body: 'Each campus runs its own sessions while leadership sees the whole picture. Ushers only see what their branch needs.' },
  { icon: CalendarDays, title: 'Events with tickets and waitlists', body: 'A registration page, QR tickets, capacity limits that fill from the waitlist, and a door check-in list that works on a phone.' },
  { icon: BarChart3, title: 'Reports you can trust', body: 'Attendance against the previous period, visitor journeys from first visit to membership, and every number defined in plain words.' },
  { icon: Users, title: 'People, without the spreadsheet', body: 'Import your existing list with a preview and duplicate check, then keep one record per person with their full attendance history.' },
]

export default function Landing() {
  const { me } = useSession()
  const signedIn = !!me
  return (
    <div className="min-h-screen bg-ivory text-ink">
      <header className="mx-auto flex max-w-page items-center justify-between px-6 py-5">
        <Logo size={30} />
        <nav className="flex items-center gap-2">
          {signedIn ? <Link to="/app" className="rounded-lg bg-brand-700 px-4 py-2 text-sm font-medium text-white hover:bg-brand-800">Open GatherHQ</Link> : <>
            <Link to="/login" className="rounded-lg px-4 py-2 text-sm font-medium text-ink hover:bg-white">Sign in</Link>
            <Link to="/signup" className="rounded-lg bg-brand-700 px-4 py-2 text-sm font-medium text-white hover:bg-brand-800">Start free</Link>
          </>}
        </nav>
      </header>

      <section className="mx-auto grid max-w-page items-center gap-14 px-6 pb-24 pt-10 lg:grid-cols-[1.1fr_1fr] lg:pt-20">
        <div>
          <h1 className="max-w-xl text-[40px] font-semibold leading-[1.08] tracking-[-0.025em] text-ink sm:text-[54px]">Know your people. Coordinate every branch. Follow through.</h1>
          <p className="mt-6 max-w-lg text-[18px] leading-relaxed text-ink-soft">GatherHQ brings attendance, visitors, follow-ups and events into one calm place — so no one who walks through your doors is forgotten.</p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link to={signedIn ? '/app' : '/signup'} className="rounded-lg bg-brand-700 px-6 py-3 text-[15px] font-medium text-white hover:bg-brand-800">{signedIn ? 'Open your workspace' : 'Start your free 30 days'}</Link>
            {!signedIn && <Link to="/login" className="rounded-lg border border-mist-200 bg-white px-6 py-3 text-[15px] font-medium text-ink hover:border-mist-300">Sign in</Link>}
          </div>
          <p className="mt-4 text-sm text-mist-500">No card required. Set up in minutes — import your members from a spreadsheet.</p>
        </div>
        <PhoneMock />
      </section>

      <section className="border-y border-mist-200 bg-white">
        <div className="mx-auto max-w-page px-6 py-20">
          <h2 className="max-w-2xl text-[30px] font-semibold leading-tight text-ink">What happens on a Sunday morning</h2>
          <ol className="mt-10 grid gap-10 md:grid-cols-3">
            {[
              ['People scan the QR code at the door', 'Returning members check in in seconds. First-time visitors share their name and number once.'],
              ['Your team sees who is here, live', 'Ushers add anyone without a phone. Leaders see the count and how it compares with last week.'],
              ['Nobody slips through the cracks', 'Every first-time visitor gets a welcome follow-up assigned to someone on your team, due within 48 hours.'],
            ].map(([t, b], i) => (
              <li key={t}>
                <div className="flex h-9 w-9 items-center justify-center rounded-full border border-brand-200 text-sm font-semibold text-brand-700">{i + 1}</div>
                <h3 className="mt-4 text-[17px] font-semibold text-ink">{t}</h3>
                <p className="mt-2 text-[15px] leading-relaxed text-mist-600">{b}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="mx-auto max-w-page px-6 py-20">
        <h2 className="max-w-2xl text-[30px] font-semibold leading-tight text-ink">Built for the way churches really run</h2>
        <p className="mt-3 max-w-xl text-[16px] text-mist-600">From a single congregation to a headquarters with many branches — without making small churches manage big-church complexity.</p>
        <div className="mt-12 grid gap-x-12 gap-y-10 md:grid-cols-2">
          {FEATURES.map(f => (
            <div key={f.title} className="flex gap-4">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-700"><f.icon size={20} /></span>
              <div><h3 className="text-[16px] font-semibold text-ink">{f.title}</h3><p className="mt-1.5 text-[15px] leading-relaxed text-mist-600">{f.body}</p></div>
            </div>
          ))}
        </div>
      </section>

      <section className="bg-brand-800 text-white">
        <div className="mx-auto grid max-w-page gap-12 px-6 py-20 lg:grid-cols-[1fr_1.2fr]">
          <div>
            <h2 className="text-[30px] font-semibold leading-tight">Your members' trust, protected</h2>
            <p className="mt-4 max-w-md text-[16px] leading-relaxed text-brand-100">Church records are personal. GatherHQ is built so the right people see the right things — and nothing more.</p>
          </div>
          <ul className="grid gap-6 sm:grid-cols-2">
            {[[ShieldCheck, 'Every church is sealed off', 'Each organisation’s data is isolated on the server, not just hidden in the interface.'],
              [Lock, 'Access by role and branch', 'Ushers check people in without seeing the directory. Branch leaders see only their branches.'],
              [FileSearch, 'Exports are permissioned and logged', 'Only people you trust can download personal data, and every export is recorded.'],
              [Check, 'Private check-in', 'A phone number alone shows only a masked hint like “C•••• O.” — people confirm their own first name to check in.']].map(([Icon, t, b]) => (
              <li key={t}><Icon size={20} className="text-gold-200" /><h3 className="mt-3 font-semibold">{t}</h3><p className="mt-1 text-[14px] leading-relaxed text-brand-100">{b}</p></li>
            ))}
          </ul>
        </div>
      </section>

      <section className="mx-auto max-w-page px-6 py-20 text-center">
        <h2 className="text-[30px] font-semibold text-ink">{BRAND.tagline}</h2>
        <p className="mx-auto mt-3 max-w-lg text-[16px] text-mist-600">Try everything free for 30 days. Plans for churches of every size are on the way — your data stays yours, and you can export it any time.</p>
        <Link to={signedIn ? '/app' : '/signup'} className="mt-8 inline-block rounded-lg bg-brand-700 px-6 py-3 text-[15px] font-medium text-white hover:bg-brand-800">{signedIn ? 'Open your workspace' : 'Create your church account'}</Link>
      </section>

      <footer className="border-t border-mist-200">
        <div className="mx-auto flex max-w-page flex-wrap items-center justify-between gap-4 px-6 py-8 text-sm text-mist-500">
          <Logo size={24} />
          <span>© {new Date().getFullYear()} GatherHQ</span>
        </div>
      </footer>
    </div>
  )
}
