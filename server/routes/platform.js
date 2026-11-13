// The GatherHQ team's console (admin.gatherhq.org). Platform operators only
// (users.is_platform_admin or PLATFORM_ADMIN_EMAILS). Being a church owner never grants this.
// Church data stays private: counts, team members and activity names only — never member records or notes.
import { billingStatus, monthlyValue, PLANS } from '../../shared/plans.js'
import { fb, col, plain } from '../firebase.js'
import { notFound, oneOf, bad } from '../http.js'
import { audit, platformAudit } from '../util.js'
import { platformAdminEmails, ROLE_LABELS } from '../access.js'
import { emailProvider, sendEmails } from '../email.js'

const DAY = 86400e3
const toD = (v) => (v ? (typeof v.toDate === 'function' ? v.toDate() : new Date(v)) : null)

async function orgRow(db, o, since) {
  const d = o.data()
  const C = (n) => col(db, o.id, n)
  const [branches, people, sessions, team, owner, last, recent] = await Promise.all([
    C('branches').count().get(), C('people').count().get(), C('gatherings').count().get(),
    db.collection('memberships').where('org_id', '==', o.id).where('status', '==', 'active').count().get(),
    db.collection('memberships').where('org_id', '==', o.id).where('role', '==', 'owner').limit(1).get(),
    C('checkins').orderBy('created_at', 'desc').limit(1).get(),
    C('checkins').where('created_at', '>=', since).count().get(),
  ])
  const billing = billingStatus(d)
  return {
    id: o.id, name: d.name, slug: d.slug, status: d.status, plan: d.plan, country: d.country || null,
    multi_branch: !!d.features?.branches || branches.data().count > 1, billing,
    children: d.features?.children !== false,
    mrr: billing.state === 'active' || billing.state === 'past_due' ? monthlyValue(billing.plan, billing.interval) : 0,
    created_at: plain(d.created_at), branches: branches.data().count, people: people.data().count, sessions: sessions.data().count, team: team.data().count,
    owner_email: owner.docs[0]?.data().user_email || null, owner_name: owner.docs[0]?.data().user_name || null,
    last_checkin_at: last.empty ? null : plain(last.docs[0].data().created_at), checkins_7d: recent.data().count,
  }
}

const grantsOf = async (db) => new Set((await db.collection('platformAdmins').where('active', '==', true).get()).docs.map(d => d.id))
const userOut = (snap, grants = new Set()) => {
  const u = snap.data()
  return { id: snap.id, email: u.email, name: u.name, created_at: plain(u.created_at) || null, last_login_at: plain(u.last_login_at) || null,
    is_platform_admin: platformAdminEmails().includes(String(u.email).toLowerCase()) || grants.has(snap.id),
    admin_from_settings: platformAdminEmails().includes(String(u.email).toLowerCase()) }
}

async function getOrg(db, id) {
  const ref = db.collection('orgs').doc(String(id).slice(0, 64))
  const o = await ref.get()
  if (!o.exists) throw notFound()
  return { ref, o, d: o.data() }
}

