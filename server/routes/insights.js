import { q, one } from '../db.js'
import { bad, date } from '../http.js'
import { requireCap, branchFilter, can } from '../access.js'

function range(query, defaultDays = 84) {
  const to = query.to ? new Date(date(query.to)) : new Date()
  const from = query.from ? new Date(date(query.from)) : new Date(to.getTime() - defaultDays * 86400000)
  if (from >= to) throw bad('The start date must be before the end date.')
  if (to - from > 731 * 86400000) throw bad('Choose a range of two years or less.')
  return { from: from.toISOString(), to: to.toISOString() }
}

export default function (r) {
  r.get('/overview', async ({ ctx, query }) => {
    const branches = await branchFilter(ctx, query.branch)
    const org = ctx.org.id
    const tz = ctx.org.timezone || 'UTC'
    const weeks = Number(ctx.org.settings?.absenceWeeks || 3)
    const out = { definitions: {
      today: 'Check-ins recorded today across all sessions',
      latest: 'Most recent session that has started',
      firstTimers: 'People whose first ever check-in was in the last 7 days',
      returning: 'Visitors (not yet members) who checked in during the last 7 days on their 2nd+ visit',
      regulars: `Members seen in the last ${weeks} weeks`,
      absent: `Members not seen for ${weeks}+ weeks with no open follow-up`,
    } }

    if (can(ctx, 'attendance.view')) {
      const [today, latest, firstTimers, returning, upcoming, trend] = await Promise.all([
        one(`SELECT COUNT(*)::int AS n FROM checkins c WHERE c.org_id = $1 AND ($2::uuid[] IS NULL OR c.branch_id = ANY($2))
               AND (c.created_at AT TIME ZONE $3)::date = (NOW() AT TIME ZONE $3)::date`, [org, branches, tz]),
        one(`SELECT g.id, g.name, g.kind, g.starts_at, g.branch_id, b.name AS branch_name,
                    (SELECT COUNT(*)::int FROM checkins c WHERE c.gathering_id = g.id) AS attendance,
                    (SELECT COUNT(*)::int FROM checkins c WHERE c.gathering_id = g.id AND c.first_time) AS first_timers
               FROM gatherings g JOIN branches b ON b.id = g.branch_id
              WHERE g.org_id = $1 AND ($2::uuid[] IS NULL OR g.branch_id = ANY($2)) AND g.starts_at <= NOW() AND g.status IN ('open','closed')
              ORDER BY g.starts_at DESC LIMIT 1`, [org, branches]),
        one(`SELECT COUNT(*)::int AS n FROM checkins c WHERE c.org_id = $1 AND ($2::uuid[] IS NULL OR c.branch_id = ANY($2))
               AND c.first_time AND c.created_at >= NOW() - INTERVAL '7 days'`, [org, branches]),
        one(`SELECT COUNT(DISTINCT c.person_id)::int AS n FROM checkins c JOIN people p ON p.id = c.person_id
              WHERE c.org_id = $1 AND ($2::uuid[] IS NULL OR c.branch_id = ANY($2)) AND NOT c.first_time
                AND p.status = 'visitor' AND c.created_at >= NOW() - INTERVAL '7 days'`, [org, branches]),
        q(`SELECT g.id, g.name, g.starts_at, g.status, b.name AS branch_name FROM gatherings g JOIN branches b ON b.id = g.branch_id
            WHERE g.org_id = $1 AND ($2::uuid[] IS NULL OR g.branch_id = ANY($2)) AND g.starts_at > NOW() AND g.status IN ('scheduled','open')
            ORDER BY g.starts_at LIMIT 4`, [org, branches]),
        q(`SELECT to_char(date_trunc('week', g.starts_at AT TIME ZONE $3), 'YYYY-MM-DD') AS week, COUNT(c.id)::int AS attendance,
                  COUNT(c.id) FILTER (WHERE c.first_time)::int AS first_timers
             FROM gatherings g LEFT JOIN checkins c ON c.gathering_id = g.id
            WHERE g.org_id = $1 AND ($2::uuid[] IS NULL OR g.branch_id = ANY($2)) AND g.starts_at >= NOW() - INTERVAL '12 weeks' AND g.starts_at <= NOW()
            GROUP BY 1 ORDER BY 1`, [org, branches, tz]),
      ])
      let previous = null
      if (latest) {
        previous = await one(`SELECT g.name, g.starts_at, (SELECT COUNT(*)::int FROM checkins c WHERE c.gathering_id = g.id) AS attendance
                                FROM gatherings g WHERE g.org_id = $1 AND g.branch_id = $2 AND g.kind = $3 AND g.starts_at < $4 AND g.status IN ('open','closed')
                               ORDER BY g.starts_at DESC LIMIT 1`, [org, latest.branch_id, latest.kind, latest.starts_at])
      }
      Object.assign(out, { today: today.n, latest, previous, firstTimers: firstTimers.n, returning: returning.n, upcomingSessions: upcoming, trend })
    }

    if (can(ctx, 'people.view') || can(ctx, 'reports.view')) {
      const people = await one(`SELECT COUNT(*) FILTER (WHERE status = 'member')::int AS members,
                                       COUNT(*) FILTER (WHERE status = 'visitor')::int AS visitors,
                                       COUNT(*) FILTER (WHERE status = 'member' AND last_seen_at >= NOW() - make_interval(days => $3))::int AS regulars
                                  FROM people WHERE org_id = $1 AND ($2::uuid[] IS NULL OR branch_id = ANY($2))`, [org, branches, weeks * 7])
      const absent = await one(`SELECT COUNT(*)::int AS n FROM people p WHERE p.org_id = $1 AND ($2::uuid[] IS NULL OR p.branch_id = ANY($2))
                                  AND p.status = 'member' AND p.last_seen_at < NOW() - make_interval(days => $3)
                                  AND NOT EXISTS (SELECT 1 FROM followups f WHERE f.person_id = p.id AND f.reason = 'absence' AND f.status IN ('pending','in_progress'))`,
        [org, branches, weeks * 7])
      Object.assign(out, { people, absent: absent.n })
    }

    if (can(ctx, 'followups.view')) {
      out.followups = await one(`SELECT COUNT(*) FILTER (WHERE due_at < (date_trunc('day', NOW() AT TIME ZONE $3) AT TIME ZONE $3))::int AS overdue,
                                        COUNT(*) FILTER (WHERE due_at < ((date_trunc('day', NOW() AT TIME ZONE $3) + INTERVAL '1 day') AT TIME ZONE $3))::int AS due,
                                        COUNT(*) FILTER (WHERE assignee_user_id = $4)::int AS mine,
                                        COUNT(*)::int AS open
                                   FROM followups WHERE org_id = $1 AND ($2::uuid[] IS NULL OR branch_id = ANY($2)) AND status IN ('pending','in_progress')`,
        [org, branches, tz, ctx.user.id])
    }

    if (can(ctx, 'events.view')) {
      out.upcomingEvents = await q(`SELECT e.id, e.name, e.starts_at, e.location, e.capacity, e.status,
                                           (SELECT COUNT(*)::int FROM registrations r WHERE r.event_id = e.id AND r.status = 'registered') AS registered
                                      FROM events e WHERE e.org_id = $1 AND ($2::uuid[] IS NULL OR e.branch_id IS NULL OR e.branch_id = ANY($2))
                                       AND COALESCE(e.ends_at, e.starts_at) >= NOW() AND e.status IN ('published','postponed')
                                     ORDER BY e.starts_at LIMIT 4`, [org, branches])
    }

    out.activity = await q(`SELECT a.action, a.entity, a.created_at, a.meta, u.name AS user_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
                             WHERE a.org_id = $1 AND a.action NOT LIKE '%exported' ORDER BY a.created_at DESC LIMIT 8`, [org])
    return out
  })

  // --- reports ---------------------------------------------------------------------
  r.get('/reports/attendance', async ({ ctx, query }) => {
    requireCap(ctx, 'reports.view')
    const branches = await branchFilter(ctx, query.branch)
    const { from, to } = range(query)
    const tz = ctx.org.timezone || 'UTC'
    const [weekly, byBranch, sessions, byKind] = await Promise.all([
      q(`SELECT to_char(date_trunc('week', g.starts_at AT TIME ZONE $4), 'YYYY-MM-DD') AS week, COUNT(c.id)::int AS attendance,
                COUNT(c.id) FILTER (WHERE c.first_time)::int AS first_timers, COUNT(DISTINCT g.id)::int AS sessions
           FROM gatherings g LEFT JOIN checkins c ON c.gathering_id = g.id
          WHERE g.org_id = $1 AND ($2::uuid[] IS NULL OR g.branch_id = ANY($2)) AND g.starts_at BETWEEN $3 AND $5 AND g.status <> 'draft'
          GROUP BY 1 ORDER BY 1`, [ctx.org.id, branches, from, tz, to]),
      q(`SELECT b.id, b.name, COUNT(c.id)::int AS attendance, COUNT(DISTINCT g.id)::int AS sessions,
                COUNT(c.id) FILTER (WHERE c.first_time)::int AS first_timers
           FROM branches b LEFT JOIN gatherings g ON g.branch_id = b.id AND g.starts_at BETWEEN $3 AND $4 AND g.status <> 'draft'
           LEFT JOIN checkins c ON c.gathering_id = g.id
          WHERE b.org_id = $1 AND ($2::uuid[] IS NULL OR b.id = ANY($2)) GROUP BY b.id, b.name ORDER BY attendance DESC`, [ctx.org.id, branches, from, to]),
      q(`SELECT g.id, g.name, g.kind, g.starts_at, b.name AS branch_name, COUNT(c.id)::int AS attendance, COUNT(c.id) FILTER (WHERE c.first_time)::int AS first_timers
           FROM gatherings g JOIN branches b ON b.id = g.branch_id LEFT JOIN checkins c ON c.gathering_id = g.id
          WHERE g.org_id = $1 AND ($2::uuid[] IS NULL OR g.branch_id = ANY($2)) AND g.starts_at BETWEEN $3 AND $4 AND g.status <> 'draft'
          GROUP BY g.id, b.name ORDER BY g.starts_at DESC LIMIT 200`, [ctx.org.id, branches, from, to]),
      q(`SELECT g.kind, COUNT(DISTINCT g.id)::int AS sessions, COUNT(c.id)::int AS attendance
           FROM gatherings g LEFT JOIN checkins c ON c.gathering_id = g.id
          WHERE g.org_id = $1 AND ($2::uuid[] IS NULL OR g.branch_id = ANY($2)) AND g.starts_at BETWEEN $3 AND $4 AND g.status <> 'draft'
          GROUP BY g.kind ORDER BY attendance DESC`, [ctx.org.id, branches, from, to]),
    ])
    // Comparable previous period of equal length.
    const span = new Date(to) - new Date(from)
    const prevFrom = new Date(new Date(from) - span).toISOString()
    const totals = await one(`SELECT
        (SELECT COUNT(*)::int FROM checkins c JOIN gatherings g ON g.id = c.gathering_id WHERE c.org_id = $1 AND ($2::uuid[] IS NULL OR c.branch_id = ANY($2)) AND g.starts_at BETWEEN $3 AND $4) AS current,
        (SELECT COUNT(*)::int FROM checkins c JOIN gatherings g ON g.id = c.gathering_id WHERE c.org_id = $1 AND ($2::uuid[] IS NULL OR c.branch_id = ANY($2)) AND g.starts_at BETWEEN $5 AND $3) AS previous,
        (SELECT COUNT(DISTINCT c.person_id)::int FROM checkins c JOIN gatherings g ON g.id = c.gathering_id WHERE c.org_id = $1 AND ($2::uuid[] IS NULL OR c.branch_id = ANY($2)) AND g.starts_at BETWEEN $3 AND $4) AS unique_people,
        (SELECT COUNT(*)::int FROM gatherings g WHERE g.org_id = $1 AND ($2::uuid[] IS NULL OR g.branch_id = ANY($2)) AND g.starts_at BETWEEN $3 AND $4 AND g.status <> 'draft') AS sessions`,
      [ctx.org.id, branches, from, to, prevFrom])
    return { from, to, previousFrom: prevFrom, totals, weekly, byBranch, sessions, byKind }
  })

  // Visitor journey: of people whose first visit fell in the period, how many came back and how many became members.
  r.get('/reports/visitors', async ({ ctx, query }) => {
    requireCap(ctx, 'reports.view')
    const branches = await branchFilter(ctx, query.branch)
    const { from, to } = range(query)
    const tz = ctx.org.timezone || 'UTC'
    // Only genuine first visits (a visitor's first ever check-in) — not members' first recorded check-in.
    const firstVisitors = `SELECT p.* FROM people p WHERE p.org_id = $1 AND ($2::uuid[] IS NULL OR p.branch_id = ANY($2))
      AND EXISTS (SELECT 1 FROM checkins c WHERE c.person_id = p.id AND c.first_time AND c.created_at BETWEEN $3 AND $4)`
    const funnel = await one(`SELECT COUNT(*)::int AS first_visits,
                                     COUNT(*) FILTER (WHERE visit_count >= 2)::int AS returned,
                                     COUNT(*) FILTER (WHERE visit_count >= 3)::int AS returned_3,
                                     COUNT(*) FILTER (WHERE status = 'member')::int AS became_members
                                FROM (${firstVisitors}) fv`, [ctx.org.id, branches, from, to])
    const monthly = await q(`SELECT to_char(date_trunc('month', first_visit_at AT TIME ZONE $5), 'YYYY-MM') AS month, COUNT(*)::int AS first_visits,
                                    COUNT(*) FILTER (WHERE visit_count >= 2)::int AS returned
                               FROM (${firstVisitors}) fv GROUP BY 1 ORDER BY 1`, [ctx.org.id, branches, from, to, tz])
    const followups = await one(`SELECT COUNT(*)::int AS created, COUNT(*) FILTER (WHERE status = 'done')::int AS completed,
                                        COUNT(*) FILTER (WHERE status IN ('pending','in_progress') AND due_at < NOW())::int AS overdue,
                                        ROUND(AVG(EXTRACT(EPOCH FROM (closed_at - created_at)) / 3600) FILTER (WHERE status = 'done'))::int AS avg_hours_to_close
                                   FROM followups WHERE org_id = $1 AND ($2::uuid[] IS NULL OR branch_id = ANY($2)) AND created_at BETWEEN $3 AND $4`,
      [ctx.org.id, branches, from, to])
    return { from, to, funnel, monthly, followups }
  })

  r.get('/reports/data-quality', async ({ ctx, query }) => {
    requireCap(ctx, 'reports.view')
    const branches = await branchFilter(ctx, query.branch)
    const counts = await one(`SELECT COUNT(*)::int AS total,
                                     COUNT(*) FILTER (WHERE phone_norm IS NULL)::int AS no_phone,
                                     COUNT(*) FILTER (WHERE email IS NULL)::int AS no_email,
                                     COUNT(*) FILTER (WHERE branch_id IS NULL)::int AS no_branch,
                                     COUNT(*) FILTER (WHERE last_name IS NULL)::int AS no_last_name
                                FROM people WHERE org_id = $1 AND status <> 'archived' AND ($2::uuid[] IS NULL OR branch_id = ANY($2))`, [ctx.org.id, branches])
    const dupNames = await q(`SELECT lower(first_name) AS first, lower(COALESCE(last_name,'')) AS last, COUNT(*)::int AS n,
                                     array_agg(id) AS ids
                                FROM people WHERE org_id = $1 AND status <> 'archived' AND ($2::uuid[] IS NULL OR branch_id = ANY($2))
                               GROUP BY 1, 2 HAVING COUNT(*) > 1 ORDER BY n DESC LIMIT 50`, [ctx.org.id, branches])
    const dupEmails = await q(`SELECT lower(email) AS email, COUNT(*)::int AS n, array_agg(id) AS ids FROM people
                                WHERE org_id = $1 AND email IS NOT NULL AND status <> 'archived' AND ($2::uuid[] IS NULL OR branch_id = ANY($2))
                                GROUP BY 1 HAVING COUNT(*) > 1 ORDER BY n DESC LIMIT 50`, [ctx.org.id, branches])
    return { counts, possibleDuplicates: { byName: dupNames, byEmail: dupEmails } }
  })
}
