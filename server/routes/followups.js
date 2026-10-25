import { fb, col, docOut, plain, getMany, ms, F } from '../firebase.js'
import { bad, notFound, conflict, str, oneOf, int, uuid, date, isUuid } from '../http.js'
import { requireCap, branchFilter, assertRowScope, orgBranches } from '../access.js'
import { audit, startOfDayInTz } from '../util.js'
import { createAutoFollowup, followupCounters, followupDoc, lockRef } from '../domain.js'

const STATUSES = ['pending', 'in_progress', 'done', 'cancelled']
const REASONS = ['first_visit', 'second_visit', 'absence', 'event', 'manual']
const NOTE_KINDS = ['call', 'message', 'visit', 'note', 'no_answer']
const OPEN = ['pending', 'in_progress']

async function assignee(db, ctx, userId) {
  if (!userId) return { id: null, name: null }
  const m = await db.collection('memberships').doc(`${ctx.org.id}_${String(userId)}`).get()
  if (!m.exists || m.data().status !== 'active') throw bad('That team member was not found.')
  return { id: m.data().user_id, name: m.data().user_name }
}

async function loadFollowup(ctx, id) {
  const { db } = await fb()
  const f = docOut(await col(db, ctx.org.id, 'followups').doc(uuid(id, { required: true })).get())
  return assertRowScope(ctx, f)
}

// Changes a follow-up's open/closed state, keeping lock docs and person counters consistent.
export async function closeFollowup(ctx, followupId, status, outcome, extra = {}) {
  const { db } = await fb()
  const fRef = col(db, ctx.org.id, 'followups').doc(followupId)
  return db.runTransaction(async (tx) => {
    const fs = await tx.get(fRef)
    const f = fs.data()
    if (!f) throw notFound()
    const pRef = col(db, ctx.org.id, 'people').doc(f.person_id)
    const lRef = f.reason !== 'manual' ? lockRef(db, ctx.org.id, f.person_id, f.reason) : null
    const [ps, ls] = await tx.getAll(pRef, ...(lRef ? [lRef] : []))
    const wasOpen = OPEN.includes(f.status)
    const nowOpen = OPEN.includes(status)
    const patch = { status, ...extra }
    if (outcome) patch.outcome = outcome
    if (wasOpen && !nowOpen) {
      patch.closed_at = new Date()
      if (lRef && ls?.exists && ls.data().followup_id === followupId) tx.delete(lRef)
      if (ps.exists) tx.update(pRef, followupCounters(ps.data(), { remove: [f.reason] }))
    } else if (!wasOpen && nowOpen) {
      if (lRef && ls?.exists && ls.data().followup_id !== followupId) throw conflict('This person already has another open follow-up for the same reason.')
      patch.closed_at = null
      if (lRef) tx.set(lRef, { followup_id: followupId, created_at: new Date() })
      if (ps.exists) tx.update(pRef, followupCounters(ps.data(), { add: [f.reason] }))
    }
    tx.update(fRef, patch)
    return f
  })
}

