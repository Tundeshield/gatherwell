import { useEffect } from 'react'
import { Link, NavLink, useParams } from 'react-router-dom'
import Logo from '../../components/Logo'

export const LEGAL_VERSION = '2026-11-01'
const UPDATED = '1 November 2026'
const CONTACT = 'privacy@gatherhq.org'
const Mail = () => <a href={`mailto:${CONTACT}`} className="link">{CONTACT}</a>

const SUBPROCESSORS = [
  ['Google LLC (Firebase, Google Cloud)', 'Database, sign-in and file storage for all GatherHQ data', 'Google Cloud data centres'],
  ['Netlify, Inc.', 'Hosting the website and running the application', 'United States and global edge network'],
  ['Resend, Inc.', 'Delivering emails a church sends through GatherHQ, and account emails', 'European Union (Ireland)'],
  ['Paddle.com Market Ltd', 'Selling GatherHQ subscriptions as our reseller and merchant of record, including tax and invoices (billing details only, never member data)', 'United Kingdom'],
]

function H({ children }) { return <h2 className="mb-3 mt-10 text-[19px] font-semibold text-ink">{children}</h2> }
function P({ children }) { return <p className="mb-4 leading-relaxed text-ink-soft">{children}</p> }
function UL({ items }) { return <ul className="mb-4 list-disc space-y-1.5 pl-5 leading-relaxed text-ink-soft">{items.map((x, i) => <li key={i}>{x}</li>)}</ul> }

function Privacy() {
  return (
    <>
      <P>This policy explains how GatherHQ (“we”, “us”) handles personal information. GatherHQ is software that churches use to record attendance, welcome visitors, follow up with people and run events.</P>
      <H>Who is responsible for what</H>
      <UL items={[
        <><b>Church data.</b> When a church uses GatherHQ, the church decides what information it collects about its members, visitors and volunteers, and why. The church is the <i>data controller</i>. We process that information only on the church’s behalf and on its instructions, as its <i>data processor</i>, under our <Link to="/legal/dpa" className="link">Data Processing Agreement</Link>. If you’re a member or visitor of a church, please contact your church first about your information; we will help them respond.</>,
        <><b>Account and website data.</b> For the details of people who create GatherHQ accounts, and for visitors to gatherhq.org, we are the data controller.</>,
      ]} />
      <H>What we collect</H>
      <UL items={[
        'Account holders: name, email address, password (stored securely by Google Firebase; we never see it), church name, country, role, and a record of activity in the account.',
        'Church records, as entered by a church or by people checking in: names, phone numbers, email addresses, attendance, event registrations, answers to check-in questions, follow-up notes, tags and similar details the church chooses to record.',
        'Technical information: a sign-in cookie, IP address and basic request logs used for security and to prevent abuse.',
        'Billing: when paid plans start, our payment provider collects card or bank details directly. We only receive confirmation of payment.',
      ]} />
      <H>How we use it</H>
      <UL items={[
        'To provide the service the church asked for: storing records, sending the emails it writes, showing reports and reminders.',
        'To keep accounts secure, prevent misuse and fix problems.',
        'To send account holders essential service messages (for example, security notices, invitations and the Monday brief, which can be switched off).',
        'We do not sell personal information, use church data for advertising, or contact a church’s members for our own purposes.',
      ]} />
      <P>Our legal bases are performance of a contract (providing the service), our legitimate interests in running a secure and reliable service, and legal obligations. Churches are responsible for having a lawful basis, such as consent or legitimate interest, for the information they record about their people.</P>
      <H>Cookies and similar technology</H>
      <P>We use one essential cookie to keep account holders signed in. On public check-in pages, a person can choose to have their phone number remembered on their own device. We do not use advertising or tracking cookies, so there is no cookie banner.</P>
      <H>Where data is stored and who processes it</H>
      <P>We use a small number of trusted providers (subprocessors), listed in the <Link to="/legal/dpa" className="link">Data Processing Agreement</Link>. Some are in countries outside the UK or European Economic Area. Where that happens, transfers are protected by the providers’ standard contractual clauses or equivalent safeguards.</P>
      <H>How long we keep it</H>
      <P>Church data is kept for as long as the church’s account is active. Churches can delete individual people, or all their people, at any time from inside GatherHQ. When a church closes its account, we delete its data within 30 days, apart from copies in backups, which expire within a further 30 days. Account holders can ask us to delete their account at any time.</P>
      <H>Security</H>
      <P>Data is encrypted in transit and at rest. Each church’s data is kept separate and is only available to that church’s team, according to their role. Public check-in pages never reveal people’s contact details. We keep an activity log of changes in each church’s account.</P>
      <H>Your rights</H>
      <P>Depending on where you live, you may have the right to access, correct, delete, restrict or object to the use of your personal information, to move it elsewhere, and to complain to a data protection authority (in the UK, the ICO). For church records, contact your church: GatherHQ gives churches the tools to download or delete a person’s information. For your GatherHQ account, or if your church is unable to help, contact us at <Mail />. Every email a church sends through GatherHQ includes an unsubscribe link.</P>
      <H>Children</H>
      <P>Churches may record information about children, for example in children’s ministry. Churches are responsible for obtaining any consent required from a parent or guardian. GatherHQ accounts are only for adults.</P>
      <P>When a church uses children’s check-in, it may record a child’s name, date of birth, class, allergies and medical notes, the parents linked to them, who else may collect them, and when they were checked in and picked up. Allergies and medical notes are only visible to the church’s children’s team and administrators; allergies are printed on the child’s name label so teachers can see them. A parent can ask the church to see, correct or erase their child’s record at any time.</P>
      <H>Changes and contact</H>
      <P>We will post any changes here and update the date above, and tell account holders by email about significant changes. Questions: <Mail />.</P>
    </>
  )
}

