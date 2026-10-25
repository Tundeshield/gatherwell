import { fb, col, docOut, plain, F, toDate } from '../firebase.js'
import { bad, notFound, conflict, forbidden, str, oneOf, int, uuid, date, email as emailV } from '../http.js'
import { requireCap, branchFilter, assertBranch, assertRowScope, orgBranches } from '../access.js'
import { shortId, sanitizeForm, audit, normalizePhone, ticketCode } from '../util.js'
import { toCsv, csvResponse } from '../domain.js'

export const EVENT_STATUSES = ['draft', 'published', 'postponed', 'cancelled', 'completed']
const DEFAULT_EVENT_FORM = [
  { id: 'first_name', type: 'text', label: 'First name', required: true, core: true },
  { id: 'last_name', type: 'text', label: 'Last name', required: true, core: true },
  { id: 'phone', type: 'phone', label: 'Phone number', required: true, core: true },
  { id: 'email', type: 'email', label: 'Email', required: false, core: true },
]
const keyRef = (db, orgId, eventId, kind, value) => col(db, orgId, 'regKeys').doc(`${eventId}_${kind}_${String(value).replace(/[^A-Za-z0-9@._-]/g, '').slice(0, 120)}`)

async function loadEvent(ctx, id) {
  const { db } = await fb()
  const e = docOut(await col(db, ctx.org.id, 'events').doc(uuid(id, { required: true })).get())
  assertRowScope(ctx, e)
  const b = (await orgBranches(ctx)).find(x => x.id === e.branch_id)
  return { ...e, branch_name: b?.name || null }
}

export const eventStats = (e) => ({ registered: e.registered || 0, waitlist: e.waitlist || 0, cancelled: e.cancelled || 0, checked_in: e.checked_in || 0 })

// Shared by public registration and staff "add attendee". `event` must include id and org_id.
export async function createRegistration({ orgId, event, orgSettings, name, phone, email, answers = {} }) {
  const { db } = await fb()
  const phoneNorm = phone ? normalizePhone(phone, orgSettings?.defaultCountryCode) : null
  if (phone && !phoneNorm) throw bad("That phone number doesn't look valid.")
  const eRef = col(db, orgId, 'events').doc(event.id)
  const regRef = col(db, orgId, 'registrations').doc()
  const code = ticketCode()
  return db.runTransaction(async (tx) => {
    const refs = [eRef, keyRef(db, orgId, event.id, 'c', code)]
    if (phoneNorm) refs.push(keyRef(db, orgId, event.id, 'p', phoneNorm))
    if (email) refs.push(keyRef(db, orgId, event.id, 'e', email.toLowerCase()))
    const personRef = phoneNorm ? col(db, orgId, 'phones').doc(phoneNorm) : null
    const snaps = await tx.getAll(...refs, ...(personRef ? [personRef] : []))
    const [es, codeSnap, ...rest] = snaps
    const ev = es.data()
    if (!ev) throw notFound('Event not found.')
    let i = 0
    if (phoneNorm && rest[i++].exists) throw conflict('This phone number is already registered for this event.')
    if (email && rest[i++].exists) throw conflict('This email is already registered for this event.')
    if (codeSnap.exists) throw conflict('Please try again.')
    const personSnap = personRef ? rest[i] : null
    const status = ev.capacity && (ev.registered || 0) >= ev.capacity ? 'waitlist' : 'registered'
    const now = new Date()
    const data = { event_id: event.id, person_id: personSnap?.exists ? personSnap.data().person_id : null, name, email: email || null, phone: phone || null,
      phone_norm: phoneNorm, answers, status, code, checked_in_at: null, checked_in_by: null, created_at: now }
    tx.set(regRef, data)
    tx.set(keyRef(db, orgId, event.id, 'c', code), { event_id: event.id, registration_id: regRef.id })
    if (phoneNorm) tx.set(keyRef(db, orgId, event.id, 'p', phoneNorm), { event_id: event.id, registration_id: regRef.id })
    if (email) tx.set(keyRef(db, orgId, event.id, 'e', email.toLowerCase()), { event_id: event.id, registration_id: regRef.id })
    tx.update(eRef, status === 'registered' ? { registered: F.inc(1) } : { waitlist: F.inc(1) })
    return { id: regRef.id, ...plain(data) }
  })
}

