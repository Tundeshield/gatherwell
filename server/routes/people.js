import { q, one, tx, builder } from '../db.js'
import { bad, conflict, notFound, forbidden, str, oneOf, int, uuid, date, email as emailV, isUuid } from '../http.js'
import { requireCap, branchFilter, assertBranch, assertRowScope, can } from '../access.js'
import { normalizePhone, audit } from '../util.js'
import { toCsv, csvResponse } from '../domain.js'

export const STATUSES = ['visitor', 'member', 'inactive', 'transferred', 'archived']

// Builds the WHERE clause for people lists (shared by list, export and message audiences).
export async function peopleWhere(ctx, f, b = builder()) {
  b.add('p.org_id = ?', ctx.org.id)
  const branches = await branchFilter(ctx, f.branch)
  if (branches) b.add('p.branch_id = ANY(?)', branches)
  if (f.status && f.status !== 'all') {
    const list = String(f.status).split(',').filter(s => STATUSES.includes(s))
    if (list.length) b.add('p.status = ANY(?)', list)
  } else if (!f.includeArchived) {
    b.add(`p.status <> 'archived'`)
  }
  if (f.unit && isUuid(f.unit)) b.add('p.unit_id = ?', f.unit)
  const weeks = Number(ctx.org.settings?.absenceWeeks || 3)
  if (f.attendance === 'recent') b.add(`p.last_seen_at >= NOW() - make_interval(days => ?)`, weeks * 7)
  if (f.attendance === 'absent') b.add(`p.last_seen_at < NOW() - make_interval(days => ?)`, weeks * 7)
  if (f.attendance === 'never') b.add(`p.last_seen_at IS NULL`)
  if (f.firstVisitSince) b.add('EXISTS (SELECT 1 FROM checkins fc WHERE fc.person_id = p.id AND fc.first_time AND fc.created_at >= ?)', date(f.firstVisitSince))
  if (f.followup === 'open') b.add(`EXISTS (SELECT 1 FROM followups fu WHERE fu.person_id = p.id AND fu.status IN ('pending','in_progress'))`)
  if (f.q) {
    const term = String(f.q).trim().slice(0, 80)
    const digits = term.replace(/\D/g, '')
    const like = `%${term.replace(/[%_\\]/g, '\\$&')}%`
    if (digits.length >= 4) {
      b.add(`(p.phone_norm LIKE ? OR (p.first_name || ' ' || COALESCE(p.last_name,'')) ILIKE ? OR p.email ILIKE ?)`, `%${digits.replace(/^0/, '')}%`, like, like)
    } else {
      b.add(`((p.first_name || ' ' || COALESCE(p.last_name,'')) ILIKE ? OR p.email ILIKE ?)`, like, like)
    }
  }
  return b
}

const SORTS = {
  name: 'p.first_name ASC, p.last_name ASC',
  recent: 'p.created_at DESC',
  last_seen: 'p.last_seen_at DESC NULLS LAST',
  first_visit: 'p.first_visit_at DESC NULLS LAST',
}

function cleanPerson(body, cc) {
  const phone = str(body.phone, { max: 40, name: 'Phone' })
  const phoneNorm = phone ? normalizePhone(phone, cc) : null
  if (phone && !phoneNorm) throw bad('That phone number doesn\'t look valid.')
  return {
    first_name: str(body.firstName, { required: true, max: 80, name: 'First name' }),
    last_name: str(body.lastName, { max: 80, name: 'Last name' }),
    phone, phone_norm: phoneNorm,
    email: body.email ? emailV(body.email) : null,
    gender: oneOf(body.gender || null, ['female', 'male'], { name: 'Gender' }),
    birthday: body.birthday ? date(body.birthday, { name: 'Birthday' }).slice(0, 10) : null,
    status: oneOf(body.status, STATUSES, { name: 'Status', fallback: 'visitor' }),
    joined_at: body.joinedAt ? date(body.joinedAt, { name: 'Date joined' }).slice(0, 10) : null,
    notes: str(body.notes, { max: 2000, name: 'Notes' }),
  }
}

async function scopedUnit(ctx, unitId) {
  if (!unitId) return null
  const u = await one(`SELECT id FROM units WHERE id = $1 AND org_id = $2`, [uuid(unitId), ctx.org.id])
  if (!u) throw bad('Service unit not found.')
  return u.id
}

