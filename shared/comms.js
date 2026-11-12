// Communications: the shared vocabulary of channels, workflow triggers and steps, ready-made
// workflows and templates, and timezone-safe scheduling. Used by the server and the browser.

export const CHANNELS = {
  email: { label: 'Email', blurb: 'Best for longer news, with your logo and colours.', paid: false },
  whatsapp: { label: 'WhatsApp', blurb: 'Read by almost everyone, almost straight away.', paid: true },
  sms: { label: 'SMS', blurb: 'Short text messages to any phone.', paid: true },
}
export const CHANNEL_KEYS = Object.keys(CHANNELS)

export const PURPOSES = {
  welcome: 'Welcome', invitation: 'Invitations', announcement: 'Announcements', event: 'Events',
  reminder: 'Reminders', followup: 'Follow-up', appreciation: 'Appreciation', general: 'General updates',
}

// Personalisation available everywhere. Event fields only fill in event workflows.
export const FIELDS = [
  ['{first_name}', 'First name'], ['{last_name}', 'Last name'], ['{church_name}', 'Church name'],
  ['{event_name}', 'Event name'], ['{event_date}', 'Event date'],
]
export function fillText(text, v = {}) {
  return String(text || '').replace(/\{(first_name|last_name|church_name|event_name|event_date)\}/g, (_, k) => v[k] ?? '')
}

// SMS length: 160 plain characters per message, 70 if it has emoji or special letters.
export function smsInfo(text) {
  const t = String(text || '')
  const unicode = /[^\x00-\x7F£€¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ¡ÄÖÑÜ§¿äöñüà]/.test(t)
  const single = unicode ? 70 : 160, multi = unicode ? 67 : 153
  return { length: t.length, segments: t.length === 0 ? 0 : t.length <= single ? 1 : Math.ceil(t.length / multi), unicode, perSegment: single }
}

// Country from an international phone number (digits only), for pricing.
const PREFIXES = [['234', 'NG'], ['233', 'GH'], ['254', 'KE'], ['27', 'ZA'], ['44', 'GB'], ['91', 'IN'], ['49', 'DE'], ['1', 'US']]
export const countryOf = (phoneNorm) => (PREFIXES.find(([p]) => String(phoneNorm || '').startsWith(p)) || [null, 'OTHER'])[1]

// --- time in the church's timezone ---------------------------------------------------------
export function tzOffset(tz, date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(date).map(x => [x.type, x.value]))
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - Math.floor(date.getTime() / 1000) * 1000
}
// Local wall-clock parts of an instant.
export function localParts(date, tz) {
  const d = new Date(date.getTime() + tzOffset(tz, date))
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), dow: d.getUTCDay() }
}
// The instant a local wall-clock time happens. Correct across daylight-saving changes:
// a time skipped by the clocks going forward moves to the first valid minute after it.
export function zonedToUtc({ y, mo, d, h = 0, mi = 0 }, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi)
  const off1 = tzOffset(tz, new Date(guess))
  let t = guess - off1
  const off2 = tzOffset(tz, new Date(t))
  if (off2 !== off1) t = guess - off2
  return new Date(t)
}
// "2026-11-20" + "19:00" in the church's timezone → instant.
export function localToUtc(dateStr, timeStr, tz) {
  const [y, mo, d] = String(dateStr).split('-').map(Number)
  const [h, mi] = String(timeStr || '00:00').split(':').map(Number)
  if (!y || !mo || !d || isNaN(h) || isNaN(mi)) return null
  return zonedToUtc({ y, mo, d, h, mi }, tz)
}
export function utcToLocal(date, tz) {
  const p = localParts(new Date(date), tz)
  const z = (n) => String(n).padStart(2, '0')
  return { date: `${p.y}-${z(p.mo)}-${z(p.d)}`, time: `${z(p.h)}:${z(p.mi)}` }
}
const addDays = ({ y, mo, d }, n) => { const t = new Date(Date.UTC(y, mo - 1, d + n)); return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() } }
const hm = (time) => { const [h, mi] = String(time || '10:00').split(':').map(Number); return { h: h || 0, mi: mi || 0 } }

// Next time it is one of `weekdays` (0 = Sunday) at `time`, strictly after `from`.
export function nextWeekdayAt(from, tz, weekdays, time) {
  const days = (weekdays && weekdays.length ? weekdays : [0, 1, 2, 3, 4, 5, 6]).map(Number)
  const p = localParts(from, tz)
  for (let i = 0; i < 8; i++) {
    const day = addDays(p, i)
    const dow = (p.dow + i) % 7
    if (!days.includes(dow)) continue
    const at = zonedToUtc({ ...day, ...hm(time) }, tz)
    if (at > from) return at
  }
  return null
}

