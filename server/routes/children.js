// Children's church: classes (rooms), children linked to their parents, safe check-in with
// matching pickup codes, and pickup. Switched off unless the church turns it on (org.features.children).
// Children are kept apart from the people directory and from adult attendance numbers.
// Allergies and medical notes are only returned to people with children.view (the children's team and admins).
import crypto from 'node:crypto'
import { fb, col, plain } from '../firebase.js'
import { bad, notFound, forbidden, conflict, str, int } from '../http.js'
import { requireCap, orgBranches } from '../access.js'
import { audit, normalizePhone, displayPhone, tzOffsetMs } from '../util.js'
import { createPerson } from './people.js'
import { createAutoFollowup } from '../domain.js'

const DAY = 86400e3
export const childrenEnabled = (org) => !!org?.features?.children

export const DEFAULT_ROOMS = [
  { name: 'Crèche (0–1)', min_age: 0, max_age: 1, capacity: 8, ratio: 3 },
  { name: 'Toddlers (2–4)', min_age: 2, max_age: 4, capacity: 12, ratio: 4 },
  { name: 'Explorers (5–7)', min_age: 5, max_age: 7, capacity: 20, ratio: 8 },
  { name: 'Juniors (8–12)', min_age: 8, max_age: 12, capacity: 25, ratio: 10 },
]

// Letters and digits that can't be confused when read aloud or handwritten (no 0/O, 1/I/L, 5/S, 2/Z, 8/B),
// and no vowels, so a code can never spell a word.
const CODE_CHARS = 'CDFGHJKMNPQRTVWXY34679'
const newCode = () => Array.from(crypto.randomBytes(3), b => CODE_CHARS[b % CODE_CHARS.length]).join('')

export function dayKey(tz, date = new Date()) {
  return new Date(date.getTime() + tzOffsetMs(tz || 'Africa/Lagos', date)).toISOString().slice(0, 10)
}

export function ageOn(birth, day) {
  if (!birth || !/^\d{4}-\d{2}-\d{2}$/.test(birth)) return null
  const [by, bm, bd] = birth.split('-').map(Number)
  const [y, m, d] = day.split('-').map(Number)
  let a = y - by
  if (m < bm || (m === bm && d < bd)) a--
  return a >= 0 ? a : null
}

// The class a child goes to: the one chosen for them, else the one for their age, else the nearest by age.
export function roomFor(child, rooms, day) {
  if (child.room_id) { const r = rooms.find(x => x.id === child.room_id); if (r) return r }
  if (!rooms.length) return null
  const age = ageOn(child.birth_date, day)
  if (age == null) return null
  const exact = rooms.find(r => age >= r.min_age && age <= r.max_age)
  if (exact) return exact
  return [...rooms].sort((a, b) => Math.min(Math.abs(age - a.min_age), Math.abs(age - a.max_age)) - Math.min(Math.abs(age - b.min_age), Math.abs(age - b.max_age)))[0]
}

const childName = (c) => [c.first_name, c.last_name].filter(Boolean).join(' ')
const personName = (p) => [p.first_name, p.last_name].filter(Boolean).join(' ')

function requireOn(ctx) {
  if (!childrenEnabled(ctx.org)) throw forbidden('Children’s church is switched off for this church. An owner can switch it on in Settings › Children.')
}

async function loadRooms(db, orgId) {
  const qs = await col(db, orgId, 'kidsRooms').get()
  return qs.docs.map(d => ({ id: d.id, ...d.data() })).filter(r => !r.archived).sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.min_age - b.min_age)
}

async function loadChildren(db, orgId) {
  const qs = await col(db, orgId, 'children').get()
  return qs.docs.map(d => ({ id: d.id, ...d.data() })).filter(c => c.status !== 'archived')
}

function roomOut(r) {
  return { id: r.id, name: r.name, minAge: r.min_age, maxAge: r.max_age, capacity: r.capacity || null, ratio: r.ratio || null, location: r.location || null }
}

