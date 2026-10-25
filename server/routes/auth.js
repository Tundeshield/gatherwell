import { fb, plain } from '../firebase.js'
import { bad, conflict, unauthorized, str, email as emailV, json, clientIp, notFound, forbidden } from '../http.js'
import { rateLimit, slugify, shortId, sha256, audit } from '../util.js'
import { sessionCookie, clearCookie, SESSION_DAYS, ROLE_LABELS, membershipId, orgBranches } from '../access.js'

const DEFAULT_SETTINGS = { absenceWeeks: 3, firstVisitFollowup: true, firstVisitHours: 48, secondVisitFollowup: true, defaultCountryCode: '234' }

function password(v) {
  const s = String(v || '')
  if (s.length < 8) throw bad('Password must be at least 8 characters.')
  if (s.length > 200) throw bad('Password is too long.')
  return s
}

// Creates org + first branch + owner membership, reserving a unique slug.
async function createOrganisation(db, { orgName, branchName, timezone, country, contactEmail, settings, owner }) {
  const orgRef = db.collection('orgs').doc()
  const branchRef = orgRef.collection('branches').doc()
  const now = new Date()
  let slug = slugify(orgName)
  for (let i = 0; i < 6; i++) {
    try {
      await db.runTransaction(async (tx) => {
        const slugRef = db.collection('orgSlugs').doc(slug)
        const s = await tx.get(slugRef)
        if (s.exists) throw Object.assign(new Error('slug taken'), { slugTaken: true })
        tx.set(slugRef, { org_id: orgRef.id })
        tx.set(orgRef, {
          name: orgName, slug, timezone, country: country || null, contact_email: contactEmail || null, contact_phone: null,
          status: 'active', plan: 'trial', trial_ends_at: new Date(now.getTime() + 30 * 86400e3), settings, created_at: now, updated_at: now,
        })
        tx.set(branchRef, { name: branchName, address: null, phone: null, timezone, status: 'active', created_at: now, updated_at: now })
        tx.set(db.collection('memberships').doc(membershipId(orgRef.id, owner.id)), {
          org_id: orgRef.id, user_id: owner.id, role: 'owner', branch_ids: null, can_export: true, status: 'active', created_at: now,
          user_name: owner.name, user_email: owner.email,
        })
        tx.set(db.collection('users').doc(owner.id), { active_org_id: orgRef.id }, { merge: true })
      })
      return { id: orgRef.id, name: orgName }
    } catch (e) {
      if (!e.slugTaken) throw e
      slug = `${slugify(orgName).slice(0, 32)}-${shortId(5).toLowerCase()}`
    }
  }
  throw new Error('Could not reserve a unique church address.')
}

export async function mePayload(ctx) {
  const { db } = await fb()
  const ms = await db.collection('memberships').where('user_id', '==', ctx.user.id).where('status', '==', 'active').get()
  const orgSnaps = ms.empty ? [] : await db.getAll(...ms.docs.map(d => db.collection('orgs').doc(d.data().org_id)))
  const orgs = orgSnaps.map((o, i) => (o.exists && o.data().status !== 'closed' ? { id: o.id, name: o.data().name, role: ms.docs[i].data().role } : null)).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name))
  let branches = []
  if (ctx.org) {
    branches = (await orgBranches(ctx)).filter(b => !ctx.branchScope || ctx.branchScope.includes(b.id))
      .map(b => ({ id: b.id, name: b.name, status: b.status, address: b.address || null, timezone: b.timezone || null }))
      .sort((a, b) => (a.status === b.status ? a.name.localeCompare(b.name) : a.status === 'active' ? -1 : 1))
  }
  const o = ctx.org
  return {
    user: ctx.user,
    org: o && {
      id: o.id, name: o.name, slug: o.slug, timezone: o.timezone, country: o.country, status: o.status, plan: o.plan,
      trialEndsAt: plain(o.trial_ends_at), settings: { ...DEFAULT_SETTINGS, ...(o.settings || {}) }, contactEmail: o.contact_email, contactPhone: o.contact_phone,
    },
    membership: ctx.membership && { role: ctx.membership.role, roleLabel: ROLE_LABELS[ctx.membership.role], branchIds: ctx.membership.branch_ids || null, canExport: !!ctx.membership.can_export },
    caps: ctx.caps,
    branches,
    orgs,
  }
}

