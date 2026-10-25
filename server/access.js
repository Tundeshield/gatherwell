// Authentication context and authorisation rules. Every tenant read/write is scoped to
// orgs/{ctx.org.id} and ctx.branchScope from here — never IDs trusted from the client.
import { fb } from './firebase.js'
import { parseCookies, unauthorized, forbidden, notFound, isUuid } from './http.js'

export const SESSION_COOKIE = 'gw_session'
export const SESSION_DAYS = 14 // Firebase session cookies last at most 14 days

export const ROLES = ['owner', 'admin', 'lead', 'usher', 'viewer']
export const ROLE_LABELS = { owner: 'Owner', admin: 'Admin', lead: 'Attendance lead', usher: 'Usher', viewer: 'Viewer' }

// Capabilities by role. 'export' additionally requires membership.can_export unless owner.
const CAPS = {
  owner: ['org.manage', 'branches.manage', 'branches.create', 'team.manage', 'people.view', 'people.edit', 'people.delete',
    'attendance.view', 'attendance.manage', 'attendance.record', 'events.view', 'events.manage', 'events.checkin',
    'followups.view', 'followups.manage', 'reports.view', 'messages.manage', 'units.manage', 'export'],
  admin: ['branches.manage', 'team.manage', 'people.view', 'people.edit', 'people.delete',
    'attendance.view', 'attendance.manage', 'attendance.record', 'events.view', 'events.manage', 'events.checkin',
    'followups.view', 'followups.manage', 'reports.view', 'messages.manage', 'units.manage', 'export'],
  lead: ['people.view', 'people.edit', 'attendance.view', 'attendance.manage', 'attendance.record',
    'events.view', 'events.manage', 'events.checkin', 'followups.view', 'followups.manage', 'reports.view', 'export'],
  usher: ['attendance.view', 'attendance.record', 'events.view', 'events.checkin'],
  viewer: ['reports.view', 'attendance.view', 'events.view'],
}

export function capsFor(m) {
  if (!m) return []
  const caps = new Set(CAPS[m.role] || [])
  if (m.role !== 'owner' && !m.can_export) caps.delete('export')
  if (m.role === 'admin' && !m.branch_ids) caps.add('branches.create')
  return [...caps]
}

export function can(ctx, cap) { return !!ctx?.caps?.includes(cap) }
export function requireCap(ctx, cap) { if (!can(ctx, cap)) throw forbidden() }

export function sessionCookie(value, maxAge = SESSION_DAYS * 86400) {
  const secure = process.env.NETLIFY_DEV === 'true' || process.env.GW_INSECURE_COOKIES === '1' ? '' : '; Secure'
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`
}
export const clearCookie = () => `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`

export const membershipId = (orgId, uid) => `${orgId}_${uid}`

export function platformAdminEmails() {
  return (process.env.PLATFORM_ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
}

// Resolves user, active organisation, membership, capabilities and branch scope from the session cookie.
export async function loadContext(req) {
  const cookie = parseCookies(req)[SESSION_COOKIE]
  if (!cookie) return null
  const { db, auth } = await fb()
  let claims
  try { claims = await auth.verifySessionCookie(cookie, true) } catch { return null }
  const uid = claims.uid
  const userSnap = await db.collection('users').doc(uid).get()
  if (!userSnap.exists) return null
  const u = userSnap.data()
  const ctx = {
    cookie,
    user: { id: uid, email: u.email, name: u.name, isPlatformAdmin: !!u.is_platform_admin || platformAdminEmails().includes(String(u.email).toLowerCase()) },
    org: null, membership: null, caps: [], branchScope: null,
  }

  let m = null, org = null
  if (u.active_org_id) {
    ;[m, org] = await activeMembership(db, uid, u.active_org_id)
  }
  if (!m) {
    const all = await db.collection('memberships').where('user_id', '==', uid).where('status', '==', 'active').get()
    const sorted = all.docs.map(d => d.data()).sort((a, b) => String(a.org_id).localeCompare(String(b.org_id)))
    for (const cand of sorted) {
      ;[m, org] = await activeMembership(db, uid, cand.org_id)
      if (m) { await db.collection('users').doc(uid).update({ active_org_id: cand.org_id }); break }
    }
  }
  if (m) {
    ctx.org = org
    ctx.membership = m
    ctx.caps = org.status === 'active' ? capsFor(m) : []
    ctx.branchScope = Array.isArray(m.branch_ids) && m.branch_ids.length ? m.branch_ids : null
  }
  return ctx
}

async function activeMembership(db, uid, orgId) {
  const [ms, os] = await db.getAll(db.collection('memberships').doc(membershipId(orgId, uid)), db.collection('orgs').doc(orgId))
  if (!ms.exists || !os.exists) return [null, null]
  const m = ms.data()
  const o = os.data()
  if (m.status !== 'active' || o.status === 'closed') return [null, null]
  return [{ id: ms.id, ...m }, { id: os.id, ...o }]
}

export function requireUser(ctx) { if (!ctx?.user) throw unauthorized() }
export function requireOrg(ctx) {
  requireUser(ctx)
  if (!ctx.org) throw forbidden("You aren't a member of an active church yet.")
}

const validId = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(v)
export { validId }

// Loads all branches of the org once per request.
export async function orgBranches(ctx) {
  if (ctx._branches) return ctx._branches
  const { db } = await fb()
  const qs = await db.collection('orgs').doc(ctx.org.id).collection('branches').get()
  ctx._branches = qs.docs.map(d => ({ id: d.id, ...d.data() }))
  return ctx._branches
}

// Branch IDs this request may touch: null = every branch in the org.
export async function branchFilter(ctx, requested) {
  if (requested && requested !== 'all') {
    if (!validId(requested)) throw notFound('Branch not found.')
    if (ctx.branchScope && !ctx.branchScope.includes(requested)) throw forbidden("You don't have access to that branch.")
    const b = (await orgBranches(ctx)).find(x => x.id === requested)
    if (!b) throw notFound('Branch not found.')
    return [requested]
  }
  return ctx.branchScope
}

// Asserts a single branch is writable by this user (used when creating records).
export async function assertBranch(ctx, branchId) {
  if (!branchId || !validId(branchId)) throw notFound('Choose a branch.')
  if (ctx.branchScope && !ctx.branchScope.includes(branchId)) throw forbidden("You don't have access to that branch.")
  const b = (await orgBranches(ctx)).find(x => x.id === branchId)
  if (!b) throw notFound('Branch not found.')
  return b
}

// Rows already live under orgs/{ctx.org.id}; this enforces branch scope.
export function assertRowScope(ctx, row, { allowOrgWide = true } = {}) {
  if (!row) throw notFound()
  if (ctx.branchScope && row.branch_id && !ctx.branchScope.includes(row.branch_id)) throw notFound()
  if (ctx.branchScope && !row.branch_id && !allowOrgWide) throw notFound()
  return row
}

export const inScope = (ctx, branchId, branches) => {
  const list = branches === undefined ? ctx.branchScope : branches
  return !list || (branchId && list.includes(branchId))
}

export { isUuid }
