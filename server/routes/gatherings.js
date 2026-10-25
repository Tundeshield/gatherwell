import { fb, col, docOut, plain, getMany, toDate, ms, F } from '../firebase.js'
import { bad, notFound, conflict, str, oneOf, int, uuid, date } from '../http.js'
import { requireCap, branchFilter, assertBranch, assertRowScope, orgBranches } from '../access.js'
import { shortId, sanitizeForm, audit, normalizePhone, DEFAULT_CHECKIN_FORM } from '../util.js'
import { recordCheckin, toCsv, csvResponse } from '../domain.js'
import { createPerson } from './people.js'

const STATUSES = ['draft', 'scheduled', 'open', 'closed', 'archived']
const KINDS = ['service', 'midweek', 'youth', 'prayer', 'meeting', 'class', 'other']

export async function loadGathering(ctx, id) {
  const { db } = await fb()
  const g = docOut(await col(db, ctx.org.id, 'gatherings').doc(uuid(id, { required: true })).get())
  assertRowScope(ctx, g, { allowOrgWide: false })
  const b = (await orgBranches(ctx)).find(x => x.id === g.branch_id)
  return { ...g, branch_name: b?.name || null }
}

// Recomputes visit count, first/last seen for a person from their remaining check-ins.
export async function recomputePerson(db, orgId, personId) {
  const ref = col(db, orgId, 'people').doc(personId)
  const cks = await col(db, orgId, 'checkins').where('person_id', '==', personId).get()
  const times = cks.docs.map(d => ms(d.data().starts_at)).filter(Boolean).sort((a, b) => a - b)
  const snap = await ref.get()
  if (!snap.exists) return
  const firstTime = cks.docs.filter(d => d.data().first_time).map(d => ms(d.data().starts_at)).sort((a, b) => a - b)[0]
  await ref.update({
    visit_count: cks.size, first_visit_at: times.length ? new Date(times[0]) : null, last_seen_at: times.length ? new Date(times.at(-1)) : null,
    first_time_at: firstTime ? new Date(firstTime) : null, updated_at: new Date(),
  })
}

const out = (g) => ({ ...g, attendance: g.attendance || 0, first_timers: g.first_timers || 0 })

