// Shared domain logic: check-ins and automatic follow-ups.
import { conflict } from './http.js'

const OPEN = `status IN ('pending','in_progress') AND reason <> 'manual'`

// Records a check-in inside an existing transaction `c`. Returns { checkin, firstTime, alreadyCheckedIn }.
export async function recordCheckin(c, { org, gathering, personId, method, answers = {}, userId = null }) {
  const person = await c.one(`SELECT id, status, visit_count, first_visit_at FROM people WHERE id = $1 AND org_id = $2 FOR UPDATE`, [personId, org.id])
  if (!person) throw conflict('Person not found.')
  // A first-time visitor is a visitor with no previous check-ins (existing members' first recorded check-in doesn't count).
  const firstTime = person.visit_count === 0 && person.status === 'visitor'
  const checkin = await c.one(
    `INSERT INTO checkins (org_id, branch_id, gathering_id, person_id, method, first_time, answers, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (gathering_id, person_id) DO NOTHING RETURNING *`,
    [org.id, gathering.branch_id, gathering.id, personId, method, firstTime, answers, userId])
  if (!checkin) return { checkin: null, firstTime: false, alreadyCheckedIn: true }

  const seenAt = new Date(gathering.starts_at) > new Date() ? new Date().toISOString() : gathering.starts_at
  await c.q(`UPDATE people SET visit_count = visit_count + 1,
               first_visit_at = COALESCE(first_visit_at, $2),
               last_seen_at = GREATEST(COALESCE(last_seen_at, $2), $2),
               updated_at = NOW() WHERE id = $1`, [personId, seenAt])

  const s = org.settings || {}
  const visits = person.visit_count + 1
  if (person.status === 'visitor') {
    if (visits === 1 && s.firstVisitFollowup !== false) {
      await createAutoFollowup(c, { orgId: org.id, branchId: gathering.branch_id, personId, reason: 'first_visit',
        title: `Welcome first-time visitor (${gathering.name})`, dueHours: s.firstVisitHours || 48 })
    } else if (visits === 2 && s.secondVisitFollowup !== false) {
      // The welcome call is no longer the right action once they've come back.
      await c.q(`UPDATE followups SET status = 'done', outcome = COALESCE(outcome, 'Returned for a second visit'), closed_at = NOW()
                  WHERE person_id = $1 AND reason = 'first_visit' AND ${OPEN}`, [personId])
      await createAutoFollowup(c, { orgId: org.id, branchId: gathering.branch_id, personId, reason: 'second_visit',
        title: 'Second visit — invite to connect', dueHours: 72 })
    }
  }
  // Someone flagged for absence has come back: close the case, keeping the history.
  await c.q(`UPDATE followups SET status = 'done', outcome = COALESCE(outcome, 'Returned — checked in at ' || $2), closed_at = NOW()
              WHERE person_id = $1 AND reason = 'absence' AND ${OPEN}`, [personId, gathering.name])
  return { checkin, firstTime, alreadyCheckedIn: false }
}

export async function createAutoFollowup(c, { orgId, branchId, personId, reason, title, dueHours = 48, dueAt = null, assignee = null, createdBy = null }) {
  return c.one(
    `INSERT INTO followups (org_id, branch_id, person_id, reason, title, due_at, assignee_user_id, created_by)
     VALUES ($1,$2,$3,$4,$5, COALESCE($6::timestamptz, NOW() + make_interval(hours => $7)), $8, $9)
     ON CONFLICT (person_id, reason) WHERE ${OPEN} DO NOTHING RETURNING id`,
    [orgId, branchId, personId, reason, title, dueAt, dueHours, assignee, createdBy])
}

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
