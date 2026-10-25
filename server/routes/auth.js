import { q, one, tx } from '../db.js'
import { bad, conflict, unauthorized, str, email as emailV, json, clientIp, notFound, forbidden } from '../http.js'
import { hashPassword, verifyPassword, rateLimit, slugify, shortId, sha256, audit } from '../util.js'
import { createSession, sessionCookie, SESSION_COOKIE, capsFor, ROLE_LABELS } from '../access.js'

function password(v) {
  const s = String(v || '')
  if (s.length < 8) throw bad('Password must be at least 8 characters.')
  if (s.length > 200) throw bad('Password is too long.')
  return s
}

async function uniqueSlug(client, base) {
  let slug = slugify(base)
  for (let i = 0; i < 5; i++) {
    const exists = await client.one(`SELECT 1 FROM organisations WHERE slug = $1`, [slug])
    if (!exists) return slug
    slug = `${slugify(base).slice(0, 32)}-${shortId(5).toLowerCase()}`
  }
  return `${slugify(base).slice(0, 30)}-${shortId(8).toLowerCase()}`
}

export async function mePayload(ctx) {
  const orgs = await q(`SELECT o.id, o.name, m.role FROM memberships m JOIN organisations o ON o.id = m.org_id
                         WHERE m.user_id = $1 AND m.status = 'active' AND o.status <> 'closed' ORDER BY o.name`, [ctx.user.id])
  let branches = []
  if (ctx.org) {
    branches = await q(`SELECT id, name, status, address, timezone FROM branches WHERE org_id = $1
                          AND ($2::uuid[] IS NULL OR id = ANY($2)) ORDER BY status, name`, [ctx.org.id, ctx.branchScope])
  }
  return {
    user: ctx.user,
    org: ctx.org && {
      id: ctx.org.id, name: ctx.org.name, slug: ctx.org.slug, timezone: ctx.org.timezone, country: ctx.org.country,
      status: ctx.org.status, plan: ctx.org.plan, trialEndsAt: ctx.org.trial_ends_at, settings: ctx.org.settings,
      contactEmail: ctx.org.contact_email, contactPhone: ctx.org.contact_phone,
    },
    membership: ctx.membership && { role: ctx.membership.role, roleLabel: ROLE_LABELS[ctx.membership.role], branchIds: ctx.membership.branch_ids, canExport: ctx.membership.can_export },
    caps: ctx.caps,
    branches,
    orgs,
  }
}