function childOut(c, { rooms, day, guardians = new Map() }) {
  const room = roomFor(c, rooms, day)
  return {
    id: c.id, firstName: c.first_name, lastName: c.last_name || null, name: childName(c), birthDate: c.birth_date || null, age: ageOn(c.birth_date, day),
    roomId: c.room_id || null, room: room ? { id: room.id, name: room.name } : null,
    allergies: c.allergies || null, medical: c.medical || null, pickupNotes: c.pickup_notes || null, notes: c.notes || null,
    guardians: (c.guardian_ids || []).map(id => guardians.get(id)).filter(Boolean),
    lastCheckinAt: plain(c.last_checkin_at) || null, firstCheckinAt: plain(c.first_checkin_at) || null, createdAt: plain(c.created_at) || null,
  }
}

async function guardianMap(db, orgId, ids, cc) {
  const uniq = [...new Set(ids.filter(Boolean))]
  if (!uniq.length) return new Map()
  const snaps = await db.getAll(...uniq.map(id => col(db, orgId, 'people').doc(id)))
  return new Map(snaps.filter(s => s.exists).map(s => { const p = s.data(); return [s.id, { id: s.id, name: personName(p), firstName: p.first_name, phone: p.phone_norm ? displayPhone(p.phone_norm, cc) : (p.phone || null), phoneNorm: p.phone_norm || null }] }))
}

async function cleanGuardians(db, ctx, ids) {
  if (!Array.isArray(ids)) return undefined
  const uniq = [...new Set(ids.map(String))].slice(0, 6)
  if (!uniq.length) return []
  const snaps = await db.getAll(...uniq.map(id => col(db, ctx.org.id, 'people').doc(id.slice(0, 64))))
  if (snaps.some(s => !s.exists)) throw bad('One of the parents was not found.')
  return snaps.map(s => s.id)
}

function childFields(body, rooms, { partial = false } = {}) {
  const out = {}
  const has = (k) => body[k] !== undefined
  if (!partial || has('firstName')) out.first_name = str(body.firstName, { required: true, max: 80, name: 'First name' })
  if (!partial || has('lastName')) out.last_name = str(body.lastName, { max: 80 }) || null
  if (!partial || has('birthDate')) {
    const b = body.birthDate ? String(body.birthDate).slice(0, 10) : null
    if (b && (!/^\d{4}-\d{2}-\d{2}$/.test(b) || isNaN(new Date(b)) || new Date(b) > new Date())) throw bad('Please check the highlighted fields.', { fields: { birthDate: 'Enter a valid date of birth.' } })
    out.birth_date = b
  }
  if (!partial || has('roomId')) {
    const rid = body.roomId ? String(body.roomId) : null
    if (rid && !rooms.some(r => r.id === rid)) throw bad('That class was not found.')
    out.room_id = rid
  }
  for (const [k, f, max] of [['allergies', 'allergies', 300], ['medical', 'medical', 1000], ['pickupNotes', 'pickup_notes', 300], ['notes', 'notes', 1000]]) {
    if (!partial || has(k)) out[f] = str(body[k], { max }) || null
  }
  return out
}

// Today's check-ins for a church, newest first.
async function checkinsFor(db, orgId, day) {
  const qs = await col(db, orgId, 'kidsCheckins').where('day', '==', day).get()
  return qs.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => +new Date(plain(b.checked_in_at)) - +new Date(plain(a.checked_in_at)))
}

const checkinOut = (k) => ({
  id: k.id, childId: k.child_id, childName: k.child_name, firstName: k.first_name, lastName: k.last_name || null, roomId: k.room_id, roomName: k.room_name, code: k.code,
  guardianId: k.guardian_id, guardianName: k.guardian_name, guardianPhone: k.guardian_phone || null, alert: k.alert || null, medical: k.medical || null, firstTime: !!k.first_time,
  checkedInAt: plain(k.checked_in_at), checkedInBy: k.checked_in_by || null, pickedUpAt: plain(k.picked_up_at) || null, pickedUpBy: k.picked_up_by || null, day: k.day,
})

