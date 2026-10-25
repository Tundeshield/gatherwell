// Platform operators only (users.is_platform_admin or PLATFORM_ADMIN_EMAILS). Being a church owner never grants this.
// Aggregates only — no member records or pastoral notes are exposed here.
import { q, one } from '../db.js'
import { notFound, oneOf, uuid, bad } from '../http.js'
import { audit } from '../util.js'

export default function (r) {
  r.get('/platform/summary', { auth: 'platform' }, async () => {
    const totals = await one(`SELECT (SELECT COUNT(*)::int FROM organisations) AS orgs,
                                     (SELECT COUNT(*)::int FROM organisations WHERE status = 'active') AS active_orgs,
                                     (SELECT COUNT(*)::int FROM branches) AS branches,
                                     (SELECT COUNT(*)::int FROM people) AS people,
                                     (SELECT COUNT(*)::int FROM checkins WHERE created_at > NOW() - INTERVAL '7 days') AS checkins_7d,
                                     (SELECT COUNT(*)::int FROM users) AS users`)
    const orgs = await q(`SELECT o.id, o.name, o.slug, o.status, o.plan, o.trial_ends_at, o.created_at, o.country,
                                 (SELECT COUNT(*)::int FROM branches b WHERE b.org_id = o.id) AS branches,
                                 (SELECT COUNT(*)::int FROM people p WHERE p.org_id = o.id) AS people,
                                 (SELECT COUNT(*)::int FROM gatherings g WHERE g.org_id = o.id) AS sessions,
                                 (SELECT COUNT(*)::int FROM memberships m WHERE m.org_id = o.id AND m.status = 'active') AS team,
                                 (SELECT MAX(c.created_at) FROM checkins c WHERE c.org_id = o.id) AS last_checkin_at,
                                 (SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = o.id AND m.role = 'owner' ORDER BY m.created_at LIMIT 1) AS owner_email
                            FROM organisations o ORDER BY o.created_at DESC LIMIT 500`)
    return { totals, orgs }
  })

  r.patch('/platform/orgs/:id', { auth: 'platform' }, async ({ ctx, params, body }) => {
    const status = oneOf(body.status, ['active', 'suspended', 'closed'], { name: 'Status' })
    if (!status) throw bad('Choose a status.')
    if (status === 'closed' && body.confirm !== 'close') throw bad('Type-confirm required to close an organisation.')
    const o = await one(`UPDATE organisations SET status = $2, updated_at = NOW() WHERE id = $1 RETURNING id, name, status`, [uuid(params.id), status])
    if (!o) throw notFound()
    await audit({ org: { id: o.id }, user: ctx.user }, `platform.org_${status}`, 'organisation', o.id, { by: ctx.user.email })
    return o
  })
}