export default function (r) {
  r.post('/auth/signup', { auth: 'public' }, async ({ req, body }) => {
    await rateLimit(`signup:${clientIp(req)}`, 10, 3600)
    const orgName = str(body.orgName, { required: true, max: 120, name: 'Church name' })
    const branchName = str(body.branchName, { max: 120, name: 'Branch name' }) || 'Main campus'
    const name = str(body.name, { required: true, max: 120, name: 'Your name' })
    const email = emailV(body.email, { required: true })
    const pw = password(body.password)
    const timezone = str(body.timezone, { max: 64 }) || 'Africa/Lagos'
    const country = str(body.country, { max: 64 })
    const cc = String(body.defaultCountryCode || '').replace(/\D/g, '').slice(0, 4) || '234'

    const existing = await one(`SELECT id FROM users WHERE email = $1`, [email])
    if (existing) throw conflict('An account with this email already exists. Sign in instead, then create a new church from your account.')

    const hash = await hashPassword(pw)
    const { user, org } = await tx(async (c) => {
      const user = await c.one(`INSERT INTO users (email, name, password_hash, last_login_at) VALUES ($1,$2,$3,NOW()) RETURNING id, email, name`, [email, name, hash])
      const slug = await uniqueSlug(c, orgName)
      const settings = { absenceWeeks: 3, firstVisitFollowup: true, firstVisitHours: 48, secondVisitFollowup: true, defaultCountryCode: cc }
      const org = await c.one(`INSERT INTO organisations (name, slug, timezone, country, contact_email, trial_ends_at, settings)
                               VALUES ($1,$2,$3,$4,$5, NOW() + INTERVAL '30 days', $6) RETURNING *`, [orgName, slug, timezone, country, email, settings])
      await c.q(`INSERT INTO branches (org_id, name, timezone) VALUES ($1,$2,$3)`, [org.id, branchName, timezone])
      await c.q(`INSERT INTO memberships (org_id, user_id, role, can_export) VALUES ($1,$2,'owner',TRUE)`, [org.id, user.id])
      return { user, org }
    })
    await audit({ org, user }, 'org.created', 'organisation', org.id)
    const token = await createSession(user.id, org.id)
    return json({ ok: true }, 201, { 'set-cookie': sessionCookie(token) })
  })

  r.post('/auth/login', { auth: 'public' }, async ({ req, body }) => {
    const email = emailV(body.email, { required: true })
    await rateLimit(`login:${clientIp(req)}:${email}`, 8, 900)
    await rateLimit(`login-ip:${clientIp(req)}`, 40, 900)
    const user = await one(`SELECT id, password_hash FROM users WHERE email = $1`, [email])
    const ok = user ? await verifyPassword(String(body.password || ''), user.password_hash) : await verifyPassword('x', 'scrypt$AAAA$AAAA').catch(() => false)
    if (!user || !ok) throw unauthorized('Incorrect email or password.')
    await q(`UPDATE users SET last_login_at = NOW() WHERE id = $1`, [user.id])
    const token = await createSession(user.id, null)
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie(token) })
  })

  r.post('/auth/logout', { auth: 'public', optionalUser: true }, async ({ ctx }) => {
    if (ctx?.sessionId) await q(`DELETE FROM auth_sessions WHERE id = $1`, [ctx.sessionId])
    return json({ ok: true }, 200, { 'set-cookie': `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` })
  })

  r.get('/me', { auth: 'user' }, async ({ ctx }) => mePayload(ctx))

  r.post('/me/switch-org', { auth: 'user' }, async ({ ctx, body }) => {
    const m = await one(`SELECT m.org_id FROM memberships m JOIN organisations o ON o.id = m.org_id
                          WHERE m.user_id = $1 AND m.org_id = $2 AND m.status = 'active' AND o.status <> 'closed'`, [ctx.user.id, body.orgId])
    if (!m) throw forbidden()
    await q(`UPDATE auth_sessions SET active_org_id = $1 WHERE id = $2`, [m.org_id, ctx.sessionId])
    return { ok: true }
  })

  // A signed-in user (e.g. invited to one church) can start another organisation.
  r.post('/me/orgs', { auth: 'user' }, async ({ ctx, body }) => {
    const orgName = str(body.orgName, { required: true, max: 120, name: 'Church name' })
    const branchName = str(body.branchName, { max: 120 }) || 'Main campus'
    const timezone = str(body.timezone, { max: 64 }) || 'Africa/Lagos'
    const org = await tx(async (c) => {
      const slug = await uniqueSlug(c, orgName)
      const org = await c.one(`INSERT INTO organisations (name, slug, timezone, trial_ends_at, settings) VALUES ($1,$2,$3, NOW() + INTERVAL '30 days', $4) RETURNING *`,
        [orgName, slug, timezone, { absenceWeeks: 3, firstVisitFollowup: true, firstVisitHours: 48, secondVisitFollowup: true, defaultCountryCode: '234' }])
      await c.q(`INSERT INTO branches (org_id, name, timezone) VALUES ($1,$2,$3)`, [org.id, branchName, timezone])
      await c.q(`INSERT INTO memberships (org_id, user_id, role, can_export) VALUES ($1,$2,'owner',TRUE)`, [org.id, ctx.user.id])
      return org
    })
    await q(`UPDATE auth_sessions SET active_org_id = $1 WHERE id = $2`, [org.id, ctx.sessionId])
    await audit({ org, user: ctx.user }, 'org.created', 'organisation', org.id)
    return { ok: true, orgId: org.id }
  })

  r.patch('/me', { auth: 'user' }, async ({ ctx, body }) => {
    const name = str(body.name, { max: 120, name: 'Name' })
    if (name) await q(`UPDATE users SET name = $1 WHERE id = $2`, [name, ctx.user.id])
    if (body.newPassword) {
      const u = await one(`SELECT password_hash FROM users WHERE id = $1`, [ctx.user.id])
      if (!(await verifyPassword(String(body.currentPassword || ''), u.password_hash))) throw bad('Your current password is incorrect.')
      await q(`UPDATE users SET password_hash = $1 WHERE id = $2`, [await hashPassword(password(body.newPassword)), ctx.user.id])
      // Sign out other devices.
      await q(`DELETE FROM auth_sessions WHERE user_id = $1 AND id <> $2`, [ctx.user.id, ctx.sessionId])
    }
    return { ok: true }
  })

  // --- invitations --------------------------------------------------------------
  r.get('/public/invite/:token', { auth: 'public' }, async ({ params }) => {
    const inv = await one(`SELECT i.email, i.role, i.expires_at, i.accepted_at, i.revoked_at, o.name AS org_name,
                                  EXISTS (SELECT 1 FROM users u WHERE u.email = i.email) AS has_account
                             FROM invites i JOIN organisations o ON o.id = i.org_id WHERE i.token_hash = $1`, [sha256(params.token)])
    if (!inv || inv.revoked_at) throw notFound('This invitation is not valid. Ask your church admin for a new link.')
    if (inv.accepted_at) throw bad('This invitation has already been used. Sign in instead.')
    if (new Date(inv.expires_at) < new Date()) throw bad('This invitation has expired. Ask your church admin for a new link.')
    return { email: inv.email, role: inv.role, roleLabel: ROLE_LABELS[inv.role], orgName: inv.org_name, hasAccount: inv.has_account }
  })

  r.post('/auth/accept-invite', { auth: 'public' }, async ({ req, body }) => {
    await rateLimit(`invite:${clientIp(req)}`, 20, 900)
    const inv = await one(`SELECT * FROM invites WHERE token_hash = $1`, [sha256(String(body.token || ''))])
    if (!inv || inv.revoked_at || inv.accepted_at || new Date(inv.expires_at) < new Date()) throw bad('This invitation is no longer valid.')
    let user = await one(`SELECT id, password_hash FROM users WHERE email = $1`, [inv.email])
    if (user) {
      if (!(await verifyPassword(String(body.password || ''), user.password_hash))) throw unauthorized('Incorrect password for this account.')
    } else {
      const name = str(body.name, { required: true, max: 120, name: 'Your name' })
      user = await one(`INSERT INTO users (email, name, password_hash) VALUES ($1,$2,$3) RETURNING id`, [inv.email, name, await hashPassword(password(body.password))])
    }
    await tx(async (c) => {
      await c.q(`INSERT INTO memberships (org_id, user_id, role, branch_ids, can_export) VALUES ($1,$2,$3,$4,$5)
                 ON CONFLICT (org_id, user_id) DO UPDATE SET role = EXCLUDED.role, branch_ids = EXCLUDED.branch_ids, can_export = EXCLUDED.can_export, status = 'active'`,
        [inv.org_id, user.id, inv.role, inv.branch_ids, inv.can_export])
      await c.q(`UPDATE invites SET accepted_at = NOW() WHERE id = $1`, [inv.id])
    })
    await audit({ org: { id: inv.org_id }, user }, 'team.invite_accepted', 'user', user.id, { role: inv.role })
    const token = await createSession(user.id, inv.org_id)
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie(token) })
  })
}
