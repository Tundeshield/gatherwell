// Shared pieces of the Communications area: tabs, channel and status labels, previews.
import { NavLink, Outlet } from 'react-router-dom'
import { Mail, MessageCircle, Smartphone, Send, CalendarClock, Workflow } from 'lucide-react'
import { Badge } from '../../../components/ui'
import { CHANNELS, MESSAGE_STATUS, DELIVERY_STATUS, fillText, countryName } from '../../../../shared/comms.js'
import { IS_STAGING } from '../../../components/EnvBanner'

export const CHANNEL_ICON = { email: Mail, whatsapp: MessageCircle, sms: Smartphone }
export const channelLabel = (c) => CHANNELS[c]?.label || c
export const money = (n) => { const v = Number(n || 0); return `$${v > 0 && v < 0.1 ? v.toFixed(3) : v.toFixed(2)}` }
export const ACTIONS = [
  { to: '/app/communications/send?mode=now', icon: Send, title: 'Send a message', body: 'Email or SMS, straight away.' },
  { to: '/app/communications/send?mode=later', icon: CalendarClock, title: 'Schedule a message', body: 'Pick the day and time it goes out.' },
  { to: '/app/communications/workflows?new=1', icon: Workflow, title: 'Automate it', body: 'Welcome visitors, remind, follow up, every time.' },
]

const TABS = [['', 'Overview', true], ['messages', 'Messages'], ['workflows', 'Workflows'], ['templates', 'Templates'], ['channels', 'Channels & usage']]
export function CommsLayout() {
  return (
    <div className="mx-auto max-w-page px-4 py-6 sm:px-6">
      <div className="mb-5">
        <h1 className="text-[26px] font-semibold tracking-tight text-ink">Communications</h1>
        <p className="mt-1 text-sm text-mist-500">Reach your people by email and text message, now, later or automatically.</p>
      </div>
      <nav aria-label="Communications" className="-mx-4 mb-6 flex gap-1 overflow-x-auto border-b border-mist-200 px-4 sm:mx-0 sm:px-0">
        {TABS.map(([to, label, end]) => (
          <NavLink key={to} to={`/app/communications${to ? '/' + to : ''}`} end={!!end}
            className={({ isActive }) => `whitespace-nowrap border-b-2 px-3 pb-3 pt-1 text-[15px] font-medium transition-colors ${isActive ? 'border-brand-700 text-brand-800' : 'border-transparent text-mist-500 hover:text-ink'}`}>{label}</NavLink>
        ))}
      </nav>
      <Outlet />
    </div>
  )
}

const STATUS_TONE = { draft: 'neutral', scheduled: 'info', sending: 'gold', sent: 'success', failed: 'danger', cancelled: 'neutral', paused: 'gold' }
export const MessageStatus = ({ status }) => <Badge tone={STATUS_TONE[status] || 'neutral'}>{MESSAGE_STATUS[status] || status}</Badge>
const D_TONE = { sent: 'info', delivered: 'success', read: 'success', failed: 'danger', skipped: 'neutral', unknown: 'gold', queued: 'neutral', sending: 'gold' }
export const DeliveryStatus = ({ status }) => <Badge tone={D_TONE[status] || 'neutral'}>{DELIVERY_STATUS[status] || status}</Badge>
const WF_TONE = { active: 'success', paused: 'gold', draft: 'neutral', completed: 'info' }
export const WorkflowStatus = ({ status }) => <Badge tone={WF_TONE[status] || 'neutral'} dot={status === 'active'}>{{ active: 'On', paused: 'Paused', draft: 'Draft', completed: 'Finished' }[status] || status}</Badge>

export function ChannelChip({ channel }) {
  const Icon = CHANNEL_ICON[channel] || Mail
  return <span className="inline-flex items-center gap-1.5 text-sm text-mist-600"><Icon size={15} aria-hidden />{channelLabel(channel)}</span>
}

// Who a group message goes to, in words.
export function audienceText(a = {}, tagNames = {}) {
  if (a.mode === 'people') return `${(a.people || []).length} chosen ${(a.people || []).length === 1 ? 'person' : 'people'}`
  const who = a.statuses?.length ? a.statuses.map(s => ({ member: 'members', visitor: 'visitors', inactive: 'inactive people' }[s] || s)).join(' and ') : 'everyone'
  const seg = { first_timers_30d: ', first visit in the last 30 days', absent: ', not seen recently', recent: ', seen recently' }[a.segment] || ''
  const tags = a.tags?.length ? `, tagged ${a.tags.map(t => tagNames[t] ? `“${tagNames[t]}”` : 'with a tag').join(' or ')}` : ''
  return (who.charAt(0).toUpperCase() + who.slice(1)) + seg + tags
}

