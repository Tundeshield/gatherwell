import { fb, col, docOut, docsOut, plain, getMany } from '../firebase.js'
import { bad, forbidden, notFound, str, email as emailV, oneOf, int, uuid, isUuid } from '../http.js'
import { requireCap, assertBranch, orgBranches, ROLE_LABELS, membershipId } from '../access.js'
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
  const all = new Set((await orgBranches(ctx)).map(b => b.id))
  if (unique.some(id => !all.has(id))) throw bad('One of those branches was not found.')
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

async function validLeader(db, ctx, personId) {
  if (!personId) return null
  const p = await col(db, ctx.org.id, 'people').doc(uuid(personId)).get()
  if (!p.exists) throw bad('Unit leader not found.')
  return p.id
}

export default function (r) {
  // --- organisation settings ------------------------------------------------------
  r.patch('/org', async ({ ctx, body }) => {
    requireCap(ctx, 'org.manage')
    const { db } = await fb()
    const s = { ...(ctx.org.settings || {}) }
    const inS = body.settings || {}
    if (inS.absenceWeeks !== undefined) s.absenceWeeks = int(inS.absenceWeeks, { min: 1, max: 26, name: 'Absence weeks' })
    if (inS.firstVisitFollowup !== undefined) s.firstVisitFollowup = !!inS.firstVisitFollowup
    if (inS.firstVisitHours !== undefined) s.firstVisitHours = int(inS.firstVisitHours, { min: 1, max: 336, name: 'Follow-up window' })
    if (inS.secondVisitFollowup !== undefined) s.secondVisitFollowup = !!inS.secondVisitFollowup
    if (inS.defaultCountryCode !== undefined) s.defaultCountryCode = String(inS.defaultCountryCode).replace(/\D/g, '').slice(0, 4) || '234'
    const patch = { settings: s, updated_at: new Date() }
    const name = str(body.name, { max: 120, name: 'Name' }); if (name) patch.name = name
    const tz = str(body.timezone, { max: 64 }); if (tz) patch.timezone = tz
    const country = str(body.country, { max: 64 }); if (country) patch.country = country
    if (body.contactEmail !== undefined) patch.contact_email = body.contactEmail ? emailV(body.contactEmail) : null
    if (body.contactPhone !== undefined) patch.contact_phone = str(body.contactPhone, { max: 40 })
    await db.collection('orgs').doc(ctx.org.id).update(patch)
    await audit(ctx, 'org.updated', 'organisation', ctx.org.id)
    return { ok: true }
  })

  // --- branches ---------------------------------------------------------------------
  r.get('/branches', async ({ ctx }) => {
    const { db } = await fb()
    const branches = (await orgBranches(ctx)).filter(b => !ctx.branchScope || ctx.branchScope.includes(b.id))
    const counts = await Promise.all(branches.map(b => col(db, ctx.org.id, 'people').where('branch_id', '==', b.id).count().get()))
    return branches.map((b, i) => ({ ...plain(b), people_count: counts[i].data().count }))
      .sort((a, b) => (a.status === b.status ? a.name.localeCompare(b.name) : a.status === 'active' ? -1 : 1))
  })

  r.post('/branches', async ({ ctx, body }) => {
    requireCap(ctx, 'branches.create')
    const { db } = await fb()
    const data = { name: str(body.name, { required: true, max: 120, name: 'Branch name' }), address: str(body.address, { max: 300 }), phone: str(body.phone, { max: 40 }),
      timezone: str(body.timezone, { max: 64 }), status: 'active', created_at: new Date(), updated_at: new Date() }
    const ref = await col(db, ctx.org.id, 'branches').add(data)
    await audit(ctx, 'branch.created', 'branch', ref.id, { name: data.name })
    return { id: ref.id, ...plain(data) }
  })

  r.patch('/branches/:id', async ({ ctx, params, body }) => {
    requireCap(ctx, 'branches.manage')
    await assertBranch(ctx, params.id)
    const { db } = await fb()
    const status = oneOf(body.status, ['active', 'archived'], { name: 'Status' })
    if (status === 'archived') {
      const others = (await orgBranches(ctx)).filter(b => b.status === 'active' && b.id !== params.id)
      if (!others.length) throw bad('You need at least one active branch.')
    }
    const patch = { updated_at: new Date() }
    for (const [k, max] of [['name', 120], ['address', 300], ['phone', 40], ['timezone', 64]]) { const v = str(body[k], { max }); if (v !== null) patch[k] = v }
    if (status) patch.status = status
    const ref = col(db, ctx.org.id, 'branches').doc(params.id)
    await ref.update(patch)
    await audit(ctx, status === 'archived' ? 'branch.archived' : 'branch.updated', 'branch', params.id)
    return docOut(await ref.get())
  })

  // --- service units ------------------------------------------------------------------
  r.get('/units', async ({ ctx }) => {
    const { db } = await fb()
    const units = docsOut(await col(db, ctx.org.id, 'units').get()).filter(u => !ctx.branchScope || !u.branch_id || ctx.branchScope.includes(u.branch_id))
    const branches = new Map((await orgBranches(ctx)).map(b => [b.id, b.name]))
    const [counts, leaders] = await Promise.all([
      Promise.all(units.map(u => col(db, ctx.org.id, 'people').where('unit_id', '==', u.id).count().get())),
      getMany(db, units.filter(u => u.leader_person_id).map(u => col(db, ctx.org.id, 'people').doc(u.leader_person_id))),
    ])
    const leaderName = new Map(leaders.filter(l => l.exists).map(l => [l.id, [l.data().first_name, l.data().last_name].filter(Boolean).join(' ')]))
    return units.map((u, i) => ({ ...u, branch_name: branches.get(u.branch_id) || null, member_count: counts[i].data().count, leader_name: leaderName.get(u.leader_person_id) || null }))
      .sort((a, b) => a.name.localeCompare(b.name))
  })

  r.post('/units', async ({ ctx, body }) => {
    requireCap(ctx, 'units.manage')
    const { db } = await fb()
    const branchId = body.branchId ? (await assertBranch(ctx, body.branchId)).id : null
    if (!branchId && ctx.branchScope) throw forbidden('Choose one of your branches for this unit.')
    const data = { branch_id: branchId, name: str(body.name, { required: true, max: 80, name: 'Unit name' }), description: str(body.description, { max: 500 }),
      leader_person_id: await validLeader(db, ctx, body.leaderPersonId), created_at: new Date() }
    const ref = await col(db, ctx.org.id, 'units').add(data)
    await audit(ctx, 'unit.created', 'unit', ref.id, { name: data.name })
    return { id: ref.id, ...plain(data) }
  })

  async function loadUnit(db, ctx, id) {
    const u = docOut(await col(db, ctx.org.id, 'units').doc(uuid(id)).get())
    if (!u || (ctx.branchScope && (!u.branch_id || !ctx.branchScope.includes(u.branch_id)))) throw notFound()
    return u
  }

  r.patch('/units/:id', async ({ ctx, params, body }) => {
    requireCap(ctx, 'units.manage')
    const { db } = await fb()
    const u = await loadUnit(db, ctx, params.id)
    const patch = {}
    const name = str(body.name, { max: 80 }); if (name) patch.name = name
    if (body.description !== undefined) patch.description = str(body.description, { max: 500 })
    if (body.leaderPersonId !== undefined) patch.leader_person_id = await validLeader(db, ctx, body.leaderPersonId)
    const ref = col(db, ctx.org.id, 'units').doc(u.id)
    await ref.update(patch)
    return docOut(await ref.get())
  })

  r.delete('/units/:id', async ({ ctx, params }) => {
    requireCap(ctx, 'units.manage')
    const { db } = await fb()
    const u = await loadUnit(db, ctx, params.id)
    const members = await col(db, ctx.org.id, 'people').where('unit_id', '==', u.id).get()
    for (let i = 0; i < members.docs.length; i += 400) {
      const b = db.batch()
      members.docs.slice(i, i + 400).forEach(d => b.update(d.ref, { unit_id: null }))
      await b.commit()
    }
    await col(db, ctx.org.id, 'units').doc(u.id).delete()
    await audit(ctx, 'unit.deleted', 'unit', u.id, { name: u.name })
    return { ok: true }
  })

  // --- attendance templates -------------------------------------------------------------
  r.get('/templates', async ({ ctx }) => {
    requireCap(ctx, 'attendance.view')
    const { db } = await fb()
    return docsOut(await col(db, ctx.org.id, 'templates').get()).sort((a, b) => a.name.localeCompare(b.name))
  })
  r.post('/templates', async ({ ctx, body }) => {
    requireCap(ctx, 'attendance.manage')
    const { db } = await fb()
    const data = { name: str(body.name, { required: true, max: 80, name: 'Template name' }), kind: str(body.kind, { max: 40 }) || 'service', form: sanitizeForm(body.form), created_at: new Date() }
    const ref = await col(db, ctx.org.id, 'templates').add(data)
    return { id: ref.id, ...plain(data) }
  })
  r.delete('/templates/:id', async ({ ctx, params }) => {
    requireCap(ctx, 'attendance.manage')
    const { db } = await fb()
    await col(db, ctx.org.id, 'templates').doc(uuid(params.id)).delete()
    return { ok: true }
  })

  // --- team -----------------------------------------------------------------------------
  r.get('/team', async ({ ctx }) => {
    requireCap(ctx, 'team.manage')
    const { db } = await fb()
    const [ms, inv] = await Promise.all([
      db.collection('memberships').where('org_id', '==', ctx.org.id).get(),
      db.collection('invites').where('org_id', '==', ctx.org.id).get(),
    ])
    const members = ms.docs.map(d => ({ id: d.id, ...plain(d.data()) }))
    const users = await getMany(db, members.map(m => db.collection('users').doc(m.user_id)))
    const lastLogin = new Map(users.filter(u => u.exists).map(u => [u.id, plain(u.data().last_login_at) || null]))
    const now = Date.now()
    const invites = inv.docs.map(d => ({ id: d.id, ...plain(d.data()) }))
      .filter(i => !i.accepted_at && !i.revoked_at && new Date(i.expires_at).getTime() > now)
      .map(({ token_hash, ...i }) => i)
    const visible = (row) => !ctx.branchScope || (row.branch_ids && row.branch_ids.some(id => ctx.branchScope.includes(id)))
    return {
      members: members.filter(m => visible(m) || m.user_id === ctx.user.id)
        .map(m => ({ id: m.id, user_id: m.user_id, role: m.role, branch_ids: m.branch_ids || null, can_export: !!m.can_export, status: m.status, created_at: m.created_at,
          name: m.user_name, email: m.user_email, last_login_at: lastLogin.get(m.user_id) || null, roleLabel: ROLE_LABELS[m.role], manageable: canManageMember(ctx, m), isMe: m.user_id === ctx.user.id }))
        .sort((a, b) => (a.status === b.status ? String(a.name).localeCompare(String(b.name)) : a.status === 'active' ? -1 : 1)),
      invites: invites.filter(visible).map(i => ({ ...i, roleLabel: ROLE_LABELS[i.role] })).sort((a, b) => b.created_at.localeCompare(a.created_at)),
      assignableRoles: assignableRoles(ctx),
    }
  })

  r.post('/team/invites', async ({ ctx, body }) => {
    requireCap(ctx, 'team.manage')
    const { db } = await fb()
    const email = emailV(body.email, { required: true })
    const role = oneOf(body.role, INVITE_ROLES, { name: 'Role' })
    if (!role) throw bad('Choose a role.')
    if (!assignableRoles(ctx).includes(role)) throw forbidden("You can't invite someone with that role.")
    const branchIds = await cleanBranchIds(ctx, body.branchIds)
    const canExport = !!body.canExport && (ctx.membership.role === 'owner' || ctx.membership.can_export) && role !== 'usher' && role !== 'viewer'
    const existing = await db.collection('memberships').where('org_id', '==', ctx.org.id).where('user_email', '==', email).where('status', '==', 'active').limit(1).get()
    if (!existing.empty) throw bad('That person is already on your team.')
    const open = await db.collection('invites').where('org_id', '==', ctx.org.id).where('email', '==', email).get()
    const batch = db.batch()
    open.docs.filter(d => !d.data().accepted_at && !d.data().revoked_at).forEach(d => batch.update(d.ref, { revoked_at: new Date() }))
    const token = randomToken(24)
    const ref = db.collection('invites').doc()
    const data = { org_id: ctx.org.id, email, role, branch_ids: branchIds, can_export: canExport, token_hash: sha256(token),
      expires_at: new Date(Date.now() + 14 * 86400e3), accepted_at: null, revoked_at: null, created_by: ctx.user.id, created_at: new Date() }
    batch.set(ref, data)
    await batch.commit()
    await audit(ctx, 'team.invited', 'invite', ref.id, { email, role })
    // No email provider is configured yet, so the admin shares the link themselves.
    return { id: ref.id, email, role, expires_at: plain(data.expires_at), token, path: `/invite/${token}` }
  })

  r.delete('/team/invites/:id', async ({ ctx, params }) => {
    requireCap(ctx, 'team.manage')
    const { db } = await fb()
    const ref = db.collection('invites').doc(uuid(params.id))
    const inv = (await ref.get()).data()
    if (!inv || inv.org_id !== ctx.org.id) throw notFound()
    if (ctx.branchScope && (!inv.branch_ids || inv.branch_ids.some(id => !ctx.branchScope.includes(id)))) throw forbidden()
    await ref.update({ revoked_at: new Date() })
    await audit(ctx, 'team.invite_revoked', 'invite', ref.id)
    return { ok: true }
  })

  r.patch('/team/members/:id', async ({ ctx, params, body }) => {
    requireCap(ctx, 'team.manage')
    const { db } = await fb()
    const id = String(params.id)
    if (!id.startsWith(`${ctx.org.id}_`)) throw notFound()
    const ref = db.collection('memberships').doc(id)
    const m = (await ref.get()).data()
    if (!m || m.org_id !== ctx.org.id) throw notFound()
    if (!canManageMember(ctx, m)) throw forbidden("You can't change this person's access.")
    const role = body.role !== undefined ? oneOf(body.role, ['owner', 'admin', 'lead', 'usher', 'viewer'], { name: 'Role' }) : m.role
    if (role !== m.role && !assignableRoles(ctx).includes(role)) throw forbidden("You can't give that role.")
    const branchIds = body.branchIds !== undefined ? await cleanBranchIds(ctx, body.branchIds) : (m.branch_ids || null)
    const status = body.status !== undefined ? oneOf(body.status, ['active', 'revoked'], { name: 'Status' }) : m.status
    const canExport = body.canExport !== undefined ? (!!body.canExport && (ctx.membership.role === 'owner' || ctx.membership.can_export)) : !!m.can_export
    if (m.role === 'owner' && (role !== 'owner' || status !== 'active')) {
      const owners = await db.collection('memberships').where('org_id', '==', ctx.org.id).where('role', '==', 'owner').where('status', '==', 'active').get()
      if (owners.docs.filter(d => d.id !== id).length === 0) throw bad('Every church needs at least one owner.')
    }
    const patch = { role, branch_ids: role === 'owner' ? null : branchIds, status, can_export: role === 'owner' ? true : canExport }
    await ref.update(patch)
    await audit(ctx, status === 'revoked' ? 'team.revoked' : 'team.updated', 'membership', id, { role, branchIds, status, name: m.user_name })
    return { id, ...m, ...patch }
  })

  // Names only — for assigning follow-ups and pastoral contacts.
  r.get('/team/assignees', async ({ ctx }) => {
    if (!ctx.caps.includes('followups.manage') && !ctx.caps.includes('people.edit')) throw forbidden()
    const { db } = await fb()
    const ms = await db.collection('memberships').where('org_id', '==', ctx.org.id).where('status', '==', 'active').get()
    return ms.docs.map(d => d.data()).filter(m => ['owner', 'admin', 'lead'].includes(m.role))
      .map(m => ({ user_id: m.user_id, name: m.user_name })).sort((a, b) => String(a.name).localeCompare(String(b.name)))
  })

  r.get('/audit', async ({ ctx, query }) => {
    requireCap(ctx, 'org.manage')
    const { db } = await fb()
    const qs = await col(db, ctx.org.id, 'audit').orderBy('created_at', 'desc').limit(Math.min(int(query.limit) || 100, 300)).get()
    return docsOut(qs)
  })
}

export { membershipId }