// Sending hours: automatic messages wait for the next allowed time instead of arriving at night.
export const DEFAULT_QUIET = { start: 8, end: 21 }
export function withinSendingHours(date, tz, q = DEFAULT_QUIET) {
  const h = localParts(date, tz).h
  return h >= q.start && h < q.end
}
export function nextSendingTime(date, tz, q = DEFAULT_QUIET) {
  if (withinSendingHours(date, tz, q)) return date
  const p = localParts(date, tz)
  const day = p.h < q.start ? p : addDays(p, 1)
  return zonedToUtc({ ...day, h: q.start, mi: 0 }, tz)
}

// Repeating schedules for "send regularly" workflows.
export function nextRecurrence(schedule, tz, after) {
  const s = schedule || {}
  if (s.frequency === 'once') {
    const at = localToUtc(s.date, s.time, tz)
    return at && at > after ? at : null
  }
  if (s.frequency === 'daily') return nextWeekdayAt(after, tz, [0, 1, 2, 3, 4, 5, 6], s.time)
  return nextWeekdayAt(after, tz, s.weekdays?.length ? s.weekdays : [1], s.time)
}

// --- workflows ---------------------------------------------------------------------------------
export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
export const TRIGGERS = {
  first_visit: { label: 'Someone visits for the first time', group: 'event' },
  second_visit: { label: 'Someone visits for the second time', group: 'event' },
  event_registered: { label: 'Someone registers for an event', group: 'event' },
  became_member: { label: 'Someone becomes a member', group: 'event' },
  absent: { label: 'Someone hasn’t attended for a while', group: 'event' },
  tag_added: { label: 'Someone is given a tag', group: 'event' },
  schedule: { label: 'On a regular schedule', group: 'schedule' },
}
export const STEP_TYPES = {
  wait: 'Wait', send: 'Send a message', check: 'Check something', task: 'Create a follow-up task',
  tag: 'Add a tag', start_workflow: 'Move to another workflow', end: 'End',
}
export const CONDITIONS = {
  attended: 'Did they attend again?', replied: 'Did they reply?', registered: 'Are they registered for the event?',
  has_tag: 'Do they have a tag?', opted_out: 'Have they opted out?',
}
export const OUTCOMES = { continue: 'Carry on', end: 'End the workflow', task: 'Create a follow-up task and end' }

const plural = (n, w) => `${n} ${w}${Number(n) === 1 ? '' : 's'}`
const time12 = (t) => { const { h, mi } = hm(t); return `${((h + 11) % 12) + 1}${mi ? ':' + String(mi).padStart(2, '0') : ''}${h < 12 ? 'am' : 'pm'}` }
export const fmtTime = time12

export function describeTrigger(t = {}, names = {}) {
  switch (t.type) {
    case 'first_visit': return 'When someone visits for the first time'
    case 'second_visit': return 'When someone visits for the second time'
    case 'event_registered': return t.eventId ? `When someone registers for ${names.event || 'an event'}` : 'When someone registers for any event'
    case 'became_member': return 'When someone becomes a member'
    case 'absent': return `When someone hasn’t attended for ${plural(t.weeks || 3, 'week')}`
    case 'tag_added': return `When someone is tagged ${names.tag ? `“${names.tag}”` : 'with a tag'}`
    case 'schedule': {
      const s = t.schedule || {}
      if (s.frequency === 'once') return `Once, on ${s.date || '…'} at ${time12(s.time)}`
      if (s.frequency === 'daily') return `Every day at ${time12(s.time)}`
      return `Every ${(s.weekdays?.length ? s.weekdays : [1]).map(d => WEEKDAYS[d]).join(' and ')} at ${time12(s.time)}`
    }
    default: return 'Choose how this starts'
  }
}
export function describeWait(w = {}) {
  if (w.kind === 'until_day') return `Wait until ${WEEKDAYS[w.weekday ?? 1]} at ${time12(w.time)}`
  if (w.kind === 'until_time') return `Wait until ${time12(w.time)}`
  if (w.kind === 'before_event') return `Wait until ${plural(w.days ?? 1, 'day')} before the event, at ${time12(w.time)}`
  return `Wait ${plural(w.amount ?? 2, w.unit === 'minutes' ? 'minute' : w.unit === 'hours' ? 'hour' : 'day')}`
}
export function describeStep(s = {}, names = {}) {
  switch (s.type) {
    case 'wait': return describeWait(s.wait)
    case 'send': return `Send ${s.channel === 'whatsapp' ? 'a WhatsApp message' : s.channel === 'sms' ? 'an SMS' : 'an email'}${s.title ? `: “${s.title}”` : ''}`
    case 'check': return CONDITIONS[s.condition] || 'Check something'
    case 'task': return `Create a follow-up task${s.title ? `: “${s.title}”` : ''}`
    case 'tag': return `Add the tag ${names.tags?.[s.tagId] ? `“${names.tags[s.tagId]}”` : ''}`.trim()
    case 'start_workflow': return `Move to ${names.workflows?.[s.workflowId] ? `“${names.workflows[s.workflowId]}”` : 'another workflow'}`
    case 'end': return 'End'
    default: return 'Step'
  }
}
export function summariseWorkflow(w = {}) {
  const steps = w.steps || []
  const sends = steps.filter(s => s.type === 'send')
  const checks = steps.filter(s => s.type === 'check').length
  const chans = [...new Set(sends.map(s => CHANNELS[s.channel]?.label).filter(Boolean))]
  const parts = [`${plural(sends.length, 'message')}${chans.length ? ` by ${chans.join(' and ')}` : ''}`]
  if (checks) parts.push(plural(checks, 'check'))
  if (steps.some(s => s.type === 'task' || (s.type === 'check' && [s.ifYes, s.ifNo].includes('task')))) parts.push('a follow-up task when needed')
  return parts.join(', ')
}

