import { q, one, tx, builder } from '../db.js'
import { bad, notFound, conflict, forbidden, str, oneOf, int, uuid, date, email as emailV } from '../http.js'
import { requireCap, branchFilter, assertBranch, assertRowScope } from '../access.js'
import { shortId, sanitizeForm, audit, normalizePhone, ticketCode } from '../util.js'
import { toCsv, csvResponse } from '../domain.js'

export const EVENT_STATUSES = ['draft', 'published', 'postponed', 'cancelled', 'completed']
const DEFAULT_EVENT_FORM = [
  { id: 'first_name', type: 'text', label: 'First name', required: true, core: true },
  { id: 'last_name', type: 'text', label: 'Last name', required: true, core: true },
  { id: 'phone', type: 'phone', label: 'Phone number', required: true, core: true },
  { id: 'email', type: 'email', label: 'Email', required: false, core: true },
]

async function loadEvent(ctx, id) {
  const e = await one(`SELECT e.*, b.name AS branch_name FROM events e LEFT JOIN branches b ON b.id = e.branch_id WHERE e.id = $1 AND e.org_id = $2`,
    [uuid(id, { required: true }), ctx.org.id])
  return assertRowScope(ctx, e)
}

export async function eventStats(eventId) {
  return one(`SELECT COUNT(*) FILTER (WHERE status = 'registered')::int AS registered,
                     COUNT(*) FILTER (WHERE status = 'waitlist')::int AS waitlist,
                     COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
                     COUNT(*) FILTER (WHERE checked_in_at IS NOT NULL)::int AS checked_in
                FROM registrations WHERE event_id = $1`, [eventId])
}

