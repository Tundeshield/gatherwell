// The GatherHQ team's business console (admin.gatherhq.org): sign-in, money, subscriptions,
// churches, expenses, messaging economics, platform health, admins and the audit log.
// Every route here is 'platform' (separate admin session) except the sign-in itself.
// Figures come only from stored records: Stripe payments, church billing state, ledgers.
import { fb, col, plain } from '../firebase.js'
import { bad, json, notFound, unauthorized, forbidden, str, clientIp, oneOf } from '../http.js'
import { rateLimit, platformAudit } from '../util.js'
import { adminCookie, clearAdminCookie, isPlatformAdmin, platformAdminEmails, ADMIN_SESSION_HOURS } from '../access.js'
import { PLANS, billingStatus, monthlyValue } from '../../shared/plans.js'
import { billingEnabled, stripe, mode as stripeMode } from '../billing.js'
import { paymentOut, revenueOf, monthlySeries, syncFromStripe } from '../payments.js'
import { emailProvider } from '../email.js'
import { health as smsHealthOf, SMS_ADAPTERS } from '../comms/sms.js'
import { appEnv, isProduction } from '../env.js'
import { COMMIT } from '../version.js'

const DAY = 86400e3
const toD = (v) => (v ? (typeof v.toDate === 'function' ? v.toDate() : new Date(v)) : null)
const r2 = (n) => Math.round(Number(n || 0) * 100) / 100

// Date range from query: preset (today, 7d, 30d, month, last_month, year, all) or from/to (YYYY-MM-DD).
export function rangeOf(q = {}, now = new Date()) {
  const startOfDay = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const tomorrow = new Date(startOfDay(now).getTime() + DAY)
  switch (q.range) {
    case 'today': return { from: startOfDay(now), to: tomorrow, label: 'Today' }
    case '7d': return { from: new Date(tomorrow - 7 * DAY), to: tomorrow, label: 'Last 7 days' }
    case '30d': return { from: new Date(tomorrow - 30 * DAY), to: tomorrow, label: 'Last 30 days' }
    case 'last_month': return { from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)), to: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), label: 'Last month' }
    case 'year': return { from: new Date(Date.UTC(now.getUTCFullYear(), 0, 1)), to: tomorrow, label: 'This year' }
    case 'all': return { from: null, to: null, label: 'All time' }
    case 'custom': {
      const f = new Date(`${q.from}T00:00:00Z`), t = new Date(`${q.to}T00:00:00Z`)
      if (isNaN(f) || isNaN(t) || t < f) throw bad('Choose a valid date range.')
      return { from: f, to: new Date(t.getTime() + DAY), label: `${q.from} to ${q.to}` }
    }
    default: return { from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), to: tomorrow, label: 'This month' }
  }
}

const stripeBase = () => `https://dashboard.stripe.com/${stripeMode() === 'test' ? 'test/' : ''}`
function stripeLinks(p) {
  const b = stripeBase()
  return {
    payment: p.payment_intent ? `${b}payments/${p.payment_intent}` : null, invoice: p.invoice_id ? `${b}invoices/${p.invoice_id}` : null,
    subscription: p.subscription_id ? `${b}subscriptions/${p.subscription_id}` : null, customer: p.customer_id ? `${b}customers/${p.customer_id}` : null,
  }
}

async function allPayments(db) {
  const qs = await db.collection('payments').orderBy('created_at', 'desc').limit(5000).get()
  return qs.docs.map(paymentOut)
}

async function allOrgs(db) {
  const qs = await db.collection('orgs').orderBy('created_at', 'desc').limit(2000).get()
  return qs.docs.map(o => ({ id: o.id, ...o.data() }))
}

// Subscription facts for one church, from its billing record (kept in sync by Stripe webhooks).
function subOf(o, now = new Date()) {
  const s = billingStatus(o, now)
  const b = o.billing || {}
  const paying = (s.state === 'active' || s.state === 'past_due') && !!PLANS[s.plan]
  return {
    state: s.state, plan: s.plan || null, interval: s.interval || b.interval || null, manual: !!s.manual, cancelling: !!s.cancelling,
    trial_ends_at: s.trialEndsAt ? s.trialEndsAt.toISOString() : null, days_left: s.daysLeft ?? null,
    renews_at: s.renewsAt ? s.renewsAt.toISOString() : null, paying, ever_paid: !!b.last_payment_at || !!b.subscription_id,
    mrr: paying ? r2(monthlyValue(s.plan, s.interval)) : 0, last_error: b.last_error || null,
    subscription_id: b.subscription_id || null, customer_id: b.customer_id || null,
  }
}

function mrrOf(orgs, now) {
  let stripeMrr = 0, manualMrr = 0, paying = 0
  for (const o of orgs) {
    if (o.status === 'closed') continue
    const s = subOf(o, now)
    if (!s.paying) continue
    paying++
    const exact = monthlyValue(s.plan, s.interval) // unrounded, so ARR of a yearly plan is exactly its price
    if (s.manual) manualMrr += exact; else stripeMrr += exact
  }
  const exact = stripeMrr + manualMrr, mrr = r2(exact)
  return { mrr, arr: r2(exact * 12), stripe_mrr: r2(stripeMrr), manual_mrr: r2(manualMrr), paying, arppc: paying ? r2(exact / paying) : 0 }
}