async function scopedOwner(ctx, userId) {
  if (!userId) return null
  const m = await one(`SELECT user_id FROM memberships WHERE org_id = $1 AND user_id = $2 AND status = 'active'`, [ctx.org.id, uuid(userId)])
  if (!m) throw bad('That team member was not found.')
  return m.user_id
}

export default function (r) {
  r.get('/people', async ({ ctx, query }) => {
    requireCap(ctx, 'people.view')
    const b = await peopleWhere(ctx, query)
    const limit = Math.min(int(query.limit) || 50, 200)
    const offset = Math.max(int(query.offset) || 0, 0)
    const order = SORTS[query.sort] || SORTS.name
    const where = b.sql()
    const [rows, total] = await Promise.all([
      q(`SELECT p.id, p.first_name, p.last_name, p.phone, p.email, p.status, p.branch_id, p.unit_id, p.first_visit_at, p.last_seen_at,
                p.visit_count, p.created_at, b.name AS branch_name, u.name AS unit_name,
                (SELECT COUNT(*)::int FROM followups fu WHERE fu.person_id = p.id AND fu.status IN ('pending','in_progress')) AS open_followups
           FROM people p LEFT JOIN branches b ON b.id = p.branch_id LEFT JOIN units u ON u.id = p.unit_id
           ${where} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`, b.params),
      one(`SELECT COUNT(*)::int AS n FROM people p ${where}`, b.params),
    ])
    return { rows, total: total.n, limit, offset }
  })

  r.get('/people/export', async ({ ctx, query }) => {
    requireCap(ctx, 'people.view')
    requireCap(ctx, 'export')
    const b = await peopleWhere(ctx, query)
    const rows = await q(`SELECT p.*, b.name AS branch_name, u.name AS unit_name FROM people p
                            LEFT JOIN branches b ON b.id = p.branch_id LEFT JOIN units u ON u.id = p.unit_id
                            ${b.sql()} ORDER BY p.first_name, p.last_name LIMIT 20000`, b.params)
    await audit(ctx, 'people.exported', 'people', null, { count: rows.length, filters: query })
    const csv = toCsv(rows, [
      { label: 'First name', value: 'first_name' }, { label: 'Last name', value: 'last_name' },
      { label: 'Phone', value: 'phone' }, { label: 'Email', value: 'email' }, { label: 'Status', value: 'status' },
      { label: 'Branch', value: 'branch_name' }, { label: 'Service unit', value: 'unit_name' },
      { label: 'Gender', value: 'gender' }, { label: 'Birthday', value: r => r.birthday ? String(r.birthday).slice(0, 10) : '' },
      { label: 'First visit', value: r => r.first_visit_at ? new Date(r.first_visit_at).toISOString().slice(0, 10) : '' },
      { label: 'Last attended', value: r => r.last_seen_at ? new Date(r.last_seen_at).toISOString().slice(0, 10) : '' },
      { label: 'Visits', value: 'visit_count' },
      { label: 'Date joined', value: r => r.joined_at ? String(r.joined_at).slice(0, 10) : '' },
    ])
    return csvResponse(csv, `people-${new Date().toISOString().slice(0, 10)}.csv`)
  })

  r.get('/people/:id', async ({ ctx, params }) => {
    requireCap(ctx, 'people.view')
    const p = await one(`SELECT p.*, b.name AS branch_name, u.name AS unit_name, ou.name AS owner_name
                           FROM people p LEFT JOIN branches b ON b.id = p.branch_id LEFT JOIN units u ON u.id = p.unit_id
                           LEFT JOIN users ou ON ou.id = p.owner_user_id
                          WHERE p.id = $1 AND p.org_id = $2`, [uuid(params.id, { required: true }), ctx.org.id])
    assertRowScope(ctx, p)
    const [attendance, followups, registrations] = await Promise.all([
      q(`SELECT c.id, c.created_at, c.first_time, c.method, g.id AS gathering_id, g.name, g.starts_at, b.name AS branch_name
           FROM checkins c JOIN gatherings g ON g.id = c.gathering_id JOIN branches b ON b.id = c.branch_id
          WHERE c.person_id = $1 AND c.org_id = $2 ORDER BY g.starts_at DESC LIMIT 60`, [p.id, ctx.org.id]),
      can(ctx, 'followups.view') ? q(`SELECT f.id, f.reason, f.title, f.status, f.due_at, f.outcome, f.closed_at, u.name AS assignee_name
           FROM followups f LEFT JOIN users u ON u.id = f.assignee_user_id WHERE f.person_id = $1 AND f.org_id = $2 ORDER BY f.created_at DESC LIMIT 30`, [p.id, ctx.org.id]) : [],
      q(`SELECT r.id, r.status, r.checked_in_at, e.id AS event_id, e.name, e.starts_at FROM registrations r JOIN events e ON e.id = r.event_id
          WHERE r.person_id = $1 AND r.org_id = $2 ORDER BY e.starts_at DESC LIMIT 30`, [p.id, ctx.org.id]),
    ])
    if (!can(ctx, 'people.edit')) delete p.notes
    return { person: p, attendance, followups, registrations }
  })

  r.post('/people', async ({ ctx, body }) => {
    requireCap(ctx, 'people.edit')
    const data = cleanPerson(body, ctx.org.settings?.defaultCountryCode)
    const branchId = (await assertBranch(ctx, body.branchId)).id
    if (data.phone_norm) {
      const dup = await one(`SELECT id, first_name, last_name FROM people WHERE org_id = $1 AND phone_norm = $2`, [ctx.org.id, data.phone_norm])
      if (dup) throw conflict(`${dup.first_name} ${dup.last_name || ''} already has this phone number.`.trim(), { existingId: dup.id })
    }
    const unitId = await scopedUnit(ctx, body.unitId)
    const ownerId = await scopedOwner(ctx, body.ownerUserId)
    const p = await one(`INSERT INTO people (org_id, branch_id, first_name, last_name, phone, phone_norm, email, gender, birthday, status, joined_at, notes, unit_id, owner_user_id, source)
                         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'manual') RETURNING *`,
      [ctx.org.id, branchId, data.first_name, data.last_name, data.phone, data.phone_norm, data.email, data.gender, data.birthday, data.status, data.joined_at, data.notes, unitId, ownerId])
    await audit(ctx, 'person.created', 'person', p.id)
    return p
  })

  r.patch('/people/:id', async ({ ctx, params, body }) => {
    requireCap(ctx, 'people.edit')
    const existing = await one(`SELECT * FROM people WHERE id = $1 AND org_id = $2`, [uuid(params.id, { required: true }), ctx.org.id])
    assertRowScope(ctx, existing)
    const merged = {
      firstName: existing.first_name, lastName: existing.last_name, phone: existing.phone, email: existing.email, gender: existing.gender,
      birthday: existing.birthday, status: existing.status, joinedAt: existing.joined_at, notes: existing.notes, ...body,
    }
    const data = cleanPerson(merged, ctx.org.settings?.defaultCountryCode)
    if (data.phone_norm && data.phone_norm !== existing.phone_norm) {
      const dup = await one(`SELECT id, first_name, last_name FROM people WHERE org_id = $1 AND phone_norm = $2 AND id <> $3`, [ctx.org.id, data.phone_norm, existing.id])
      if (dup) throw conflict(`${dup.first_name} ${dup.last_name || ''} already has this phone number.`.trim(), { existingId: dup.id })
    }
    const branchId = body.branchId !== undefined ? (await assertBranch(ctx, body.branchId)).id : existing.branch_id
    const unitId = body.unitId !== undefined ? await scopedUnit(ctx, body.unitId) : existing.unit_id
    const ownerId = body.ownerUserId !== undefined ? await scopedOwner(ctx, body.ownerUserId) : existing.owner_user_id
    const p = await one(`UPDATE people SET first_name=$3, last_name=$4, phone=$5, phone_norm=$6, email=$7, gender=$8, birthday=$9, status=$10,
                           joined_at=$11, notes=$12, branch_id=$13, unit_id=$14, owner_user_id=$15, updated_at=NOW()
                          WHERE id=$1 AND org_id=$2 RETURNING *`,
      [existing.id, ctx.org.id, data.first_name, data.last_name, data.phone, data.phone_norm, data.email, data.gender, data.birthday,
        data.status, data.joined_at, data.notes, branchId, unitId, ownerId])
    if (data.status !== existing.status) {
      await audit(ctx, 'person.status_changed', 'person', p.id, { from: existing.status, to: data.status })
      // Leaving the visitor journey closes visitor follow-ups.
      if (existing.status === 'visitor' && data.status !== 'visitor') {
        await q(`UPDATE followups SET status = 'done', outcome = COALESCE(outcome, 'Status changed to ' || $2), closed_at = NOW()
                  WHERE person_id = $1 AND reason IN ('first_visit','second_visit') AND status IN ('pending','in_progress')`, [p.id, data.status])
      }
    }
    return p
  })

  r.delete('/people/:id', async ({ ctx, params }) => {
    requireCap(ctx, 'people.delete')
    const p = await one(`SELECT * FROM people WHERE id = $1 AND org_id = $2`, [uuid(params.id, { required: true }), ctx.org.id])
    assertRowScope(ctx, p)
    await q(`DELETE FROM people WHERE id = $1 AND org_id = $2`, [p.id, ctx.org.id])
    await audit(ctx, 'person.deleted', 'person', p.id, { name: `${p.first_name} ${p.last_name || ''}`.trim() })
    return { ok: true }
  })

  // Bulk status / unit / branch changes.
  r.post('/people/bulk', async ({ ctx, body }) => {
    requireCap(ctx, 'people.edit')
    const ids = (Array.isArray(body.ids) ? body.ids : []).filter(isUuid).slice(0, 1000)
    if (!ids.length) throw bad('Select at least one person.')
    const sets = []
    const params = [ctx.org.id, ids, ctx.branchScope]
    if (body.status) { params.push(oneOf(body.status, STATUSES, { name: 'Status' })); sets.push(`status = $${params.length}`) }
    if (body.unitId !== undefined) { params.push(await scopedUnit(ctx, body.unitId)); sets.push(`unit_id = $${params.length}`) }
    if (body.branchId) { params.push((await assertBranch(ctx, body.branchId)).id); sets.push(`branch_id = $${params.length}`) }
    if (!sets.length) throw bad('Nothing to change.')
    const rows = await q(`UPDATE people SET ${sets.join(', ')}, updated_at = NOW()
                           WHERE org_id = $1 AND id = ANY($2) AND ($3::uuid[] IS NULL OR branch_id = ANY($3)) RETURNING id`, params)
    await audit(ctx, 'people.bulk_updated', 'people', null, { count: rows.length, status: body.status, unitId: body.unitId, branchId: body.branchId })
    return { updated: rows.length }
  })

  // --- import: preview then commit ----------------------------------------------------
  r.post('/people/import/preview', async ({ ctx, body }) => {
    requireCap(ctx, 'people.edit')
    const branchId = (await assertBranch(ctx, body.branchId)).id
    return analyseImport(ctx, body.rows, branchId)
  })

  r.post('/people/import/commit', async ({ ctx, body }) => {
    requireCap(ctx, 'people.edit')
    const branchId = (await assertBranch(ctx, body.branchId)).id
    const policy = oneOf(body.duplicatePolicy, ['skip', 'update'], { name: 'Duplicate policy', fallback: 'skip' })
    const analysis = await analyseImport(ctx, body.rows, branchId)
    const summary = { created: 0, updated: 0, skipped: 0, rejected: analysis.summary.rejected }
    const toCreate = analysis.rows.filter(r => r.action === 'create')
    const toUpdate = analysis.rows.filter(r => r.action === 'duplicate')
    await tx(async (c) => {
      for (let i = 0; i < toCreate.length; i += 200) {
        const chunk = toCreate.slice(i, i + 200)
        const vals = []
        const params = []
        for (const r of chunk) {
          const d = r.data
          const base = params.length
          params.push(ctx.org.id, branchId, d.first_name, d.last_name, d.phone, d.phone_norm, d.email, d.gender, d.status, d.joined_at, d.birthday)
          vals.push(`(${Array.from({ length: 11 }, (_, k) => `$${base + k + 1}`).join(',')},'import')`)
        }
        await c.q(`INSERT INTO people (org_id, branch_id, first_name, last_name, phone, phone_norm, email, gender, status, joined_at, birthday, source)
                   VALUES ${vals.join(',')} ON CONFLICT (org_id, phone_norm) WHERE phone_norm IS NOT NULL DO NOTHING RETURNING id`, params)
          .then(inserted => { summary.created += inserted.length; summary.skipped += chunk.length - inserted.length })
      }
      if (policy === 'update') {
        for (const r of toUpdate) {
          const d = r.data
          // Only fill blanks — never overwrite existing details with imported ones.
          await c.q(`UPDATE people SET last_name = COALESCE(last_name, $3), email = COALESCE(email, $4), gender = COALESCE(gender, $5),
                       joined_at = COALESCE(joined_at, $6), birthday = COALESCE(birthday, $7), updated_at = NOW()
                      WHERE id = $1 AND org_id = $2`, [r.existingId, ctx.org.id, d.last_name, d.email, d.gender, d.joined_at, d.birthday])
          summary.updated++
        }
      } else {
        summary.skipped += toUpdate.length
      }
    })
    summary.skipped += analysis.rows.filter(r => r.action === 'skip').length
    await audit(ctx, 'people.imported', 'people', null, { ...summary, branchId })
    return { summary }
  })
}

