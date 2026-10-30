import { fb, col, docOut, plain, getMany, searchTokens, toDate, ms, isAlreadyExists } from '../firebase.js'
import { bad, conflict, notFound, str, oneOf, int, uuid, date, email as emailV, isUuid } from '../http.js'
import { requireCap, branchFilter, assertBranch, assertRowScope, can, orgBranches } from '../access.js'
import { normalizePhone, audit } from '../util.js'
import { toCsv, csvResponse, lockRef } from '../domain.js'

export const STATUSES = ['visitor', 'member', 'inactive', 'transferred', 'archived']
const ACTIVE_STATUSES = ['visitor', 'member', 'inactive', 'transferred']
const SORTS = { name: ['name_lower', 'asc'], recent: ['created_at', 'desc'], last_seen: ['last_seen_at', 'desc'], first_visit: ['first_visit_at', 'desc'] }

const nameLower = (first, last) => `${first || ''} ${last || ''}`.trim().toLowerCase()
const fold = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')

export function personFields(d) {
  return {
    ...d,
    name_lower: nameLower(d.first_name, d.last_name),
    search: searchTokens(d),
  }
}

async function lookups(ctx) {
  const { db } = await fb()
  if (!ctx._units) ctx._units = (await col(db, ctx.org.id, 'units').get()).docs.map(d => ({ id: d.id, ...d.data() }))
  const branches = new Map((await orgBranches(ctx)).map(b => [b.id, b.name]))
  const units = new Map(ctx._units.map(u => [u.id, u.name]))
  return { branches, units }
}

function rowOut(snapOrObj, lk) {
  const p = snapOrObj.data ? { id: snapOrObj.id, ...plain(snapOrObj.data()) } : snapOrObj
  return {
    id: p.id, first_name: p.first_name, last_name: p.last_name || null, phone: p.phone || null, email: p.email || null, status: p.status,
    branch_id: p.branch_id || null, unit_id: p.unit_id || null, first_visit_at: p.first_visit_at || null, last_seen_at: p.last_seen_at || null,
    visit_count: p.visit_count || 0, created_at: p.created_at, branch_name: lk.branches.get(p.branch_id) || null, unit_name: lk.units.get(p.unit_id) || null,
    open_followups: p.open_followups || 0, phone_norm: p.phone_norm || null, gender: p.gender || null, birthday: p.birthday || null, joined_at: p.joined_at || null,
    email_opt_out: !!p.email_opt_out,
  }
}

// In-memory predicate matching the same filters (used for search results and audiences).
function matches(ctx, p, f, branches, weeks) {
  if (branches && !branches.includes(p.branch_id)) return false
  if (f.statuses?.length) { if (!f.statuses.includes(p.status)) return false } else if (!f.includeArchived && p.status === 'archived') return false
  if (f.unit && p.unit_id !== f.unit) return false
  const cutoff = Date.now() - weeks * 7 * 86400e3
  if (f.attendance === 'recent' && !(p.last_seen_at && ms(p.last_seen_at) >= cutoff)) return false
  if (f.attendance === 'absent' && !(p.last_seen_at && ms(p.last_seen_at) < cutoff)) return false
  if (f.attendance === 'never' && p.last_seen_at) return false
  if (f.firstVisitSince && !(p.first_time_at && ms(p.first_time_at) >= new Date(f.firstVisitSince).getTime())) return false
  if (f.followup === 'open' && !p.has_open_followup) return false
  return true
}

function parseFilters(query) {
  const statuses = query.status && query.status !== 'all' ? String(query.status).split(',').filter(s => STATUSES.includes(s)) : []
  return {
    q: query.q ? String(query.q).trim().slice(0, 80) : '', statuses, includeArchived: !!query.includeArchived,
    unit: query.unit && isUuid(query.unit) ? query.unit : null,
    attendance: ['recent', 'absent', 'never'].includes(query.attendance) ? query.attendance : null,
    firstVisitSince: query.firstVisitSince ? date(query.firstVisitSince) : null,
    followup: query.followup === 'open' ? 'open' : null,
    sort: SORTS[query.sort] ? query.sort : 'name',
    branch: query.branch,
  }
}