// Shared by public registration and staff "add attendee".
export async function createRegistration(c, { event, orgSettings, name, phone, email, answers = {} }) {
  const phoneNorm = phone ? normalizePhone(phone, orgSettings?.defaultCountryCode) : null
  if (phone && !phoneNorm) throw bad("That phone number doesn't look valid.")
  if (phoneNorm) {
    const dup = await c.one(`SELECT id FROM registrations WHERE event_id = $1 AND phone_norm = $2 AND status <> 'cancelled'`, [event.id, phoneNorm])
    if (dup) throw conflict('This phone number is already registered for this event.')
  }
  if (email) {
    const dup = await c.one(`SELECT id FROM registrations WHERE event_id = $1 AND lower(email) = lower($2) AND status <> 'cancelled'`, [event.id, email])
    if (dup) throw conflict('This email is already registered for this event.')
  }
  // Lock the event row so capacity checks are consistent under concurrent sign-ups.
  await c.one(`SELECT id FROM events WHERE id = $1 FOR UPDATE`, [event.id])
  let status = 'registered'
  if (event.capacity) {
    const n = await c.one(`SELECT COUNT(*)::int AS n FROM registrations WHERE event_id = $1 AND status = 'registered'`, [event.id])
    if (n.n >= event.capacity) status = 'waitlist'
  }
  // Link to an existing person only on an exact phone match within the organisation.
  const person = phoneNorm ? await c.one(`SELECT id FROM people WHERE org_id = $1 AND phone_norm = $2`, [event.org_id, phoneNorm]) : null
  let code
  for (let i = 0; i < 5; i++) {
    code = ticketCode()
    const clash = await c.one(`SELECT 1 FROM registrations WHERE event_id = $1 AND code = $2`, [event.id, code])
    if (!clash) break
  }
  return c.one(`INSERT INTO registrations (org_id, event_id, person_id, name, email, phone, phone_norm, answers, status, code)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [event.org_id, event.id, person?.id || null, name, email, phone, phoneNorm, answers, status, code])
}

function eventInput(body, partial = false) {
  const startsAt = date(body.startsAt, { required: !partial, name: 'Start time' })
  const endsAt = body.endsAt === null ? null : date(body.endsAt, { name: 'End time' })
  if (startsAt && endsAt && new Date(endsAt) <= new Date(startsAt)) throw bad('End time must be after the start time.')
  const opens = body.registrationOpensAt === null ? null : date(body.registrationOpensAt, { name: 'Registration opens' })
  const closes = body.registrationClosesAt === null ? null : date(body.registrationClosesAt, { name: 'Registration closes' })
  if (opens && closes && new Date(closes) <= new Date(opens)) throw bad('Registration must close after it opens.')
  return {
    name: str(body.name, { required: !partial, max: 140, name: 'Event name' }),
    description: str(body.description, { max: 4000, name: 'Description' }),
    location: str(body.location, { max: 300, name: 'Location' }),
    startsAt, endsAt, opens, closes,
    capacity: body.capacity === null || body.capacity === '' ? null : int(body.capacity, { min: 1, max: 100000, name: 'Capacity' }),
    status: oneOf(body.status, EVENT_STATUSES, { name: 'Status' }),
  }
}

export default function (r) {
  r.get('/events', async ({ ctx, query }) => {
    requireCap(ctx, 'events.view')
    const b = builder()
    b.add('e.org_id = ?', ctx.org.id)
    const branches = await branchFilter(ctx, query.branch)
    if (branches) b.add('(e.branch_id IS NULL OR e.branch_id = ANY(?))', branches)
    if (query.when === 'upcoming') b.add(`COALESCE(e.ends_at, e.starts_at) >= NOW()`)
    if (query.when === 'past') b.add(`COALESCE(e.ends_at, e.starts_at) < NOW()`)
    if (query.status && EVENT_STATUSES.includes(query.status)) b.add('e.status = ?', query.status)
    const order = query.when === 'upcoming' ? 'e.starts_at ASC' : 'e.starts_at DESC'
    const rows = await q(`SELECT e.id, e.name, e.location, e.starts_at, e.ends_at, e.status, e.capacity, e.branch_id, e.public_token,
                                 e.registration_opens_at, e.registration_closes_at, b.name AS branch_name,
                                 (SELECT COUNT(*)::int FROM registrations r WHERE r.event_id = e.id AND r.status = 'registered') AS registered,
                                 (SELECT COUNT(*)::int FROM registrations r WHERE r.event_id = e.id AND r.checked_in_at IS NOT NULL) AS checked_in
                            FROM events e LEFT JOIN branches b ON b.id = e.branch_id ${b.sql()} ORDER BY ${order} LIMIT 200`, b.params)
    return { rows }
  })

  r.post('/events', async ({ ctx, body }) => {
    requireCap(ctx, 'events.manage')
    const d = eventInput(body)
    let branchId = null
    if (body.branchId) branchId = (await assertBranch(ctx, body.branchId)).id
    else if (ctx.branchScope) throw forbidden('Choose one of your branches for this event.')
    const form = sanitizeForm(body.form?.length ? body.form : DEFAULT_EVENT_FORM)
    const e = await one(`INSERT INTO events (org_id, branch_id, name, description, location, starts_at, ends_at, registration_opens_at, registration_closes_at, capacity, status, public_token, form, created_by)
                         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [ctx.org.id, branchId, d.name, d.description, d.location, d.startsAt, d.endsAt, d.opens, d.closes, d.capacity, d.status || 'published', shortId(10), JSON.stringify(form), ctx.user.id])
    await audit(ctx, 'event.created', 'event', e.id, { name: e.name })
    return e
  })

  r.get('/events/:id', async ({ ctx, params }) => {
    requireCap(ctx, 'events.view')
    const e = await loadEvent(ctx, params.id)
    const stats = await eventStats(e.id)
    const followups = await one(`SELECT COUNT(*)::int AS n FROM followups f JOIN registrations r ON r.person_id = f.person_id
                                  WHERE r.event_id = $1 AND f.reason = 'event' AND f.org_id = $2`, [e.id, ctx.org.id])
    return { event: e, stats: { ...stats, followups: followups.n } }
  })

  r.patch('/events/:id', async ({ ctx, params, body }) => {
    requireCap(ctx, 'events.manage')
    const e = await loadEvent(ctx, params.id)
    const d = eventInput(body, true)
    let branchId = e.branch_id
    if (body.branchId !== undefined) {
      if (body.branchId) branchId = (await assertBranch(ctx, body.branchId)).id
      else if (ctx.branchScope) throw forbidden()
      else branchId = null
    }
    const form = body.form ? JSON.stringify(sanitizeForm(body.form)) : null
    const upd = await one(`UPDATE events SET name = COALESCE($3, name), description = COALESCE($4, description), location = COALESCE($5, location),
                             starts_at = COALESCE($6, starts_at), ends_at = CASE WHEN $13 THEN $7 ELSE ends_at END,
                             registration_opens_at = CASE WHEN $14 THEN $8 ELSE registration_opens_at END,
                             registration_closes_at = CASE WHEN $15 THEN $9 ELSE registration_closes_at END,
                             capacity = CASE WHEN $16 THEN $10 ELSE capacity END, status = COALESCE($11, status),
                             form = COALESCE($12::jsonb, form), branch_id = $17, updated_at = NOW()
                            WHERE id = $1 AND org_id = $2 RETURNING *`,
      [e.id, ctx.org.id, d.name, d.description, d.location, d.startsAt, d.endsAt, d.opens, d.closes, d.capacity, d.status, form,
        body.endsAt !== undefined, body.registrationOpensAt !== undefined, body.registrationClosesAt !== undefined, body.capacity !== undefined, branchId])
    if (d.status && d.status !== e.status) await audit(ctx, `event.${d.status}`, 'event', e.id)
    // Capacity increased: promote from the waitlist in sign-up order.
    if (upd.capacity && (!e.capacity || upd.capacity > e.capacity)) await promoteWaitlist(e.id, upd.capacity)
    return upd
  })

  r.delete('/events/:id', async ({ ctx, params, query }) => {
    requireCap(ctx, 'events.manage')
    const e = await loadEvent(ctx, params.id)
    const s = await eventStats(e.id)
    if (s.registered + s.waitlist > 0 && query.confirm !== 'delete') throw conflict(`This event has ${s.registered + s.waitlist} registrations. Cancel it instead, or confirm deletion.`)
    await q(`DELETE FROM events WHERE id = $1 AND org_id = $2`, [e.id, ctx.org.id])
    await audit(ctx, 'event.deleted', 'event', e.id, { name: e.name })
    return { ok: true }
  })

  r.get('/events/:id/registrations', async ({ ctx, params, query }) => {
    requireCap(ctx, 'events.view')
    const e = await loadEvent(ctx, params.id)
    const term = query.q ? `%${String(query.q).slice(0, 80).replace(/[%_\\]/g, '\\$&')}%` : null
    const status = ['registered', 'waitlist', 'cancelled', 'checked_in'].includes(query.status) ? query.status : null
    const rows = await q(`SELECT r.id, r.name, r.email, r.phone, r.status, r.code, r.checked_in_at, r.created_at, r.answers, r.person_id,
                                 p.status AS person_status
                            FROM registrations r LEFT JOIN people p ON p.id = r.person_id
                           WHERE r.event_id = $1
                             AND ($2::text IS NULL OR r.name ILIKE $2 OR r.phone ILIKE $2 OR r.email ILIKE $2 OR r.code ILIKE $2)
                             AND ($3::text IS NULL OR ($3 = 'checked_in' AND r.checked_in_at IS NOT NULL) OR r.status = $3)
                           ORDER BY r.created_at DESC LIMIT 5000`, [e.id, term, status])
    return { rows }
  })

  r.post('/events/:id/registrations', async ({ ctx, params, body }) => {
    requireCap(ctx, 'events.checkin')
    const e = await loadEvent(ctx, params.id)
    if (e.status === 'cancelled') throw bad('This event is cancelled.')
    const name = [str(body.firstName, { required: true, max: 80, name: 'First name' }), str(body.lastName, { max: 80 })].filter(Boolean).join(' ')
    const reg = await tx((c) => createRegistration(c, { event: e, orgSettings: ctx.org.settings, name, phone: str(body.phone, { max: 40 }), email: body.email ? emailV(body.email) : null }))
    if (body.checkIn) await q(`UPDATE registrations SET checked_in_at = NOW(), checked_in_by = $2 WHERE id = $1`, [reg.id, ctx.user.id])
    await audit(ctx, 'event.registration_added', 'event', e.id, { registrationId: reg.id })
    return reg
  })

  // Door check-in by registration id or ticket code.
  r.post('/events/:id/checkin', async ({ ctx, params, body }) => {
    requireCap(ctx, 'events.checkin')
    const e = await loadEvent(ctx, params.id)
    if (e.status === 'cancelled') throw bad('This event is cancelled.')
    const code = body.code ? String(body.code).trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12) : null
    const reg = body.registrationId
      ? await one(`SELECT * FROM registrations WHERE id = $1 AND event_id = $2`, [uuid(body.registrationId), e.id])
      : await one(`SELECT * FROM registrations WHERE code = $1 AND event_id = $2`, [code, e.id])
    if (!reg) throw notFound('No registration found with that code for this event.')
    if (reg.status === 'cancelled') throw bad(`${reg.name}'s registration was cancelled.`)
    if (body.undo) {
      await q(`UPDATE registrations SET checked_in_at = NULL, checked_in_by = NULL WHERE id = $1`, [reg.id])
      await audit(ctx, 'event.checkin_undone', 'event', e.id, { registrationId: reg.id })
      return { ok: true, registration: { ...reg, checked_in_at: null } }
    }
    if (reg.checked_in_at) return { ok: true, already: true, registration: reg }
    const upd = await one(`UPDATE registrations SET checked_in_at = NOW(), checked_in_by = $2,
                             status = CASE WHEN status = 'waitlist' THEN 'registered' ELSE status END WHERE id = $1 RETURNING *`, [reg.id, ctx.user.id])
    return { ok: true, registration: upd, wasWaitlisted: reg.status === 'waitlist' }
  })

  r.patch('/events/:id/registrations/:regId', async ({ ctx, params, body }) => {
    requireCap(ctx, 'events.manage')
    const e = await loadEvent(ctx, params.id)
    const reg = await one(`SELECT * FROM registrations WHERE id = $1 AND event_id = $2`, [uuid(params.regId), e.id])
    if (!reg) throw notFound()
    const status = oneOf(body.status, ['registered', 'waitlist', 'cancelled'], { name: 'Status' })
    let personId = reg.person_id
    if (body.personId !== undefined) {
      if (body.personId === null) personId = null
      else {
        const p = await one(`SELECT id FROM people WHERE id = $1 AND org_id = $2`, [uuid(body.personId), ctx.org.id])
        if (!p) throw notFound('Person not found.')
        personId = p.id
      }
    }
    const upd = await one(`UPDATE registrations SET status = COALESCE($2, status), person_id = $3 WHERE id = $1 RETURNING *`, [reg.id, status, personId])
    if (status === 'cancelled' && reg.status === 'registered' && e.capacity) await promoteWaitlist(e.id, e.capacity)
    await audit(ctx, 'event.registration_updated', 'event', e.id, { registrationId: reg.id, status, personId })
    return upd
  })

  r.get('/events/:id/export', async ({ ctx, params }) => {
    requireCap(ctx, 'events.view')
    requireCap(ctx, 'export')
    const e = await loadEvent(ctx, params.id)
    const rows = await q(`SELECT * FROM registrations WHERE event_id = $1 ORDER BY created_at`, [e.id])
    const extra = (e.form || []).filter(f => !f.core)
    await audit(ctx, 'event.exported', 'event', e.id, { count: rows.length })
    return csvResponse(toCsv(rows, [
      { label: 'Name', value: 'name' }, { label: 'Phone', value: 'phone' }, { label: 'Email', value: 'email' },
      { label: 'Status', value: 'status' }, { label: 'Ticket code', value: 'code' },
      { label: 'Registered at', value: r => new Date(r.created_at).toISOString() },
      { label: 'Checked in at', value: r => r.checked_in_at ? new Date(r.checked_in_at).toISOString() : '' },
      ...extra.map(f => ({ label: f.label, value: r => r.answers?.[f.id] ?? '' })),
    ]), `${e.name}-registrations.csv`)
  })
}

async function promoteWaitlist(eventId, capacity) {
  await tx(async (c) => {
    await c.one(`SELECT id FROM events WHERE id = $1 FOR UPDATE`, [eventId])
    const n = await c.one(`SELECT COUNT(*)::int AS n FROM registrations WHERE event_id = $1 AND status = 'registered'`, [eventId])
    const free = capacity - n.n
    if (free > 0) {
      await c.q(`UPDATE registrations SET status = 'registered' WHERE id IN (
                   SELECT id FROM registrations WHERE event_id = $1 AND status = 'waitlist' ORDER BY created_at LIMIT $2)`, [eventId, free])
    }
  })
}