export const EXCLUSION_TEXT = {
  no_contact: (ch, n) => `${n} ${n === 1 ? 'has' : 'have'} no ${ch === 'email' ? 'email address' : 'phone number'}`,
  no_consent: (ch, n) => `${n} haven’t agreed to receive ${channelLabel(ch)} messages yet`,
  opted_out: (ch, n) => `${n} asked not to receive ${channelLabel(ch)} messages`,
  duplicate: (ch, n) => `${n} share ${ch === 'email' ? 'an email address' : 'a phone number'} with someone else, so get it once`,
}
const places = (cs) => cs.map(countryName).join(', ')
const ROUTE_TEXT = {
  unsupported_country: (n, cs) => `${n} have numbers in ${places(cs)}, where GatherHQ can’t send texts yet`,
  provider_unavailable: (n, cs) => `${n} have numbers in ${places(cs)}, where texts aren’t switched on yet`,
  sender_needed: (n, cs) => `${n} in ${places(cs)} need a registered sender name first (Channels & usage)`,
  sender_pending: (n, cs) => `${n} in ${places(cs)} will get texts once your sender name is approved`,
  sender_rejected: (n, cs) => `${n} in ${places(cs)}: your sender name wasn’t approved`,
  provider_down: (n, cs) => `${n} in ${places(cs)}: the text service is having problems, try again shortly`,
  type_not_allowed: (n, cs) => `${n} in ${places(cs)} can only receive reminders and updates by text`,
}
export function Exclusions({ channel, excluded, unroutable }) {
  const rows = Object.entries(excluded || {}).filter(([k, n]) => n > 0 && k !== 'no_route')
  const routes = Object.entries(unroutable || {})
  if (!rows.length && !routes.length) return null
  return (
    <ul className="mt-2 space-y-1 text-sm text-mist-600">
      {rows.map(([k, n]) => <li key={k} className="flex gap-2"><span aria-hidden className="text-mist-400">•</span>{EXCLUSION_TEXT[k]?.(channel, n) || `${n} not included`}</li>)}
      {routes.map(([k, x]) => <li key={k} className="flex gap-2"><span aria-hidden className="text-mist-400">•</span>{(ROUTE_TEXT[k] || ROUTE_TEXT.unsupported_country)(x.count, x.countries)}</li>)}
    </ul>
  )
}
// Text-message cost by destination country.
export function CountryCosts({ byCountry }) {
  const rows = Object.entries(byCountry || {})
  if (rows.length < 1) return null
  return (
    <table className="mt-2 w-full max-w-md text-sm">
      <thead><tr className="text-left text-xs text-mist-500"><th className="py-1 font-medium">Country</th><th className="py-1 text-right font-medium">People</th><th className="py-1 text-right font-medium">Texts</th><th className="py-1 text-right font-medium">Cost</th></tr></thead>
      <tbody className="divide-y divide-mist-100">{rows.map(([cc, c]) => (
        <tr key={cc}><td className="py-1.5 text-ink">{countryName(cc)}</td><td className="tabular py-1.5 text-right">{c.count ?? c.people}</td><td className="tabular py-1.5 text-right">{c.segments ?? '—'}</td><td className="tabular py-1.5 text-right">{money(c.cost ?? c.per100)}</td></tr>
      ))}</tbody>
    </table>
  )
}

// Phone-style previews for WhatsApp and SMS.
export function BubblePreview({ channel, text, churchName, firstName = 'Ada' }) {
  const body = fillText(text, { first_name: firstName, last_name: '', church_name: churchName, event_name: 'Youth Camp', event_date: 'Saturday 21 November' })
  const wa = channel === 'whatsapp'
  return (
    <div className={`rounded-2xl p-4 ${wa ? 'bg-[#E5DDD5]' : 'bg-mist-100'}`} aria-label={`${channelLabel(channel)} preview`}>
      <p className="mb-2 text-center text-xs font-medium text-mist-500">{churchName}</p>
      <div className={`ml-0 mr-8 whitespace-pre-wrap rounded-2xl rounded-tl-sm px-3.5 py-2.5 text-[15px] leading-snug text-ink shadow-sm ${wa ? 'bg-white' : 'bg-white'}`}>
        {body || <span className="text-mist-400">Your message will appear here.</span>}
      </div>
    </div>
  )
}

export function StagingNote({ children }) {
  if (!IS_STAGING) return null
  return <p className="rounded-lg border border-gold-200 bg-gold-50 px-3 py-2 text-[13px] text-gold-700">{children}</p>
}
