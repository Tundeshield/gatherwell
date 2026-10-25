// Authentication context and authorisation rules. Every tenant query uses ctx.org.id and
// ctx.branchScope from here — never an organisation or branch ID trusted from the client.
import { one, q } from './db.js'
import { parseCookies, unauthorized, forbidden, notFound, isUuid } from './http.js'
import { sha256, randomToken } from './util.js'

export const SESSION_COOKIE = 'gw_session'
const SESSION_DAYS = 30

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

export function capsFor(membership) {
  if (!membership) return []
  const caps = new Set(CAPS[membership.role] || [])
  if (membership.role !== 'owner' && !membership.can_export) caps.delete('export')
  // Org-wide admins can create branches; branch-scoped admins can only edit theirs.
  if (membership.role === 'admin' && !membership.branch_ids) caps.add('branches.create')
  return [...caps]
}

export function can(ctx, cap) { return !!ctx?.caps?.includes(cap) }
export function requireCap(ctx, cap) { if (!can(ctx, cap)) throw forbidden() }

export function sessionCookie(token, maxAge = SESSION_DAYS * 86400) {
  const secure = process.env.NETLIFY_DEV === 'true' || process.env.GW_INSECURE_COOKIES === '1' ? '' : '; Secure'
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`
}

export async function createSession(userId, orgId) {
  const token = randomToken(32)
  await q(`INSERT INTO auth_sessions (user_id, token_hash, active_org_id, expires_at) VALUES ($1,$2,$3, NOW() + make_interval(days => $4))`,
    [userId, sha256(token), orgId || null, SESSION_DAYS])
  return token
}

// Resolves the signed-in user, their active organisation, membership, capabilities and branch scope.
export async function loadContext(req) {
  const token = parseCookies(req)[SESSION_COOKIE]
  if (!token) return null
  const s = await one(
    `SELECT s.id, s.user_id, s.active_org_id, u.email, u.name, u.is_platform_admin
       FROM auth_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > NOW()`, [sha256(token)])
  if (!s) return null
  // Touch at most every 10 minutes.
  q(`UPDATE auth_sessions SET last_seen_at = NOW() WHERE id = $1 AND last_seen_at < NOW() - INTERVAL '10 minutes'`, [s.id]).catch(() => {})

  const ctx = {
    sessionId: s.id,
    user: { id: s.user_id, email: s.email, name: s.name, isPlatformAdmin: s.is_platform_admin || platformAdminEmails().includes(s.email) },
    org: null, membership: null, caps: [], branchScope: null,
  }
  let m = null
  if (s.active_org_id) m = await membershipFor(s.user_id, s.active_org_id)
  if (!m) {
    // Fall back to the first active membership.
    m = await one(`SELECT m.*, o.name AS org_name FROM memberships m JOIN organisations o ON o.id = m.org_id
                    WHERE m.user_id = $1 AND m.status = 'active' AND o.status <> 'closed' ORDER BY m.created_at LIMIT 1`, [s.user_id])
    if (m) await q(`UPDATE auth_sessions SET active_org_id = $1 WHERE id = $2`, [m.org_id, s.id])
  }
  if (m) {
    const org = await one(`SELECT * FROM organisations WHERE id = $1`, [m.org_id])
    ctx.org = org
    ctx.membership = m
    ctx.caps = org.status === 'active' ? capsFor(m) : []
    ctx.branchScope = m.branch_ids && m.branch_ids.length ? m.branch_ids : null
  }
  return ctx
}

async function membershipFor(userId, orgId) {
  return one(`SELECT m.* FROM memberships m JOIN organisations o ON o.id = m.org_id
               WHERE m.user_id = $1 AND m.org_id = $2 AND m.status = 'active' AND o.status <> 'closed'`, [userId, orgId])
}

export function platformAdminEmails() {
  return (process.env.PLATFORM_ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
}

export function requireUser(ctx) { if (!ctx?.user) throw unauthorized() }
export function requireOrg(ctx) {
  requireUser(ctx)
  if (!ctx.org) throw forbidden("You aren't a member of an active church yet.")
}

// Branch IDs this request may touch: null = every branch in the org.
// If `requested` is given it must be inside the user's scope and belong to their org.
export async function branchFilter(ctx, requested) {
  if (requested && requested !== 'all') {
    if (!isUuid(requested)) throw notFound('Branch not found.')
    if (ctx.branchScope && !ctx.branchScope.includes(requested)) throw forbidden("You don't have access to that branch.")
    const b = await one(`SELECT id FROM branches WHERE id = $1 AND org_id = $2`, [requested, ctx.org.id])
    if (!b) throw notFound('Branch not found.')
    return [requested]
  }
  return ctx.branchScope
}

// Asserts a single branch is writable by this user (used when creating records).
export async function assertBranch(ctx, branchId) {
  if (!branchId || !isUuid(branchId)) throw notFound('Choose a branch.')
  if (ctx.branchScope && !ctx.branchScope.includes(branchId)) throw forbidden("You don't have access to that branch.")
  const b = await one(`SELECT id, status FROM branches WHERE id = $1 AND org_id = $2`, [branchId, ctx.org.id])
  if (!b) throw notFound('Branch not found.')
  return b
}

// Asserts a fetched row belongs to the org and the user's branch scope.
// `allowOrgWide` lets rows with branch_id NULL through (org-wide events, unassigned people).
export function assertRowScope(ctx, row, { allowOrgWide = true } = {}) {
  if (!row || row.org_id !== ctx.org.id) throw notFound()
  if (ctx.branchScope && row.branch_id && !ctx.branchScope.includes(row.branch_id)) throw notFound()
  if (ctx.branchScope && !row.branch_id && !allowOrgWide) throw notFound()
  return row
}
