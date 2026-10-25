import { q, one, tx, builder } from '../db.js'
import { bad, notFound, str, oneOf, int, uuid, date, isUuid } from '../http.js'
import { requireCap, branchFilter, assertRowScope } from '../access.js'
import { audit } from '../util.js'
import { createAutoFollowup } from '../domain.js'

const STATUSES = ['pending', 'in_progress', 'done', 'cancelled']
const REASONS = ['first_visit', 'second_visit', 'absence', 'event', 'manual']
const NOTE_KINDS = ['call', 'message', 'visit', 'note', 'no_answer']

async function assignee(ctx, userId) {
  if (!userId) return null
  const m = await one(`SELECT user_id FROM memberships WHERE org_id = $1 AND user_id = $2 AND status = 'active'`, [ctx.org.id, uuid(userId)])
  if (!m) throw bad('That team member was not found.')
  return m.user_id
}

async function loadFollowup(ctx, id) {
  const f = await one(`SELECT * FROM followups WHERE id = $1 AND org_id = $2`, [uuid(id, { required: true }), ctx.org.id])
  return assertRowScope(ctx, f)
}

// End of "today" in the organisation's timezone, as a timestamptz expression.
const END_OF_TODAY = `((date_trunc('day', NOW() AT TIME ZONE $TZ) + INTERVAL '1 day') AT TIME ZONE $TZ)`
const START_OF_TODAY = `(date_trunc('day', NOW() AT TIME ZONE $TZ) AT TIME ZONE $TZ)`