const MAX_IMPORT = 5000

async function analyseImport(ctx, rawRows, branchId) {
  if (!Array.isArray(rawRows) || !rawRows.length) throw bad('There are no rows to import.')
  if (rawRows.length > MAX_IMPORT) throw bad(`Imports are limited to ${MAX_IMPORT} rows at a time. Split the file and try again.`)
  const cc = ctx.org.settings?.defaultCountryCode || '234'
  const rows = []
  const seenPhones = new Map()
  for (let i = 0; i < rawRows.length; i++) {
    const r = rawRows[i] || {}
    const errors = []
    let first = String(r.firstName || '').trim()
    let last = String(r.lastName || '').trim()
    if (!first && r.fullName) { const parts = String(r.fullName).trim().split(/\s+/); first = parts.shift() || ''; last = last || parts.join(' ') }
    if (!first) errors.push('Missing first name')
    const phone = String(r.phone || '').trim()
    const phoneNorm = phone ? normalizePhone(phone, cc) : null
    if (phone && !phoneNorm) errors.push(`Phone "${phone}" isn't valid`)
    let email = String(r.email || '').trim().toLowerCase() || null
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { errors.push(`Email "${email}" isn't valid`); email = null }
    const status = String(r.status || '').trim().toLowerCase()
    const g = String(r.gender || '').trim().toLowerCase()
    const toDate = (v) => { if (!v) return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10) }
    const data = {
      first_name: first.slice(0, 80), last_name: last.slice(0, 80) || null, phone: phone || null, phone_norm: phoneNorm, email,
      gender: ['f', 'female', 'woman'].includes(g) ? 'female' : ['m', 'male', 'man'].includes(g) ? 'male' : null,
      status: STATUSES.includes(status) ? status : 'member',
      joined_at: toDate(r.joinedAt), birthday: toDate(r.birthday),
    }
    let action = errors.length ? 'reject' : 'create'
    let note = null
    if (action === 'create' && phoneNorm) {
      if (seenPhones.has(phoneNorm)) { action = 'skip'; note = `Same phone as row ${seenPhones.get(phoneNorm) + 1}` }
      else seenPhones.set(phoneNorm, i)
    }
    rows.push({ index: i, action, errors, note, data, name: `${first} ${last}`.trim() })
  }
  const phones = [...seenPhones.keys()]
  if (phones.length) {
    const existing = await q(`SELECT id, phone_norm, first_name, last_name FROM people WHERE org_id = $1 AND phone_norm = ANY($2)`, [ctx.org.id, phones])
    const byPhone = new Map(existing.map(e => [e.phone_norm, e]))
    for (const row of rows) {
      const e = row.action === 'create' && byPhone.get(row.data.phone_norm)
      if (e) { row.action = 'duplicate'; row.existingId = e.id; row.note = `Matches ${e.first_name} ${e.last_name || ''}`.trim() }
    }
  }
  const summary = {
    total: rows.length,
    create: rows.filter(r => r.action === 'create').length,
    duplicate: rows.filter(r => r.action === 'duplicate').length,
    skip: rows.filter(r => r.action === 'skip').length,
    rejected: rows.filter(r => r.action === 'reject').length,
  }
  return { summary, rows }
}