export default function (r) {
  r.get('/platform/summary', { auth: 'platform' }, async () => {
    const { db } = await fb()
    const now = Date.now()
    const since = new Date(now - 7 * DAY)
    const orgSnaps = await db.collection('orgs').orderBy('created_at', 'desc').limit(1000).get()
    const orgs = await Promise.all(orgSnaps.docs.map(o => orgRow(db, o, since)))
    const users = await db.collection('users').count().get()
    const live = orgs.filter(o => o.status !== 'closed')
    const by = (s) => live.filter(o => o.billing.state === s)
    const mrr = live.reduce((a, o) => a + o.mrr, 0)
    // New churches per week for the last 12 weeks (oldest first).
    const weekStart = (t) => { const d = new Date(t); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.getTime() }
    const thisWeek = weekStart(now)
    const signups = Array.from({ length: 12 }, (_, i) => ({ week: new Date(thisWeek - (11 - i) * 7 * DAY).toISOString(), count: 0 }))
    for (const o of orgs) {
      const t = o.created_at ? weekStart(new Date(o.created_at).getTime()) : null
      const i = t == null ? -1 : 11 - Math.round((thisWeek - t) / (7 * DAY))
      if (i >= 0 && i < 12) signups[i].count++
    }
    const pick = ({ id, name, owner_email, billing, last_checkin_at, created_at, people }) => ({ id, name, owner_email, billing, last_checkin_at, created_at, people })
    const quietCutoff = now - 14 * DAY
    const totals = {
      orgs: live.length, active_orgs: live.filter(o => o.status === 'active').length, branches: live.reduce((a, o) => a + o.branches, 0),
      people: live.reduce((a, o) => a + o.people, 0), checkins_7d: live.reduce((a, o) => a + o.checkins_7d, 0), users: users.data().count,
      mrr: Math.round(mrr * 100) / 100, arr: Math.round(mrr * 12), paying: by('active').filter(o => o.mrr > 0).length,
      trialing: by('trialing').length, free: by('free').length, past_due: by('past_due').length, expired: by('expired').length,
      suspended: live.filter(o => o.status === 'suspended').length,
      new_7d: orgs.filter(o => o.created_at && new Date(o.created_at).getTime() >= now - 7 * DAY).length,
      new_30d: orgs.filter(o => o.created_at && new Date(o.created_at).getTime() >= now - 30 * DAY).length,
    }
    const attention = {
      trials_ending: by('trialing').filter(o => o.billing.daysLeft <= 7).sort((a, b) => a.billing.daysLeft - b.billing.daysLeft).map(pick),
      payment_problems: [...by('past_due'), ...by('expired').filter(o => o.billing.lapsed)].map(pick),
      quiet: live.filter(o => o.status === 'active' && o.created_at && new Date(o.created_at).getTime() < quietCutoff && (!o.last_checkin_at || new Date(o.last_checkin_at).getTime() < quietCutoff)).map(pick),
    }
    return { totals, signups, attention, orgs }
  })

  r.get('/platform/orgs/:id', { auth: 'platform' }, async ({ params }) => {
    const { db } = await fb()
    const { o, d } = await getOrg(db, params.id)
    const row = await orgRow(db, o, new Date(Date.now() - 7 * DAY))
    const C = (n) => col(db, o.id, n)
    const weekly = await Promise.all(Array.from({ length: 8 }, async (_, i) => {
      const end = new Date(Date.now() - (7 - i) * 7 * DAY), start = new Date(end.getTime() - 7 * DAY)
      const c = await C('checkins').where('created_at', '>=', start).where('created_at', '<', end).count().get()
      return { week: start.toISOString(), count: c.data().count }
    }))
    const [members, branches, events, messages, activity] = await Promise.all([
      db.collection('memberships').where('org_id', '==', o.id).get(),
      C('branches').get(),
      C('events').count().get(),
      C('messages').count().get(),
      C('audit').orderBy('created_at', 'desc').limit(30).get(),
    ])
    const userIds = [...new Set(members.docs.map(m => m.data().user_id).filter(Boolean))]
    const users = userIds.length ? await db.getAll(...userIds.map(id => db.collection('users').doc(id))) : []
    const lastLogin = new Map(users.filter(u => u.exists).map(u => [u.id, plain(u.data().last_login_at) || null]))
    const b = d.billing || {}
    return {
      ...row,
      trial_ends_at: plain(d.trial_ends_at) || null, terms_accepted_at: plain(d.terms_accepted_at) || null, dpa_accepted_at: plain(d.dpa_accepted_at) || null,
      timezone: d.timezone || null,
      billing_detail: { plan: b.plan || null, interval: b.interval || null, status: b.status || null, manual: !!b.manual, email: b.email || null,
        customer_code: b.customer_id || null, subscription_code: b.subscription_id || null, card: b.card || null,
        next_payment_date: plain(b.next_payment_date) || null, last_payment_at: plain(b.last_payment_at) || null, last_error: b.last_error || null },
      counts: { events: events.data().count, messages: messages.data().count },
      branch_list: branches.docs.map(x => ({ id: x.id, name: x.data().name })),
      weekly_checkins: weekly,
      team_members: members.docs.map(m => { const x = m.data(); return { user_id: x.user_id, name: x.user_name, email: x.user_email, role: x.role, role_label: ROLE_LABELS[x.role] || x.role, status: x.status, last_login_at: lastLogin.get(x.user_id) || null } })
        .sort((a, b) => (a.role === 'owner' ? -1 : b.role === 'owner' ? 1 : String(a.name).localeCompare(String(b.name)))),
      activity: activity.docs.map(a => { const x = a.data(); return { action: x.action, entity: x.entity, by: x.user_name || null, at: plain(x.created_at) } }),
    }
  })

  r.patch('/platform/orgs/:id', { auth: 'platform' }, async ({ ctx, params, body }) => {
    const { db } = await fb()
    const { ref, o, d } = await getOrg(db, params.id)
    const log = async (action, meta = {}) => { await audit({ org: { id: o.id }, user: ctx.user }, action, 'organisation', o.id, { by: ctx.user.email, ...meta }); await platformAudit(ctx, action, { type: 'church', id: o.id, name: d.name }, meta) }
    // Make a church complimentary (never charged) or put it back on the normal trial and plans.
    if (body.plan !== undefined) {
      const plan = body.plan === 'free' ? 'free' : 'trial'
      await ref.update({ plan, updated_at: new Date() })
      await log(`platform.plan_${plan}`)
      return { id: o.id, name: d.name, plan }
    }
    // Give a church more trial time.
    if (body.extendTrialDays !== undefined) {
      const days = Math.round(Number(body.extendTrialDays))
      if (!(days >= 1 && days <= 365)) throw bad('Choose between 1 and 365 days.')
      const st = billingStatus(d)
      const from = st.state === 'trialing' ? st.trialEndsAt : new Date()
      const trial_ends_at = new Date(from.getTime() + days * DAY)
      const update = { trial_ends_at, updated_at: new Date() }
      // A lapsed paid plan goes back to a trial.
      if (st.state === 'expired' && d.billing?.status) update.billing = { ...d.billing, status: null, manual: false }
      await ref.update(update)
      await log('platform.trial_extended', { days })
      return { id: o.id, trial_ends_at: trial_ends_at.toISOString() }
    }
    // Set a plan by hand (for example, paid by bank transfer), active until a date.
    if (body.manualPlan !== undefined) {
      if (body.manualPlan === null) {
        if (!d.billing?.manual) throw bad('This church’s plan wasn’t set by hand.')
        await ref.update({ billing: { ...d.billing, manual: false, status: null }, updated_at: new Date() })
        await log('platform.manual_plan_removed')
        return { id: o.id }
      }
      const plan = oneOf(body.manualPlan.plan, Object.keys(PLANS), { name: 'Plan' })
      const interval = oneOf(body.manualPlan.interval, ['monthly', 'yearly'], { name: 'Billing period' }) || 'monthly'
      const until = new Date(body.manualPlan.until)
      if (!plan) throw bad('Choose a plan.')
      if (isNaN(until) || until <= new Date()) throw bad('Choose a paid-until date in the future.')
      if (d.billing?.subscription_id && d.billing?.provider === 'stripe' && d.billing?.status === 'active' && !d.billing?.manual) throw bad('This church already pays by card through Stripe. Ask them to cancel that first (Settings › Billing › Update card or cancel).')
      const update = { billing: { ...(d.billing || {}), plan, interval, status: 'active', manual: true, next_payment_date: until.toISOString(), updated_at: new Date() }, updated_at: new Date() }
      if (plan === 'network') update.features = { ...(d.features || {}), branches: true }
      await ref.update(update)
      await log('platform.manual_plan', { plan, interval, until: until.toISOString() })
      return { id: o.id, plan, until: until.toISOString() }
    }
    // Switch children's church on or off for a church.
    if (body.children !== undefined) {
      const on = body.children === true
      await ref.update({ features: { ...(d.features || {}), children: on }, updated_at: new Date() })
      if (on) { const { seedRooms } = await import('./children.js'); await seedRooms(db, o.id) }
      await log(on ? 'platform.children_on' : 'platform.children_off')
      return { id: o.id, children: on }
    }
    // Switch multiple branches on or off for a church.
    if (body.multiBranch !== undefined) {
      const on = body.multiBranch === true
      await ref.update({ features: { ...(d.features || {}), branches: on }, updated_at: new Date() })
      await log(on ? 'platform.multi_branch_on' : 'platform.multi_branch_off')
      return { id: o.id, name: d.name, multi_branch: on }
    }
    const status = oneOf(body.status, ['active', 'suspended', 'closed'], { name: 'Status' })
    if (!status) throw bad('Choose a status.')
    if (status === 'closed' && body.confirm !== 'close') throw bad('Type-confirm required to close an organisation.')
    if (status === 'suspended' && body.confirm !== 'suspend') throw bad('Confirm to suspend this church.')
    await ref.update({ status, updated_at: new Date() })
    await log(`platform.org_${status}`)
    return { id: o.id, name: d.name, status }
  })

  // --- users and support ---------------------------------------------------------------
  r.get('/platform/users', { auth: 'platform' }, async ({ query }) => {
    const { db } = await fb()
    const q = String(query.q || '').trim().toLowerCase().slice(0, 100)
    const snaps = await db.collection('users').orderBy('created_at', 'desc').limit(3000).get()
    const grants = await grantsOf(db)
    const all = snaps.docs.map(s => userOut(s, grants))
    const rows = q ? all.filter(u => `${u.email} ${u.name}`.toLowerCase().includes(q)) : all
    return { total: rows.length, users: rows.slice(0, 200) }
  })

  r.get('/platform/users/:id', { auth: 'platform' }, async ({ params }) => {
    const { db } = await fb()
    const snap = await db.collection('users').doc(String(params.id).slice(0, 128)).get()
    if (!snap.exists) throw notFound()
    const ms = await db.collection('memberships').where('user_id', '==', snap.id).get()
    const orgIds = [...new Set(ms.docs.map(m => m.data().org_id))]
    const orgs = orgIds.length ? await db.getAll(...orgIds.map(id => db.collection('orgs').doc(id))) : []
    const name = new Map(orgs.filter(x => x.exists).map(x => [x.id, x.data().name]))
    return { ...userOut(snap, await grantsOf(db)), churches: ms.docs.map(m => { const x = m.data(); return { org_id: x.org_id, org_name: name.get(x.org_id) || '(deleted church)', role: x.role, role_label: ROLE_LABELS[x.role] || x.role, status: x.status } }) }
  })

  r.patch('/platform/users/:id', { auth: 'platform' }, async ({ ctx, params, body }) => {
    const { db } = await fb()
    const ref = db.collection('users').doc(String(params.id).slice(0, 128))
    const snap = await ref.get()
    if (!snap.exists) throw notFound()
    if (body.platformAdmin === undefined) throw bad('Nothing to change.')
    const on = body.platformAdmin === true
    if (!on && snap.id === ctx.user.id) throw bad('You can’t remove your own admin access.')
    if (!on && platformAdminEmails().includes(String(snap.data().email).toLowerCase())) throw bad('This person is an admin through the PLATFORM_ADMIN_EMAILS setting in Netlify. Remove them there.')
    await db.collection('platformAdmins').doc(snap.id).set(on ? { email: snap.data().email, active: true, granted_by: ctx.user.email, granted_at: new Date() } : { active: false, revoked_by: ctx.user.email, revoked_at: new Date() }, { merge: true })
    await platformAudit(ctx, on ? 'admin.granted' : 'admin.revoked', { type: 'user', id: snap.id, name: snap.data().email })
    return { id: snap.id, is_platform_admin: on }
  })

  // A password reset link for someone who can't get in. Emailed to them when email is set up; also shown to you to share.
  r.post('/platform/users/:id/reset-link', { auth: 'platform' }, async ({ params }) => {
    const { db, auth } = await fb()
    const snap = await db.collection('users').doc(String(params.id).slice(0, 128)).get()
    if (!snap.exists) throw notFound()
    const { email, name } = snap.data()
    let link
    try { link = await auth.generatePasswordResetLink(email) } catch (e) {
      if (/not-found|no user/i.test(e.code || e.message)) throw bad('This person signs in another way (for example, Google), so there’s no password to reset.')
      throw e
    }
    let emailed = false
    const provider = emailProvider()
    if (provider) {
      const first = String(name || '').split(' ')[0] || 'there'
      const [res] = await sendEmails(provider, [{
        from: `GatherHQ <hello@${provider.domain}>`, to: [email], subject: 'Reset your GatherHQ password',
        text: `Hi ${first},\n\nHere is a link to choose a new password for GatherHQ:\n\n${link}\n\nIf you didn't ask for this, you can ignore this email.\n\nThe GatherHQ team`,
        html: `<p>Hi ${first.replace(/[<>&]/g, '')},</p><p>Here is a link to choose a new password for GatherHQ:</p><p><a href="${link}">Choose a new password</a></p><p>If you didn’t ask for this, you can ignore this email.</p><p>The GatherHQ team</p>`,
      }])
      emailed = !!res?.ok
    }
    return { link, emailed, email }
  })

  r.post('/platform/users/:id/sign-out', { auth: 'platform' }, async ({ params }) => {
    const { db, auth } = await fb()
    const snap = await db.collection('users').doc(String(params.id).slice(0, 128)).get()
    if (!snap.exists) throw notFound()
    await auth.revokeRefreshTokens(snap.id)
    return { ok: true }
  })
}