export default function (r) {
  r.get('/followups', async ({ ctx, query }) => {
    requireCap(ctx, 'followups.view')
    const b = builder()
    b.add('f.org_id = ?', ctx.org.id)
    const branches = await branchFilter(ctx, query.branch)
    if (branches) b.add('f.branch_id = ANY(?)', branches)
    if (query.reason && REASONS.includes(query.reason)) b.add('f.reason = ?', query.reason)
    if (query.assignee === 'me') b.add('f.assignee_user_id = ?', ctx.user.id)
    else if (query.assignee === 'unassigned') b.add('f.assignee_user_id IS NULL')
    else if (isUuid(query.assignee)) b.add('f.assignee_user_id = ?', query.assignee)
    if (query.person && isUuid(query.person)) b.add('f.person_id = ?', query.person)

    const base = b.sql()
    const baseParams = [...b.params]
    const tz = `$${baseParams.length + 1}`
    const eod = END_OF_TODAY.replaceAll('$TZ', tz)
    const sod = START_OF_TODAY.replaceAll('$TZ', tz)
    const open = `f.status IN ('pending','in_progress')`
    const buckets = {
      overdue: `${open} AND f.due_at < ${sod}`,
      today: `${open} AND f.due_at >= ${sod} AND f.due_at < ${eod}`,
      upcoming: `${open} AND f.due_at >= ${eod}`,
      open,
      done: `f.status IN ('done','cancelled')`,
    }
    const bucket = buckets[query.bucket] ? query.bucket : 'open'
    const withTz = [...baseParams, ctx.org.timezone || 'UTC']
    const counts = await one(`SELECT COUNT(*) FILTER (WHERE ${buckets.overdue})::int AS overdue, COUNT(*) FILTER (WHERE ${buckets.today})::int AS today,
                                     COUNT(*) FILTER (WHERE ${buckets.upcoming})::int AS upcoming, COUNT(*) FILTER (WHERE ${buckets.open})::int AS open,
                                     COUNT(*) FILTER (WHERE ${buckets.done} AND f.closed_at > NOW() - INTERVAL '30 days')::int AS done_30d
                                FROM followups f ${base}`, withTz)
    const limit = Math.min(int(query.limit) || 50, 200)
    const offset = Math.max(int(query.offset) || 0, 0)
    const order = bucket === 'done' ? 'f.closed_at DESC NULLS LAST' : 'f.due_at ASC'
    const usesTz = ['overdue', 'today', 'upcoming'].includes(bucket)
    const rows = await q(`SELECT f.id, f.reason, f.title, f.status, f.due_at, f.outcome, f.next_action, f.closed_at, f.created_at, f.branch_id,
                                 f.assignee_user_id, u.name AS assignee_name, p.id AS person_id, p.first_name, p.last_name, p.phone, p.status AS person_status,
                                 p.visit_count, p.last_seen_at, b.name AS branch_name,
                                 (SELECT COUNT(*)::int FROM followup_notes n WHERE n.followup_id = f.id) AS attempts,
                                 (SELECT MAX(n.created_at) FROM followup_notes n WHERE n.followup_id = f.id) AS last_attempt_at
                            FROM followups f JOIN people p ON p.id = f.person_id LEFT JOIN users u ON u.id = f.assignee_user_id
                            LEFT JOIN branches b ON b.id = f.branch_id
                            ${base} AND ${buckets[bucket]} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`, usesTz ? withTz : baseParams)
    return { rows, counts, bucket }
  })

  r.get('/followups/:id', async ({ ctx, params }) => {
    requireCap(ctx, 'followups.view')
    const f = await loadFollowup(ctx, params.id)
    const [person, notes] = await Promise.all([
      one(`SELECT id, first_name, last_name, phone, email, status, visit_count, first_visit_at, last_seen_at FROM people WHERE id = $1`, [f.person_id]),
      q(`SELECT n.id, n.kind, n.body, n.created_at, u.name AS user_name FROM followup_notes n LEFT JOIN users u ON u.id = n.user_id
          WHERE n.followup_id = $1 ORDER BY n.created_at DESC`, [f.id]),
    ])
    const assigneeRow = f.assignee_user_id ? await one(`SELECT name FROM users WHERE id = $1`, [f.assignee_user_id]) : null
    return { followup: { ...f, assignee_name: assigneeRow?.name || null }, person, notes }
  })

  r.post('/followups', async ({ ctx, body }) => {
    requireCap(ctx, 'followups.manage')
    const p = await one(`SELECT id, org_id, branch_id FROM people WHERE id = $1 AND org_id = $2`, [uuid(body.personId, { required: true, name: 'Person' }), ctx.org.id])
    assertRowScope(ctx, p)
    const f = await one(`INSERT INTO followups (org_id, branch_id, person_id, reason, title, due_at, assignee_user_id, next_action, created_by)
                         VALUES ($1,$2,$3,'manual',$4,$5,$6,$7,$8) RETURNING *`,
      [ctx.org.id, p.branch_id, p.id, str(body.title, { required: true, max: 160, name: 'Reason' }),
        date(body.dueAt, { name: 'Due date' }) || new Date(Date.now() + 2 * 86400000).toISOString(),
        await assignee(ctx, body.assigneeUserId), str(body.nextAction, { max: 300 }), ctx.user.id])
    await audit(ctx, 'followup.created', 'followup', f.id)
    return f
  })

  r.patch('/followups/:id', async ({ ctx, params, body }) => {
    requireCap(ctx, 'followups.manage')
    const f = await loadFollowup(ctx, params.id)
    const status = oneOf(body.status, STATUSES, { name: 'Status' })
    const closing = status && ['done', 'cancelled'].includes(status) && !['done', 'cancelled'].includes(f.status)
    const reopening = status && ['pending', 'in_progress'].includes(status) && ['done', 'cancelled'].includes(f.status)
    const upd = await one(`UPDATE followups SET status = COALESCE($3, status),
                             assignee_user_id = CASE WHEN $4 THEN $5 ELSE assignee_user_id END,
                             due_at = COALESCE($6, due_at), outcome = COALESCE($7, outcome), next_action = COALESCE($8, next_action),
                             title = COALESCE($9, title),
                             closed_at = CASE WHEN $10 THEN NOW() WHEN $11 THEN NULL ELSE closed_at END
                            WHERE id = $1 AND org_id = $2 RETURNING *`,
      [f.id, ctx.org.id, status, body.assigneeUserId !== undefined, await assignee(ctx, body.assigneeUserId),
        date(body.dueAt, { name: 'Due date' }), str(body.outcome, { max: 1000 }), str(body.nextAction, { max: 300 }), str(body.title, { max: 160 }), !!closing, !!reopening])
    if (status && status !== f.status) await audit(ctx, `followup.${status}`, 'followup', f.id)
    return upd
  })

  r.post('/followups/:id/notes', async ({ ctx, params, body }) => {
    requireCap(ctx, 'followups.manage')
    const f = await loadFollowup(ctx, params.id)
    const kind = oneOf(body.kind, NOTE_KINDS, { name: 'Type', fallback: 'note' })
    const text = str(body.body, { max: 2000, name: 'Note' })
    if (!text && kind === 'note') throw bad('Write a note.')
    const n = await tx(async (c) => {
      const n = await c.one(`INSERT INTO followup_notes (followup_id, org_id, user_id, kind, body) VALUES ($1,$2,$3,$4,$5) RETURNING *`, [f.id, ctx.org.id, ctx.user.id, kind, text])
      if (f.status === 'pending') await c.q(`UPDATE followups SET status = 'in_progress' WHERE id = $1`, [f.id])
      return n
    })
    return n
  })

  // Members past the absence threshold who don't already have an open absence case.
  r.get('/followups/absence/candidates', async ({ ctx, query }) => {
    requireCap(ctx, 'followups.view')
    const weeks = Number(ctx.org.settings?.absenceWeeks || 3)
    const branches = await branchFilter(ctx, query.branch)
    const rows = await q(`SELECT p.id, p.first_name, p.last_name, p.phone, p.last_seen_at, p.visit_count, b.name AS branch_name
                            FROM people p LEFT JOIN branches b ON b.id = p.branch_id
                           WHERE p.org_id = $1 AND p.status = 'member' AND p.last_seen_at IS NOT NULL
                             AND p.last_seen_at < NOW() - make_interval(days => $2)
                             AND ($3::uuid[] IS NULL OR p.branch_id = ANY($3))
                             AND NOT EXISTS (SELECT 1 FROM followups f WHERE f.person_id = p.id AND f.reason = 'absence' AND f.status IN ('pending','in_progress'))
                           ORDER BY p.last_seen_at DESC LIMIT 500`, [ctx.org.id, weeks * 7, branches])
    return { rows, weeks }
  })

  r.post('/followups/absence', async ({ ctx, body }) => {
    requireCap(ctx, 'followups.manage')
    const ids = (Array.isArray(body.personIds) ? body.personIds : []).filter(isUuid).slice(0, 500)
    if (!ids.length) throw bad('Select at least one person.')
    const who = await assignee(ctx, body.assigneeUserId)
    const dueAt = date(body.dueAt, { name: 'Due date' })
    const people = await q(`SELECT id, branch_id FROM people WHERE org_id = $1 AND id = ANY($2) AND status = 'member'
                              AND ($3::uuid[] IS NULL OR branch_id = ANY($3))`, [ctx.org.id, ids, ctx.branchScope])
    let created = 0
    await tx(async (c) => {
      for (const p of people) {
        const row = await createAutoFollowup(c, { orgId: ctx.org.id, branchId: p.branch_id, personId: p.id, reason: 'absence',
          title: 'Check in — not seen recently', dueAt, dueHours: 72, assignee: who, createdBy: ctx.user.id })
        if (row) created++
      }
    })
    await audit(ctx, 'followup.absence_created', 'followup', null, { created })
    return { created, skipped: people.length - created }
  })
}