function Terms() {
  return (
    <>
      <P>These terms apply when a church or person uses GatherHQ. By creating an account you agree to them on behalf of yourself and your church.</P>
      <H>The service</H>
      <P>GatherHQ provides tools for attendance, visitor follow-up, events and messaging for churches. We may improve or change features over time, and will give reasonable notice before removing anything significant that you rely on.</P>
      <H>Your account</H>
      <UL items={[
        'The person who creates a church account is its owner and can invite others. Owners are responsible for who they give access to.',
        'Keep your password secret and tell us at once if you think your account has been misused.',
        'You must be at least 18 and able to agree to these terms for your church.',
      ]} />
      <H>Your church’s data</H>
      <UL items={[
        'Your church owns the information it puts into GatherHQ. You can download it at any time and take it with you.',
        'You are responsible for collecting it lawfully: telling people how their information will be used, getting consent where needed (for example, for marketing emails and for children’s details), and keeping it accurate.',
        'Our Data Processing Agreement forms part of these terms and explains how we handle that data on your behalf.',
      ]} />
      <H>Acceptable use</H>
      <P>Don’t use GatherHQ to send spam or messages to people who haven’t agreed to hear from you, to store information you have no right to hold, to harass anyone, to break the law, or to try to access another church’s data or disrupt the service. We may suspend accounts that do.</P>
      <H>Plans and payment</H>
      <P>GatherHQ is currently free. When paid plans begin, we will tell you the price in advance; you can choose a plan or export your data and leave. Paid plans renew automatically until cancelled, and payments are processed by our payment provider.</P>
      <H>Availability</H>
      <P>We work hard to keep GatherHQ available and secure, but the service is provided “as is” and we can’t promise it will always be uninterrupted or error-free.</P>
      <H>Liability</H>
      <P>As far as the law allows, we are not liable for indirect or consequential losses, and our total liability to a church in any year is limited to the amount it paid us in the 12 months before the claim. Nothing in these terms limits liability that cannot be limited by law.</P>
      <H>Ending</H>
      <P>You can stop using GatherHQ at any time, and ask us to close your account at <Mail />. We may end an account for serious or repeated breaches of these terms. After closure, data is deleted as described in our <Link to="/legal/privacy" className="link">Privacy Policy</Link>.</P>
      <H>Changes and contact</H>
      <P>We may update these terms and will tell account holders about significant changes before they apply. Questions: <Mail />.</P>
    </>
  )
}

