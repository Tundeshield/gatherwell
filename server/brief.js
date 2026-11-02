// The Monday Pastor's Brief: last week at a glance, with names, emailed to owners and admins.
import { fb, col, plain, toDate, ms } from './firebase.js'
import { startOfDayInTz } from './util.js'
import { dayKey } from './routes/children.js'

const DAY = 86400e3
const name = (p) => [p.first_name, p.last_name].filter(Boolean).join(' ')
const list = (names, more) => names.map(n => `• ${n}`).join('\n') + (more > 0 ? `\n…and ${more} more` : '')
const pct = (a, b) => (b > 0 ? Math.round(((a - b) / b) * 100) : null)

/** Gathers last week's numbers for one church. `now` is when the brief is sent. */
export async function briefData(org, now = new Date()) {
  const { db } = await fb()
  const C = (n) => col(db, org.id, n)
  const tz = org.timezone || 'Africa/Lagos'
  const to = startOfDayInTz(tz, now) // today, 00:00 local
  const from = new Date(to.getTime() - 7 * DAY)
  const prevFrom = new Date(from.getTime() - 28 * DAY)
  const weeks = Number(org.settings?.absenceWeeks || 3)

  const [sessionsQs, prevQs, firstQs, recentFirstQs, driftQs, fuQs, eventsQs, peopleQs] = await Promise.all([
    C('gatherings').where('starts_at', '>=', from).where('starts_at', '<', to).orderBy('starts_at', 'asc').limit(200).get(),
    C('gatherings').where('starts_at', '>=', prevFrom).where('starts_at', '<', from).orderBy('starts_at', 'asc').limit(1000).get(),
    C('people').where('first_time_at', '>=', from).where('first_time_at', '<', to).orderBy('first_time_at', 'asc').limit(500).get(),
    C('people').where('first_time_at', '>=', new Date(from.getTime() - 42 * DAY)).where('first_time_at', '<', from).orderBy('first_time_at', 'asc').limit(2000).get(),
    C('people').where('last_seen_at', '>=', new Date(now.getTime() - (weeks + 3) * 7 * DAY)).where('last_seen_at', '<', new Date(now.getTime() - 14 * DAY)).orderBy('last_seen_at', 'desc').limit(2000).get(),
    C('followups').where('status', 'in', ['pending', 'in_progress']).limit(5000).get(),
    C('events').where('starts_at', '>=', now).where('starts_at', '<', new Date(now.getTime() + 14 * DAY)).orderBy('starts_at', 'asc').limit(20).get(),
    C('people').limit(20000).get(),
  ])

  const sessions = sessionsQs.docs.map(d => plain(d.data())).filter(g => g.status !== 'archived')
  const total = sessions.reduce((a, g) => a + (g.attendance || 0), 0)
  const prevAvg = prevQs.docs.reduce((a, d) => a + (d.data().attendance || 0), 0) / 4
  const top = [...sessions].sort((a, b) => (b.attendance || 0) - (a.attendance || 0))[0] || null

  const firstTimers = firstQs.docs.map(d => d.data()).filter(p => p.status !== 'archived')
  const cameBack = recentFirstQs.docs.map(d => d.data()).filter(p => p.status !== 'archived' && p.last_seen_at && ms(p.last_seen_at) >= from.getTime())
  // Regulars (4+ visits) whose last visit was 2 or more weeks ago.
  const drifting = driftQs.docs.map(d => d.data()).filter(p => ['member', 'visitor'].includes(p.status) && (p.visit_count || 0) >= 4)

  const open = fuQs.docs.map(d => plain(d.data()))
  const overdue = open.filter(f => f.due_at && new Date(f.due_at) < now).sort((a, b) => new Date(a.due_at) - new Date(b.due_at))

  // Birthdays in the coming 7 days (birthdays are stored as YYYY-MM-DD).
  const md = new Set(Array.from({ length: 7 }, (_, i) => new Date(to.getTime() + i * DAY + 12 * 3600e3).toISOString().slice(5, 10)))
  const birthdays = peopleQs.docs.map(d => d.data()).filter(p => p.birthday && p.status !== 'archived' && md.has(String(p.birthday).slice(5, 10)))
    .sort((a, b) => String(a.birthday).slice(5).localeCompare(String(b.birthday).slice(5)))

  const events = eventsQs.docs.map(d => plain(d.data())).filter(e => e.status === 'published')

  // Children's church (only when the church uses it). Counted apart from adult attendance.
  let children = null
  if (org.features?.children !== false) {
    const [kq, cq] = await Promise.all([
      C('kidsCheckins').where('day', '>=', dayKey(tz, from)).where('day', '<', dayKey(tz, to)).get(),
      C('children').get(),
    ])
    const ks = kq.docs.map(d => d.data())
    const used = !cq.empty
    const missing = cq.docs.map(d => d.data()).filter(c => c.status !== 'archived' && c.last_checkin_at && now - ms(c.last_checkin_at) >= 21 * DAY && now - ms(c.last_checkin_at) < 120 * DAY)
    if (used) children = { checkins: ks.length, children: new Set(ks.map(k => k.child_id)).size, firstTime: ks.filter(k => k.first_time).length, missing: missing.map(c => [c.first_name, c.last_name].filter(Boolean).join(' ')) }
  }

  return {
    from, to, tz, total, prevAvg: Math.round(prevAvg), change: pct(total, prevAvg), sessions: sessions.length,
    firstTimers: firstTimers.length, firstTimeVisits: sessions.reduce((a, g) => a + (g.first_timers || 0), 0),
    top: top && { name: top.name, attendance: top.attendance || 0, starts_at: top.starts_at },
    lists: {
      firstTimers: firstTimers.map(name), cameBack: cameBack.map(name), drifting: drifting.map(name),
      overdue: overdue.map(f => `${f.person_name || 'Someone'}${f.assignee_name ? ` (${f.assignee_name})` : ' (unassigned)'}`),
      birthdays: birthdays.map(p => `${name(p)}, ${new Date(`2000-${String(p.birthday).slice(5, 10)}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })}`),
      events: events.map(e => `${e.name}, ${new Date(e.starts_at).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: tz })}${e.capacity ? ` (${e.registered || 0}/${e.capacity} registered)` : ` (${e.registered || 0} registered)`}`),
    },
    openFollowups: open.length, overdueFollowups: overdue.length, children,
  }
}

/** Turns the numbers into email blocks for renderEmail. */
export function briefEmail(org, d, appUrl) {
  const fmt = (n) => Number(n || 0).toLocaleString('en-GB')
  const range = `${d.from.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: d.tz })} – ${new Date(d.to.getTime() - 1).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: d.tz })}`
  const blocks = [{ type: 'heading', text: 'Your week at a glance' }]

  if (d.sessions === 0) {
    blocks.push({ type: 'text', text: `No sessions were recorded last week (${range}). Create your services in GatherHQ so attendance and visitors are tracked automatically.` })
  } else {
    const trend = d.change === null ? '' : d.change === 0 ? ', the same as your 4-week average' : `, ${Math.abs(d.change)}% ${d.change > 0 ? 'up on' : 'down on'} your 4-week average of ${fmt(d.prevAvg)}`
    blocks.push({ type: 'text', text: `${fmt(d.total)} check-ins across ${d.sessions} ${d.sessions === 1 ? 'session' : 'sessions'} last week (${range})${trend}.${d.top && d.sessions > 1 ? `\nBiggest: ${d.top.name} with ${fmt(d.top.attendance)}.` : ''}` })
  }

  const section = (title, names, empty) => {
    blocks.push({ type: 'divider' }, { type: 'heading', text: `${title} (${names.length})` })
    blocks.push({ type: 'text', text: names.length ? list(names.slice(0, 15), names.length - 15) : empty })
  }
  section('First-time visitors', d.lists.firstTimers, 'No first-time visitors last week.')
  if (d.lists.cameBack.length) section('Came back for another visit', d.lists.cameBack, '')
  section('Regulars we haven’t seen for 2+ weeks', d.lists.drifting, 'Everyone who comes regularly was here recently.')
  blocks.push({ type: 'divider' }, { type: 'heading', text: 'Follow-ups' })
  blocks.push({ type: 'text', text: d.openFollowups === 0 ? 'No open follow-ups. Well done!' :
    `${fmt(d.openFollowups)} open, ${fmt(d.overdueFollowups)} overdue.${d.lists.overdue.length ? `\n\nOverdue:\n${list(d.lists.overdue.slice(0, 8), d.lists.overdue.length - 8)}` : ''}` })
  if (d.children) {
    const c = d.children
    blocks.push({ type: 'divider' }, { type: 'heading', text: 'Children’s church' })
    blocks.push({ type: 'text', text: c.checkins === 0 ? 'No children were checked in last week.'
      : `${fmt(c.children)} ${c.children === 1 ? 'child' : 'children'} came last week${c.firstTime ? `, ${c.firstTime} for the first time` : ''}.${c.missing.length ? `\n\nHaven’t come in 3 weeks:\n${list(c.missing.slice(0, 10), c.missing.length - 10)}` : ''}` })
  }
  if (d.lists.birthdays.length) section('Birthdays this week', d.lists.birthdays, '')
  if (d.lists.events.length) section('Coming up', d.lists.events, '')
  blocks.push({ type: 'button', label: 'Open GatherHQ', url: `${appUrl}/app` })

  const subject = d.sessions === 0
    ? `Your Monday brief for ${org.name}`
    : `${fmt(d.total)} at church last week${d.firstTimers ? `, ${d.firstTimers} new` : ''}: your Monday brief`
  const preheader = [d.firstTimers && `${d.firstTimers} first-time visitors`, d.lists.drifting.length && `${d.lists.drifting.length} regulars to check on`, d.overdueFollowups && `${d.overdueFollowups} overdue follow-ups`].filter(Boolean).join(' · ') || 'Last week at a glance'
  return { subject, preheader, blocks }
}
