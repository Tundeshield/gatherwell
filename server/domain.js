// Shared domain logic: check-ins and automatic follow-ups (Firestore transactions).
import { conflict } from './http.js'
import { fb, col, F, toDate } from './firebase.js'

export const AUTO_REASONS = ['first_visit', 'second_visit', 'absence', 'event']
export const lockRef = (db, orgId, personId, reason) => col(db, orgId, 'followupKeys').doc(`${personId}_${reason}`)

function followupDoc({ branchId, person, personId, reason, title, dueAt, assigneeId = null, assigneeName = null, createdBy = null }) {
  return {
    person_id: personId, branch_id: branchId || null, reason, title: title || null, status: 'pending',
    assignee_user_id: assigneeId, assignee_name: assigneeName, due_at: dueAt, outcome: null, next_action: null,
    created_by: createdBy, created_at: new Date(), closed_at: null, attempts: 0, last_attempt_at: null,
    person_name: [person?.first_name, person?.last_name].filter(Boolean).join(' '),
  }
}

// Person counters for open follow-ups, recomputed from the snapshot read inside the transaction.
export function followupCounters(p, { add = [], remove = [] }) {
  const reasons = new Set(p.open_reasons || [])
  let open = p.open_followups || 0
  for (const r of add) { open++; if (r !== 'manual') reasons.add(r) }
  for (const r of remove) { open = Math.max(0, open - 1); reasons.delete(r) }
  return { open_followups: open, open_reasons: [...reasons], has_open_followup: open > 0 }
}

// Records a check-in. Returns { checkinId, firstTime, alreadyCheckedIn }.
export async function recordCheckin({ org, gathering, personId, method, answers = {}, user = null }) {
  const { db } = await fb()
  const C = (n) => col(db, org.id, n)
  const s = org.settings || {}
  return db.runTransaction(async (tx) => {
    const ckRef = C('checkins').doc(`${gathering.id}_${personId}`)
    const pRef = C('people').doc(personId)
    const gRef = C('gatherings').doc(gathering.id)
    const L = { first_visit: lockRef(db, org.id, personId, 'first_visit'), second_visit: lockRef(db, org.id, personId, 'second_visit'), absence: lockRef(db, org.id, personId, 'absence') }
    const [ck, ps, l1, l2, la] = await tx.getAll(ckRef, pRef, L.first_visit, L.second_visit, L.absence)
    if (ck.exists) return { checkinId: ck.id, firstTime: false, alreadyCheckedIn: true }
    if (!ps.exists) throw conflict('Person not found.')
    const p = ps.data()
    const visitsBefore = p.visit_count || 0
    // A first-time visitor is a visitor with no previous check-ins (existing members' first recorded check-in doesn't count).
    const firstTime = visitsBefore === 0 && p.status === 'visitor'
    const visits = visitsBefore + 1
    const now = new Date()
    const startsAt = toDate(gathering.starts_at)
    const seenAt = startsAt > now ? now : startsAt
    const add = [], remove = []

    tx.set(ckRef, {
      gathering_id: gathering.id, person_id: personId, branch_id: gathering.branch_id, first_time: firstTime, method, answers,
      created_at: now, created_by: user?.id || null, created_by_name: user?.name || null,
      first_name: p.first_name, last_name: p.last_name || null, phone: p.phone || null, person_status: p.status,
      gathering_name: gathering.name, starts_at: startsAt,
    })

    const closeFollowup = (lockSnap, outcome) => {
      tx.set(C('followups').doc(lockSnap.data().followup_id), { status: 'done', outcome, closed_at: now }, { merge: true })
      tx.delete(lockSnap.ref)
    }
    const openFollowup = (reason, title, dueHours) => {
      const ref = C('followups').doc()
      tx.set(ref, followupDoc({ branchId: gathering.branch_id, person: p, personId, reason, title, dueAt: new Date(now.getTime() + dueHours * 3600e3) }))
      tx.set(L[reason], { followup_id: ref.id, created_at: now })
      add.push(reason)
    }

    if (p.status === 'visitor') {
      if (visits === 1 && s.firstVisitFollowup !== false && !l1.exists) {
        openFollowup('first_visit', `Welcome first-time visitor (${gathering.name})`, s.firstVisitHours || 48)
      } else if (visits === 2 && s.secondVisitFollowup !== false) {
        // The welcome call is no longer the right action once they've come back.
        if (l1.exists) { closeFollowup(l1, 'Returned for a second visit'); remove.push('first_visit') }
        if (!l2.exists) openFollowup('second_visit', 'Second visit — invite to connect', 72)
      }
    }
    // Someone flagged for absence has come back: close the case, keeping the history.
    if (la.exists) { closeFollowup(la, `Returned — checked in at ${gathering.name}`); remove.push('absence') }

    const lastSeen = p.last_seen_at && toDate(p.last_seen_at) > seenAt ? p.last_seen_at : seenAt
    tx.update(pRef, {
      visit_count: visits, first_visit_at: p.first_visit_at || seenAt, first_time_at: firstTime ? seenAt : (p.first_time_at || null),
      last_seen_at: lastSeen, updated_at: now, ...followupCounters(p, { add, remove }),
    })
    tx.update(gRef, { attendance: F.inc(1), first_timers: F.inc(firstTime ? 1 : 0), manual: F.inc(method === 'manual' ? 1 : 0) })
    return { checkinId: ckRef.id, firstTime, alreadyCheckedIn: false }
  })
}

// Creates an automatic follow-up unless one is already open for that person and reason.
export async function createAutoFollowup({ orgId, personId, reason, title, dueAt = null, dueHours = 48, assigneeId = null, assigneeName = null, createdBy = null }) {
  const { db } = await fb()
  return db.runTransaction(async (tx) => {
    const pRef = col(db, orgId, 'people').doc(personId)
    const lRef = lockRef(db, orgId, personId, reason)
    const [ps, ls] = await tx.getAll(pRef, lRef)
    if (!ps.exists || ls.exists) return null
    const p = ps.data()
    const ref = col(db, orgId, 'followups').doc()
    tx.set(ref, followupDoc({ branchId: p.branch_id, person: p, personId, reason, title, dueAt: dueAt ? new Date(dueAt) : new Date(Date.now() + dueHours * 3600e3), assigneeId, assigneeName, createdBy }))
    tx.set(lRef, { followup_id: ref.id, created_at: new Date() })
    tx.update(pRef, followupCounters(p, { add: [reason] }))
    return ref.id
  })
}

export { followupDoc }

export const personName = (p) => [p.first_name, p.last_name].filter(Boolean).join(' ')

export function toCsv(rows, columns) {
  const esc = (v) => {
    if (v === null || v === undefined) return ''
    let s = v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v)
    // Neutralise spreadsheet formula injection.
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const head = columns.map(c => esc(c.label)).join(',')
  const body = rows.map(r => columns.map(c => esc(typeof c.value === 'function' ? c.value(r) : r[c.value])).join(',')).join('\n')
  return '﻿' + head + '\n' + body + '\n'
}

export function csvResponse(csv, filename) {
  return new Response(csv, {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${filename.replace(/[^\w.-]/g, '_')}"`,
      'cache-control': 'no-store',
    },
  })
}