function Dpa() {
  return (
    <>
      <P>This Data Processing Agreement (“DPA”) forms part of the GatherHQ Terms of Service between the church using GatherHQ (the “Controller”) and GatherHQ (the “Processor”). It reflects the requirements of Article 28 of the UK and EU General Data Protection Regulation and similar laws. A church owner can record acceptance in GatherHQ under Settings › Data & privacy.</P>
      <H>1. What is processed</H>
      <UL items={[
        <><b>Subject matter and purpose:</b> providing GatherHQ, including recording attendance and events, managing follow-ups, and sending messages the Controller writes.</>,
        <><b>Duration:</b> for as long as the Controller uses GatherHQ, plus the deletion period below.</>,
        <><b>People:</b> church members, visitors, volunteers, staff and event attendees, including children where the Controller records them.</>,
        <><b>Data:</b> names, contact details, attendance and event records, check-in answers, tags, follow-up notes and any other details the Controller chooses to record. The Controller should not record special category data (such as health information) in GatherHQ unless it has a lawful basis to do so.</>,
      ]} />
      <H>2. Processor commitments</H>
      <UL items={[
        'Process personal data only on the Controller’s documented instructions, which are given through its use and configuration of GatherHQ, unless required by law.',
        'Ensure everyone who can access the data is bound by confidentiality.',
        'Maintain appropriate security: encryption in transit and at rest, strict separation of each church’s data, role-based access, activity logging and abuse protection.',
        'Help the Controller respond to requests from individuals (for example, by providing tools to download or delete a person’s information) and with security and impact assessments where reasonable.',
        'Notify the Controller without undue delay, and within 72 hours where possible, after becoming aware of a personal data breach affecting its data.',
        'At the end of the service, delete the Controller’s data within 30 days (backups expire within a further 30 days), after giving the Controller the chance to export it.',
        'Make available the information reasonably needed to show compliance with this DPA, and answer reasonable audit questions in writing.',
      ]} />
      <H>3. Subprocessors</H>
      <P>The Controller authorises the subprocessors below. We impose data protection terms on each that are at least as protective as this DPA, and will notify account owners at least 30 days before adding or replacing one, so they can object.</P>
      <div className="mb-4 overflow-x-auto rounded-lg border border-mist-200">
        <table className="w-full text-left text-sm">
          <thead className="bg-mist-50 text-mist-600"><tr><th className="px-3 py-2 font-medium">Subprocessor</th><th className="px-3 py-2 font-medium">Purpose</th><th className="px-3 py-2 font-medium">Location</th></tr></thead>
          <tbody className="divide-y divide-mist-100 text-ink-soft">{SUBPROCESSORS.map(([a, b, c]) => <tr key={a}><td className="px-3 py-2 font-medium text-ink">{a}</td><td className="px-3 py-2">{b}</td><td className="px-3 py-2">{c}</td></tr>)}</tbody>
        </table>
      </div>
      <H>4. International transfers</H>
      <P>Where personal data is transferred outside the UK or European Economic Area, transfers rely on adequacy decisions or on standard contractual clauses (including the UK addendum) agreed with the relevant subprocessor.</P>
      <H>5. Controller responsibilities</H>
      <P>The Controller is responsible for the lawfulness of the data it records, for giving people appropriate privacy information, for obtaining consent where required (including from parents or guardians for children), and for the content of messages it sends.</P>
      <H>6. Contact</H>
      <P>Data protection questions and requests: <Mail />.</P>
    </>
  )
}

const DOCS = {
  privacy: ['Privacy Policy', Privacy],
  terms: ['Terms of Service', Terms],
  dpa: ['Data Processing Agreement', Dpa],
}

export default function Legal() {
  const { doc } = useParams()
  const [title, Body] = DOCS[doc] || DOCS.privacy
  useEffect(() => { document.title = `${title} · GatherHQ`; window.scrollTo(0, 0); return () => { document.title = 'GatherHQ' } }, [title])
  return (
    <div className="min-h-screen bg-ivory">
      <header className="border-b border-mist-200 bg-white/70">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-4">
          <Link to="/"><Logo size={26} /></Link>
          <nav className="flex gap-4 text-sm">
            {Object.entries(DOCS).map(([k, [t]]) => <NavLink key={k} to={`/legal/${k}`} className={({ isActive }) => isActive ? 'font-medium text-brand-700' : 'text-mist-500 hover:text-ink'}>{t.replace(' of Service', '').replace('Data Processing Agreement', 'DPA')}</NavLink>)}
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-6 py-12">
        <h1 className="text-[32px] font-semibold tracking-tight text-ink">{title}</h1>
        <p className="mb-8 mt-2 text-sm text-mist-500">Last updated {UPDATED}</p>
        <div className="text-[15.5px]"><Body /></div>
      </main>
      <LegalFooter />
    </div>
  )
}

export function LegalFooter({ className = '' }) {
  return (
    <footer className={`border-t border-mist-200 ${className}`}>
      <div className="mx-auto flex max-w-page flex-wrap items-center justify-between gap-4 px-6 py-8 text-sm text-mist-500">
        <Logo size={24} />
        <nav className="flex flex-wrap gap-x-5 gap-y-2">
          <Link to="/pricing" className="hover:text-ink">Pricing</Link>
          <Link to="/legal/privacy" className="hover:text-ink">Privacy</Link>
          <Link to="/legal/terms" className="hover:text-ink">Terms</Link>
          <Link to="/legal/dpa" className="hover:text-ink">Data Processing Agreement</Link>
          <a href={`mailto:${CONTACT}`} className="hover:text-ink">{CONTACT}</a>
        </nav>
        <span>© {new Date().getFullYear()} GatherHQ</span>
      </div>
    </footer>
  )
}