function roomStats(rooms, checkins, staff) {
  return rooms.map(r => {
    const here = checkins.filter(k => k.room_id === r.id && !k.picked_up_at).length
    const adults = Number(staff?.[r.id] || 0)
    const needed = r.ratio ? Math.ceil(here / r.ratio) : 0
    return { ...roomOut(r), here, total: checkins.filter(k => k.room_id === r.id).length, pickedUp: checkins.filter(k => k.room_id === r.id && k.picked_up_at).length, adults, adultsNeeded: needed, short: Math.max(0, needed - adults), full: !!r.capacity && here >= r.capacity }
  })
}

export async function seedRooms(db, orgId) {
  const existing = await col(db, orgId, 'kidsRooms').limit(1).get()
  if (!existing.empty) return
  const b = db.batch()
  DEFAULT_ROOMS.forEach((r, i) => b.set(col(db, orgId, 'kidsRooms').doc(), { ...r, order: i, created_at: new Date() }))
  await b.commit()
}

export default function (r) {
  // --- settings --------------------------------------------------------------------
  r.patch('/children/settings', async ({ ctx, body }) => {
    const { db } = await fb()
    const ref = db.collection('orgs').doc(ctx.org.id)
    const patch = {}
    if (body.enabled !== undefined) {
      requireCap(ctx, 'org.manage')
      patch.features = { ...(ctx.org.features || {}), children: body.enabled === true }
      if (body.enabled === true) await seedRooms(db, ctx.org.id)
    }
    if (body.labels !== undefined) {
      requireCap(ctx, 'children.manage')
      patch.settings = { ...(ctx.org.settings || {}), kidsLabels: body.labels === 'none' ? 'none' : 'print' }
    }
    if (!Object.keys(patch).length) throw bad('Nothing to change.')
    await ref.update({ ...patch, updated_at: new Date() })
    if (body.enabled !== undefined) await audit(ctx, body.enabled ? 'children.enabled' : 'children.disabled', 'organisation', ctx.org.id)
    return { enabled: patch.features ? patch.features.children : childrenEnabled(ctx.org) }
  })

  // --- classes ---------------------------------------------------------------------
  r.get('/children/rooms', async ({ ctx }) => {
    requireCap(ctx, 'children.view'); requireOn(ctx)
    const { db } = await fb()
    return { rooms: (await loadRooms(db, ctx.org.id)).map(roomOut) }
  })

  const roomBody = (body, partial) => {
    const out = {}
    if (!partial || body.name !== undefined) out.name = str(body.name, { required: true, max: 60, name: 'Class name' })
    if (!partial || body.minAge !== undefined) out.min_age = int(body.minAge, { min: 0, max: 18, name: 'Youngest age' }) ?? 0
    if (!partial || body.maxAge !== undefined) out.max_age = int(body.maxAge, { min: 0, max: 18, name: 'Oldest age' }) ?? 12
    if (!partial || body.capacity !== undefined) out.capacity = body.capacity ? int(body.capacity, { min: 1, max: 500, name: 'Places' }) : null
    if (!partial || body.ratio !== undefined) out.ratio = body.ratio ? int(body.ratio, { min: 1, max: 50, name: 'Children per adult' }) : null
    if (!partial || body.location !== undefined) out.location = str(body.location, { max: 60 }) || null
    if (out.min_age != null && out.max_age != null && out.min_age > out.max_age) throw bad('The youngest age must be less than the oldest.')
    return out
  }
  r.post('/children/rooms', async ({ ctx, body }) => {
    requireCap(ctx, 'children.manage'); requireOn(ctx)
    const { db } = await fb()
    const rooms = await loadRooms(db, ctx.org.id)
    if (rooms.length >= 30) throw bad('You can have up to 30 classes.')
    const ref = col(db, ctx.org.id, 'kidsRooms').doc()
    const doc = { ...roomBody(body, false), order: rooms.length, created_at: new Date() }
    await ref.set(doc)
    return roomOut({ id: ref.id, ...doc })
  })
  r.patch('/children/rooms/:id', async ({ ctx, params, body }) => {
    requireCap(ctx, 'children.manage'); requireOn(ctx)
    const { db } = await fb()
    const ref = col(db, ctx.org.id, 'kidsRooms').doc(String(params.id).slice(0, 64))
    const s = await ref.get()
    if (!s.exists) throw notFound()
    const patch = roomBody({ ...body }, true)
    const merged = { ...s.data(), ...patch }
    if (merged.min_age > merged.max_age) throw bad('The youngest age must be less than the oldest.')
    await ref.update({ ...patch, updated_at: new Date() })
    return roomOut({ id: s.id, ...merged })
  })
  r.delete('/children/rooms/:id', async ({ ctx, params }) => {
    requireCap(ctx, 'children.manage'); requireOn(ctx)
    const { db } = await fb()
    const ref = col(db, ctx.org.id, 'kidsRooms').doc(String(params.id).slice(0, 64))
    if (!(await ref.get()).exists) throw notFound()
    // Kept for past check-ins; children placed here by hand go back to their age group.
    await ref.update({ archived: true, updated_at: new Date() })
    const placed = await col(db, ctx.org.id, 'children').where('room_id', '==', ref.id).get()
    for (const c of placed.docs) await c.ref.update({ room_id: null })
    return { ok: true }
  })

  // --- children --------------------------------------------------------------------
  r.get('/children', async ({ ctx }) => {
    requireCap(ctx, 'children.view'); requireOn(ctx)
    const { db } = await fb()
    const day = dayKey(ctx.org.timezone)
    const [rooms, kids] = await Promise.all([loadRooms(db, ctx.org.id), loadChildren(db, ctx.org.id)])
    const guardians = await guardianMap(db, ctx.org.id, kids.flatMap(c => c.guardian_ids || []), ctx.org.settings?.defaultCountryCode)
    return { rows: kids.map(c => childOut(c, { rooms, day, guardians })).sort((a, b) => a.name.localeCompare(b.name)), rooms: rooms.map(roomOut) }
  })

  r.get('/children/family/:personId', async ({ ctx, params }) => {
    requireCap(ctx, 'children.view'); requireOn(ctx)
    const { db } = await fb()
    const pid = String(params.personId).slice(0, 64)
    const day = dayKey(ctx.org.timezone)
    const [rooms, qs] = await Promise.all([loadRooms(db, ctx.org.id), col(db, ctx.org.id, 'children').where('guardian_ids', 'array-contains', pid).get()])
    const kids = qs.docs.map(d => ({ id: d.id, ...d.data() })).filter(c => c.status !== 'archived')
    const guardians = await guardianMap(db, ctx.org.id, [pid, ...kids.flatMap(c => c.guardian_ids || [])], ctx.org.settings?.defaultCountryCode)
    const recent = await Promise.all(kids.map(async c => {
      const ks = await col(db, ctx.org.id, 'kidsCheckins').where('child_id', '==', c.id).get()
      return [c.id, ks.docs.map(d => d.data().day)]
    }))
    const days = new Map(recent)
    return {
      children: kids.map(c => ({ ...childOut(c, { rooms, day, guardians }), days: [...new Set(days.get(c.id) || [])].sort().slice(-12) })),
      adults: [...guardians.values()],
      rooms: rooms.map(roomOut),
    }
  })

  r.post('/children', async ({ ctx, body }) => {
    requireCap(ctx, 'children.edit'); requireOn(ctx)
    const { db } = await fb()
    const rooms = await loadRooms(db, ctx.org.id)
    const fields = childFields(body, rooms)
    const guardian_ids = (await cleanGuardians(db, ctx, body.guardianIds || [])) || []
    const ref = col(db, ctx.org.id, 'children').doc()
    const doc = { ...fields, guardian_ids, status: 'active', created_at: new Date(), updated_at: new Date(), created_by: ctx.user.id, last_checkin_at: null, first_checkin_at: null }
    await ref.set(doc)
    await audit(ctx, 'child.created', 'child', ref.id)
    const guardians = await guardianMap(db, ctx.org.id, guardian_ids, ctx.org.settings?.defaultCountryCode)
    return childOut({ id: ref.id, ...doc }, { rooms, day: dayKey(ctx.org.timezone), guardians })
  })

  r.patch('/children/:id', async ({ ctx, params, body }) => {
    requireCap(ctx, 'children.edit'); requireOn(ctx)
    const { db } = await fb()
    const ref = col(db, ctx.org.id, 'children').doc(String(params.id).slice(0, 64))
    const s = await ref.get()
    if (!s.exists) throw notFound()
    const rooms = await loadRooms(db, ctx.org.id)
    const patch = childFields(body, rooms, { partial: true })
    if (body.guardianIds !== undefined) patch.guardian_ids = await cleanGuardians(db, ctx, body.guardianIds)
    await ref.update({ ...patch, updated_at: new Date() })
    await audit(ctx, 'child.updated', 'child', s.id)
    const doc = { ...s.data(), ...patch }
    const guardians = await guardianMap(db, ctx.org.id, doc.guardian_ids || [], ctx.org.settings?.defaultCountryCode)
    return childOut({ id: s.id, ...doc }, { rooms, day: dayKey(ctx.org.timezone), guardians })
  })

  // Erases a child and their check-in history.
  r.delete('/children/:id', async ({ ctx, params }) => {
    requireCap(ctx, 'children.manage'); requireOn(ctx)
    const { db } = await fb()
    const ref = col(db, ctx.org.id, 'children').doc(String(params.id).slice(0, 64))
    if (!(await ref.get()).exists) throw notFound()
    const ks = await col(db, ctx.org.id, 'kidsCheckins').where('child_id', '==', ref.id).get()
    const refs = [...ks.docs.map(d => d.ref), ref]
    for (let i = 0; i < refs.length; i += 400) { const b = db.batch(); refs.slice(i, i + 400).forEach(x => b.delete(x)); await b.commit() }
    await audit(ctx, 'child.deleted', 'child', ref.id)
    return { ok: true }
  })

  // --- check-in --------------------------------------------------------------------
  // A parent's phone number → the family's children, ready to tick.
  r.post('/children/lookup', async ({ ctx, body }) => {
    requireCap(ctx, 'children.checkin'); requireOn(ctx)
    const { db } = await fb()
    const cc = ctx.org.settings?.defaultCountryCode
    const phoneNorm = normalizePhone(body.phone, cc)
    if (!phoneNorm) throw bad('Please enter a valid phone number.')
    const ph = (await col(db, ctx.org.id, 'phones').doc(phoneNorm).get()).data()
    if (!ph) return { found: false }
    return familyForCheckin(db, ctx, ph.person_id)
  })

  r.get('/children/checkin-family/:personId', async ({ ctx, params }) => {
    requireCap(ctx, 'children.checkin'); requireOn(ctx)
    const { db } = await fb()
    return familyForCheckin(db, ctx, String(params.personId).slice(0, 64))
  })

  // A new family at the desk: the parent (found by phone, or added) and their children.
  r.post('/children/register', async ({ ctx, body }) => {
    requireCap(ctx, 'children.checkin'); requireOn(ctx)
    const { db } = await fb()
    const cc = ctx.org.settings?.defaultCountryCode
    const parent = body.parent || {}
    const phoneNorm = normalizePhone(parent.phone, cc)
    if (!phoneNorm) throw bad('Please check the highlighted fields.', { fields: { phone: 'Enter a valid phone number.' } })
    const kidsIn = (Array.isArray(body.children) ? body.children : []).slice(0, 10)
    if (!kidsIn.length) throw bad('Add at least one child.')
    const rooms = await loadRooms(db, ctx.org.id)
    const kidFields = kidsIn.map(k => childFields(k, rooms))
    let personId = (await col(db, ctx.org.id, 'phones').doc(phoneNorm).get()).data()?.person_id || null
    if (!personId) {
      const branches = await orgBranches(ctx)
      const branchId = ctx.branchScope?.[0] || branches[0]?.id || null
      const p = await createPerson(ctx, {
        first_name: str(parent.firstName, { required: true, max: 80, name: 'Parent’s first name' }), last_name: str(parent.lastName, { max: 80 }),
        phone: displayPhone(phoneNorm, cc), phone_norm: phoneNorm, status: 'visitor',
      }, { branch_id: branchId, source: 'children' })
      personId = p.id
    }
    const b = db.batch()
    for (const f of kidFields) b.set(col(db, ctx.org.id, 'children').doc(), { ...f, guardian_ids: [personId], status: 'active', created_at: new Date(), updated_at: new Date(), created_by: ctx.user.id, last_checkin_at: null, first_checkin_at: null })
    await b.commit()
    await audit(ctx, 'child.family_registered', 'person', personId, { children: kidFields.length })
    return familyForCheckin(db, ctx, personId)
  })

  r.post('/children/checkin', async ({ ctx, body }) => {
    requireCap(ctx, 'children.checkin'); requireOn(ctx)
    const { db } = await fb()
    const day = dayKey(ctx.org.timezone)
    const guardianId = String(body.guardianId || '').slice(0, 64)
    const gs = await col(db, ctx.org.id, 'people').doc(guardianId).get()
    if (!gs.exists) throw bad('Parent not found.')
    const g = gs.data()
    const ids = [...new Set((Array.isArray(body.childIds) ? body.childIds : []).map(String))].slice(0, 12)
    if (!ids.length) throw bad('Choose at least one child.')
    const rooms = await loadRooms(db, ctx.org.id)
    const roomOverride = body.rooms && typeof body.rooms === 'object' ? body.rooms : {}
    const snaps = await db.getAll(...ids.map(id => col(db, ctx.org.id, 'children').doc(id.slice(0, 64))))
    if (snaps.some(s => !s.exists || s.data().status === 'archived')) throw bad('One of the children was not found.')
    const kids = snaps.map(s => ({ id: s.id, ...s.data() }))
    if (kids.some(c => !(c.guardian_ids || []).includes(guardianId))) throw bad('These children aren’t linked to this parent.')
    const today = await checkinsFor(db, ctx.org.id, day)
    const active = today.filter(k => !k.picked_up_at)
    // One code per family per day: siblings and later check-ins reuse it.
    const family = active.find(k => k.guardian_id === guardianId)
    let code = family?.code
    const dayRef = col(db, ctx.org.id, 'kidsDays').doc(day)
    if (!code) {
      code = await db.runTransaction(async (tx) => {
        const d = (await tx.get(dayRef)).data() || {}
        const used = new Set(Object.keys(d.codes || {}))
        let c = newCode()
        for (let i = 0; i < 50 && used.has(c); i++) c = newCode()
        tx.set(dayRef, { codes: { ...(d.codes || {}), [c]: guardianId }, updated_at: new Date() }, { merge: true })
        return c
      })
    }
    const cc = ctx.org.settings?.defaultCountryCode
    const now = new Date()
    const out = []
    for (const c of kids) {
      const already = active.find(k => k.child_id === c.id)
      if (already) { out.push({ ...checkinOut(already), alreadyCheckedIn: true }); continue }
      const room = (roomOverride[c.id] && rooms.find(r => r.id === roomOverride[c.id])) || roomFor(c, rooms, day)
      if (!room) throw bad(`Choose a class for ${c.first_name}.`, { code: 'room_required', childId: c.id })
      const firstTime = !c.first_checkin_at
      const doc = {
        day, child_id: c.id, child_name: childName(c), first_name: c.first_name, last_name: c.last_name || null, room_id: room.id, room_name: room.name, code,
        guardian_id: guardianId, guardian_name: personName(g), guardian_phone: g.phone_norm ? displayPhone(g.phone_norm, cc) : (g.phone || null),
        alert: c.allergies || null, medical: c.medical || null, first_time: firstTime,
        checked_in_at: now, checked_in_by: ctx.user.name || null, picked_up_at: null, picked_up_by: null,
      }
      const ref = col(db, ctx.org.id, 'kidsCheckins').doc()
      await ref.set(doc)
      await col(db, ctx.org.id, 'children').doc(c.id).update({ last_checkin_at: now, ...(firstTime ? { first_checkin_at: now } : {}) })
      if (firstTime) {
        await createAutoFollowup({ orgId: ctx.org.id, personId: guardianId, reason: 'first_visit', title: `Welcome ${g.first_name}: ${c.first_name} came to children’s church for the first time` }).catch(() => null)
      }
      out.push({ ...checkinOut({ id: ref.id, ...doc }), alreadyCheckedIn: false })
    }
    await audit(ctx, 'child.checked_in', 'person', guardianId, { children: out.length })
    return { code, guardianName: personName(g), checkins: out, labels: ctx.org.settings?.kidsLabels !== 'none', orgName: ctx.org.name, day }
  })

  // --- today, rooms and pickup -----------------------------------------------------
  r.get('/children/today', async ({ ctx }) => {
    requireCap(ctx, 'children.view'); requireOn(ctx)
    const { db } = await fb()
    const day = dayKey(ctx.org.timezone)
    const [rooms, today, dayDoc, kids] = await Promise.all([
      loadRooms(db, ctx.org.id), checkinsFor(db, ctx.org.id, day), col(db, ctx.org.id, 'kidsDays').doc(day).get(), loadChildren(db, ctx.org.id),
    ])
    const staff = dayDoc.data()?.staff || {}
    // Last time children's church met before today, for comparison.
    const prevQs = await col(db, ctx.org.id, 'kidsCheckins').where('day', '<', day).orderBy('day', 'desc').limit(400).get()
    const prevDay = prevQs.docs[0]?.data().day || null
    const prevCount = prevDay ? prevQs.docs.filter(d => d.data().day === prevDay).length : null
    const now = Date.now()
    const missing = kids.filter(c => c.last_checkin_at && now - +new Date(plain(c.last_checkin_at)) >= 21 * DAY && now - +new Date(plain(c.last_checkin_at)) < 120 * DAY)
      .sort((a, b) => +new Date(plain(b.last_checkin_at)) - +new Date(plain(a.last_checkin_at))).slice(0, 25)
    const guardians = await guardianMap(db, ctx.org.id, missing.flatMap(c => (c.guardian_ids || []).slice(0, 1)), ctx.org.settings?.defaultCountryCode)
    const stats = roomStats(rooms, today, staff)
    return {
      day, prevDay, prevCount,
      totals: {
        here: today.filter(k => !k.picked_up_at).length, checkedIn: today.length, pickedUp: today.filter(k => k.picked_up_at).length,
        firstTime: today.filter(k => k.first_time).length, adults: Object.values(staff).reduce((a, n) => a + Number(n || 0), 0),
        short: stats.reduce((a, r) => a + r.short, 0), children: kids.length,
      },
      rooms: stats,
      latest: today.slice(0, 30).map(checkinOut),
      missing: missing.map(c => ({ id: c.id, name: childName(c), room: roomFor(c, rooms, day)?.name || null, lastCheckinAt: plain(c.last_checkin_at), guardian: guardians.get((c.guardian_ids || [])[0]) || null })),
    }
  })

  r.get('/children/rooms/:id/today', async ({ ctx, params }) => {
    requireCap(ctx, 'children.view'); requireOn(ctx)
    const { db } = await fb()
    const day = dayKey(ctx.org.timezone)
    const rooms = await loadRooms(db, ctx.org.id)
    const room = rooms.find(x => x.id === String(params.id))
    if (!room) throw notFound('Class not found.')
    const [today, dayDoc] = await Promise.all([checkinsFor(db, ctx.org.id, day), col(db, ctx.org.id, 'kidsDays').doc(day).get()])
    const mine = today.filter(k => k.room_id === room.id)
    const [stats] = roomStats([room], today, dayDoc.data()?.staff || {})
    return { day, room: stats, rooms: rooms.map(x => ({ id: x.id, name: x.name })), checkins: mine.map(checkinOut) }
  })

  r.post('/children/rooms/:id/adults', async ({ ctx, params, body }) => {
    requireCap(ctx, 'children.checkin'); requireOn(ctx)
    const { db } = await fb()
    const day = dayKey(ctx.org.timezone)
    const rooms = await loadRooms(db, ctx.org.id)
    if (!rooms.some(x => x.id === String(params.id))) throw notFound('Class not found.')
    const n = int(body.adults, { min: 0, max: 50, name: 'Adults' }) ?? 0
    const ref = col(db, ctx.org.id, 'kidsDays').doc(day)
    await db.runTransaction(async (tx) => {
      const d = (await tx.get(ref)).data() || {}
      tx.set(ref, { staff: { ...(d.staff || {}), [String(params.id)]: n }, updated_at: new Date() }, { merge: true })
    })
    return { adults: n }
  })

  r.post('/children/pickup/lookup', async ({ ctx, body }) => {
    requireCap(ctx, 'children.checkin'); requireOn(ctx)
    const { db } = await fb()
    const code = String(body.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6)
    if (code.length < 3) throw bad('Enter the 3-character code from the pickup tag.')
    const day = dayKey(ctx.org.timezone)
    const today = (await checkinsFor(db, ctx.org.id, day)).filter(k => k.code === code)
    if (!today.length) return { found: false, code }
    const kidIds = [...new Set(today.map(k => k.child_id))]
    const snaps = await db.getAll(...kidIds.map(id => col(db, ctx.org.id, 'children').doc(id)))
    const kids = new Map(snaps.filter(s => s.exists).map(s => [s.id, s.data()]))
    const guardians = await guardianMap(db, ctx.org.id, [...kids.values()].flatMap(c => c.guardian_ids || []), ctx.org.settings?.defaultCountryCode)
    return {
      found: true, code,
      checkins: today.map(k => {
        const c = kids.get(k.child_id) || {}
        return { ...checkinOut(k), allowed: (c.guardian_ids || []).map(id => guardians.get(id)?.name).filter(Boolean), pickupNotes: c.pickup_notes || null }
      }),
    }
  })

  r.post('/children/pickup', async ({ ctx, body }) => {
    requireCap(ctx, 'children.checkin'); requireOn(ctx)
    const { db } = await fb()
    const ids = [...new Set((Array.isArray(body.checkinIds) ? body.checkinIds : []).map(String))].slice(0, 12)
    if (!ids.length) throw bad('Choose who is being picked up.')
    const code = String(body.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
    const snaps = await db.getAll(...ids.map(id => col(db, ctx.org.id, 'kidsCheckins').doc(id.slice(0, 64))))
    if (snaps.some(s => !s.exists)) throw notFound()
    // The code on the parent's tag must match: never hand a child over on a name alone.
    if (snaps.some(s => s.data().code !== code)) throw conflict('That code doesn’t match. Don’t hand the child over. Ask the children’s leader.')
    const now = new Date()
    const b = db.batch()
    for (const s of snaps) if (!s.data().picked_up_at) b.update(s.ref, { picked_up_at: now, picked_up_by: ctx.user.name || null })
    await b.commit()
    await audit(ctx, 'child.picked_up', 'kidsCheckin', ids[0], { children: ids.length })
    return { ok: true, pickedUpAt: now.toISOString() }
  })
}

async function familyForCheckin(db, ctx, personId) {
  const ps = await col(db, ctx.org.id, 'people').doc(personId).get()
  if (!ps.exists || ps.data().status === 'archived') return { found: false }
  const p = ps.data()
  const day = dayKey(ctx.org.timezone)
  const [rooms, qs, today] = await Promise.all([
    loadRooms(db, ctx.org.id),
    col(db, ctx.org.id, 'children').where('guardian_ids', 'array-contains', personId).get(),
    checkinsFor(db, ctx.org.id, day),
  ])
  const kids = qs.docs.map(d => ({ id: d.id, ...d.data() })).filter(c => c.status !== 'archived')
  return {
    found: true,
    guardian: { id: ps.id, firstName: p.first_name, lastName: p.last_name || null, name: personName(p), phone: p.phone_norm ? displayPhone(p.phone_norm, ctx.org.settings?.defaultCountryCode) : (p.phone || null) },
    rooms: rooms.map(x => ({ id: x.id, name: x.name })),
    children: kids.map(c => {
      const room = roomFor(c, rooms, day)
      const k = today.find(x => x.child_id === c.id && !x.picked_up_at)
      return { id: c.id, firstName: c.first_name, lastName: c.last_name || null, name: childName(c), age: ageOn(c.birth_date, day), room: room ? { id: room.id, name: room.name } : null, allergies: c.allergies || null, checkedIn: !!k, code: k?.code || null }
    }).sort((a, b) => (b.age ?? -1) - (a.age ?? -1)),
  }
}
