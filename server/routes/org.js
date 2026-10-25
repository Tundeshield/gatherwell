import { q, one, tx } from '../db.js'
import { bad, forbidden, notFound, str, email as emailV, oneOf, int, uuid, isUuid } from '../http.js'
import { requireCap, assertBranch, ROLE_LABELS } from '../access.js'
import { randomToken, sha256, audit, sanitizeForm } from '../util.js'

const INVITE_ROLES = ['admin', 'lead', 'usher', 'viewer']

function assignableRoles(ctx) {
  const m = ctx.membership
  if (m.role === 'owner') return ['owner', 'admin', 'lead', 'usher', 'viewer']
  if (m.role === 'admin' && !m.branch_ids) return ['admin', 'lead', 'usher', 'viewer']
  if (m.role === 'admin') return ['lead', 'usher', 'viewer']
  return []
}

async function cleanBranchIds(ctx, ids) {
  if (ids === null || ids === undefined || (Array.isArray(ids) && ids.length === 0)) {
    if (ctx.branchScope) throw forbidden('You can only give access to the branches you manage.')
    return null
  }
  if (!Array.isArray(ids)) throw bad('Branches must be a list.')
  const unique = [...new Set(ids.filter(isUuid))]
  if (!unique.length) throw bad('Choose at least one branch.')
  const rows = await q(`SELECT id FROM branches WHERE org_id = $1 AND id = ANY($2)`, [ctx.org.id, unique])
  if (rows.length !== unique.length) throw bad('One of those branches was not found.')
  if (ctx.branchScope && unique.some(id => !ctx.branchScope.includes(id))) throw forbidden('You can only give access to the branches you manage.')
  return unique
}

// Scoped admins only manage members whose access sits entirely inside their own branches.
function canManageMember(ctx, target) {
  if (target.user_id === ctx.user.id) return false
  if (target.role === 'owner' && ctx.membership.role !== 'owner') return false
  if (ctx.branchScope) {
    if (!target.branch_ids) return false
    if (target.branch_ids.some(id => !ctx.branchScope.includes(id))) return false
  }
  return true
}