// Returns { rows (plain objects incl. id), total } for list, export and message audiences.
export async function findPeople(ctx, query, { limit = 50, offset = 0, all = false } = {}) {
  const { db } = await fb()
  const f = parseFilters(query)
  const branches = await branchFilter(ctx, f.branch)
  const weeks = Number(ctx.org.settings?.absenceWeeks || 3)
  const people = col(db, ctx.org.id, 'people')
  const cap = all ? 20000 : null

  if (f.q) {
    // Token search, then exact filtering in memory.
    const words = fold(f.q).split(/\s+/).filter(Boolean)
    const digits = f.q.replace(/\D/g, '')
    const token = digits.length >= 4 && digits.length >= f.q.replace(/\s/g, '').length - 1 ? digits.replace(/^0+/, '') : words[0].slice(0, 20)
    const qs = await people.where('search', 'array-contains', token).limit(1000).get()
    let rows = qs.docs.map(d => ({ id: d.id, ...plain(d.data()) }))
      .filter(p => (digits.length >= 4 && token === digits.replace(/^0+/, '')) || words.every(w => (p.search || []).includes(w.slice(0, 20))))
      .filter(p => matches(ctx, p, f, branches, weeks))
    const [field, dir] = SORTS[f.sort]
    rows.sort((a, b) => { const x = a[field] ?? '', y = b[field] ?? ''; return (x < y ? -1 : x > y ? 1 : 0) * (dir === 'desc' ? -1 : 1) })
    return { rows: all ? rows : rows.slice(offset, offset + limit), total: rows.length }
  }

  let q = people
  const statuses = f.statuses.length ? f.statuses : (f.includeArchived ? null : ACTIVE_STATUSES)
  // Firestore allows at most 30 combinations across 'in' filters.
  const statusInMemory = statuses && branches && statuses.length * branches.length > 30
  if (statuses && !statusInMemory) q = q.where('status', 'in', statuses)
  if (branches) q = branches.length === 1 ? q.where('branch_id', '==', branches[0]) : q.where('branch_id', 'in', branches.slice(0, 30))
  if (f.unit) q = q.where('unit_id', '==', f.unit)
  if (f.followup) q = q.where('has_open_followup', '==', true)
  let order = SORTS[f.sort]
  const cutoff = new Date(Date.now() - weeks * 7 * 86400e3)
  if (f.attendance === 'recent') { q = q.where('last_seen_at', '>=', cutoff); order = ['last_seen_at', 'desc'] }
  else if (f.attendance === 'absent') { q = q.where('last_seen_at', '<', cutoff); order = ['last_seen_at', 'desc'] }
  else if (f.attendance === 'never') { q = q.where('last_seen_at', '==', null); order = SORTS.name } // no dates to sort by
  else if (f.firstVisitSince) { q = q.where('first_time_at', '>=', new Date(f.firstVisitSince)); order = ['first_time_at', 'desc'] }

  if (statusInMemory) {
    const qs = await q.orderBy(order[0], order[1]).limit(cap || 5000).get()
    const rows = qs.docs.map(d => ({ id: d.id, ...plain(d.data()) })).filter(p => statuses.includes(p.status))
    return { rows: all ? rows : rows.slice(offset, offset + limit), total: rows.length }
  }
  const [countSnap, qs] = await Promise.all([
    q.count().get(),
    q.orderBy(order[0], order[1]).offset(all ? 0 : offset).limit(all ? cap : limit).get(),
  ])
  return { rows: qs.docs.map(d => ({ id: d.id, ...plain(d.data()) })), total: countSnap.data().count }
}