export default function (r) {
  r.get('/gatherings', async ({ ctx, query }) => {
    requireCap(ctx, 'attendance.view')
    const { db } = await fb()
    const branches = await branchFilter(ctx, query.branch)
    let q = col(db, ctx.org.id, 'gatherings')
    if (query.status && STATUSES.includes(query.status)) q = q.where('status', '==', query.status)
    else q = q.where('status', 'in', ['draft', 'scheduled', 'open', 'closed'])
    if (branches) q = branches.length === 1 ? q.where('branch_id', '==', branches[0]) : q.where('branch_id', 'in', branches.slice(0, 6))
    if (query.from) q = q.where('starts_at', '>=', new Date(date(query.from)))
    if (query.to) q = q.where('starts_at', '<=', new Date(date(query.to)))
    const limit = Math.min(int(query.limit) || 30, 100)
    const offset = Math.max(int(query.offset) || 0, 0)
    const names = new Map((await orgBranches(ctx)).map(b => [b.id, b.name]))
    if (query.q) {
      const term = String(query.q).toLowerCase().slice(0, 80)
      const qs = await q.orderBy('starts_at', 'desc').limit(1000).get()
      const rows = qs.docs.map(d => out({ id: d.id, ...plain(d.data()) })).filter(g => g.name.toLowerCase().includes(term))
      return { rows: rows.slice(offset, offset + limit).map(g => ({ ...g, branch_name: names.get(g.branch_id) })), total: rows.length, limit, offset }
    }
    const [count, qs] = await Promise.all([q.count().get(), q.orderBy('starts_at', 'desc').offset(offset).limit(limit).get()])
    return { rows: qs.docs.map(d => out({ id: d.id, ...plain(d.data()), branch_name: names.get(d.data().branch_id) })), total: count.data().count, limit, offset }
  })

  r.post('/gatherings', async ({ ctx, body }) => {
    requireCap(ctx, 'attendance.manage')
    const { db } = await fb()
    const branch = await assertBranch(ctx, body.branchId)
    if (branch.status !== 'active') throw bad('That branch is archived.')
    const startsAt = date(body.startsAt, { required: true, name: 'Start time' })
    const endsAt = date(body.endsAt, { name: 'End time' })
    if (endsAt && new Date(endsAt) <= new Date(startsAt)) throw bad('End time must be after the start time.')
    const ref = col(db, ctx.org.id, 'gatherings').doc()
    const token = shortId(10)
    const data = {
      branch_id: branch.id, name: str(body.name, { required: true, max: 120, name: 'Name' }), kind: oneOf(body.kind, KINDS, { name: 'Type', fallback: 'service' }),
      description: str(body.description, { max: 1000 }), starts_at: new Date(startsAt), ends_at: endsAt ? new Date(endsAt) : null,
      status: oneOf(body.status, STATUSES, { name: 'Status', fallback: 'open' }), public_token: token,
      form: sanitizeForm(body.form?.length ? body.form : DEFAULT_CHECKIN_FORM), attendance: 0, first_timers: 0, manual: 0,
      created_by: ctx.user.id, created_at: new Date(), updated_at: new Date(),
    }
    const batch = db.batch()
    batch.set(ref, data)
    batch.create(db.collection('publicLinks').doc(token), { kind: 'gathering', org_id: ctx.org.id, ref_id: ref.id })
    await batch.commit()
    await audit(ctx, 'gathering.created', 'gathering', ref.id, { name: data.name })
    return { id: ref.id, ...plain(data) }
  })

  r.get('/gatherings/:id', async ({ ctx, params }) => {
    requireCap(ctx, 'attendance.view')
    const { db } = await fb()
    const g = await loadGathering(ctx, params.id)
    // Previous comparable gathering: same branch and type, earlier start.
    const prevQs = await col(db, ctx.org.id, 'gatherings').where('branch_id', '==', g.branch_id).where('starts_at', '<', new Date(g.starts_at)).orderBy('starts_at', 'desc').limit(20).get()
    const prev = prevQs.docs.map(d => ({ id: d.id, ...plain(d.data()) })).find(x => x.kind === g.kind && !['draft', 'archived'].includes(x.status))
    return {
      gathering: g,
      stats: { attendance: g.attendance || 0, first_timers: g.first_timers || 0, manual: g.manual || 0 },
      previous: prev ? { id: prev.id, name: prev.name, starts_at: prev.starts_at, attendance: prev.attendance || 0 } : null,
    }
  })

  r.patch('/gatherings/:id', async ({ ctx, params, body }) => {
    requireCap(ctx, 'attendance.manage')
    const { db } = await fb()
    const g = await loadGathering(ctx, params.id)
    const patch = { updated_at: new Date() }
    const name = str(body.name, { max: 120 }); if (name) patch.name = name
    const kind = oneOf(body.kind, KINDS, { name: 'Type' }); if (kind) patch.kind = kind
    if (body.description !== undefined) patch.description = str(body.description, { max: 1000 })
    if (body.startsAt) patch.starts_at = new Date(date(body.startsAt, { name: 'Start time' }))
    if (body.endsAt !== undefined) patch.ends_at = body.endsAt ? new Date(date(body.endsAt, { name: 'End time' })) : null
    const start = patch.starts_at || new Date(g.starts_at)
    const end = patch.ends_at !== undefined ? patch.ends_at : (g.ends_at ? new Date(g.ends_at) : null)
    if (end && end <= start) throw bad('End time must be after the start time.')
    const status = oneOf(body.status, STATUSES, { name: 'Status' }); if (status) patch.status = status
    if (body.form) patch.form = sanitizeForm(body.form)
    const ref = col(db, ctx.org.id, 'gatherings').doc(g.id)
    await ref.update(patch)
    if (status && status !== g.status) await audit(ctx, `gathering.${status}`, 'gathering', g.id, { name: g.name })
    return { ...docOut(await ref.get()), branch_name: g.branch_name }
  })

  r.delete('/gatherings/:id', async ({ ctx, params, query }) => {
    requireCap(ctx, 'attendance.manage')
    const { db } = await fb()
    const g = await loadGathering(ctx, params.id)
    const cks = await col(db, ctx.org.id, 'checkins').where('gathering_id', '==', g.id).get()
    if (cks.size > 0 && query.confirm !== 'delete') throw conflict(`This session has ${cks.size} check-ins. Archive it instead, or confirm deletion.`, { checkins: cks.size })
    const refs = [...cks.docs.map(d => d.ref), col(db, ctx.org.id, 'gatherings').doc(g.id), db.collection('publicLinks').doc(g.public_token)]
    for (let i = 0; i < refs.length; i += 400) { const b = db.batch(); refs.slice(i, i + 400).forEach(x => b.delete(x)); await b.commit() }
    const people = [...new Set(cks.docs.map(d => d.data().person_id))]
    for (let i = 0; i < people.length; i += 20) await Promise.all(people.slice(i, i + 20).map(pid => recomputePerson(db, ctx.org.id, pid)))
    await audit(ctx, 'gathering.deleted', 'gathering', g.id, { name: g.name, checkins: cks.size })
    return { ok: true }
  })

  async function attendees(db, ctx, g) {
    const qs = await col(db, ctx.org.id, 'checkins').where('gathering_id', '==', g.id).get()
    return qs.docs.map(d => { const c = plain(d.data()); return {
      id: d.id, created_at: c.created_at, first_time: c.first_time, method: c.method, answers: c.answers || {}, person_id: c.person_id,
      first_name: c.first_name, last_name: c.last_name, phone: c.phone, status: c.person_status, recorded_by: c.created_by_name } })
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
  }

  r.get('/gatherings/:id/attendees', async ({ ctx, params, query }) => {
    requireCap(ctx, 'attendance.view')
    const { db } = await fb()
    const g = await loadGathering(ctx, params.id)
    let rows = await attendees(db, ctx, g)
    if (query.q) {
      const t = String(query.q).toLowerCase().slice(0, 80)
      rows = rows.filter(c => `${c.first_name} ${c.last_name || ''}`.toLowerCase().includes(t) || String(c.phone || '').includes(t))
    }
    return { rows }
  })

  r.get('/gatherings/:id/export', async ({ ctx, params }) => {
    requireCap(ctx, 'attendance.view')
    requireCap(ctx, 'export')
    const { db } = await fb()
    const g = await loadGathering(ctx, params.id)
    const rows = (await attendees(db, ctx, g)).reverse()
    const extra = (g.form || []).filter(f => !f.core)
    await audit(ctx, 'gathering.exported', 'gathering', g.id, { count: rows.length, name: g.name })
    const csv = toCsv(rows, [
      { label: 'First name', value: 'first_name' }, { label: 'Last name', value: 'last_name' }, { label: 'Phone', value: 'phone' },
      { label: 'Status', value: 'status' }, { label: 'First time', value: r => r.first_time ? 'Yes' : 'No' },
      { label: 'Method', value: 'method' }, { label: 'Checked in at', value: 'created_at' },
      ...extra.map(f => ({ label: f.label, value: r => r.answers?.[f.id] ?? '' })),
    ])
    return csvResponse(csv, `${g.name}-${String(g.starts_at).slice(0, 10)}.csv`)
  })

  // Manual check-in by an usher: an existing person, or a new person.
  r.post('/gatherings/:id/checkins', async ({ ctx, params, body }) => {
    requireCap(ctx, 'attendance.record')
    const { db } = await fb()
    const g = await loadGathering(ctx, params.id)
    if (['archived', 'draft'].includes(g.status)) throw bad('This session is not accepting attendance.')
    let personId = body.personId
    if (personId) {
      const p = await col(db, ctx.org.id, 'people').doc(uuid(personId)).get()
      if (!p.exists) throw notFound('Person not found.')
    } else {
      const first = str(body.firstName, { required: true, max: 80, name: 'First name' })
      const phone = str(body.phone, { max: 40, name: 'Phone' })
      const phoneNorm = phone ? normalizePhone(phone, ctx.org.settings?.defaultCountryCode) : null
      if (phone && !phoneNorm) throw bad("That phone number doesn't look valid.")
      try {
        const p = await createPerson(ctx, { first_name: first, last_name: str(body.lastName, { max: 80 }), phone, phone_norm: phoneNorm, email: str(body.email, { max: 254 }), status: 'visitor' }, { branch_id: g.branch_id, source: 'manual' })
        personId = p.id
      } catch (e) {
        if (e.status === 409) throw conflict(`${e.message.replace(' already has this phone number.', '')} already has this phone number — search for them instead.`, e.details)
        throw e
      }
    }
    const res = await recordCheckin({ org: ctx.org, gathering: g, personId, method: 'manual', user: ctx.user })
    if (res.alreadyCheckedIn) throw conflict('Already checked in for this session.')
    return { ok: true, firstTime: res.firstTime, checkinId: res.checkinId }
  })

  r.delete('/gatherings/:id/checkins/:checkinId', async ({ ctx, params }) => {
    requireCap(ctx, 'attendance.manage')
    const { db } = await fb()
    const g = await loadGathering(ctx, params.id)
    const ref = col(db, ctx.org.id, 'checkins').doc(String(params.checkinId).slice(0, 140))
    const c = (await ref.get()).data()
    if (!c || c.gathering_id !== g.id) throw notFound()
    const b = db.batch()
    b.delete(ref)
    b.update(col(db, ctx.org.id, 'gatherings').doc(g.id), { attendance: F.inc(-1), first_timers: F.inc(c.first_time ? -1 : 0), manual: F.inc(c.method === 'manual' ? -1 : 0) })
    await b.commit()
    await recomputePerson(db, ctx.org.id, c.person_id)
    await audit(ctx, 'checkin.removed', 'gathering', g.id, { personId: c.person_id, name: `${c.first_name} ${c.last_name || ''}`.trim() })
    return { ok: true }
  })

  // People search for the usher's manual check-in box (marks who's already in).
  r.get('/gatherings/:id/lookup', async ({ ctx, params, query }) => {
    requireCap(ctx, 'attendance.record')
    const { db } = await fb()
    const g = await loadGathering(ctx, params.id)
    const term = String(query.q || '').trim().slice(0, 80)
    if (term.length < 2) return { rows: [] }
    const digits = term.replace(/\D/g, '')
    const words = term.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').split(/\s+/).filter(Boolean)
    const token = digits.length >= 4 ? digits.replace(/^0+/, '') : words[0].slice(0, 20)
    const qs = await col(db, ctx.org.id, 'people').where('search', 'array-contains', token).limit(60).get()
    const people = qs.docs.map(d => ({ id: d.id, ...d.data() }))
      .filter(p => p.status !== 'archived' && (digits.length >= 4 || words.every(w => (p.search || []).includes(w.slice(0, 20)))))
      .sort((a, b) => (b.branch_id === g.branch_id) - (a.branch_id === g.branch_id) || a.name_lower.localeCompare(b.name_lower)).slice(0, 12)
    const cks = await getMany(db, people.map(p => col(db, ctx.org.id, 'checkins').doc(`${g.id}_${p.id}`)))
    const names = new Map((await orgBranches(ctx)).map(b => [b.id, b.name]))
    // People from branches outside the user's scope can be checked in (visiting members) but their details stay masked.
    return { rows: people.map((p, i) => {
      const masked = ctx.branchScope && p.branch_id && !ctx.branchScope.includes(p.branch_id)
      return { id: p.id, first_name: p.first_name, last_name: masked ? (p.last_name ? p.last_name[0] + '.' : null) : p.last_name,
        phone: masked ? (p.phone ? '•••• ' + String(p.phone).slice(-3) : null) : p.phone, status: p.status, branch_name: names.get(p.branch_id) || null, checked_in: cks[i].exists }
    }) }
  })
}

export { toDate }
