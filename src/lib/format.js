// Date and number formatting in the church's own timezone.
const cache = new Map()
function fmt(tz, opts) {
  const key = tz + JSON.stringify(opts)
  if (!cache.has(key)) cache.set(key, new Intl.DateTimeFormat(undefined, { timeZone: tz, ...opts }))
  return cache.get(key)
}

export const fmtDate = (d, tz) => d ? fmt(tz, { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(d)) : '—'
export const fmtDay = (d, tz) => d ? fmt(tz, { weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(d)) : '—'
export const fmtTime = (d, tz) => d ? fmt(tz, { hour: 'numeric', minute: '2-digit' }).format(new Date(d)) : ''
export const fmtDateTime = (d, tz) => d ? `${fmtDay(d, tz)}, ${fmtTime(d, tz)}` : '—'
export const fmtNum = (n) => (n ?? 0).toLocaleString()

export function relative(d) {
  if (!d) return 'never'
  const diff = (Date.now() - new Date(d).getTime()) / 1000
  const abs = Math.abs(diff)
  const future = diff < 0
  const unit = abs < 60 ? null : abs < 3600 ? ['minute', 60] : abs < 86400 ? ['hour', 3600] : abs < 86400 * 30 ? ['day', 86400] : abs < 86400 * 365 ? ['month', 86400 * 30] : ['year', 86400 * 365]
  if (!unit) return future ? 'in a moment' : 'just now'
  const n = Math.round(abs / unit[1])
  const s = `${n} ${unit[0]}${n === 1 ? '' : 's'}`
  return future ? `in ${s}` : `${s} ago`
}

// <input type="datetime-local"> values are local to the browser; convert carefully.
export function toLocalInput(d) {
  if (!d) return ''
  const dt = new Date(d)
  const pad = (n) => String(n).padStart(2, '0')
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}`
}
export const fromLocalInput = (s) => s ? new Date(s).toISOString() : null

export const personName = (p) => [p?.first_name, p?.last_name].filter(Boolean).join(' ') || 'Unnamed'
export const initials = (p) => ((p?.first_name?.[0] || '') + (p?.last_name?.[0] || '')).toUpperCase() || '?'

export function pctChange(curr, prev) {
  if (!prev) return null
  return Math.round(((curr - prev) / prev) * 100)
}

export const STATUS_LABELS = { visitor: 'Visitor', member: 'Member', inactive: 'Inactive', transferred: 'Transferred', archived: 'Archived' }
export const REASON_LABELS = { first_visit: 'First visit', second_visit: 'Second visit', absence: 'Not seen recently', event: 'Event', manual: 'Manual' }
export const KIND_LABELS = { service: 'Service', midweek: 'Midweek', youth: 'Youth', prayer: 'Prayer', meeting: 'Meeting', class: 'Class', other: 'Other' }