function cleanPerson(body, cc) {
  const phone = str(body.phone, { max: 40, name: 'Phone' })
  const phoneNorm = phone ? normalizePhone(phone, cc) : null
  if (phone && !phoneNorm) throw bad("That phone number doesn't look valid.")
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

export function newPersonDoc(data, extra = {}) {
  const now = new Date()
  return personFields({
    first_name: data.first_name, last_name: data.last_name || null, phone: data.phone || null, phone_norm: data.phone_norm || null, email: data.email || null,
    gender: data.gender || null, birthday: data.birthday || null, status: data.status || 'visitor', joined_at: data.joined_at || null, notes: data.notes || null,
    branch_id: null, unit_id: null, owner_user_id: null, first_visit_at: null, first_time_at: null, last_seen_at: null, visit_count: 0,
    open_followups: 0, open_reasons: [], has_open_followup: false, source: 'manual', created_at: now, updated_at: now, ...extra,
  })
}

// Creates a person, reserving their phone number atomically. Throws 409 with existingId on duplicates.
export async function createPerson(ctx, data, extra = {}) {
  const { db } = await fb()
  const ref = col(db, ctx.org.id, 'people').doc()
  const doc = newPersonDoc(data, extra)
  await db.runTransaction(async (tx) => {
    if (doc.phone_norm) {
      const phoneRef = col(db, ctx.org.id, 'phones').doc(doc.phone_norm)
      const ph = await tx.get(phoneRef)
      if (ph.exists) {
        const ex = await tx.get(col(db, ctx.org.id, 'people').doc(ph.data().person_id))
        const n = ex.exists ? `${ex.data().first_name} ${ex.data().last_name || ''}`.trim() : 'Someone'
        throw conflict(`${n} already has this phone number.`, { existingId: ph.data().person_id, hint: ex.exists ? ex.data().first_name : null })
      }
      tx.set(phoneRef, { person_id: ref.id })
    }
    tx.set(ref, doc)
  })
  return { id: ref.id, ...plain(doc) }
}

async function scopedUnit(db, ctx, unitId) {
  if (!unitId) return null
  const u = await col(db, ctx.org.id, 'units').doc(uuid(unitId)).get()
  if (!u.exists) throw bad('Service unit not found.')
  return u.id
}
async function scopedOwner(db, ctx, userId) {
  if (!userId) return null
  const m = await db.collection('memberships').doc(`${ctx.org.id}_${userId}`).get()
  if (!m.exists || m.data().status !== 'active') throw bad('That team member was not found.')
  return m.data().user_id
}

const dateStr = (v) => (v ? new Date(v).toISOString().slice(0, 10) : '')

export default function (r) {
  r.get('/people', async ({ ctx, query }) => {
    requireCap(ctx, 'people.view')
    const limit = Math.min(int(query.limit) || 50, 200)
    const offset = Math.max(int(query.offset) || 0, 0)
    const { rows, total } = await findPeople(ctx, query, { limit, offset })
    const lk = await lookups(ctx)
    return { rows: rows.map(p => rowOut(p, lk)), total, limit, offset }
  })

  r.get('/people/export', async ({ ctx, query }) => {
    requireCap(ctx, 'people.view')
    requireCap(ctx, 'export')
    const { rows } = await findPeople(ctx, query, { all: true })
    const lk = await lookups(ctx)
    await audit(ctx, 'people.exported', 'people', null, { count: rows.length })
    const csv = toCsv(rows.map(p => rowOut(p, lk)), [
      { label: 'First name', value: 'first_name' }, { label: 'Last name', value: 'last_name' },
      { label: 'Phone', value: 'phone' }, { label: 'Email', value: 'email' }, { label: 'Status', value: 'status' },
      { label: 'Branch', value: 'branch_name' }, { label: 'Service unit', value: 'unit_name' },
      { label: 'Gender', value: 'gender' }, { label: 'Birthday', value: 'birthday' },
      { label: 'First visit', value: r => dateStr(r.first_visit_at) }, { label: 'Last attended', value: r => dateStr(r.last_seen_at) },
      { label: 'Visits', value: 'visit_count' }, { label: 'Date joined', value: 'joined_at' },
    ])
    return csvResponse(csv, `people-${new Date().toISOString().slice(0, 10)}.csv`)
  })

  r.get('/people/:id', async ({ ctx, params }) => {
    requireCap(ctx, 'people.view')
    const { db } = await fb()
    const C = (n) => col(db, ctx.org.id, n)
    const p = docOut(await C('people').doc(uuid(params.id, { required: true })).get())
    assertRowScope(ctx, p)
    const lk = await lookups(ctx)
    const [att, fus, regs] = await Promise.all([
      C('checkins').where('person_id', '==', p.id).orderBy('created_at', 'desc').limit(60).get(),
      can(ctx, 'followups.view') ? C('followups').where('person_id', '==', p.id).orderBy('created_at', 'desc').limit(30).get() : null,
      C('registrations').where('person_id', '==', p.id).limit(50).get(),
    ])
    const owner = p.owner_user_id ? (await db.collection('users').doc(p.owner_user_id).get()).data() : null
    const eventIds = [...new Set(regs.docs.map(d => d.data().event_id))]
    const events = new Map((await getMany(db, eventIds.map(id => C('events').doc(id)))).filter(e => e.exists).map(e => [e.id, plain(e.data())]))
    const person = { ...p, branch_name: lk.branches.get(p.branch_id) || null, unit_name: lk.units.get(p.unit_id) || null, owner_name: owner?.name || null }
    delete person.search
    if (!can(ctx, 'people.edit')) delete person.notes
    return {
      person,
      attendance: att.docs.map(d => { const c = plain(d.data()); return { id: d.id, created_at: c.created_at, first_time: c.first_time, method: c.method, gathering_id: c.gathering_id, name: c.gathering_name, starts_at: c.starts_at, branch_name: lk.branches.get(c.branch_id) || null } })
        .sort((a, b) => (b.starts_at || '').localeCompare(a.starts_at || '')),
      followups: fus ? fus.docs.map(d => { const f = plain(d.data()); return { id: d.id, reason: f.reason, title: f.title, status: f.status, due_at: f.due_at, outcome: f.outcome, closed_at: f.closed_at, assignee_name: f.assignee_name } }) : [],
      registrations: regs.docs.map(d => { const g = plain(d.data()); const e = events.get(g.event_id) || {}; return { id: d.id, status: g.status, checked_in_at: g.checked_in_at, event_id: g.event_id, name: e.name, starts_at: e.starts_at } })
        .sort((a, b) => (b.starts_at || '').localeCompare(a.starts_at || '')),
    }
  })

  r.post('/people', async ({ ctx, body }) => {
    requireCap(ctx, 'people.edit')
    const { db } = await fb()
    const data = cleanPerson(body, ctx.org.settings?.defaultCountryCode)
    const branchId = (await assertBranch(ctx, body.branchId)).id
    const p = await createPerson(ctx, data, { branch_id: branchId, unit_id: await scopedUnit(db, ctx, body.unitId), owner_user_id: await scopedOwner(db, ctx, body.ownerUserId), source: 'manual' })
    await audit(ctx, 'person.created', 'person', p.id, { name: `${p.first_name} ${p.last_name || ''}`.trim() })
    return p
  })

  r.patch('/people/:id', async ({ ctx, params, body }) => {
    requireCap(ctx, 'people.edit')
    const { db } = await fb()
    const C = (n) => col(db, ctx.org.id, n)
    const ref = C('people').doc(uuid(params.id, { required: true }))
    const existing = docOut(await ref.get())
    assertRowScope(ctx, existing)
    const merged = {
      firstName: existing.first_name, lastName: existing.last_name, phone: existing.phone, email: existing.email, gender: existing.gender,
      birthday: existing.birthday, status: existing.status, joinedAt: existing.joined_at, notes: existing.notes, ...body,
    }
    const data = cleanPerson(merged, ctx.org.settings?.defaultCountryCode)
    const branchId = body.branchId !== undefined ? (await assertBranch(ctx, body.branchId)).id : existing.branch_id
    const unitId = body.unitId !== undefined ? await scopedUnit(db, ctx, body.unitId) : existing.unit_id
    const ownerId = body.ownerUserId !== undefined ? await scopedOwner(db, ctx, body.ownerUserId) : existing.owner_user_id
    const patch = personFields({ ...data, branch_id: branchId || null, unit_id: unitId || null, owner_user_id: ownerId || null, updated_at: new Date() })
    await db.runTransaction(async (tx) => {
      if (data.phone_norm !== (existing.phone_norm || null)) {
        if (data.phone_norm) {
          const nRef = C('phones').doc(data.phone_norm)
          const ph = await tx.get(nRef)
          if (ph.exists && ph.data().person_id !== existing.id) {
            const ex = await tx.get(C('people').doc(ph.data().person_id))
            throw conflict(`${ex.data()?.first_name || 'Someone'} ${ex.data()?.last_name || ''}`.trim() + ' already has this phone number.', { existingId: ph.data().person_id })
          }
          tx.set(nRef, { person_id: existing.id })
        }
        if (existing.phone_norm) tx.delete(C('phones').doc(existing.phone_norm))
      }
      tx.update(ref, patch)
    })
    if (data.status !== existing.status) {
      await audit(ctx, 'person.status_changed', 'person', existing.id, { from: existing.status, to: data.status, name: `${data.first_name} ${data.last_name || ''}`.trim() })
      if (existing.status === 'visitor' && data.status !== 'visitor') {
        // Leaving the visitor journey closes visitor follow-ups.
        const { closeFollowup } = await import('./followups.js')
        for (const reason of ['first_visit', 'second_visit']) {
          const l = await lockRef(db, ctx.org.id, existing.id, reason).get()
          if (l.exists) await closeFollowup(ctx, l.data().followup_id, 'done', `Status changed to ${data.status}`)
        }
      }
    }
    return docOut(await ref.get())
  })

  r.delete('/people/:id', async ({ ctx, params }) => {
    requireCap(ctx, 'people.delete')
    const { db } = await fb()
    const C = (n) => col(db, ctx.org.id, n)
    const ref = C('people').doc(uuid(params.id, { required: true }))
    const p = docOut(await ref.get())
    assertRowScope(ctx, p)
    const [cks, fus] = await Promise.all([C('checkins').where('person_id', '==', p.id).get(), C('followups').where('person_id', '==', p.id).get()])
    const ops = []
    for (const c of cks.docs) {
      ops.push(b => b.delete(c.ref))
      const g = c.data()
      ops.push(b => b.set(C('gatherings').doc(g.gathering_id), { attendance: F_inc(-1), first_timers: F_inc(g.first_time ? -1 : 0), manual: F_inc(g.method === 'manual' ? -1 : 0) }, { merge: true }))
    }
    for (const f of fus.docs) {
      ops.push(b => b.delete(f.ref))
      if (f.data().reason !== 'manual') ops.push(b => b.delete(lockRef(db, ctx.org.id, p.id, f.data().reason)))
    }
    if (p.phone_norm) ops.push(b => b.delete(C('phones').doc(p.phone_norm)))
    ops.push(b => b.delete(ref))
    for (let i = 0; i < ops.length; i += 400) { const b = db.batch(); ops.slice(i, i + 400).forEach(op => op(b)); await b.commit() }
    await audit(ctx, 'person.deleted', 'person', p.id, { name: `${p.first_name} ${p.last_name || ''}`.trim() })
    return { ok: true }
  })

  // Clean slate: removes every person in the church with their check-ins, follow-ups and
  // phone keys. Sessions and events stay (their attendance resets to zero). Works in rounds so
  // a large church never hits the function time limit; the client calls again until done.
  r.post('/people/delete-all', async ({ ctx, body }) => {
    requireCap(ctx, 'org.manage')
    if (String(body.confirm || '').trim().toUpperCase() !== 'DELETE') throw bad('Type DELETE to confirm.')
    const { db } = await fb()
    const C = (n) => col(db, ctx.org.id, n)
    const started = Date.now()
    const budget = () => Date.now() - started < 6000
    let removed = 0
    const wipe = async (name, withNotes = false) => {
      while (budget()) {
        const qs = await C(name).limit(300).get()
        if (qs.empty) return true
        const b = db.batch()
        for (const d of qs.docs) {
          if (withNotes) for (const n of (await d.ref.collection('notes').get()).docs) b.delete(n.ref)
          b.delete(d.ref)
        }
        await b.commit()
        if (name === 'people') removed += qs.size
      }
      return false
    }
    for (const name of ['checkins', 'followups', 'followupKeys', 'phones', 'people']) {
      if (!(await wipe(name, name === 'followups'))) {
        const left = (await C('people').count().get()).data().count
        return { done: false, removed, remaining: left }
      }
    }
    // Everything is gone: reset session counters and unlink event registrations.
    for (const g of (await C('gatherings').get()).docs) await g.ref.update({ attendance: 0, first_timers: 0, manual: 0 })
    const linked = (await C('registrations').get()).docs.filter(d => d.data().person_id)
    for (let i = 0; i < linked.length; i += 400) {
      const b = db.batch(); linked.slice(i, i + 400).forEach(d => b.update(d.ref, { person_id: null })); await b.commit()
    }
    await audit(ctx, 'people.deleted_all', 'people', null, {})
    return { done: true, removed, remaining: 0 }
  })

  r.post('/people/bulk', async ({ ctx, body }) => {
    requireCap(ctx, 'people.edit')
    const { db } = await fb()
    const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).filter(isUuid))].slice(0, 1000)
    if (!ids.length) throw bad('Select at least one person.')
    const patch = {}
    if (body.status) patch.status = oneOf(body.status, STATUSES, { name: 'Status' })
    if (body.unitId !== undefined) patch.unit_id = await scopedUnit(db, ctx, body.unitId)
    if (body.branchId) patch.branch_id = (await assertBranch(ctx, body.branchId)).id
    if (!Object.keys(patch).length) throw bad('Nothing to change.')
    patch.updated_at = new Date()
    const snaps = await getMany(db, ids.map(id => col(db, ctx.org.id, 'people').doc(id)))
    const ok = snaps.filter(s => s.exists && (!ctx.branchScope || ctx.branchScope.includes(s.data().branch_id)))
    for (let i = 0; i < ok.length; i += 400) { const b = db.batch(); ok.slice(i, i + 400).forEach(s => b.update(s.ref, patch)); await b.commit() }
    await audit(ctx, 'people.bulk_updated', 'people', null, { count: ok.length, status: body.status || null })
    return { updated: ok.length }
  })

  // --- import: preview then commit ----------------------------------------------------
  r.post('/people/import/preview', async ({ ctx, body }) => {
    requireCap(ctx, 'people.edit')
    await assertBranch(ctx, body.branchId)
    return analyseImport(ctx, body.rows)
  })

  r.post('/people/import/commit', async ({ ctx, body }) => {
    requireCap(ctx, 'people.edit')
    const { db } = await fb()
    const branchId = (await assertBranch(ctx, body.branchId)).id
    const policy = oneOf(body.duplicatePolicy, ['skip', 'update'], { name: 'Duplicate policy', fallback: 'skip' })
    const analysis = await analyseImport(ctx, body.rows)
    const summary = { created: 0, updated: 0, skipped: analysis.rows.filter(r => r.action === 'skip').length, rejected: analysis.summary.rejected }
    const toCreate = analysis.rows.filter(r => r.action === 'create')
    const C = (n) => col(db, ctx.org.id, n)
    for (let i = 0; i < toCreate.length; i += 200) {
      const chunk = toCreate.slice(i, i + 200)
      const write = async (rows) => {
        const b = db.batch()
        for (const r of rows) {
          const ref = C('people').doc()
          if (r.data.phone_norm) b.create(C('phones').doc(r.data.phone_norm), { person_id: ref.id })
          b.set(ref, newPersonDoc(r.data, { branch_id: branchId, source: 'import' }))
        }
        await b.commit()
      }
      try { await write(chunk); summary.created += chunk.length }
      catch (e) {
        if (!isAlreadyExists(e)) throw e
        // Someone else added one of these numbers meanwhile: fall back to one at a time.
        for (const r of chunk) {
          try { await write([r]); summary.created++ } catch (e2) { if (isAlreadyExists(e2)) summary.skipped++; else throw e2 }
        }
      }
    }
    const dups = analysis.rows.filter(r => r.action === 'duplicate')
    if (policy === 'update' && dups.length) {
      const snaps = await getMany(db, dups.map(r => C('people').doc(r.existingId)))
      const byId = new Map(snaps.filter(s => s.exists).map(s => [s.id, s]))
      const ops = []
      for (const r of dups) {
        const s = byId.get(r.existingId)
        if (!s) continue
        const cur = s.data()
        // Only fill blanks — never overwrite existing details with imported ones.
        const patch = {}
        for (const k of ['last_name', 'email', 'gender', 'joined_at', 'birthday']) if (!cur[k] && r.data[k]) patch[k] = r.data[k]
        if (Object.keys(patch).length) { Object.assign(patch, personFields({ ...cur, ...patch }), { updated_at: new Date() }); ops.push([s.ref, patch]) }
        summary.updated++
      }
      for (let i = 0; i < ops.length; i += 400) { const b = db.batch(); ops.slice(i, i + 400).forEach(([ref, p]) => b.update(ref, p)); await b.commit() }
    } else summary.skipped += dups.length
    await audit(ctx, 'people.imported', 'people', null, { ...summary, branchId })
    return { summary }
  })
}