export default function (r) {
  r.get('/followups', async ({ ctx, query }) => {
    requireCap(ctx, 'followups.view')
    const { db } = await fb()
    const branches = await branchFilter(ctx, query.branch)
    const tz = ctx.org.timezone || 'UTC'
    const sod = startOfDayInTz(tz).getTime()
    const eod = sod + 86400e3
    const since30 = new Date(Date.now() - 30 * 86400e3)
    const fcol = col(db, ctx.org.id, 'followups')
    const [openQs, doneQs] = await Promise.all([
      fcol.where('status', 'in', OPEN).limit(3000).get(),
      fcol.where('status', 'in', ['done', 'cancelled']).where('closed_at', '>=', since30).orderBy('closed_at', 'desc').limit(1000).get(),
    ])
    const keep = (f) => (!branches || branches.includes(f.branch_id)) &&
      (!REASONS.includes(query.reason) || f.reason === query.reason) &&
      (query.assignee === 'me' ? f.assignee_user_id === ctx.user.id : query.assignee === 'unassigned' ? !f.assignee_user_id : isUuid(query.assignee) ? f.assignee_user_id === query.assignee : true) &&
      (!isUuid(query.person) || f.person_id === query.person)
    const open = openQs.docs.map(d => ({ id: d.id, ...plain(d.data()) })).filter(keep)
    const done = doneQs.docs.map(d => ({ id: d.id, ...plain(d.data()) })).filter(keep)
    const due = (f) => ms(f.due_at)
    const buckets = {
      overdue: open.filter(f => due(f) < sod), today: open.filter(f => due(f) >= sod && due(f) < eod), upcoming: open.filter(f => due(f) >= eod), open, done,
    }
    const counts = { overdue: buckets.overdue.length, today: buckets.today.length, upcoming: buckets.upcoming.length, open: open.length, done_30d: done.length }
    const bucket = buckets[query.bucket] ? query.bucket : 'open'
    let list = buckets[bucket]
    if (bucket !== 'done') list = [...list].sort((a, b) => due(a) - due(b))
    // When filtering by one person, include their closed history too.
    if (isUuid(query.person) && bucket === 'open') list = [...list, ...done]
    const limit = Math.min(int(query.limit) || 50, 200)
    const offset = Math.max(int(query.offset) || 0, 0)
    const page = list.slice(offset, offset + limit)
    const people = await getMany(db, page.map(f => col(db, ctx.org.id, 'people').doc(f.person_id)))
    const names = new Map((await orgBranches(ctx)).map(b => [b.id, b.name]))
    const rows = page.map((f, i) => {
      const p = people[i].exists ? people[i].data() : {}
      return {
        id: f.id, reason: f.reason, title: f.title, status: f.status, due_at: f.due_at, outcome: f.outcome, next_action: f.next_action, closed_at: f.closed_at,
        created_at: f.created_at, branch_id: f.branch_id, assignee_user_id: f.assignee_user_id, assignee_name: f.assignee_name, person_id: f.person_id,
        first_name: p.first_name || f.person_name || 'Removed', last_name: p.last_name || null, phone: p.phone || null, person_status: p.status || null,
        visit_count: p.visit_count || 0, last_seen_at: plain(p.last_seen_at) || null, branch_name: names.get(f.branch_id) || null,
        attempts: f.attempts || 0, last_attempt_at: f.last_attempt_at,
      }
    })
    return { rows, counts, bucket, total: list.length }
  })

  r.get('/followups/:id', async ({ ctx, params }) => {
    requireCap(ctx, 'followups.view')
    const { db } = await fb()
    const f = await loadFollowup(ctx, params.id)
    const [ps, notes] = await Promise.all([
      col(db, ctx.org.id, 'people').doc(f.person_id).get(),
      col(db, ctx.org.id, 'followups').doc(f.id).collection('notes').orderBy('created_at', 'desc').get(),
    ])
    const p = ps.exists ? plain(ps.data()) : { first_name: f.person_name || 'Removed' }
    return {
      followup: f,
      person: { id: f.person_id, first_name: p.first_name, last_name: p.last_name || null, phone: p.phone || null, email: p.email || null, status: p.status || null,
        visit_count: p.visit_count || 0, first_visit_at: p.first_visit_at || null, last_seen_at: p.last_seen_at || null },
      notes: notes.docs.map(d => ({ id: d.id, ...plain(d.data()) })),
    }
  })

  r.post('/followups', async ({ ctx, body }) => {
    requireCap(ctx, 'followups.manage')
    const { db } = await fb()
    const pRef = col(db, ctx.org.id, 'people').doc(uuid(body.personId, { required: true, name: 'Person' }))
    const p0 = docOut(await pRef.get())
    assertRowScope(ctx, p0)
    const who = await assignee(db, ctx, body.assigneeUserId)
    const title = str(body.title, { required: true, max: 160, name: 'Reason' })
    const dueAt = new Date(date(body.dueAt, { name: 'Due date' }) || Date.now() + 2 * 86400e3)
    const ref = col(db, ctx.org.id, 'followups').doc()
    await db.runTransaction(async (tx) => {
      const ps = await tx.get(pRef)
      tx.set(ref, { ...followupDoc({ branchId: p0.branch_id, person: p0, personId: p0.id, reason: 'manual', title, dueAt, assigneeId: who.id, assigneeName: who.name, createdBy: ctx.user.id }), next_action: str(body.nextAction, { max: 300 }) })
      tx.update(pRef, followupCounters(ps.data(), { add: ['manual'] }))
    })
    await audit(ctx, 'followup.created', 'followup', ref.id, { name: p0.first_name })
    return docOut(await ref.get())
  })

  r.patch('/followups/:id', async ({ ctx, params, body }) => {
    requireCap(ctx, 'followups.manage')
    const { db } = await fb()
    const f = await loadFollowup(ctx, params.id)
    const status = oneOf(body.status, STATUSES, { name: 'Status' })
    const extra = {}
    if (body.assigneeUserId !== undefined) { const w = await assignee(db, ctx, body.assigneeUserId); extra.assignee_user_id = w.id; extra.assignee_name = w.name }
    if (body.dueAt) extra.due_at = new Date(date(body.dueAt, { name: 'Due date' }))
    if (body.nextAction !== undefined) extra.next_action = str(body.nextAction, { max: 300 })
    if (body.title) extra.title = str(body.title, { max: 160 })
    const outcome = str(body.outcome, { max: 1000 })
    if (status && status !== f.status) {
      await closeFollowup(ctx, f.id, status, outcome, extra)
      await audit(ctx, `followup.${status}`, 'followup', f.id, { name: f.person_name })
    } else {
      if (outcome) extra.outcome = outcome
      if (Object.keys(extra).length) await col(db, ctx.org.id, 'followups').doc(f.id).update(extra)
    }
    return docOut(await col(db, ctx.org.id, 'followups').doc(f.id).get())
  })

  r.post('/followups/:id/notes', async ({ ctx, params, body }) => {
    requireCap(ctx, 'followups.manage')
    const { db } = await fb()
    const f = await loadFollowup(ctx, params.id)
    const kind = oneOf(body.kind, NOTE_KINDS, { name: 'Type', fallback: 'note' })
    const text = str(body.body, { max: 2000, name: 'Note' })
    if (!text && kind === 'note') throw bad('Write a note.')
    const fRef = col(db, ctx.org.id, 'followups').doc(f.id)
    const nRef = fRef.collection('notes').doc()
    const now = new Date()
    const note = { kind, body: text, user_id: ctx.user.id, user_name: ctx.user.name, created_at: now }
    const b = db.batch()
    b.set(nRef, note)
    b.update(fRef, { attempts: F.inc(1), last_attempt_at: now, ...(f.status === 'pending' ? { status: 'in_progress' } : {}) })
    await b.commit()
    return { id: nRef.id, ...plain(note) }
  })

  // Members past the absence threshold who don't already have an open absence case.
  r.get('/followups/absence/candidates', async ({ ctx, query }) => {
    requireCap(ctx, 'followups.view')
    const { db } = await fb()
    const weeks = Number(ctx.org.settings?.absenceWeeks || 3)
    const branches = await branchFilter(ctx, query.branch)
    const qs = await col(db, ctx.org.id, 'people').where('status', '==', 'member').where('last_seen_at', '<', new Date(Date.now() - weeks * 7 * 86400e3))
      .orderBy('last_seen_at', 'desc').limit(1500).get()
    const names = new Map((await orgBranches(ctx)).map(b => [b.id, b.name]))
    const rows = qs.docs.map(d => ({ id: d.id, ...d.data() }))
      .filter(p => (!branches || branches.includes(p.branch_id)) && !(p.open_reasons || []).includes('absence'))
      .slice(0, 500)
      .map(p => ({ id: p.id, first_name: p.first_name, last_name: p.last_name || null, phone: p.phone || null, last_seen_at: plain(p.last_seen_at), visit_count: p.visit_count || 0, branch_name: names.get(p.branch_id) || null }))
    return { rows, weeks }
  })

  r.post('/followups/absence', async ({ ctx, body }) => {
    requireCap(ctx, 'followups.manage')
    const { db } = await fb()
    const ids = [...new Set((Array.isArray(body.personIds) ? body.personIds : []).filter(isUuid))].slice(0, 500)
    if (!ids.length) throw bad('Select at least one person.')
    const who = await assignee(db, ctx, body.assigneeUserId)
    const dueAt = date(body.dueAt, { name: 'Due date' })
    const snaps = await getMany(db, ids.map(id => col(db, ctx.org.id, 'people').doc(id)))
    const people = snaps.filter(s => s.exists && s.data().status === 'member' && (!ctx.branchScope || ctx.branchScope.includes(s.data().branch_id)))
    let created = 0
    for (const p of people) {
      const id = await createAutoFollowup({ orgId: ctx.org.id, personId: p.id, reason: 'absence', title: 'Check in — not seen recently', dueAt, dueHours: 72, assigneeId: who.id, assigneeName: who.name, createdBy: ctx.user.id })
      if (id) created++
    }
    await audit(ctx, 'followup.absence_created', 'followup', null, { created })
    return { created, skipped: people.length - created }
  })
}