let seq = 0
export const stepId = () => `s${Date.now().toString(36)}${(seq++).toString(36)}`

// Ready-made starting points. `channel` is the church's preferred messaging channel.
export function presetWorkflow(key, channel = 'email') {
  const send = (title, purpose, body, subject) => ({ id: stepId(), type: 'send', channel, title, purpose, subject: subject || title, body, category: 'marketing' })
  const P = {
    welcome: {
      name: 'Welcome first-time visitors', trigger: { type: 'first_visit' }, steps: [
        { id: stepId(), type: 'wait', wait: { kind: 'until_day', weekday: 1, time: '10:00' } },
        send('Welcome', 'welcome', 'Hi {first_name}, thank you for worshipping with us at {church_name} on Sunday. It was a joy to have you. If there’s anything we can pray about or help with, just reply to this message.', 'Welcome to {church_name}, {first_name}'),
        { id: stepId(), type: 'wait', wait: { kind: 'until_day', weekday: 5, time: '19:00' } },
        send('Sunday invitation', 'invitation', 'Hi {first_name}, we’d love to see you again this Sunday at {church_name}. Save a seat for a friend too!', 'See you on Sunday, {first_name}?'),
        { id: stepId(), type: 'wait', wait: { kind: 'until_day', weekday: 0, time: '15:00' } },
        { id: stepId(), type: 'check', condition: 'attended', ifYes: 'end', ifNo: 'task', taskTitle: 'Call {first_name}: hasn’t come back since their first visit' },
        { id: stepId(), type: 'end' },
      ],
    },
    not_returned: {
      name: 'Follow up visitors who haven’t returned', trigger: { type: 'first_visit' }, steps: [
        { id: stepId(), type: 'wait', wait: { kind: 'for', amount: 14, unit: 'days' } },
        { id: stepId(), type: 'check', condition: 'attended', ifYes: 'end', ifNo: 'continue' },
        send('We’d love to see you again', 'followup', 'Hi {first_name}, it’s been a little while since you visited {church_name}. We’d love to see you again, and we’re here if you need anything.', 'We’d love to see you again, {first_name}'),
        { id: stepId(), type: 'task', title: 'Call {first_name}: visited once and hasn’t returned', dueHours: 72 },
        { id: stepId(), type: 'end' },
      ],
    },
    event_reminder: {
      name: 'Remind people about events they registered for', trigger: { type: 'event_registered', eventId: null }, steps: [
        { id: stepId(), type: 'wait', wait: { kind: 'before_event', days: 1, time: '10:00' } },
        { ...send('Event reminder', 'reminder', 'Hi {first_name}, a reminder that {event_name} is on {event_date}. We look forward to seeing you!', 'Reminder: {event_name}'), category: 'utility' },
        { id: stepId(), type: 'end' },
      ],
    },
    missed: {
      name: 'Check in with people who missed several Sundays', trigger: { type: 'absent', weeks: 3 }, steps: [
        send('We’ve missed you', 'followup', 'Hi {first_name}, we’ve missed you at {church_name} these past few weeks. We hope you’re well, and we’re here if you need anything.', 'We’ve missed you, {first_name}'),
        { id: stepId(), type: 'wait', wait: { kind: 'for', amount: 7, unit: 'days' } },
        { id: stepId(), type: 'check', condition: 'attended', ifYes: 'end', ifNo: 'task', taskTitle: 'Check in with {first_name}: not seen for a while' },
        { id: stepId(), type: 'end' },
      ],
    },
    regular: {
      name: 'Weekly update to members', trigger: { type: 'schedule', schedule: { frequency: 'weekly', weekdays: [1], time: '10:00' }, audience: { mode: 'filters', statuses: ['member'], segment: 'all', tags: [], people: [] } },
      steps: [{ ...send('Weekly update', 'announcement', 'Hi {first_name}, here’s what’s happening at {church_name} this week.', 'This week at {church_name}'), channel: 'email' }],
    },
    scratch: { name: 'New workflow', trigger: { type: 'first_visit' }, steps: [] },
  }
  return JSON.parse(JSON.stringify(P[key] || P.scratch))
}
export const PRESETS = [
  ['welcome', 'Welcome first-time visitors', 'A welcome, an invitation back, and a task if they don’t return.'],
  ['not_returned', 'Follow up visitors who haven’t returned', 'Two weeks after a first visit, check in if they haven’t been back.'],
  ['event_reminder', 'Remind people about an event', 'A reminder the day before an event they registered for.'],
  ['missed', 'Follow up people who missed several Sundays', 'A caring message, then a task if they still don’t come.'],
  ['regular', 'Send regular messages to a group', 'For example, an email to all members every Monday.'],
  ['scratch', 'Start from scratch', 'Choose how it starts and add your own steps.'],
]