async function accept(db, inv, invRef, user) {
  const now = new Date()
  await db.runTransaction(async (tx) => {
    const fresh = await tx.get(invRef)
    const d = fresh.data()
    if (!d || d.revoked_at || d.accepted_at) throw bad('This invitation is no longer valid.')
    tx.set(db.collection('memberships').doc(membershipId(d.org_id, user.id)), {
      org_id: d.org_id, user_id: user.id, role: d.role, branch_ids: d.branch_ids || null, can_export: !!d.can_export, status: 'active',
      created_at: now, user_name: user.name, user_email: user.email,
    })
    tx.update(invRef, { accepted_at: now })
    tx.set(db.collection('users').doc(user.id), { active_org_id: d.org_id }, { merge: true })
  })
  await audit({ org: { id: inv.org_id }, user }, 'team.invite_accepted', 'user', user.id, { role: inv.role })
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
    const cc = String(body.defaultCountryCode || '').replace(/\D/g, '').slice(0, 4) || '234'
    const { db, auth } = await fb()
    let created
    try { created = await auth.createUser({ email, password: pw, displayName: name }) }
    catch (e) {
      if (e.code === 'auth/email-already-exists') throw conflict('An account with this email already exists. Sign in instead, then create a new church from your account.')
      if (e.code === 'auth/configuration-not-found' || e.code === 'auth/operation-not-allowed') throw bad('Email sign-in is not enabled for this Firebase project yet.')
      throw e
    }
    const user = { id: created.uid, email, name }
    await db.collection('users').doc(user.id).set({ email, name, is_platform_admin: false, created_at: new Date(), last_login_at: null, active_org_id: null })
    const org = await createOrganisation(db, { orgName, branchName, timezone, country: str(body.country, { max: 64 }), contactEmail: email, settings: { ...DEFAULT_SETTINGS, defaultCountryCode: cc }, owner: user })
    await audit({ org, user }, 'org.created', 'organisation', org.id, { name: orgName })
    return json({ ok: true, signIn: true }, 201)
  })

  // Exchanges a fresh Firebase ID token for an HttpOnly session cookie.
  r.post('/auth/session', { auth: 'public' }, async ({ req, body }) => {
    await rateLimit(`session:${clientIp(req)}`, 30, 900)
    const { db, auth } = await fb()
    let decoded
    try { decoded = await auth.verifyIdToken(String(body.idToken || '')) } catch { throw unauthorized('Your sign-in expired. Please sign in again.') }
    if (Date.now() / 1000 - decoded.auth_time > 5 * 60) throw unauthorized('Please sign in again.')
    const cookie = await auth.createSessionCookie(String(body.idToken), { expiresIn: SESSION_DAYS * 86400 * 1000 })
    const ref = db.collection('users').doc(decoded.uid)
    const snap = await ref.get()
    if (!snap.exists) await ref.set({ email: String(decoded.email || '').toLowerCase(), name: decoded.name || String(decoded.email || 'User').split('@')[0], is_platform_admin: false, created_at: new Date(), active_org_id: null })
    await ref.set({ last_login_at: new Date() }, { merge: true })
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie(cookie) })
  })

  r.post('/auth/logout', { auth: 'public' }, async () => json({ ok: true }, 200, { 'set-cookie': clearCookie() }))

  r.get('/me', { auth: 'user' }, async ({ ctx }) => mePayload(ctx))

  r.post('/me/switch-org', { auth: 'user' }, async ({ ctx, body }) => {
    const { db } = await fb()
    const id = String(body.orgId || '')
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(id)) throw forbidden()
    const [m, o] = await db.getAll(db.collection('memberships').doc(membershipId(id, ctx.user.id)), db.collection('orgs').doc(id))
    if (!m.exists || m.data().status !== 'active' || !o.exists || o.data().status === 'closed') throw forbidden()
    await db.collection('users').doc(ctx.user.id).update({ active_org_id: id })
    return { ok: true }
  })

  r.post('/me/orgs', { auth: 'user' }, async ({ ctx, body }) => {
    const { db } = await fb()
    const orgName = str(body.orgName, { required: true, max: 120, name: 'Church name' })
    const org = await createOrganisation(db, { orgName, branchName: str(body.branchName, { max: 120 }) || 'Main campus', timezone: str(body.timezone, { max: 64 }) || 'Africa/Lagos', settings: DEFAULT_SETTINGS, owner: ctx.user })
    await audit({ org, user: ctx.user }, 'org.created', 'organisation', org.id, { name: orgName })
    return { ok: true, orgId: org.id }
  })

  // Name changes only — passwords are changed through Firebase Auth in the browser.
  r.patch('/me', { auth: 'user' }, async ({ ctx, body }) => {
    const name = str(body.name, { required: true, max: 120, name: 'Name' })
    const { db, auth } = await fb()
    await db.collection('users').doc(ctx.user.id).update({ name })
    await auth.updateUser(ctx.user.id, { displayName: name }).catch(() => {})
    const ms = await db.collection('memberships').where('user_id', '==', ctx.user.id).get()
    const batch = db.batch()
    ms.docs.forEach(d => batch.update(d.ref, { user_name: name }))
    await batch.commit()
    return { ok: true }
  })

  // --- invitations --------------------------------------------------------------
  async function findInvite(db, token) {
    const qs = await db.collection('invites').where('token_hash', '==', sha256(String(token || ''))).limit(1).get()
    return qs.empty ? [null, null] : [qs.docs[0].data(), qs.docs[0].ref]
  }

  r.get('/public/invite/:token', { auth: 'public' }, async ({ params }) => {
    const { db, auth } = await fb()
    const [inv] = await findInvite(db, params.token)
    if (!inv || inv.revoked_at) throw notFound('This invitation is not valid. Ask your church admin for a new link.')
    if (inv.accepted_at) throw bad('This invitation has already been used. Sign in instead.')
    if (inv.expires_at.toDate() < new Date()) throw bad('This invitation has expired. Ask your church admin for a new link.')
    const o = await db.collection('orgs').doc(inv.org_id).get()
    let hasAccount = true
    try { await auth.getUserByEmail(inv.email) } catch { hasAccount = false }
    return { email: inv.email, role: inv.role, roleLabel: ROLE_LABELS[inv.role], orgName: o.data()?.name, hasAccount }
  })

  // New account: creates the Firebase user (client then signs in).
  // Existing account: the user signs in first, then calls this with their session.
  r.post('/auth/accept-invite', { auth: 'public', optionalUser: true }, async ({ req, body, ctx }) => {
    await rateLimit(`invite:${clientIp(req)}`, 20, 900)
    const { db, auth } = await fb()
    const [inv, invRef] = await findInvite(db, body.token)
    if (!inv || inv.revoked_at || inv.accepted_at || inv.expires_at.toDate() < new Date()) throw bad('This invitation is no longer valid.')
    if (ctx?.user) {
      if (ctx.user.email.toLowerCase() !== inv.email) throw forbidden(`This invitation is for ${inv.email}. Sign out and sign in with that email.`)
      await accept(db, inv, invRef, ctx.user)
      return { ok: true }
    }
    let existing = null
    try { existing = await auth.getUserByEmail(inv.email) } catch {}
    if (existing) throw unauthorized('You already have an account. Sign in to accept this invitation.')
    const name = str(body.name, { required: true, max: 120, name: 'Your name' })
    const created = await auth.createUser({ email: inv.email, password: password(body.password), displayName: name })
    const user = { id: created.uid, email: inv.email, name }
    await db.collection('users').doc(user.id).set({ email: inv.email, name, is_platform_admin: false, created_at: new Date(), active_org_id: inv.org_id })
    await accept(db, inv, invRef, user)
    return { ok: true, signIn: true }
  })
}