export default function (r) {
  // --- organisation settings ------------------------------------------------------
  r.patch('/org', async ({ ctx, body }) => {
    requireCap(ctx, 'org.manage')
    const o = ctx.org
    const s = { ...(o.settings || {}) }
    const inS = body.settings || {}
    if (inS.absenceWeeks !== undefined) s.absenceWeeks = int(inS.absenceWeeks, { min: 1, max: 26, name: 'Absence weeks' })
    if (inS.firstVisitFollowup !== undefined) s.firstVisitFollowup = !!inS.firstVisitFollowup
    if (inS.firstVisitHours !== undefined) s.firstVisitHours = int(inS.firstVisitHours, { min: 1, max: 336, name: 'Follow-up window' })
    if (inS.secondVisitFollowup !== undefined) s.secondVisitFollowup = !!inS.secondVisitFollowup
    if (inS.defaultCountryCode !== undefined) s.defaultCountryCode = String(inS.defaultCountryCode).replace(/\D/g, '').slice(0, 4) || '234'
    const row = await one(
      `UPDATE organisations SET name = COALESCE($2, name), timezone = COALESCE($3, timezone), country = COALESCE($4, country),
              contact_email = COALESCE($5, contact_email), contact_phone = COALESCE($6, contact_phone), settings = $7, updated_at = NOW()
        WHERE id = $1 RETURNING id`,
      [o.id, str(body.name, { max: 120, name: 'Name' }), str(body.timezone, { max: 64 }), str(body.country, { max: 64 }),
        body.contactEmail ? emailV(body.contactEmail) : null, str(body.contactPhone, { max: 40 }), s])
    await audit(ctx, 'org.updated', 'organisation', row.id)
    return { ok: true }
  })

  // --- branches ---------------------------------------------------------------------
  r.get('/branches', async ({ ctx }) => {
    return q(`SELECT b.*, (SELECT COUNT(*)::int FROM people p WHERE p.branch_id = b.id AND p.status <> 'archived') AS people_count
                FROM branches b WHERE b.org_id = $1 AND ($2::uuid[] IS NULL OR b.id = ANY($2)) ORDER BY b.status, b.name`, [ctx.org.id, ctx.branchScope])
  })

  r.post('/branches', async ({ ctx, body }) => {
    requireCap(ctx, 'branches.create')
    const b = await one(`INSERT INTO branches (org_id, name, address, phone, timezone) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [ctx.org.id, str(body.name, { required: true, max: 120, name: 'Branch name' }), str(body.address, { max: 300 }), str(body.phone, { max: 40 }), str(body.timezone, { max: 64 })])
    await audit(ctx, 'branch.created', 'branch', b.id, { name: b.name })
    return b
  })

  r.patch('/branches/:id', async ({ ctx, params, body }) => {
    requireCap(ctx, 'branches.manage')
    await assertBranch(ctx, params.id)
    const status = oneOf(body.status, ['active', 'archived'], { name: 'Status' })
    if (status === 'archived') {
      const active = await one(`SELECT COUNT(*)::int AS n FROM branches WHERE org_id = $1 AND status = 'active' AND id <> $2`, [ctx.org.id, params.id])
      if (active.n === 0) throw bad('You need at least one active branch.')
    }
    const b = await one(`UPDATE branches SET name = COALESCE($3, name), address = COALESCE($4, address), phone = COALESCE($5, phone),
                           timezone = COALESCE($6, timezone), status = COALESCE($7, status), updated_at = NOW()
                          WHERE id = $1 AND org_id = $2 RETURNING *`,
      [params.id, ctx.org.id, str(body.name, { max: 120 }), str(body.address, { max: 300 }), str(body.phone, { max: 40 }), str(body.timezone, { max: 64 }), status])
    await audit(ctx, status === 'archived' ? 'branch.archived' : 'branch.updated', 'branch', b.id)
    return b
  })

  // --- service units ------------------------------------------------------------------
  r.get('/units', async ({ ctx }) => {
    return q(`SELECT u.*, b.name AS branch_name,
                     (SELECT COUNT(*)::int FROM people p WHERE p.unit_id = u.id AND p.status <> 'archived') AS member_count,
                     lp.first_name || COALESCE(' ' || lp.last_name, '') AS leader_name
                FROM units u LEFT JOIN branches b ON b.id = u.branch_id
                LEFT JOIN people lp ON lp.id = u.leader_person_id AND lp.org_id = u.org_id
               WHERE u.org_id = $1 AND ($2::uuid[] IS NULL OR u.branch_id IS NULL OR u.branch_id = ANY($2))
               ORDER BY u.name`, [ctx.org.id, ctx.branchScope])
  })

  r.post('/units', async ({ ctx, body }) => {
    requireCap(ctx, 'units.manage')
    const branchId = body.branchId ? (await assertBranch(ctx, body.branchId)).id : null
    if (!branchId && ctx.branchScope) throw forbidden('Choose one of your branches for this unit.')
    const leader = await validLeader(ctx, body.leaderPersonId)
    const u = await one(`INSERT INTO units (org_id, branch_id, name, description, leader_person_id) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [ctx.org.id, branchId, str(body.name, { required: true, max: 80, name: 'Unit name' }), str(body.description, { max: 500 }), leader])
    await audit(ctx, 'unit.created', 'unit', u.id)
    return u
  })

  r.patch('/units/:id', async ({ ctx, params, body }) => {
    requireCap(ctx, 'units.manage')
    const u = await one(`SELECT * FROM units WHERE id = $1 AND org_id = $2`, [uuid(params.id), ctx.org.id])
    if (!u || (ctx.branchScope && (!u.branch_id || !ctx.branchScope.includes(u.branch_id)))) throw notFound()
    const leader = body.leaderPersonId === null ? null : (body.leaderPersonId ? await validLeader(ctx, body.leaderPersonId) : u.leader_person_id)
    return one(`UPDATE units SET name = COALESCE($3, name), description = COALESCE($4, description), leader_person_id = $5 WHERE id = $1 AND org_id = $2 RETURNING *`,
      [u.id, ctx.org.id, str(body.name, { max: 80 }), str(body.description, { max: 500 }), leader])
  })

  r.delete('/units/:id', async ({ ctx, params }) => {
    requireCap(ctx, 'units.manage')
    const u = await one(`SELECT * FROM units WHERE id = $1 AND org_id = $2`, [uuid(params.id), ctx.org.id])
    if (!u || (ctx.branchScope && (!u.branch_id || !ctx.branchScope.includes(u.branch_id)))) throw notFound()
    await q(`DELETE FROM units WHERE id = $1 AND org_id = $2`, [u.id, ctx.org.id])
    await audit(ctx, 'unit.deleted', 'unit', u.id, { name: u.name })
    return { ok: true }
  })

  // --- attendance templates -------------------------------------------------------------
  r.get('/templates', async ({ ctx }) => {
    requireCap(ctx, 'attendance.view')
    return q(`SELECT * FROM gathering_templates WHERE org_id = $1 ORDER BY name`, [ctx.org.id])
  })
  r.post('/templates', async ({ ctx, body }) => {
    requireCap(ctx, 'attendance.manage')
    return one(`INSERT INTO gathering_templates (org_id, name, kind, form) VALUES ($1,$2,$3,$4) RETURNING *`,
      [ctx.org.id, str(body.name, { required: true, max: 80, name: 'Template name' }), str(body.kind, { max: 40 }) || 'service', JSON.stringify(sanitizeForm(body.form))])
  })
  r.delete('/templates/:id', async ({ ctx, params }) => {
    requireCap(ctx, 'attendance.manage')
    await q(`DELETE FROM gathering_templates WHERE id = $1 AND org_id = $2`, [uuid(params.id), ctx.org.id])
    return { ok: true }
  })

  // --- team -----------------------------------------------------------------------------
  r.get('/team', async ({ ctx }) => {
    requireCap(ctx, 'team.manage')
    const members = await q(`SELECT m.id, m.user_id, m.role, m.branch_ids, m.can_export, m.status, m.created_at, u.name, u.email, u.last_login_at
                               FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = $1 ORDER BY m.status, u.name`, [ctx.org.id])
    const invites = await q(`SELECT id, email, role, branch_ids, can_export, expires_at, created_at FROM invites
                              WHERE org_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > NOW() ORDER BY created_at DESC`, [ctx.org.id])
    const visible = (row) => !ctx.branchScope || (row.branch_ids && row.branch_ids.some(id => ctx.branchScope.includes(id)))
    return {
      members: members.filter(m => visible(m) || m.user_id === ctx.user.id).map(m => ({ ...m, roleLabel: ROLE_LABELS[m.role], manageable: canManageMember(ctx, m), isMe: m.user_id === ctx.user.id })),
      invites: invites.filter(visible).map(i => ({ ...i, roleLabel: ROLE_LABELS[i.role] })),
      assignableRoles: assignableRoles(ctx),
    }
  })

  r.post('/team/invites', async ({ ctx, body }) => {
    requireCap(ctx, 'team.manage')
    const email = emailV(body.email, { required: true })
    const role = oneOf(body.role, INVITE_ROLES, { name: 'Role' })
    if (!role) throw bad('Choose a role.')
    if (!assignableRoles(ctx).includes(role)) throw forbidden("You can't invite someone with that role.")
    const branchIds = await cleanBranchIds(ctx, body.branchIds)
    const canExport = !!body.canExport && (ctx.membership.role === 'owner' || ctx.membership.can_export) && role !== 'usher' && role !== 'viewer'
    const existing = await one(`SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = $1 AND u.email = $2 AND m.status = 'active'`, [ctx.org.id, email])
    if (existing) throw bad('That person is already on your team.')
    await q(`UPDATE invites SET revoked_at = NOW() WHERE org_id = $1 AND email = $2 AND accepted_at IS NULL AND revoked_at IS NULL`, [ctx.org.id, email])
    const token = randomToken(24)
    const inv = await one(`INSERT INTO invites (org_id, email, role, branch_ids, can_export, token_hash, expires_at, created_by)
                           VALUES ($1,$2,$3,$4,$5,$6, NOW() + INTERVAL '14 days', $7) RETURNING id, email, role, expires_at`,
      [ctx.org.id, email, role, branchIds, canExport, sha256(token), ctx.user.id])
    await audit(ctx, 'team.invited', 'invite', inv.id, { email, role })
    // No email provider is configured yet, so the admin shares the link themselves.
    return { ...inv, token, path: `/invite/${token}` }
  })

  r.delete('/team/invites/:id', async ({ ctx, params }) => {
    requireCap(ctx, 'team.manage')
    const inv = await one(`SELECT * FROM invites WHERE id = $1 AND org_id = $2`, [uuid(params.id), ctx.org.id])
    if (!inv) throw notFound()
    if (ctx.branchScope && (!inv.branch_ids || inv.branch_ids.some(id => !ctx.branchScope.includes(id)))) throw forbidden()
    await q(`UPDATE invites SET revoked_at = NOW() WHERE id = $1`, [inv.id])
    await audit(ctx, 'team.invite_revoked', 'invite', inv.id)
    return { ok: true }
  })

  r.patch('/team/members/:id', async ({ ctx, params, body }) => {
    requireCap(ctx, 'team.manage')
    const m = await one(`SELECT * FROM memberships WHERE id = $1 AND org_id = $2`, [uuid(params.id), ctx.org.id])
    if (!m) throw notFound()
    if (!canManageMember(ctx, m)) throw forbidden("You can't change this person's access.")
    const role = body.role !== undefined ? oneOf(body.role, ['owner', 'admin', 'lead', 'usher', 'viewer'], { name: 'Role' }) : m.role
    if (role !== m.role && !assignableRoles(ctx).includes(role)) throw forbidden("You can't give that role.")
    const branchIds = body.branchIds !== undefined ? await cleanBranchIds(ctx, body.branchIds) : m.branch_ids
    const status = body.status !== undefined ? oneOf(body.status, ['active', 'revoked'], { name: 'Status' }) : m.status
    const canExport = body.canExport !== undefined ? (!!body.canExport && (ctx.membership.role === 'owner' || ctx.membership.can_export)) : m.can_export
    if (m.role === 'owner' && (role !== 'owner' || status !== 'active')) {
      const owners = await one(`SELECT COUNT(*)::int AS n FROM memberships WHERE org_id = $1 AND role = 'owner' AND status = 'active' AND id <> $2`, [ctx.org.id, m.id])
      if (owners.n === 0) throw bad('Every church needs at least one owner.')
    }
    const updated = await one(`UPDATE memberships SET role = $3, branch_ids = $4, status = $5, can_export = $6 WHERE id = $1 AND org_id = $2 RETURNING *`,
      [m.id, ctx.org.id, role, role === 'owner' ? null : branchIds, status, role === 'owner' ? true : canExport])
    if (status === 'revoked') await q(`DELETE FROM auth_sessions WHERE user_id = $1 AND active_org_id = $2`, [m.user_id, ctx.org.id])
    await audit(ctx, status === 'revoked' ? 'team.revoked' : 'team.updated', 'membership', m.id, { role, branchIds, status })
    return updated
  })

  // Names only — for assigning follow-ups and pastoral contacts.
  r.get('/team/assignees', async ({ ctx }) => {
    if (!ctx.caps.includes('followups.manage') && !ctx.caps.includes('people.edit')) throw forbidden()
    return q(`SELECT u.id AS user_id, u.name FROM memberships m JOIN users u ON u.id = m.user_id
               WHERE m.org_id = $1 AND m.status = 'active' AND m.role IN ('owner','admin','lead') ORDER BY u.name`, [ctx.org.id])
  })

  r.get('/audit', async ({ ctx, query }) => {
    requireCap(ctx, 'org.manage')
    return q(`SELECT a.id, a.action, a.entity, a.entity_id, a.meta, a.created_at, u.name AS user_name
                FROM audit_log a LEFT JOIN users u ON u.id = a.user_id WHERE a.org_id = $1 ORDER BY a.created_at DESC LIMIT $2`,
      [ctx.org.id, Math.min(int(query.limit) || 100, 300)])
  })
}

async function validLeader(ctx, personId) {
  if (!personId) return null
  const p = await one(`SELECT id FROM people WHERE id = $1 AND org_id = $2`, [uuid(personId), ctx.org.id])
  if (!p) throw bad('Unit leader not found.')
  return p.id
}