const primaryCurrency = (by) => Object.entries(by).sort((a, b) => b[1].gross - a[1].gross)[0]?.[0] || 'usd'

export default function (r) {
  // --- sign-in ------------------------------------------------------------------------------
  r.post('/admin/auth/session', { auth: 'public' }, async ({ req, body }) => {
    await rateLimit(`admin-session:${clientIp(req)}`, 10, 900)
    const { db, auth } = await fb()
    let decoded
    try { decoded = await auth.verifyIdToken(String(body.idToken || '')) } catch { throw unauthorized('Your sign-in expired. Please sign in again.') }
    if (Date.now() / 1000 - decoded.auth_time > 5 * 60) throw unauthorized('Please sign in again.')
    const snap = await db.collection('users').doc(decoded.uid).get()
    const email = String(snap.data()?.email || decoded.email || '').toLowerCase()
    if (!snap.exists || !(await isPlatformAdmin(db, decoded.uid, email))) {
      await platformAudit({ user: { id: decoded.uid, email } }, 'admin.login_refused', { type: 'user', id: decoded.uid, name: email })
      throw forbidden('This account doesn’t have access to the GatherHQ admin console.')
    }
    const cookie = await auth.createSessionCookie(String(body.idToken), { expiresIn: ADMIN_SESSION_HOURS * 3600 * 1000 })
    await platformAudit({ user: { id: decoded.uid, email } }, 'admin.login', { type: 'user', id: decoded.uid, name: email })
    return json({ ok: true }, 200, { 'set-cookie': adminCookie(cookie) })
  })
  r.post('/admin/auth/logout', { auth: 'public' }, async () => json({ ok: true }, 200, { 'set-cookie': clearAdminCookie() }))
  r.get('/admin/me', { auth: 'platform' }, async ({ ctx }) => ({ user: ctx.user, env: appEnv(), stripe: billingEnabled() ? stripeMode() : null, commit: COMMIT }))

  // --- business overview ----------------------------------------------------------------------
  r.get('/platform/business', { auth: 'platform' }, async ({ query }) => {
    const { db } = await fb()
    const now = new Date()
    const range = rangeOf(query, now)
    const [payments, orgs, users, sync] = await Promise.all([allPayments(db), allOrgs(db), db.collection('users').count().get(), db.collection('platform').doc('payments').get()])
    const live = orgs.filter(o => o.status !== 'closed')
    const subs = live.map(o => ({ o, s: subOf(o, now) }))
    const month = rangeOf({ range: 'month' }, now), last = rangeOf({ range: 'last_month' }, now), year = rangeOf({ range: 'year' }, now)
    const byCur = { range: revenueOf(payments, range), month: revenueOf(payments, month), last_month: revenueOf(payments, last), year: revenueOf(payments, year), total: revenueOf(payments, {}) }
    const cur = primaryCurrency(byCur.total)
    const pick = (by) => by[cur] || { gross: 0, refunds: 0, net: 0, subscription: 0, one_off: 0, payments: 0, failed: 0, failed_amount: 0, open: 0, open_amount: 0 }
    const created = (o) => toD(o.created_at)
    const inRange = (d) => d && (!range.from || d >= range.from) && (!range.to || d < range.to)
    const activeSince = new Date(now - 30 * DAY)
    const usersActive = await db.collection('users').where('last_login_at', '>=', activeSince).count().get()
    return {
      range: { label: range.label, from: range.from?.toISOString() || null, to: range.to?.toISOString() || null },
      currency: cur, currencies: Object.keys(byCur.total),
      revenue: { range: pick(byCur.range), month: pick(byCur.month), last_month: pick(byCur.last_month), year: pick(byCur.year), total: pick(byCur.total), other_currencies: Object.fromEntries(Object.entries(byCur.range).filter(([k]) => k !== cur)) },
      recurring: mrrOf(live, now),
      churches: {
        total: live.length, paying: subs.filter(x => x.s.paying).length, trialing: subs.filter(x => x.s.state === 'trialing').length,
        trials_ending_7d: subs.filter(x => x.s.state === 'trialing' && x.s.days_left <= 7).length,
        expired_trials: subs.filter(x => x.s.state === 'expired' && !x.s.ever_paid).length,
        churned: subs.filter(x => x.s.state === 'expired' && x.s.ever_paid).length, past_due: subs.filter(x => x.s.state === 'past_due').length,
        free: subs.filter(x => x.s.state === 'free').length, suspended: live.filter(o => o.status === 'suspended').length,
        new_in_range: live.filter(o => inRange(created(o))).length,
      },
      users: { total: users.data().count, active_30d: usersActive.data().count },
      series: monthlySeries(payments, 12, now).map(m => ({ month: m.month, ...(m[cur] || { gross: 0, refunds: 0, net: 0, subscription: 0, one_off: 0 }) })),
      signups: Array.from({ length: 12 }, (_, i) => {
        const f = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11 + i, 1)), t = new Date(Date.UTC(f.getUTCFullYear(), f.getUTCMonth() + 1, 1))
        return { month: f.toISOString().slice(0, 7), count: orgs.filter(o => created(o) >= f && created(o) < t).length }
      }),
      recent_payments: payments.slice(0, 8).map(p => ({ ...p, org_name: orgs.find(o => o.id === p.org_id)?.name || null })),
      recent_signups: live.slice(0, 6).map(o => { const s = subOf(o, now); return { id: o.id, name: o.name, created_at: plain(o.created_at), billing: { state: s.state, daysLeft: s.days_left, plan: s.plan, interval: s.interval, manual: s.manual, cancelling: s.cancelling, lapsed: s.ever_paid } } }),
      payments_synced_at: plain(sync.data()?.synced_at) || null, stripe: billingEnabled() ? stripeMode() : null,
      notes: ['Revenue is money collected through Stripe (paid invoices and one-off payments). Failed, open and refunded amounts are shown separately and never counted as revenue.',
        'MRR is each paying church’s current plan at list price (yearly plans ÷ 12), including plans set by hand. Discounts or coupons applied in Stripe aren’t reflected.'],
    }
  })

  // --- churches ---------------------------------------------------------------------------------
  r.get('/platform/churches', { auth: 'platform' }, async ({ query }) => {
    const { db } = await fb()
    const now = new Date()
    const [orgs, payments] = await Promise.all([allOrgs(db), allPayments(db)])
    const paid = {}
    for (const p of payments) {
      if (!p.org_id || !['paid', 'refunded', 'partially_refunded'].includes(p.status)) continue
      const x = (paid[p.org_id] ||= { count: 0, by: {} })
      x.count++; x.by[p.currency] = r2((x.by[p.currency] || 0) + p.amount - p.amount_refunded)
    }
    const failed = new Set(payments.filter(p => p.status === 'failed').map(p => p.org_id))
    const q = String(query.q || '').trim().toLowerCase()
    let rows = orgs.map(o => {
      const s = subOf(o, now)
      return { id: o.id, name: o.name, logo_url: o.branding?.logo_url || o.logo_url || null, status: o.status, country: o.country || null, created_at: plain(o.created_at),
        contact_email: o.billing?.email || o.contact_email || null, sub: s, payments: paid[o.id]?.count || 0, lifetime: paid[o.id]?.by || {}, has_failed_payment: failed.has(o.id),
        people: null, branches: null, users: null, last_activity_at: plain(o.last_activity_at) || null }
    })
    if (q) rows = rows.filter(x => `${x.name} ${x.contact_email || ''} ${x.id}`.toLowerCase().includes(q))
    const state = query.state
    if (state === 'paying') rows = rows.filter(x => x.sub.paying)
    else if (state === 'annual') rows = rows.filter(x => x.sub.paying && x.sub.interval === 'yearly')
    else if (state === 'trial_ending') rows = rows.filter(x => x.sub.state === 'trialing' && x.sub.days_left <= 7)
    else if (state === 'failed') rows = rows.filter(x => x.has_failed_payment || x.sub.state === 'past_due')
    else if (state === 'churned') rows = rows.filter(x => x.sub.state === 'expired' && x.sub.ever_paid)
    else if (state === 'suspended') rows = rows.filter(x => x.status === 'suspended')
    else if (state) rows = rows.filter(x => x.sub.state === state)
    const page = Math.max(1, Number(query.page) || 1), size = 50
    const slice = rows.slice((page - 1) * size, page * size)
    // Usage counts only for the rows on this page.
    await Promise.all(slice.map(async x => {
      const C = (n) => col(db, x.id, n)
      const [people, branches, users, last] = await Promise.all([C('people').count().get(), C('branches').count().get(),
        db.collection('memberships').where('org_id', '==', x.id).where('status', '==', 'active').count().get(), C('checkins').orderBy('created_at', 'desc').limit(1).get()])
      x.people = people.data().count; x.branches = branches.data().count; x.users = users.data().count
      x.last_activity_at = last.empty ? x.last_activity_at : plain(last.docs[0].data().created_at)
    }))
    return { total: rows.length, page, pages: Math.max(1, Math.ceil(rows.length / size)), rows: slice }
  })

  // Payments, subscription, credit and onboarding for one church (added to the existing church page).
  r.get('/platform/churches/:id/business', { auth: 'platform' }, async ({ params }) => {
    const { db } = await fb()
    const o = await db.collection('orgs').doc(String(params.id).slice(0, 64)).get()
    if (!o.exists) throw notFound()
    const d = o.data()
    const C = (n) => col(db, o.id, n)
    const [pays, people, gatherings, checkins, team, msgs, workflows, events] = await Promise.all([
      db.collection('payments').where('org_id', '==', o.id).get(), C('people').count().get(), C('gatherings').count().get(), C('checkins').count().get(),
      db.collection('memberships').where('org_id', '==', o.id).where('status', '==', 'active').count().get(), C('messages').count().get(), C('workflows').count().get(), C('events').count().get(),
    ])
    const payments = pays.docs.map(paymentOut).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    const n = (x) => x.data().count
    const steps = [
      ['Added people', n(people) > 0], ['Set up a service or meeting', n(gatherings) > 0], ['Recorded attendance', n(checkins) > 0],
      ['Invited a team member', n(team) > 1], ['Sent a message', n(msgs) > 0], ['Switched on a workflow', n(workflows) > 0], ['Created an event', n(events) > 0],
      ['Chose a paid plan', subOf(d).paying || subOf(d).ever_paid],
    ].map(([label, done]) => ({ label, done }))
    return {
      sub: subOf(d), credits: { balance: r2(d.credits?.balance || 0) }, payments, lifetime: revenueOf(payments, {}),
      onboarding: { steps, done: steps.filter(s => s.done).length, total: steps.length },
      stripe: { customer: d.billing?.customer_id ? `${stripeBase()}customers/${d.billing.customer_id}` : null, subscription: d.billing?.subscription_id ? `${stripeBase()}subscriptions/${d.billing.subscription_id}` : null },
    }
  })

  // --- orders and payments ------------------------------------------------------------------------
  r.get('/platform/payments', { auth: 'platform' }, async ({ query }) => {
    const { db } = await fb()
    const range = query.range ? rangeOf(query) : { from: null, to: null }
    const [all, orgs] = await Promise.all([allPayments(db), allOrgs(db)])
    const names = new Map(orgs.map(o => [o.id, o.name]))
    let rows = all.filter(p => {
      const at = p.created_at ? new Date(p.created_at) : null
      if (range.from && (!at || at < range.from || at >= range.to)) return false
      if (query.status === 'successful' && !['paid', 'partially_refunded'].includes(p.status)) return false
      if (query.status === 'refunded' && !(p.amount_refunded > 0)) return false
      if (query.status && !['successful', 'refunded'].includes(query.status) && p.status !== query.status) return false
      if (query.kind && p.kind !== query.kind) return false
      if (query.currency && p.currency !== query.currency) return false
      if (query.org && p.org_id !== query.org) return false
      return true
    })
    const q = String(query.q || '').trim().toLowerCase()
    if (q) rows = rows.filter(p => `${names.get(p.org_id) || ''} ${p.id} ${p.invoice_number || ''} ${p.payment_intent || ''}`.toLowerCase().includes(q))
    const page = Math.max(1, Number(query.page) || 1), size = 50
    const sync = (await db.collection('platform').doc('payments').get()).data()
    return {
      total: rows.length, page, pages: Math.max(1, Math.ceil(rows.length / size)), totals: revenueOf(rows, {}),
      currencies: [...new Set(all.map(p => p.currency))], synced_at: plain(sync?.synced_at) || null, stripe: billingEnabled() ? stripeMode() : null,
      rows: rows.slice((page - 1) * size, page * size).map(p => ({ ...p, org_name: names.get(p.org_id) || null })),
    }
  })

  r.get('/platform/payments/:id', { auth: 'platform' }, async ({ params }) => {
    const { db } = await fb()
    const s = await db.collection('payments').doc(String(params.id).slice(0, 200)).get()
    if (!s.exists) throw notFound()
    const p = paymentOut(s)
    const org = p.org_id ? (await db.collection('orgs').doc(p.org_id).get()).data() : null
    return { ...p, org_name: org?.name || null, links: stripeLinks(p) }
  })

  r.post('/platform/payments/sync', { auth: 'platform' }, async ({ ctx }) => {
    if (!billingEnabled()) throw bad('Stripe isn’t connected here (STRIPE_SECRET_KEY isn’t set).')
    await rateLimit('payments-sync', 6, 600)
    const res = await syncFromStripe({ stripe })
    await platformAudit(ctx, 'payments.synced', { type: 'stripe', name: stripeMode() }, res)
    return res
  })

  // --- subscriptions and pricing --------------------------------------------------------------------
  r.get('/platform/subscriptions', { auth: 'platform' }, async ({ query }) => {
    const { db } = await fb()
    const now = new Date()
    const [orgs, changes, billing] = await Promise.all([allOrgs(db), db.collection('subscriptionChanges').orderBy('at', 'desc').limit(100).get(), db.collection('platform').doc('billing').get()])
    const rows = orgs.filter(o => o.status !== 'closed').map(o => ({ id: o.id, name: o.name, created_at: plain(o.created_at), ...subOf(o, now) }))
    const count = (f) => rows.filter(f).length
    const byPlan = Object.keys(PLANS).map(k => ({
      plan: k, name: PLANS[k].name, monthly_price: PLANS[k].monthly, yearly_price: PLANS[k].yearly,
      monthly: count(x => x.paying && x.plan === k && x.interval !== 'yearly'), yearly: count(x => x.paying && x.plan === k && x.interval === 'yearly'),
      mrr: r2(rows.filter(x => x.paying && x.plan === k).reduce((a, x) => a + x.mrr, 0)),
    }))
    const everPaid = rows.filter(x => x.ever_paid)
    const in30 = new Date(now.getTime() + 30 * DAY)
    const list = query.state ? rows.filter(x => query.state === 'renewing' ? x.paying && !x.cancelling && x.renews_at && new Date(x.renews_at) <= in30
      : query.state === 'cancelling' ? x.cancelling : query.state === 'churned' ? x.state === 'expired' && x.ever_paid : query.state === 'expired_trial' ? x.state === 'expired' && !x.ever_paid
        : query.state === 'paying' ? x.paying : x.state === query.state) : rows
    const prices = billing.data()?.stripe?.[stripeMode()]?.prices || {}
    return {
      counts: {
        active: count(x => x.state === 'active' && !x.cancelling), trialing: count(x => x.state === 'trialing'), expired_trial: count(x => x.state === 'expired' && !x.ever_paid),
        cancelling: count(x => x.cancelling), churned: count(x => x.state === 'expired' && x.ever_paid), past_due: count(x => x.state === 'past_due'), free: count(x => x.state === 'free'),
        monthly: count(x => x.paying && x.interval !== 'yearly'), yearly: count(x => x.paying && x.interval === 'yearly'), manual: count(x => x.paying && x.manual),
        renewing_30d: count(x => x.paying && !x.cancelling && x.renews_at && new Date(x.renews_at) <= in30),
      },
      retention: { ever_paid: everPaid.length, still_paying: everPaid.filter(x => x.paying).length, rate: everPaid.length ? Math.round(100 * everPaid.filter(x => x.paying).length / everPaid.length) : null },
      plans: byPlan, stripe_prices: Object.fromEntries(Object.entries(prices).map(([k, v]) => [k, typeof v === 'string' ? v : v?.id || null])), stripe: billingEnabled() ? stripeMode() : null,
      changes: changes.docs.map(c => { const x = c.data(); return { ...x, at: plain(x.at) } }),
      rows: list.sort((a, b) => String(a.renews_at || a.trial_ends_at || '').localeCompare(String(b.renews_at || b.trial_ends_at || ''))).slice(0, 200),
      links: { base: stripeBase() },
    }
  })

  // --- expenses -------------------------------------------------------------------------------------
  const CATS = ['hosting', 'email', 'messaging', 'software', 'domains', 'marketing', 'contractors', 'other']
  const expenseIn = (b) => {
    const amount = Number(b.amount)
    if (!(amount > 0 && amount < 1e7)) throw bad('Enter an amount.')
    const date = new Date(`${String(b.date || '').slice(0, 10)}T00:00:00Z`)
    if (isNaN(date)) throw bad('Choose a date.')
    return { name: str(b.name, { max: 120, name: 'Name', required: true }), category: oneOf(b.category, CATS, { fallback: 'other' }), amount: r2(amount),
      currency: String(b.currency || 'usd').toLowerCase().replace(/[^a-z]/g, '').slice(0, 3) || 'usd', date, vendor: str(b.vendor, { max: 120 }) || null,
      description: str(b.description, { max: 1000 }) || null, recurring: oneOf(b.recurring, ['one_off', 'monthly', 'yearly'], { fallback: 'one_off' }) }
  }
  const expenseOut = (s) => { const x = s.data(); return { id: s.id, ...x, date: plain(x.date)?.slice(0, 10), created_at: plain(x.created_at), updated_at: plain(x.updated_at), receipt: x.receipt ? { name: x.receipt.name, type: x.receipt.type, size: x.receipt.size } : null } }

  r.get('/platform/expenses', { auth: 'platform' }, async ({ query }) => {
    const { db } = await fb()
    const now = new Date()
    const range = rangeOf({ range: query.range || 'year', from: query.from, to: query.to }, now)
    const qs = await db.collection('platformExpenses').orderBy('date', 'desc').limit(2000).get()
    const all = qs.docs.map(expenseOut)
    const inR = (e) => { const d = new Date(`${e.date}T00:00:00Z`); return (!range.from || d >= range.from) && (!range.to || d < range.to) }
    const rows = all.filter(inR).filter(e => !query.category || e.category === query.category)
    const sum = (list) => { const by = {}; for (const e of list) by[e.currency] = r2((by[e.currency] || 0) + e.amount); return by }
    const byCat = {}
    for (const e of rows) { const c = (byCat[e.category] ||= {}); c[e.currency] = r2((c[e.currency] || 0) + e.amount) }
    const months = Array.from({ length: 12 }, (_, i) => {
      const f = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11 + i, 1)), t = new Date(Date.UTC(f.getUTCFullYear(), f.getUTCMonth() + 1, 1))
      return { month: f.toISOString().slice(0, 7), ...sum(all.filter(e => { const d = new Date(`${e.date}T00:00:00Z`); return d >= f && d < t })) }
    })
    // Revenue less expenses, same range, same currency only (no conversion).
    const payments = await allPayments(db)
    const rev = revenueOf(payments, range)
    const totals = sum(rows)
    const pnl = Object.fromEntries([...new Set([...Object.keys(totals), ...Object.keys(rev)])].map(c => {
      const net = rev[c]?.net || 0, exp = totals[c] || 0
      return [c, { revenue: net, expenses: exp, result: r2(net - exp), margin: net > 0 ? Math.round(100 * (net - exp) / net) : null }]
    }))
    return { range: { label: range.label }, rows, totals, by_category: byCat, months, pnl, categories: CATS,
      note: 'Expenses are what you record here by hand. Revenue less expenses is an estimate, not audited accounts or tax reporting. Different currencies are never combined.' }
  })
  r.post('/platform/expenses', { auth: 'platform' }, async ({ ctx, body }) => {
    const { db } = await fb()
    const data = expenseIn(body)
    const ref = await db.collection('platformExpenses').add({ ...data, created_at: new Date(), created_by: ctx.user.email })
    await platformAudit(ctx, 'expense.created', { type: 'expense', id: ref.id, name: data.name }, { amount: data.amount, currency: data.currency })
    return expenseOut(await ref.get())
  })
  r.patch('/platform/expenses/:id', { auth: 'platform' }, async ({ ctx, params, body }) => {
    const { db } = await fb()
    const ref = db.collection('platformExpenses').doc(String(params.id).slice(0, 64))
    if (!(await ref.get()).exists) throw notFound()
    const data = expenseIn(body)
    await ref.update({ ...data, updated_at: new Date() })
    await platformAudit(ctx, 'expense.updated', { type: 'expense', id: ref.id, name: data.name }, { amount: data.amount, currency: data.currency })
    return expenseOut(await ref.get())
  })
  r.delete('/platform/expenses/:id', { auth: 'platform' }, async ({ ctx, params }) => {
    const { db } = await fb()
    const ref = db.collection('platformExpenses').doc(String(params.id).slice(0, 64))
    const s = await ref.get()
    if (!s.exists) throw notFound()
    await ref.delete()
    await db.collection('platformExpenseReceipts').doc(ref.id).delete().catch(() => {})
    await platformAudit(ctx, 'expense.deleted', { type: 'expense', id: ref.id, name: s.data().name })
    return { ok: true }
  })
  // Receipts: up to 700 KB (PDF or image), kept beside the expense.
  r.post('/platform/expenses/:id/receipt', { auth: 'platform' }, async ({ ctx, params, body }) => {
    const { db } = await fb()
    const ref = db.collection('platformExpenses').doc(String(params.id).slice(0, 64))
    if (!(await ref.get()).exists) throw notFound()
    const type = oneOf(body.type, ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'], { name: 'File type' })
    if (!type) throw bad('Receipts can be a PDF or an image.')
    const data = String(body.data || '').replace(/^data:[^,]*,/, '')
    if (!/^[A-Za-z0-9+/=]+$/.test(data)) throw bad('That file couldn’t be read.')
    const size = Math.floor(data.length * 3 / 4)
    if (size > 700 * 1024) throw bad('Receipts can be up to 700 KB. Try a smaller scan or photo.')
    const name = str(body.name, { max: 120 }) || 'receipt'
    await db.collection('platformExpenseReceipts').doc(ref.id).set({ data, type, name, size, at: new Date() })
    await ref.update({ receipt: { name, type, size } })
    await platformAudit(ctx, 'expense.receipt_added', { type: 'expense', id: ref.id }, { name, size })
    return { ok: true }
  })
  r.get('/platform/expenses/:id/receipt', { auth: 'platform' }, async ({ params }) => {
    const { db } = await fb()
    const s = await db.collection('platformExpenseReceipts').doc(String(params.id).slice(0, 64)).get()
    if (!s.exists) throw notFound()
    const x = s.data()
    return new Response(Buffer.from(x.data, 'base64'), { headers: { 'content-type': x.type, 'content-disposition': `attachment; filename="${x.name.replace(/[^\w. -]/g, '')}"`, 'cache-control': 'no-store' } })
  })

  // --- messaging economics -------------------------------------------------------------------------
  r.get('/platform/messaging', { auth: 'platform' }, async ({ query }) => {
    const { db } = await fb()
    const range = rangeOf({ range: query.range || '30d', from: query.from, to: query.to })
    const orgs = (await allOrgs(db)).filter(o => o.status !== 'closed')
    const email = { sent: 0, delivered: 0, failed: 0, bounced: 0, opened: 0, unsubscribes: 0 }
    const sms = { sent: 0, delivered: 0, failed: 0, segments: 0, revenue: 0, refunds: 0, provider_cost: 0, cost_known: 0, cost_unknown: 0, purchases: 0, purchase_count: 0 }
    const byCountry = {}, byChurch = [], byProvider = {}
    const whatsapp = { sent: 0 }
    const inR = (d) => d && (!range.from || d >= range.from) && (!range.to || d < range.to)
    for (const o of orgs) {
      const C = (n) => col(db, o.id, n)
      let q = C('deliveries')
      if (range.from) q = q.where('created_at', '>=', range.from).where('created_at', '<', range.to)
      const [dels, led, unsub] = await Promise.all([q.limit(20000).get(), range.from ? C('creditLedger').where('created_at', '>=', range.from).where('created_at', '<', range.to).get() : C('creditLedger').get(),
        C('people').where('email_opt_out', '==', true).count().get()])
      email.unsubscribes += unsub.data().count
      const mine = { id: o.id, name: o.name, email: 0, sms: 0, sms_revenue: 0, balance: r2(o.credits?.balance || 0) }
      for (const d of dels.docs) {
        const x = d.data()
        if (x.channel === 'email') {
          if (['sent', 'delivered', 'read', 'unknown'].includes(x.status)) email.sent++
          if (['delivered', 'read'].includes(x.status)) email.delivered++
          if (x.status === 'read') email.opened++
          if (x.status === 'failed') { email.failed++; if (/bounce/i.test(x.error || '')) email.bounced++ }
          mine.email++
        } else if (x.channel === 'sms') {
          if (['sent', 'delivered', 'read', 'unknown'].includes(x.status)) sms.sent++
          if (['delivered', 'read'].includes(x.status)) sms.delivered++
          if (x.status === 'failed') sms.failed++
          mine.sms++
        } else if (x.channel === 'whatsapp') whatsapp.sent++
      }
      for (const e of led.docs) {
        const x = e.data()
        if (!inR(toD(x.created_at))) continue
        if (x.type === 'settlement') {
          sms.revenue += x.actual_cost || 0; sms.segments += x.segments || 0; mine.sms_revenue += x.actual_cost || 0
          const c = (byCountry[x.country || 'OTHER'] ||= { count: 0, segments: 0, revenue: 0 }); c.count++; c.segments += x.segments || 0; c.revenue += x.actual_cost || 0
          const p = (byProvider[x.provider || 'unknown'] ||= { count: 0, revenue: 0, provider_cost: 0, cost_unknown: 0 }); p.count++; p.revenue += x.actual_cost || 0
          if (typeof x.provider_cost === 'number') { sms.provider_cost += x.provider_cost; sms.cost_known++; p.provider_cost += x.provider_cost } else { sms.cost_unknown++; p.cost_unknown++ }
        }
        if (x.type === 'refund') { sms.refunds += x.amount || 0; mine.sms_revenue -= x.amount || 0 }
        if (x.type === 'purchase') { sms.purchases += x.amount || 0; sms.purchase_count++ }
      }
      if (mine.email || mine.sms || mine.balance) byChurch.push({ ...mine, sms_revenue: r2(mine.sms_revenue) })
    }
    for (const k of ['revenue', 'refunds', 'provider_cost', 'purchases']) sms[k] = r2(sms[k])
    sms.net_revenue = r2(sms.revenue - sms.refunds)
    sms.margin = sms.cost_known && !sms.cost_unknown ? r2(sms.net_revenue - sms.provider_cost) : null
    const [senders, cfg] = await Promise.all([db.collection('smsSenderRequests').get(), db.collection('platform').doc('comms').get()])
    const senderCounts = {}
    for (const s of senders.docs) { const st = s.data().status || 'pending'; senderCounts[st] = (senderCounts[st] || 0) + 1 }
    const provider = emailProvider()
    return {
      range: { label: range.label }, email: { ...email, rate: email.sent ? Math.round(100 * email.delivered / email.sent) : null, provider: provider ? { name: 'Resend', domain: provider.domain } : null },
      sms: { ...sms, rate: sms.sent ? Math.round(100 * sms.delivered / sms.sent) : null, sender_ids: senderCounts },
      by_country: Object.entries(byCountry).map(([country, v]) => ({ country, ...v, revenue: r2(v.revenue) })).sort((a, b) => b.revenue - a.revenue),
      by_provider: Object.entries(byProvider).map(([id, v]) => ({ id, ...v, revenue: r2(v.revenue), provider_cost: r2(v.provider_cost) })),
      by_church: byChurch.sort((a, b) => b.sms_revenue - a.sms_revenue || b.email - a.email).slice(0, 50),
      balances: { total: r2(orgs.reduce((a, o) => a + (o.credits?.balance || 0), 0)), churches: orgs.filter(o => (o.credits?.balance || 0) > 0).length },
      whatsapp: { automation: 'Coming soon: not connected', sent: whatsapp.sent, note: 'One-tap WhatsApp opens on staff phones; GatherHQ can’t see whether those are sent.' },
      provider_config_updated_by: cfg.data()?.updated_by || null,
      notes: ['SMS revenue is credit actually used for sent texts (settlements) less refunds for undelivered ones. Credit bought but not yet used is a balance, not revenue.',
        sms.cost_unknown ? 'Some providers didn’t report their cost for a text, so the margin can’t be calculated exactly for this period.' : null].filter(Boolean),
    }
  })

  // --- platform health ---------------------------------------------------------------------------
  r.get('/platform/health', { auth: 'platform' }, async () => {
    const { db } = await fb()
    const t0 = Date.now()
    await db.collection('platform').doc('billing').get()
    const dbMs = Date.now() - t0
    const now = new Date()
    const [runs, hooks, errors, queue, audits, sh, recentOrgs, changes] = await Promise.all([
      db.collection('schedulerRuns').orderBy('at', 'desc').limit(20).get(),
      db.collection('billingEvents').orderBy('at', 'desc').limit(30).get(),
      db.collection('errorLog').orderBy('at', 'desc').limit(30).get(),
      db.collection('commsQueue').where('due_at', '<=', new Date(now.getTime() - 10 * 60e3)).count().get(),
      db.collection('platformAudit').orderBy('created_at', 'desc').limit(10).get(),
      smsHealthOf({ fresh: true }),
      db.collection('orgs').orderBy('created_at', 'desc').limit(8).get(),
      db.collection('subscriptionChanges').orderBy('at', 'desc').limit(8).get(),
    ])
    const lastRun = runs.docs[0]?.data()
    const lastAt = toD(lastRun?.at)
    const failedRuns = runs.docs.filter(d => d.data().errors).length
    const orgs = (await allOrgs(db)).filter(o => o.status !== 'closed')
    let failedDeliveries = 0
    const since = new Date(now.getTime() - DAY)
    for (const o of orgs) failedDeliveries += (await col(db, o.id, 'deliveries').where('created_at', '>=', since).get()).docs.filter(d => d.data().status === 'failed').length
    const failedPayments = (await db.collection('payments').where('status', '==', 'failed').get()).docs.map(paymentOut).filter(p => new Date(p.created_at) >= new Date(now.getTime() - 30 * DAY))
    return {
      app: { ok: true, env: appEnv(), commit: COMMIT, production: isProduction() },
      database: { ok: dbMs < 2000, ms: dbMs },
      scheduler: { ok: !!lastAt && now - lastAt < 10 * 60e3, last_run_at: plain(lastRun?.at) || null, recent_failures: failedRuns, overdue_items: queue.data().count,
        runs: runs.docs.map(d => { const x = d.data(); return { at: plain(x.at), kind: x.kind || 'jobs', ms: x.took_ms ?? null, errors: x.errors || 0 } }) },
      webhooks: { last_at: plain(hooks.docs[0]?.data().at) || null, failed: hooks.docs.filter(d => d.data().ok === false).length,
        events: hooks.docs.map(d => { const x = d.data(); return { id: d.id, type: x.event, at: plain(x.at), ok: x.ok ?? null, result: x.result || null, error: x.error || null } }) },
      providers: { email: emailProvider() ? 'configured' : 'not configured', sms: Object.entries(sh || {}).map(([id, v]) => ({ id, label: SMS_ADAPTERS[id]?.label || id, failures: v.consecutive_failures || 0, ok: v.ok_count || 0, failed: v.fail_count || 0, down_until: plain(v.down_until) || null, last_error: v.last_error || null, last_error_at: plain(v.last_error_at) || null })) },
      failures: { deliveries_24h: failedDeliveries, payments_30d: failedPayments.length },
      errors: errors.docs.map(d => { const x = d.data(); return { at: plain(x.at), method: x.method, path: x.path, message: x.message } }),
      recent: { signups: recentOrgs.docs.map(o => ({ id: o.id, name: o.data().name, at: plain(o.data().created_at) })), subscription_changes: changes.docs.map(c => { const x = c.data(); return { ...x, at: plain(x.at) } }),
        admin_actions: audits.docs.map(a => { const x = a.data(); return { action: x.action, by: x.by_email, target: x.target_name || x.target_id, at: plain(x.created_at) } }) },
    }
  })

  // --- audit log ---------------------------------------------------------------------------------
  r.get('/platform/audit', { auth: 'platform' }, async ({ query }) => {
    const { db } = await fb()
    let q = db.collection('platformAudit').orderBy('created_at', 'desc')
    if (query.before) { const b = new Date(query.before); if (!isNaN(b)) q = q.where('created_at', '<', b) }
    const qs = await q.limit(51).get()
    const rows = qs.docs.slice(0, 50).map(a => { const x = a.data(); return { id: a.id, action: x.action, by: x.by_email, target_type: x.target_type, target_id: x.target_id, target_name: x.target_name, meta: x.meta || {}, at: plain(x.created_at) } })
    const f = String(query.q || '').toLowerCase()
    return { rows: f ? rows.filter(x => JSON.stringify(x).toLowerCase().includes(f)) : rows, next: qs.docs.length > 50 ? rows[rows.length - 1].at : null }
  })

  // --- platform administrators ---------------------------------------------------------------------
  r.get('/platform/admins', { auth: 'platform' }, async () => {
    const { db } = await fb()
    const grants = await db.collection('platformAdmins').get()
    return {
      from_settings: platformAdminEmails(),
      granted: grants.docs.map(g => { const x = g.data(); return { user_id: g.id, email: x.email, active: x.active === true, granted_by: x.granted_by || null, granted_at: plain(x.granted_at) || null } }).filter(x => x.active),
    }
  })
  r.post('/platform/admins', { auth: 'platform' }, async ({ ctx, body }) => {
    const { db } = await fb()
    const email = String(body.email || '').trim().toLowerCase()
    if (body.confirm !== email) throw bad('Type the email address again to confirm.')
    const u = await db.collection('users').where('email', '==', email).limit(1).get()
    if (u.empty) throw bad('That person needs a GatherHQ account first.')
    await db.collection('platformAdmins').doc(u.docs[0].id).set({ email, active: true, granted_by: ctx.user.email, granted_at: new Date() })
    await platformAudit(ctx, 'admin.granted', { type: 'user', id: u.docs[0].id, name: email })
    return { ok: true }
  })
  r.delete('/platform/admins/:uid', { auth: 'platform' }, async ({ ctx, params }) => {
    const { db } = await fb()
    if (params.uid === ctx.user.id) throw bad('You can’t remove your own admin access.')
    const ref = db.collection('platformAdmins').doc(String(params.uid).slice(0, 128))
    const s = await ref.get()
    if (!s.exists) throw notFound()
    await ref.set({ active: false, revoked_by: ctx.user.email, revoked_at: new Date() }, { merge: true })
    await platformAudit(ctx, 'admin.revoked', { type: 'user', id: ref.id, name: s.data().email })
    return { ok: true }
  })

  // Read-only view of plans and their Stripe prices (prices themselves are set in shared/plans.js and Stripe).
  r.get('/platform/pricing', { auth: 'platform' }, async () => {
    const { db } = await fb()
    const b = (await db.collection('platform').doc('billing').get()).data() || {}
    const comms = (await db.collection('platform').doc('comms').get()).data() || {}
    return { plans: Object.values(PLANS).map(p => ({ key: p.key, name: p.name, monthly: p.monthly, yearly: p.yearly })), currency: 'USD',
      stripe: billingEnabled() ? stripeMode() : null, stripe_prices: b.stripe?.[stripeMode()]?.prices || {}, credit_packs: comms.sms?.packs || [10, 25, 50] }
  })
}
