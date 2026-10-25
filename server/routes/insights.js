import { fb, col, plain, ms } from '../firebase.js'
import { bad, date } from '../http.js'
import { requireCap, branchFilter, can, orgBranches } from '../access.js'
import { startOfDayInTz, weekKey, monthKey } from '../util.js'

function range(query, defaultDays = 84) {
  const to = query.to ? new Date(date(query.to)) : new Date()
  const from = query.from ? new Date(date(query.from)) : new Date(to.getTime() - defaultDays * 86400000)
  if (from >= to) throw bad('The start date must be before the end date.')
  if (to - from > 731 * 86400000) throw bad('Choose a range of two years or less.')
  return { from, to }
}

const inBranches = (branches) => (x) => !branches || branches.includes(x.branch_id)
const countable = (g) => !['draft', 'archived'].includes(g.status)

export default function (r) {
  r.get('/overview', async ({ ctx, query }) => {
    const { db } = await fb()
    const C = (n) => col(db, ctx.org.id, n)
    const branches = await branchFilter(ctx, query.branch)
    const tz = ctx.org.timezone || 'UTC'
    const weeks = Number(ctx.org.settings?.absenceWeeks || 3)
    const now = new Date()
    const names = new Map((await orgBranches(ctx)).map(b => [b.id, b.name]))
    const out = { definitions: {
      today: 'Check-ins recorded today across all sessions',
      latest: 'Most recent session that has started',
      firstTimers: 'People whose first ever check-in was in the last 7 days',
      returning: 'Visitors (not yet members) who checked in during the last 7 days on their 2nd+ visit',
      regulars: `Members seen in the last ${weeks} weeks`,
      absent: `Members not seen for ${weeks}+ weeks with no open follow-up`,
    } }

    if (can(ctx, 'attendance.view')) {
      const [week, past, future, trendQs] = await Promise.all([
        C('checkins').where('created_at', '>=', new Date(now.getTime() - 7 * 86400e3)).limit(20000).get(),
        C('gatherings').where('starts_at', '<=', now).orderBy('starts_at', 'desc').limit(40).get(),
        C('gatherings').where('starts_at', '>', now).orderBy('starts_at', 'asc').limit(40).get(),
        C('gatherings').where('starts_at', '>=', new Date(now.getTime() - 84 * 86400e3)).orderBy('starts_at', 'asc').limit(2000).get(),
      ])
      const checkins = week.docs.map(d => d.data()).filter(inBranches(branches))
      const sod = startOfDayInTz(tz).getTime()
      const latest = past.docs.map(d => ({ id: d.id, ...plain(d.data()) })).filter(inBranches(branches)).find(g => ['open', 'closed'].includes(g.status))
      let previous = null
      if (latest) {
        const pq = await C('gatherings').where('branch_id', '==', latest.branch_id).where('starts_at', '<', new Date(latest.starts_at)).orderBy('starts_at', 'desc').limit(20).get()
        const p = pq.docs.map(d => ({ id: d.id, ...plain(d.data()) })).find(g => g.kind === latest.kind && ['open', 'closed'].includes(g.status))
        if (p) previous = { name: p.name, starts_at: p.starts_at, attendance: p.attendance || 0 }
      }
      const trend = new Map()
      for (const d of trendQs.docs) {
        const g = d.data()
        if (!inBranches(branches)(g) || !countable(g) || ms(g.starts_at) > now.getTime()) continue
        const k = weekKey(g.starts_at.toDate ? g.starts_at.toDate() : new Date(g.starts_at), tz)
        const t = trend.get(k) || { week: k, attendance: 0, first_timers: 0 }
        t.attendance += g.attendance || 0; t.first_timers += g.first_timers || 0
        trend.set(k, t)
      }
      Object.assign(out, {
        today: checkins.filter(c => ms(c.created_at) >= sod).length,
        latest: latest ? { id: latest.id, name: latest.name, kind: latest.kind, starts_at: latest.starts_at, branch_id: latest.branch_id, branch_name: names.get(latest.branch_id) || null, attendance: latest.attendance || 0, first_timers: latest.first_timers || 0 } : null,
        previous,
        firstTimers: checkins.filter(c => c.first_time).length,
        returning: new Set(checkins.filter(c => !c.first_time && c.person_status === 'visitor').map(c => c.person_id)).size,
        upcomingSessions: future.docs.map(d => ({ id: d.id, ...plain(d.data()) })).filter(inBranches(branches)).filter(g => ['scheduled', 'open'].includes(g.status)).slice(0, 4)
          .map(g => ({ id: g.id, name: g.name, starts_at: g.starts_at, status: g.status, branch_name: names.get(g.branch_id) || null })),
        trend: [...trend.values()].sort((a, b) => a.week.localeCompare(b.week)),
      })
    }

    if (can(ctx, 'people.view') || can(ctx, 'reports.view')) {
      const P = () => {
        let q = C('people')
        if (branches) q = branches.length === 1 ? q.where('branch_id', '==', branches[0]) : q.where('branch_id', 'in', branches.slice(0, 30))
        return q
      }
      const cutoff = new Date(now.getTime() - weeks * 7 * 86400e3)
      const [members, visitors, regulars, absentQs] = await Promise.all([
        P().where('status', '==', 'member').count().get(),
        P().where('status', '==', 'visitor').count().get(),
        P().where('status', '==', 'member').where('last_seen_at', '>=', cutoff).count().get(),
        C('people').where('status', '==', 'member').where('last_seen_at', '<', cutoff).orderBy('last_seen_at', 'desc').limit(5000).get(),
      ])
      out.people = { members: members.data().count, visitors: visitors.data().count, regulars: regulars.data().count }
      out.absent = absentQs.docs.map(d => d.data()).filter(inBranches(branches)).filter(p => !(p.open_reasons || []).includes('absence')).length
    }

    if (can(ctx, 'followups.view')) {
      const qs = await C('followups').where('status', 'in', ['pending', 'in_progress']).limit(5000).get()
      const open = qs.docs.map(d => d.data()).filter(inBranches(branches))
      const sod = startOfDayInTz(tz).getTime()
      out.followups = {
        overdue: open.filter(f => ms(f.due_at) < sod).length,
        due: open.filter(f => ms(f.due_at) < sod + 86400e3).length,
        mine: open.filter(f => f.assignee_user_id === ctx.user.id).length,
        open: open.length,
      }
    }

    if (can(ctx, 'events.view')) {
      const qs = await C('events').where('starts_at', '>=', new Date(now.getTime() - 3 * 86400e3)).orderBy('starts_at', 'asc').limit(40).get()
      out.upcomingEvents = qs.docs.map(d => ({ id: d.id, ...plain(d.data()) }))
        .filter(e => !branches || !e.branch_id || branches.includes(e.branch_id))
        .filter(e => new Date(e.ends_at || e.starts_at) >= now && ['published', 'postponed'].includes(e.status)).slice(0, 4)
        .map(e => ({ id: e.id, name: e.name, starts_at: e.starts_at, location: e.location, capacity: e.capacity, status: e.status, registered: e.registered || 0 }))
    }

    const act = await C('audit').orderBy('created_at', 'desc').limit(20).get()
    out.activity = act.docs.map(d => plain(d.data())).filter(a => !a.action.endsWith('exported')).slice(0, 8)
    return out
  })

  // --- reports ---------------------------------------------------------------------
  r.get('/reports/attendance', async ({ ctx, query }) => {
    requireCap(ctx, 'reports.view')
    const { db } = await fb()
    const C = (n) => col(db, ctx.org.id, n)
    const branches = await branchFilter(ctx, query.branch)
    const { from, to } = range(query)
    const tz = ctx.org.timezone || 'UTC'
    const prevFrom = new Date(from.getTime() - (to - from))
    const [gq, cq] = await Promise.all([
      C('gatherings').where('starts_at', '>=', prevFrom).where('starts_at', '<=', to).orderBy('starts_at', 'asc').limit(5000).get(),
      C('checkins').where('created_at', '>=', from).where('created_at', '<=', to).limit(30000).get(),
    ])
    const all = gq.docs.map(d => ({ id: d.id, ...plain(d.data()) })).filter(inBranches(branches)).filter(countable)
    const cur = all.filter(g => ms(g.starts_at) >= from.getTime())
    const prev = all.filter(g => ms(g.starts_at) < from.getTime())
    const sum = (list, k) => list.reduce((a, g) => a + (g[k] || 0), 0)
    const weekly = new Map()
    for (const g of cur) {
      const k = weekKey(new Date(g.starts_at), tz)
      const w = weekly.get(k) || { week: k, attendance: 0, first_timers: 0, sessions: 0 }
      w.attendance += g.attendance || 0; w.first_timers += g.first_timers || 0; w.sessions++
      weekly.set(k, w)
    }
    const allBranches = (await orgBranches(ctx)).filter(b => !branches || branches.includes(b.id))
    const byBranch = allBranches.map(b => {
      const list = cur.filter(g => g.branch_id === b.id)
      return { id: b.id, name: b.name, attendance: sum(list, 'attendance'), sessions: list.length, first_timers: sum(list, 'first_timers') }
    }).sort((a, b) => b.attendance - a.attendance)
    const kinds = new Map()
    for (const g of cur) { const k = kinds.get(g.kind) || { kind: g.kind, sessions: 0, attendance: 0 }; k.sessions++; k.attendance += g.attendance || 0; kinds.set(g.kind, k) }
    const names = new Map(allBranches.map(b => [b.id, b.name]))
    const unique = new Set(cq.docs.map(d => d.data()).filter(inBranches(branches)).map(c => c.person_id))
    return {
      from: from.toISOString(), to: to.toISOString(), previousFrom: prevFrom.toISOString(),
      totals: { current: sum(cur, 'attendance'), previous: sum(prev, 'attendance'), unique_people: unique.size, sessions: cur.length },
      weekly: [...weekly.values()].sort((a, b) => a.week.localeCompare(b.week)),
      byBranch,
      sessions: [...cur].reverse().slice(0, 200).map(g => ({ id: g.id, name: g.name, kind: g.kind, starts_at: g.starts_at, branch_name: names.get(g.branch_id) || null, attendance: g.attendance || 0, first_timers: g.first_timers || 0 })),
      byKind: [...kinds.values()].sort((a, b) => b.attendance - a.attendance),
    }
  })

  // Visitor journey: genuine first-time visitors in the period, and what has happened since.
  r.get('/reports/visitors', async ({ ctx, query }) => {
    requireCap(ctx, 'reports.view')
    const { db } = await fb()
    const C = (n) => col(db, ctx.org.id, n)
    const branches = await branchFilter(ctx, query.branch)
    const { from, to } = range(query)
    const tz = ctx.org.timezone || 'UTC'
    const [pq, fq] = await Promise.all([
      C('people').where('first_time_at', '>=', from).where('first_time_at', '<=', to).limit(20000).get(),
      C('followups').where('created_at', '>=', from).where('created_at', '<=', to).limit(20000).get(),
    ])
    const ppl = pq.docs.map(d => d.data()).filter(inBranches(branches))
    const funnel = {
      first_visits: ppl.length, returned: ppl.filter(p => (p.visit_count || 0) >= 2).length,
      returned_3: ppl.filter(p => (p.visit_count || 0) >= 3).length, became_members: ppl.filter(p => p.status === 'member').length,
    }
    const monthly = new Map()
    for (const p of ppl) {
      const k = monthKey(p.first_time_at.toDate ? p.first_time_at.toDate() : new Date(p.first_time_at), tz)
      const m = monthly.get(k) || { month: k, first_visits: 0, returned: 0 }
      m.first_visits++; if ((p.visit_count || 0) >= 2) m.returned++
      monthly.set(k, m)
    }
    const fus = fq.docs.map(d => d.data()).filter(inBranches(branches))
    const doneList = fus.filter(f => f.status === 'done' && f.closed_at)
    const avg = doneList.length ? Math.round(doneList.reduce((a, f) => a + (ms(f.closed_at) - ms(f.created_at)) / 3600e3, 0) / doneList.length) : null
    return {
      from: from.toISOString(), to: to.toISOString(), funnel, monthly: [...monthly.values()].sort((a, b) => a.month.localeCompare(b.month)),
      followups: { created: fus.length, completed: doneList.length, overdue: fus.filter(f => ['pending', 'in_progress'].includes(f.status) && ms(f.due_at) < Date.now()).length, avg_hours_to_close: avg },
    }
  })

  r.get('/reports/data-quality', async ({ ctx, query }) => {
    requireCap(ctx, 'reports.view')
    const { db } = await fb()
    const branches = await branchFilter(ctx, query.branch)
    const qs = await col(db, ctx.org.id, 'people').where('status', 'in', ['visitor', 'member', 'inactive', 'transferred']).limit(20000).get()
    const ppl = qs.docs.map(d => ({ id: d.id, ...d.data() })).filter(inBranches(branches))
    const group = (keyFn) => {
      const m = new Map()
      for (const p of ppl) { const k = keyFn(p); if (!k) continue; const g = m.get(k) || []; g.push(p.id); m.set(k, g) }
      return [...m.entries()].filter(([, ids]) => ids.length > 1).sort((a, b) => b[1].length - a[1].length).slice(0, 50)
    }
    return {
      counts: { total: ppl.length, no_phone: ppl.filter(p => !p.phone_norm).length, no_email: ppl.filter(p => !p.email).length, no_branch: ppl.filter(p => !p.branch_id).length, no_last_name: ppl.filter(p => !p.last_name).length },
      possibleDuplicates: {
        byName: group(p => p.name_lower).map(([k, ids]) => ({ name: k, n: ids.length, ids })),
        byEmail: group(p => p.email && p.email.toLowerCase()).map(([k, ids]) => ({ email: k, n: ids.length, ids })),
      },
      sampled: qs.size >= 20000,
    }
  })
}