async function promoteWaitlist(db, orgId, eventId) {
  const waiting = (await col(db, orgId, 'registrations').where('event_id', '==', eventId).where('status', '==', 'waitlist').get())
    .docs.sort((a, b) => toDate(a.data().created_at) - toDate(b.data().created_at))
  for (const w of waiting) {
    const promoted = await db.runTransaction(async (tx) => {
      const eRef = col(db, orgId, 'events').doc(eventId)
      const [es, ws] = await tx.getAll(eRef, w.ref)
      const ev = es.data()
      if (!ev || !ws.exists || ws.data().status !== 'waitlist') return true
      if (ev.capacity && (ev.registered || 0) >= ev.capacity) return false
      tx.update(w.ref, { status: 'registered' })
      tx.update(eRef, { registered: F.inc(1), waitlist: F.inc(-1) })
      return true
    })
    if (!promoted) break
  }
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

const regOut = (d) => { const r = plain(d.data()); return { id: d.id, name: r.name, email: r.email, phone: r.phone, status: r.status, code: r.code, checked_in_at: r.checked_in_at, created_at: r.created_at, answers: r.answers || {}, person_id: r.person_id } }

export default function (r) {
  r.get('/events', async ({ ctx, query }) => {
    requireCap(ctx, 'events.view')
    const { db } = await fb()
    const branches = await branchFilter(ctx, query.branch)
    const now = new Date()
    let q = col(db, ctx.org.id, 'events')
    if (query.when === 'upcoming') q = q.where('starts_at', '>=', new Date(now.getTime() - 3 * 86400e3)).orderBy('starts_at', 'asc')
    else if (query.when === 'past') q = q.where('starts_at', '<', now).orderBy('starts_at', 'desc')
    else q = q.orderBy('starts_at', 'desc')
    const names = new Map((await orgBranches(ctx)).map(b => [b.id, b.name]))
    const rows = (await q.limit(300).get()).docs.map(d => ({ id: d.id, ...plain(d.data()) }))
      .filter(e => !branches || !e.branch_id || branches.includes(e.branch_id))
      .filter(e => query.when !== 'upcoming' || new Date(e.ends_at || e.starts_at) >= now)
      .filter(e => query.when !== 'past' || new Date(e.ends_at || e.starts_at) < now)
      .filter(e => !query.status || e.status === query.status)
      .map(e => ({ id: e.id, name: e.name, location: e.location, starts_at: e.starts_at, ends_at: e.ends_at, status: e.status, capacity: e.capacity, branch_id: e.branch_id,
        public_token: e.public_token, registration_opens_at: e.registration_opens_at, registration_closes_at: e.registration_closes_at,
        branch_name: names.get(e.branch_id) || null, registered: e.registered || 0, checked_in: e.checked_in || 0 }))
    return { rows: rows.slice(0, 200) }
  })

  r.post('/events', async ({ ctx, body }) => {
    requireCap(ctx, 'events.manage')
    const { db } = await fb()
    const d = eventInput(body)
    let branchId = null
    if (body.branchId) branchId = (await assertBranch(ctx, body.branchId)).id
    else if (ctx.branchScope) throw forbidden('Choose one of your branches for this event.')
    const ref = col(db, ctx.org.id, 'events').doc()
    const token = shortId(10)
    const data = {
      branch_id: branchId, name: d.name, description: d.description, location: d.location, starts_at: new Date(d.startsAt), ends_at: d.endsAt ? new Date(d.endsAt) : null,
      registration_opens_at: d.opens ? new Date(d.opens) : null, registration_closes_at: d.closes ? new Date(d.closes) : null, capacity: d.capacity,
      status: d.status || 'published', public_token: token, form: sanitizeForm(body.form?.length ? body.form : DEFAULT_EVENT_FORM),
      registered: 0, waitlist: 0, cancelled: 0, checked_in: 0, created_by: ctx.user.id, created_at: new Date(), updated_at: new Date(),
    }
    const b = db.batch()
    b.set(ref, data)
    b.create(db.collection('publicLinks').doc(token), { kind: 'event', org_id: ctx.org.id, ref_id: ref.id })
    await b.commit()
    await audit(ctx, 'event.created', 'event', ref.id, { name: data.name })
    return { id: ref.id, ...plain(data) }
  })

  r.get('/events/:id', async ({ ctx, params }) => {
    requireCap(ctx, 'events.view')
    const e = await loadEvent(ctx, params.id)
    return { event: e, stats: { ...eventStats(e), followups: 0 } }
  })

  r.patch('/events/:id', async ({ ctx, params, body }) => {
    requireCap(ctx, 'events.manage')
    const { db } = await fb()
    const e = await loadEvent(ctx, params.id)
    const d = eventInput(body, true)
    const patch = { updated_at: new Date() }
    if (d.name) patch.name = d.name
    if (body.description !== undefined) patch.description = d.description
    if (body.location !== undefined) patch.location = d.location
    if (d.startsAt) patch.starts_at = new Date(d.startsAt)
    if (body.endsAt !== undefined) patch.ends_at = d.endsAt ? new Date(d.endsAt) : null
    if (body.registrationOpensAt !== undefined) patch.registration_opens_at = d.opens ? new Date(d.opens) : null
    if (body.registrationClosesAt !== undefined) patch.registration_closes_at = d.closes ? new Date(d.closes) : null
    if (body.capacity !== undefined) patch.capacity = d.capacity
    if (d.status) patch.status = d.status
    if (body.form) patch.form = sanitizeForm(body.form)
    if (body.branchId !== undefined) {
      if (body.branchId) patch.branch_id = (await assertBranch(ctx, body.branchId)).id
      else if (ctx.branchScope) throw forbidden()
      else patch.branch_id = null
    }
    const ref = col(db, ctx.org.id, 'events').doc(e.id)
    await ref.update(patch)
    if (d.status && d.status !== e.status) await audit(ctx, `event.${d.status}`, 'event', e.id, { name: e.name })
    // Capacity increased (or removed): promote from the waitlist in sign-up order.
    if (body.capacity !== undefined && (!patch.capacity || !e.capacity || patch.capacity > e.capacity)) await promoteWaitlist(db, ctx.org.id, e.id)
    return { ...docOut(await ref.get()), branch_name: e.branch_name }
  })

  r.delete('/events/:id', async ({ ctx, params, query }) => {
    requireCap(ctx, 'events.manage')
    const { db } = await fb()
    const e = await loadEvent(ctx, params.id)
    const s = eventStats(e)
    if (s.registered + s.waitlist > 0 && query.confirm !== 'delete') throw conflict(`This event has ${s.registered + s.waitlist} registrations. Cancel it instead, or confirm deletion.`)
    const [regs, keys] = await Promise.all([col(db, ctx.org.id, 'registrations').where('event_id', '==', e.id).get(), col(db, ctx.org.id, 'regKeys').where('event_id', '==', e.id).get()])
    const refs = [...regs.docs.map(d => d.ref), ...keys.docs.map(d => d.ref), col(db, ctx.org.id, 'events').doc(e.id), db.collection('publicLinks').doc(e.public_token)]
    for (let i = 0; i < refs.length; i += 400) { const b = db.batch(); refs.slice(i, i + 400).forEach(x => b.delete(x)); await b.commit() }
    await audit(ctx, 'event.deleted', 'event', e.id, { name: e.name })
    return { ok: true }
  })

  r.get('/events/:id/registrations', async ({ ctx, params, query }) => {
    requireCap(ctx, 'events.view')
    const { db } = await fb()
    const e = await loadEvent(ctx, params.id)
    let rows = (await col(db, ctx.org.id, 'registrations').where('event_id', '==', e.id).get()).docs.map(regOut)
    if (query.q) { const t = String(query.q).toLowerCase().slice(0, 80); rows = rows.filter(r => [r.name, r.phone, r.email, r.code].some(v => String(v || '').toLowerCase().includes(t))) }
    if (query.status === 'checked_in') rows = rows.filter(r => r.checked_in_at)
    else if (['registered', 'waitlist', 'cancelled'].includes(query.status)) rows = rows.filter(r => r.status === query.status)
    rows.sort((a, b) => b.created_at.localeCompare(a.created_at))
    return { rows: rows.slice(0, 5000) }
  })

  r.post('/events/:id/registrations', async ({ ctx, params, body }) => {
    requireCap(ctx, 'events.checkin')
    const { db } = await fb()
    const e = await loadEvent(ctx, params.id)
    if (e.status === 'cancelled') throw bad('This event is cancelled.')
    const name = [str(body.firstName, { required: true, max: 80, name: 'First name' }), str(body.lastName, { max: 80 })].filter(Boolean).join(' ')
    const reg = await createRegistration({ orgId: ctx.org.id, event: e, orgSettings: ctx.org.settings, name, phone: str(body.phone, { max: 40 }), email: body.email ? emailV(body.email) : null })
    if (body.checkIn) await checkInRegistration(db, ctx, e, reg.id, false)
    await audit(ctx, 'event.registration_added', 'event', e.id, { registrationId: reg.id, name: e.name })
    return reg
  })

  // Door check-in by registration id or ticket code.
  r.post('/events/:id/checkin', async ({ ctx, params, body }) => {
    requireCap(ctx, 'events.checkin')
    const { db } = await fb()
    const e = await loadEvent(ctx, params.id)
    if (e.status === 'cancelled') throw bad('This event is cancelled.')
    let regId = body.registrationId ? uuid(body.registrationId) : null
    if (!regId) {
      const code = String(body.code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12)
      const k = code ? await keyRef(db, ctx.org.id, e.id, 'c', code).get() : null
      if (!k?.exists) throw notFound('No registration found with that code for this event.')
      regId = k.data().registration_id
    }
    return checkInRegistration(db, ctx, e, regId, !!body.undo)
  })

  r.patch('/events/:id/registrations/:regId', async ({ ctx, params, body }) => {
    requireCap(ctx, 'events.manage')
    const { db } = await fb()
    const e = await loadEvent(ctx, params.id)
    const regRef = col(db, ctx.org.id, 'registrations').doc(uuid(params.regId))
    const status = oneOf(body.status, ['registered', 'waitlist', 'cancelled'], { name: 'Status' })
    let personId
    if (body.personId !== undefined) {
      if (body.personId === null) personId = null
      else { const p = await col(db, ctx.org.id, 'people').doc(uuid(body.personId)).get(); if (!p.exists) throw notFound('Person not found.'); personId = p.id }
    }
    const before = await db.runTransaction(async (tx) => {
      const eRef = col(db, ctx.org.id, 'events').doc(e.id)
      const rs = await tx.get(regRef)
      const reg = rs.data()
      if (!reg || reg.event_id !== e.id) throw notFound()
      const patch = {}
      if (personId !== undefined) patch.person_id = personId
      if (status && status !== reg.status) {
        patch.status = status
        const delta = { registered: 0, waitlist: 0, cancelled: 0 }
        delta[reg.status]--; delta[status]++
        tx.update(eRef, Object.fromEntries(Object.entries(delta).filter(([, v]) => v).map(([k, v]) => [k, F.inc(v)])))
        // A cancelled registration frees the phone/email so they can register again.
        if (status === 'cancelled') {
          if (reg.phone_norm) tx.delete(keyRef(db, ctx.org.id, e.id, 'p', reg.phone_norm))
          if (reg.email) tx.delete(keyRef(db, ctx.org.id, e.id, 'e', reg.email.toLowerCase()))
        }
      }
      if (Object.keys(patch).length) tx.update(regRef, patch)
      return reg
    })
    if (status === 'cancelled' && before.status === 'registered' && e.capacity) await promoteWaitlist(db, ctx.org.id, e.id)
    await audit(ctx, 'event.registration_updated', 'event', e.id, { registrationId: regRef.id, status, name: e.name })
    return regOut(await regRef.get())
  })

  r.get('/events/:id/export', async ({ ctx, params }) => {
    requireCap(ctx, 'events.view')
    requireCap(ctx, 'export')
    const { db } = await fb()
    const e = await loadEvent(ctx, params.id)
    const rows = (await col(db, ctx.org.id, 'registrations').where('event_id', '==', e.id).get()).docs.map(regOut).sort((a, b) => a.created_at.localeCompare(b.created_at))
    const extra = (e.form || []).filter(f => !f.core)
    await audit(ctx, 'event.exported', 'event', e.id, { count: rows.length, name: e.name })
    return csvResponse(toCsv(rows, [
      { label: 'Name', value: 'name' }, { label: 'Phone', value: 'phone' }, { label: 'Email', value: 'email' },
      { label: 'Status', value: 'status' }, { label: 'Ticket code', value: 'code' },
      { label: 'Registered at', value: 'created_at' }, { label: 'Checked in at', value: r => r.checked_in_at || '' },
      ...extra.map(f => ({ label: f.label, value: r => r.answers?.[f.id] ?? '' })),
    ]), `${e.name}-registrations.csv`)
  })
}

async function checkInRegistration(db, ctx, e, regId, undo) {
  const regRef = col(db, ctx.org.id, 'registrations').doc(regId)
  const eRef = col(db, ctx.org.id, 'events').doc(e.id)
  return db.runTransaction(async (tx) => {
    const rs = await tx.get(regRef)
    const reg = rs.data()
    if (!reg || reg.event_id !== e.id) throw notFound('No registration found with that code for this event.')
    if (reg.status === 'cancelled') throw bad(`${reg.name}'s registration was cancelled.`)
    if (undo) {
      if (reg.checked_in_at) { tx.update(regRef, { checked_in_at: null, checked_in_by: null }); tx.update(eRef, { checked_in: F.inc(-1) }) }
      return { ok: true, registration: { id: regId, ...plain(reg), checked_in_at: null } }
    }
    if (reg.checked_in_at) return { ok: true, already: true, registration: { id: regId, ...plain(reg) } }
    const now = new Date()
    const patch = { checked_in_at: now, checked_in_by: ctx.user.id }
    const ev = { checked_in: F.inc(1) }
    if (reg.status === 'waitlist') { patch.status = 'registered'; ev.waitlist = F.inc(-1); ev.registered = F.inc(1) }
    tx.update(regRef, patch)
    tx.update(eRef, ev)
    return { ok: true, registration: { id: regId, ...plain({ ...reg, ...patch }) }, wasWaitlisted: reg.status === 'waitlist' }
  })
}
