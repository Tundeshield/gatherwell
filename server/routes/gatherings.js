import { q, one, tx, builder } from '../db.js'
import { bad, notFound, conflict, str, oneOf, int, uuid, date, isUuid } from '../http.js'
import { requireCap, branchFilter, assertBranch, assertRowScope } from '../access.js'
import { shortId, sanitizeForm, audit, normalizePhone, DEFAULT_CHECKIN_FORM } from '../util.js'
import { recordCheckin, toCsv, csvResponse } from '../domain.js'

const STATUSES = ['draft', 'scheduled', 'open', 'closed', 'archived']
const KINDS = ['service', 'midweek', 'youth', 'prayer', 'meeting', 'class', 'other']

async function loadGathering(ctx, id) {
  const g = await one(`SELECT g.*, b.name AS branch_name FROM gatherings g JOIN branches b ON b.id = g.branch_id WHERE g.id = $1 AND g.org_id = $2`,
    [uuid(id, { required: true }), ctx.org.id])
  return assertRowScope(ctx, g, { allowOrgWide: false })
}

export default function (r) {
  r.get('/gatherings', async ({ ctx, query }) => {
    requireCap(ctx, 'attendance.view')
    const b = builder()
    b.add('g.org_id = ?', ctx.org.id)
    const branches = await branchFilter(ctx, query.branch)
    if (branches) b.add('g.branch_id = ANY(?)', branches)
    if (query.status && STATUSES.includes(query.status)) b.add('g.status = ?', query.status)
    else b.add(`g.status <> 'archived'`)
    if (query.q) b.add('g.name ILIKE ?', `%${String(query.q).slice(0, 80).replace(/[%_\\]/g, '\\$&')}%`)
    if (query.from) b.add('g.starts_at >= ?', date(query.from))
    if (query.to) b.add('g.starts_at <= ?', date(query.to))
    const limit = Math.min(int(query.limit) || 30, 100)
    const offset = Math.max(int(query.offset) || 0, 0)
    const rows = await q(`SELECT g.id, g.name, g.kind, g.status, g.starts_at, g.ends_at, g.branch_id, g.public_token, b.name AS branch_name,
                                 (SELECT COUNT(*)::int FROM checkins c WHERE c.gathering_id = g.id) AS attendance,
                                 (SELECT COUNT(*)::int FROM checkins c WHERE c.gathering_id = g.id AND c.first_time) AS first_timers
                            FROM gatherings g JOIN branches b ON b.id = g.branch_id ${b.sql()}
                           ORDER BY g.starts_at DESC LIMIT ${limit} OFFSET ${offset}`, b.params)
    const total = await one(`SELECT COUNT(*)::int AS n FROM gatherings g ${b.sql()}`, b.params)
    return { rows, total: total.n, limit, offset }
  })

  r.post('/gatherings', async ({ ctx, body }) => {
    requireCap(ctx, 'attendance.manage')
    const branch = await assertBranch(ctx, body.branchId)
    if (branch.status !== 'active') throw bad('That branch is archived.')
    const startsAt = date(body.startsAt, { required: true, name: 'Start time' })
    const endsAt = date(body.endsAt, { name: 'End time' })
    if (endsAt && new Date(endsAt) <= new Date(startsAt)) throw bad('End time must be after the start time.')
    const form = sanitizeForm(body.form?.length ? body.form : DEFAULT_CHECKIN_FORM)
    const g = await one(`INSERT INTO gatherings (org_id, branch_id, name, kind, description, starts_at, ends_at, status, public_token, form, created_by)
                         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [ctx.org.id, branch.id, str(body.name, { required: true, max: 120, name: 'Name' }), oneOf(body.kind, KINDS, { name: 'Type', fallback: 'service' }),
        str(body.description, { max: 1000 }), startsAt, endsAt, oneOf(body.status, STATUSES, { name: 'Status', fallback: 'open' }),
        shortId(10), JSON.stringify(form), ctx.user.id])
    await audit(ctx, 'gathering.created', 'gathering', g.id, { name: g.name })
    return g
  })

  r.get('/gatherings/:id', async ({ ctx, params }) => {
    requireCap(ctx, 'attendance.view')
    const g = await loadGathering(ctx, params.id)
    const stats = await one(`SELECT COUNT(*)::int AS attendance, COUNT(*) FILTER (WHERE first_time)::int AS first_timers,
                                    COUNT(*) FILTER (WHERE method = 'manual')::int AS manual
                               FROM checkins WHERE gathering_id = $1`, [g.id])
    // Previous comparable gathering: same branch and type, earlier start.
    const prev = await one(`SELECT g2.id, g2.name, g2.starts_at, (SELECT COUNT(*)::int FROM checkins c WHERE c.gathering_id = g2.id) AS attendance
                              FROM gatherings g2 WHERE g2.org_id = $1 AND g2.branch_id = $2 AND g2.kind = $3 AND g2.starts_at < $4 AND g2.status <> 'draft'
                             ORDER BY g2.starts_at DESC LIMIT 1`, [ctx.org.id, g.branch_id, g.kind, g.starts_at])
    return { gathering: g, stats, previous: prev }
  })

  r.patch('/gatherings/:id', async ({ ctx, params, body }) => {
    requireCap(ctx, 'attendance.manage')
    const g = await loadGathering(ctx, params.id)
    const startsAt = body.startsAt ? date(body.startsAt, { name: 'Start time' }) : null
    const endsAt = body.endsAt === null ? null : (body.endsAt ? date(body.endsAt, { name: 'End time' }) : g.ends_at)
    const status = oneOf(body.status, STATUSES, { name: 'Status' })
    const form = body.form ? JSON.stringify(sanitizeForm(body.form)) : null
    const updated = await one(`UPDATE gatherings SET name = COALESCE($3, name), kind = COALESCE($4, kind), description = COALESCE($5, description),
                                 starts_at = COALESCE($6, starts_at), ends_at = $7, status = COALESCE($8, status), form = COALESCE($9::jsonb, form), updated_at = NOW()
                                WHERE id = $1 AND org_id = $2 RETURNING *`,
      [g.id, ctx.org.id, str(body.name, { max: 120 }), oneOf(body.kind, KINDS, { name: 'Type' }), str(body.description, { max: 1000 }), startsAt, endsAt, status, form])
    if (status && status !== g.status) await audit(ctx, `gathering.${status}`, 'gathering', g.id)
    return updated
  })

  r.delete('/gatherings/:id', async ({ ctx, params, query }) => {
    requireCap(ctx, 'attendance.manage')
    const g = await loadGathering(ctx, params.id)
    const n = await one(`SELECT COUNT(*)::int AS n FROM checkins WHERE gathering_id = $1`, [g.id])
    if (n.n > 0 && query.confirm !== 'delete') throw conflict(`This session has ${n.n} check-ins. Archive it instead, or confirm deletion.`, { checkins: n.n })
    await q(`DELETE FROM gatherings WHERE id = $1 AND org_id = $2`, [g.id, ctx.org.id])
    // Recompute visit counters for affected people.
    await q(`UPDATE people p SET visit_count = (SELECT COUNT(*) FROM checkins c WHERE c.person_id = p.id),
               last_seen_at = (SELECT MAX(g.starts_at) FROM checkins c JOIN gatherings g ON g.id = c.gathering_id WHERE c.person_id = p.id)
              WHERE p.org_id = $1 AND p.last_seen_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM checkins c WHERE c.person_id = p.id AND c.gathering_id = $2)
                AND p.visit_count <> (SELECT COUNT(*) FROM checkins c WHERE c.person_id = p.id)`, [ctx.org.id, g.id])
    await audit(ctx, 'gathering.deleted', 'gathering', g.id, { name: g.name, checkins: n.n })
    return { ok: true }
  })

  r.get('/gatherings/:id/attendees', async ({ ctx, params, query }) => {
    requireCap(ctx, 'attendance.view')
    const g = await loadGathering(ctx, params.id)
    const term = query.q ? `%${String(query.q).slice(0, 80).replace(/[%_\\]/g, '\\$&')}%` : null
    const rows = await q(`SELECT c.id, c.created_at, c.first_time, c.method, c.answers, p.id AS person_id, p.first_name, p.last_name, p.phone, p.status, u.name AS recorded_by
                            FROM checkins c JOIN people p ON p.id = c.person_id LEFT JOIN users u ON u.id = c.created_by
                           WHERE c.gathering_id = $1 AND ($2::text IS NULL OR (p.first_name || ' ' || COALESCE(p.last_name,'')) ILIKE $2 OR p.phone ILIKE $2)
                           ORDER BY c.created_at DESC LIMIT 2000`, [g.id, term])
    return { rows }
  })

  r.get('/gatherings/:id/export', async ({ ctx, params }) => {
    requireCap(ctx, 'attendance.view')
    requireCap(ctx, 'export')
    const g = await loadGathering(ctx, params.id)
    const rows = await q(`SELECT c.*, p.first_name, p.last_name, p.phone, p.email, p.status FROM checkins c JOIN people p ON p.id = c.person_id
                           WHERE c.gathering_id = $1 ORDER BY c.created_at`, [g.id])
    const extra = (g.form || []).filter(f => !f.core)
    await audit(ctx, 'gathering.exported', 'gathering', g.id, { count: rows.length })
    const csv = toCsv(rows, [
      { label: 'First name', value: 'first_name' }, { label: 'Last name', value: 'last_name' }, { label: 'Phone', value: 'phone' },
      { label: 'Email', value: 'email' }, { label: 'Status', value: 'status' }, { label: 'First time', value: r => r.first_time ? 'Yes' : 'No' },
      { label: 'Method', value: 'method' }, { label: 'Checked in at', value: r => new Date(r.created_at).toISOString() },
      ...extra.map(f => ({ label: f.label, value: r => r.answers?.[f.id] ?? '' })),
    ])
    return csvResponse(csv, `${g.name}-${new Date(g.starts_at).toISOString().slice(0, 10)}.csv`)
  })

  // Manual check-in by an usher: an existing person, or a new person.
  r.post('/gatherings/:id/checkins', async ({ ctx, params, body }) => {
    requireCap(ctx, 'attendance.record')
    const g = await loadGathering(ctx, params.id)
    if (['archived', 'draft'].includes(g.status)) throw bad('This session is not accepting attendance.')
    return tx(async (c) => {
      let personId = body.personId
      if (personId) {
        const p = await c.one(`SELECT id, branch_id FROM people WHERE id = $1 AND org_id = $2`, [uuid(personId), ctx.org.id])
        if (!p) throw notFound('Person not found.')
      } else {
        const first = str(body.firstName, { required: true, max: 80, name: 'First name' })
        const phone = str(body.phone, { max: 40, name: 'Phone' })
        const phoneNorm = phone ? normalizePhone(phone, ctx.org.settings?.defaultCountryCode) : null
        if (phone && !phoneNorm) throw bad("That phone number doesn't look valid.")
        if (phoneNorm) {
          const dup = await c.one(`SELECT id, first_name, last_name FROM people WHERE org_id = $1 AND phone_norm = $2`, [ctx.org.id, phoneNorm])
          if (dup) throw conflict(`${dup.first_name} ${dup.last_name || ''} already has this phone number — search for them instead.`.trim(), { existingId: dup.id })
        }
        const p = await c.one(`INSERT INTO people (org_id, branch_id, first_name, last_name, phone, phone_norm, email, status, source)
                               VALUES ($1,$2,$3,$4,$5,$6,$7,'visitor','manual') RETURNING id`,
          [ctx.org.id, g.branch_id, first, str(body.lastName, { max: 80 }), phone, phoneNorm, str(body.email, { max: 254 })])
        personId = p.id
      }
      const res = await recordCheckin(c, { org: ctx.org, gathering: g, personId, method: 'manual', userId: ctx.user.id })
      if (res.alreadyCheckedIn) throw conflict('Already checked in for this session.')
      return { ok: true, firstTime: res.firstTime, checkinId: res.checkin.id }
    })
  })

  r.delete('/gatherings/:id/checkins/:checkinId', async ({ ctx, params }) => {
    requireCap(ctx, 'attendance.manage')
    const g = await loadGathering(ctx, params.id)
    const ch = await one(`DELETE FROM checkins WHERE id = $1 AND gathering_id = $2 RETURNING person_id`, [uuid(params.checkinId), g.id])
    if (!ch) throw notFound()
    await q(`UPDATE people p SET visit_count = GREATEST(visit_count - 1, 0),
               last_seen_at = (SELECT MAX(g.starts_at) FROM checkins c JOIN gatherings g ON g.id = c.gathering_id WHERE c.person_id = p.id),
               first_visit_at = (SELECT MIN(g.starts_at) FROM checkins c JOIN gatherings g ON g.id = c.gathering_id WHERE c.person_id = p.id)
              WHERE p.id = $1 AND p.org_id = $2`, [ch.person_id, ctx.org.id])
    await audit(ctx, 'checkin.removed', 'gathering', g.id, { personId: ch.person_id })
    return { ok: true }
  })

  // People search for the usher's manual check-in box (marks who's already in).
  r.get('/gatherings/:id/lookup', async ({ ctx, params, query }) => {
    requireCap(ctx, 'attendance.record')
    const g = await loadGathering(ctx, params.id)
    const term = String(query.q || '').trim().slice(0, 80)
    if (term.length < 2) return { rows: [] }
    const digits = term.replace(/\D/g, '')
    const like = `%${term.replace(/[%_\\]/g, '\\$&')}%`
    const rows = await q(`SELECT p.id, p.first_name, p.last_name, p.phone, p.status, b.name AS branch_name,
                                 EXISTS (SELECT 1 FROM checkins c WHERE c.gathering_id = $2 AND c.person_id = p.id) AS checked_in
                            FROM people p LEFT JOIN branches b ON b.id = p.branch_id
                           WHERE p.org_id = $1 AND p.status <> 'archived'
                             AND ((p.first_name || ' ' || COALESCE(p.last_name,'')) ILIKE $3 OR ($4 <> '' AND p.phone_norm LIKE $5))
                           ORDER BY (p.branch_id = $6) DESC, p.first_name LIMIT 12`,
      [ctx.org.id, g.id, like, digits.length >= 4 ? digits : '', `%${digits.replace(/^0/, '')}%`, g.branch_id])
    // People from branches outside the user's scope can be checked in (visiting members) but their details stay masked.
    const outOfScope = (row) => ctx.branchScope && row.branch_id && !ctx.branchScope.includes(row.branch_id)
    const full = await q(`SELECT id, branch_id FROM people WHERE id = ANY($1)`, [rows.map(x => x.id)])
    const branchOf = new Map(full.map(x => [x.id, x.branch_id]))
    return { rows: rows.map(row => outOfScope({ branch_id: branchOf.get(row.id) })
      ? { ...row, phone: row.phone ? '•••• ' + String(row.phone).slice(-3) : null, last_name: row.last_name ? row.last_name[0] + '.' : null }
      : row) }
  })
}