// Batch increments without importing F at module top (keeps fake/real resolution lazy).
import { F } from '../firebase.js'
const F_inc = (n) => F.inc(n)

const MAX_IMPORT = 5000

async function analyseImport(ctx, rawRows) {
  if (!Array.isArray(rawRows) || !rawRows.length) throw bad('There are no rows to import.')
  if (rawRows.length > MAX_IMPORT) throw bad(`Imports are limited to ${MAX_IMPORT} rows at a time. Split the file and try again.`)
  const { db } = await fb()
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
    const toD = (v) => { if (!v) return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10) }
    const data = {
      first_name: first.slice(0, 80), last_name: last.slice(0, 80) || null, phone: phone || null, phone_norm: phoneNorm, email,
      gender: ['f', 'female', 'woman'].includes(g) ? 'female' : ['m', 'male', 'man'].includes(g) ? 'male' : null,
      status: STATUSES.includes(status) ? status : 'member', joined_at: toD(r.joinedAt), birthday: toD(r.birthday),
    }
    let action = errors.length ? 'reject' : 'create'
    let note = null
    if (action === 'create' && phoneNorm) {
      if (seenPhones.has(phoneNorm)) { action = 'skip'; note = `Same phone as row ${seenPhones.get(phoneNorm) + 2}` }
      else seenPhones.set(phoneNorm, i)
    }
    rows.push({ index: i, action, errors, note, data, name: `${first} ${last}`.trim() })
  }
  const phones = [...seenPhones.keys()]
  if (phones.length) {
    const snaps = await getMany(db, phones.map(p => col(db, ctx.org.id, 'phones').doc(p)))
    const existing = new Map(snaps.filter(s => s.exists).map(s => [s.id, s.data().person_id]))
    const persons = await getMany(db, [...new Set(existing.values())].map(id => col(db, ctx.org.id, 'people').doc(id)))
    const names = new Map(persons.filter(p => p.exists).map(p => [p.id, `${p.data().first_name} ${p.data().last_name || ''}`.trim()]))
    for (const row of rows) {
      const id = row.action === 'create' && existing.get(row.data.phone_norm)
      if (id) { row.action = 'duplicate'; row.existingId = id; row.note = `Matches ${names.get(id) || 'an existing person'}` }
    }
  }
  const count = (a) => rows.filter(r => r.action === a).length
  return { summary: { total: rows.length, create: count('create'), duplicate: count('duplicate'), skip: count('skip'), rejected: count('reject') }, rows }
}

export { toDate }