// Starter templates the church can use as they are or customise.
export const STARTER_TEMPLATES = [
  { key: 'welcome', purpose: 'welcome', name: 'Welcome a first-time visitor', subject: 'Welcome to {church_name}, {first_name}', body: 'Hi {first_name}, thank you for worshipping with us at {church_name}. It was a joy to have you. If there’s anything we can pray about or help with, just reply to this message.', category: 'marketing' },
  { key: 'invite', purpose: 'invitation', name: 'Invite back on Sunday', subject: 'See you on Sunday, {first_name}?', body: 'Hi {first_name}, we’d love to see you this Sunday at {church_name}. Save a seat for a friend too!', category: 'marketing' },
  { key: 'announce', purpose: 'announcement', name: 'Church announcement', subject: 'News from {church_name}', body: 'Hi {first_name}, we have some news to share with you from {church_name}.', category: 'marketing' },
  { key: 'event', purpose: 'event', name: 'Event invitation', subject: 'You’re invited: {event_name}', body: 'Hi {first_name}, you’re invited to {event_name} on {event_date}. We’d love you to come!', category: 'marketing' },
  { key: 'reminder', purpose: 'reminder', name: 'Event reminder', subject: 'Reminder: {event_name}', body: 'Hi {first_name}, a reminder that {event_name} is on {event_date}. We look forward to seeing you!', category: 'utility' },
  { key: 'missed', purpose: 'followup', name: 'We’ve missed you', subject: 'We’ve missed you, {first_name}', body: 'Hi {first_name}, we’ve missed you at {church_name} these past few weeks. We hope you’re well, and we’re here if you need anything.', category: 'marketing' },
  { key: 'thanks', purpose: 'appreciation', name: 'Thank you for serving', subject: 'Thank you, {first_name}', body: 'Hi {first_name}, thank you for serving at {church_name}. Your time and care make a real difference.', category: 'marketing' },
  { key: 'update', purpose: 'general', name: 'Weekly update', subject: 'This week at {church_name}', body: 'Hi {first_name}, here’s what’s happening at {church_name} this week.', category: 'marketing' },
]

// Normalised delivery statuses. Only what a provider actually reports is ever shown.
export const DELIVERY_STATUS = {
  queued: 'Waiting', sending: 'Sending', sent: 'Sent', delivered: 'Delivered', read: 'Read',
  failed: 'Failed', skipped: 'Not sent', unknown: 'Unknown',
}
export const MESSAGE_STATUS = {
  draft: 'Draft', scheduled: 'Scheduled', sending: 'Sending', sent: 'Sent', failed: 'Failed', cancelled: 'Cancelled', paused: 'Paused',
}
export const STOP_WORDS = ['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'optout', 'opt out']
export const isStopWord = (text) => STOP_WORDS.includes(String(text || '').trim().toLowerCase().replace(/[.!]+$/, ''))
