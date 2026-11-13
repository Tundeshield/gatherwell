// The GatherHQ team's business console: separate admin sign-in, revenue from Stripe records only,
// Stripe sync, subscriptions, expenses, messaging, health and the audit log.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { setFirebase } from '../server/firebase.js'
import { handle } from '../server/app.js'
import { createFakeFirebase } from './fake-firebase.js'
import { revenueOf } from '../server/payments.js'
import { rangeOf } from '../server/routes/business.js'

process.env.APP_ENV = 'staging'
process.env.GW_INSECURE_COOKIES = '1'
process.env.PLATFORM_ADMIN_EMAILS = 'ops@gatherhq.test'
let fake
before(() => { fake = createFakeFirebase(); setFirebase(fake); Object.assign(process.env, { STRIPE_SECRET_KEY: 'sk_test_biz', STRIPE_WEBHOOK_SECRET: 'whsec_biz' }) })
after(() => { delete process.env.STRIPE_SECRET_KEY; delete process.env.STRIPE_WEBHOOK_SECRET })

let ipSeq = 0
function client(host = 'test.local') {
  const jar = new Map()
  const ip = `10.7.0.${++ipSeq}`
  const call = async (method, path, body) => {
    const init = { method, headers: { 'x-nf-client-connection-ip': ip } }
    if (jar.size) init.headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
    if (body !== undefined) { init.body = JSON.stringify(body); init.headers['content-type'] = 'application/json' }
    const res = await handle(new Request(`http://${host}/api${path}`, init))
    const set = res.headers.get('set-cookie'); if (set) { const [kv] = set.split(';'); const i = kv.indexOf('='); const v = kv.slice(i + 1); if (v) jar.set(kv.slice(0, i), v); else jar.delete(kv.slice(0, i)) }
    const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text()
    return { status: res.status, data, headers: res.headers }
  }
  return { jar, get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), patch: (p, b) => call('PATCH', p, b), del: (p) => call('DELETE', p),
    login: (email, pw = 'password123') => call('POST', '/auth/session', { idToken: fake.auth.signIn(email, pw) }),
    adminLogin: (email, pw = 'password123') => call('POST', '/admin/auth/session', { idToken: fake.auth.signIn(email, pw) }) }
}
async function church(name, email) {
  const c = client()
  const r = await c.post('/auth/signup', { acceptTerms: true, orgName: name, name: 'Owner', email, password: 'password123', timezone: 'Africa/Lagos' })
  assert.equal(r.status, 201, JSON.stringify(r.data))
  await c.login(email)
  c.orgId = (await c.get('/me')).data.org.id
  return c
}
function hook(evt) {
  const raw = JSON.stringify(evt)
  const t = Math.floor(Date.now() / 1000)
  const sig = `t=${t},v1=${crypto.createHmac('sha256', 'whsec_biz').update(`${t}.${raw}`).digest('hex')}`
  return handle(new Request('http://test.local/api/webhooks/stripe', { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': sig }, body: raw }))
}
const S = {}
const now = Math.floor(Date.now() / 1000)
const invoice = (id, orgId, status, amount, extra = {}) => ({ id, object: 'invoice', customer: `cus_${orgId}`, subscription: `sub_${orgId}`, subscription_details: { metadata: { org_id: orgId } }, status, paid: status === 'paid', amount_paid: status === 'paid' ? amount : 0, amount_due: amount, currency: 'usd', created: now, status_transitions: { paid_at: status === 'paid' ? now : null }, lines: { data: [{ description: '1 × Single church', price: { lookup_key: 'gatherhq_church_monthly', recurring: { interval: 'month' } } }] }, livemode: false, attempt_count: 1, ...extra })

test('the church app never grants platform access; the console has its own sign-in', async () => {
  S.a = await church('Biz Church A', 'a@biz.test')
  S.b = await church('Biz Church B', 'b@biz.test')
  // Even the platform owner's own church session gets nothing from the console API.
  S.ops = await church('Ops Church', 'ops@gatherhq.test')
  let r = await S.ops.get('/me')
  assert.equal(r.data.user.isPlatformAdmin, undefined, 'church session carries no platform flag')
  assert.equal((await S.ops.get('/platform/business')).status, 403)
  assert.equal((await client().get('/platform/business')).status, 401, 'signed out: 401')
  // A church owner can't sign in to the console.
  r = await S.a.adminLogin('a@biz.test')
  assert.equal(r.status, 403)
  // The owner can, and gets a separate, short-lived, strict cookie only for /api.
  r = await S.ops.adminLogin('ops@gatherhq.test')
  assert.equal(r.status, 200)
  const cookie = r.headers.get('set-cookie')
  assert.match(cookie, /^ghq_admin=/); assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/); assert.match(cookie, /Path=\/api/); assert.match(cookie, /Max-Age=43200/)
  assert.equal((await S.ops.get('/admin/me')).status, 200)
  // An old sign-in token is refused.
  const stale = `idtoken:${(await S.ops.get('/me')).data.user.id}:${Date.now() - 10 * 60e3}`
  assert.equal((await client().post('/admin/auth/session', { idToken: stale })).status, 401)
  // Sign-ins (and refusals) are in the platform audit log.
  r = await S.ops.get('/platform/audit')
  assert.ok(r.data.rows.some(x => x.action === 'admin.login' && x.by === 'ops@gatherhq.test'))
  assert.ok(r.data.rows.some(x => x.action === 'admin.login_refused' && x.target_name === 'a@biz.test'))
})

test('in production the console API only answers on the admin address', async () => {
  const saved = process.env.APP_ENV
  process.env.APP_ENV = 'production'
  delete process.env.ADMIN_ANY_HOST
  try {
    const main = client('gatherhq.org'), admin = client('admin.gatherhq.org')
    for (const [k, v] of S.ops.jar) { main.jar.set(k, v); admin.jar.set(k, v) }
    assert.equal((await main.get('/platform/business')).status, 404)
    assert.equal((await admin.get('/admin/me')).status, 200)
  } finally { process.env.APP_ENV = saved }
})

test('revenue comes only from Stripe payment records; failed, open and refunds handled', async () => {
  const db = fake.db
  await db.collection('billingCustomers').doc(`cus_${S.a.orgId}`).set({ org_id: S.a.orgId })
  await db.collection('billingCustomers').doc(`cus_${S.b.orgId}`).set({ org_id: S.b.orgId })
  // Church A pays $19 (subscription), Church B's payment fails, Church A buys $10 of credit, then $4 is refunded.
  let r = await hook({ id: 'evt_1', type: 'invoice.paid', created: now, data: { object: invoice('in_a1', S.a.orgId, 'paid', 1900) } })
  assert.equal(r.status, 200)
  r = await hook({ id: 'evt_1', type: 'invoice.paid', created: now, data: { object: invoice('in_a1', S.a.orgId, 'paid', 1900) } })
  assert.equal((await r.json()).duplicate, true, 'duplicate webhook ignored')
  await hook({ id: 'evt_2', type: 'invoice.payment_failed', created: now, data: { object: invoice('in_b1', S.b.orgId, 'open', 1900, { last_payment_error: { message: 'Card declined' } }) } })
  await hook({ id: 'evt_3', type: 'checkout.session.completed', created: now, data: { object: { id: 'cs_1', object: 'checkout.session', mode: 'payment', payment_status: 'paid', payment_intent: 'pi_cred1', amount_total: 1000, currency: 'usd', customer: `cus_${S.a.orgId}`, client_reference_id: S.a.orgId, metadata: { org_id: S.a.orgId, kind: 'credits', amount: '10' }, created: now, livemode: false } } })
  await hook({ id: 'evt_4', type: 'charge.refunded', created: now, data: { object: { id: 'ch_1', object: 'charge', payment_intent: 'pi_cred1', amount: 1000, amount_refunded: 400, refunded: false, currency: 'usd', customer: `cus_${S.a.orgId}`, status: 'succeeded', created: now, livemode: false } } })

  r = await S.ops.get('/platform/business?range=month')
  assert.equal(r.status, 200, JSON.stringify(r.data))
  const m = r.data.revenue.month
  assert.equal(m.gross, 29); assert.equal(m.refunds, 4); assert.equal(m.net, 25)
  assert.equal(m.subscription, 19); assert.equal(m.one_off, 10)
  assert.equal(m.failed, 1); assert.equal(m.failed_amount, 19, 'failed payment is not revenue')
  assert.equal(r.data.currency, 'usd')
  assert.equal(r.data.churches.trialing, 3, 'trials are counted as trials, never revenue')
  assert.equal(r.data.recurring.mrr, 0, 'MRR comes from active subscriptions, not one-off payments')
  // The webhook log records each outcome for the health page.
  const ev = (await db.collection('billingEvents').doc('evt_3').get()).data()
  assert.equal(ev.ok, true)

  // Payments list, filters and detail with Stripe links.
  r = await S.ops.get('/platform/payments?status=failed')
  assert.equal(r.data.rows.length, 1); assert.equal(r.data.rows[0].org_name, 'Biz Church B'); assert.equal(r.data.rows[0].failure_reason, 'Card declined')
  r = await S.ops.get('/platform/payments?status=refunded')
  assert.equal(r.data.rows[0].status, 'partially_refunded')
  r = await S.ops.get('/platform/payments/in_a1')
  assert.equal(r.data.links.invoice, 'https://dashboard.stripe.com/test/invoices/in_a1')
  assert.equal(r.data.plan, 'church'); assert.equal(r.data.interval, 'monthly')
  // Lifetime revenue per church.
  r = await S.ops.get('/platform/churches?q=Biz Church A')
  assert.equal(r.data.rows[0].lifetime.usd, 25)
  r = await S.ops.get(`/platform/churches/${S.a.orgId}/business`)
  assert.equal(r.data.payments.length, 2); assert.equal(r.data.lifetime.usd.net, 25)
  // Churches can't see any of it.
  for (const p of ['/platform/business', '/platform/payments', `/platform/churches/${S.a.orgId}/business`, '/platform/messaging', '/platform/health', '/platform/expenses', '/platform/audit']) assert.equal((await S.a.get(p)).status, 403, p)
})

test('MRR, subscriptions and plan changes follow the billing state Stripe reports', async () => {
  const db = fake.db
  const sub = (plan, interval, status = 'active', extra = {}) => ({ id: `sub_${S.a.orgId}`, object: 'subscription', customer: `cus_${S.a.orgId}`, status, metadata: { org_id: S.a.orgId }, current_period_end: now + 30 * 86400, items: { data: [{ price: { lookup_key: `gatherhq_${plan}_${interval}`, recurring: { interval: interval === 'yearly' ? 'year' : 'month' } } }] }, default_payment_method: null, ...extra })
  await hook({ id: 'evt_s1', type: 'customer.subscription.created', created: now, data: { object: sub('church', 'monthly') } })
  await hook({ id: 'evt_s2', type: 'customer.subscription.updated', created: now + 1, data: { object: sub('network', 'yearly') } })
  let r = await S.ops.get('/platform/business')
  assert.equal(r.data.recurring.mrr, Math.round((590 / 12) * 100) / 100)
  assert.equal(r.data.recurring.paying, 1); assert.equal(r.data.recurring.arr, Math.round((590 / 12) * 12 * 100) / 100)
  r = await S.ops.get('/platform/subscriptions')
  assert.equal(r.data.counts.yearly, 1)
  assert.deepEqual(r.data.changes.map(c => c.kind).sort(), ['started', 'upgraded'])
  r = await S.ops.get('/platform/churches?state=annual')
  assert.equal(r.data.rows.length, 1)
  await hook({ id: 'evt_s3', type: 'customer.subscription.updated', created: now + 2, data: { object: sub('network', 'yearly', 'active', { cancel_at_period_end: true }) } })
  r = await S.ops.get('/platform/subscriptions')
  assert.equal(r.data.counts.cancelling, 1)
  assert.ok(r.data.changes.some(c => c.kind === 'cancelled'))
})

test('sync from Stripe pulls invoices and one-off charges, idempotently', async () => {
  const real = globalThis.fetch
  globalThis.fetch = async (url) => {
    const u = String(url)
    if (u.includes('/v1/invoices')) return new Response(JSON.stringify({ data: [invoice('in_old', S.b.orgId, 'paid', 1900, { created: now - 40 * 86400, status_transitions: { paid_at: now - 40 * 86400 }, charge: { id: 'ch_old', amount_refunded: 0, payment_method_details: { card: { brand: 'visa', last4: '4242' } } } }), invoice('in_open', S.b.orgId, 'open', 1900, { attempt_count: 0 })], has_more: false }), { status: 200 })
    if (u.includes('/v1/charges')) return new Response(JSON.stringify({ data: [{ id: 'ch_x', object: 'charge', payment_intent: 'pi_x', amount: 2500, amount_refunded: 0, currency: 'usd', customer: `cus_${S.b.orgId}`, status: 'succeeded', created: now, metadata: { kind: 'credits' }, livemode: false }, { id: 'ch_inv', invoice: 'in_old', amount: 1900, status: 'succeeded', created: now }], has_more: false }), { status: 200 })
    return real(url)
  }
  try {
    let r = await S.ops.post('/platform/payments/sync')
    assert.equal(r.status, 200, JSON.stringify(r.data)); assert.deepEqual(r.data, { invoices: 2, charges: 1 })
    await S.ops.post('/platform/payments/sync')
    r = await S.ops.get('/platform/payments?org=' + S.b.orgId)
    assert.equal(r.data.total, 4, 'failed + old paid + open + credit, no duplicates')
    const old = r.data.rows.find(p => p.id === 'in_old')
    assert.equal(old.method.last4, '4242')
    r = await S.ops.get('/platform/business?range=all')
    assert.equal(r.data.revenue.range.open, 1, 'unpaid invoice shown as outstanding')
    assert.equal(r.data.revenue.range.gross, 29 + 19 + 25)
    assert.ok((await S.ops.get('/platform/audit')).data.rows.some(x => x.action === 'payments.synced'))
  } finally { globalThis.fetch = real }
  assert.equal((await S.a.post('/platform/payments/sync')).status, 403)
})

test('revenue maths and date ranges', () => {
  const rows = [
    { status: 'paid', kind: 'subscription', amount: 19, amount_refunded: 0, currency: 'usd', paid_at: '2026-03-10T00:00:00Z', created_at: '2026-03-10T00:00:00Z' },
    { status: 'refunded', kind: 'one_off', amount: 10, amount_refunded: 10, currency: 'usd', paid_at: '2026-03-11T00:00:00Z', refunded_at: '2026-04-02T00:00:00Z', created_at: '2026-03-11T00:00:00Z' },
    { status: 'failed', kind: 'subscription', amount: 59, amount_refunded: 0, currency: 'usd', created_at: '2026-03-12T00:00:00Z' },
    { status: 'paid', kind: 'subscription', amount: 15, amount_refunded: 0, currency: 'gbp', paid_at: '2026-03-12T00:00:00Z', created_at: '2026-03-12T00:00:00Z' },
  ]
  const march = revenueOf(rows, { from: new Date('2026-03-01T00:00:00Z'), to: new Date('2026-04-01T00:00:00Z') })
  assert.deepEqual([march.usd.gross, march.usd.refunds, march.usd.net, march.usd.failed], [29, 0, 29, 1])
  assert.equal(march.gbp.gross, 15, 'currencies kept apart')
  const april = revenueOf(rows, { from: new Date('2026-04-01T00:00:00Z'), to: new Date('2026-05-01T00:00:00Z') })
  assert.deepEqual([april.usd.gross, april.usd.refunds, april.usd.net], [0, 10, -10], 'refund counted when it happened')
  const n = new Date('2026-11-13T15:00:00Z')
  assert.equal(rangeOf({ range: 'last_month' }, n).from.toISOString(), '2026-10-01T00:00:00.000Z')
  assert.equal(rangeOf({ range: '7d' }, n).from.toISOString(), '2026-11-07T00:00:00.000Z')
  assert.equal(rangeOf({ range: 'custom', from: '2026-01-01', to: '2026-01-31' }, n).to.toISOString(), '2026-02-01T00:00:00.000Z')
  assert.throws(() => rangeOf({ range: 'custom', from: '2026-02-01', to: '2026-01-01' }, n))
})

test('expenses: record, receipt, summaries and revenue less expenses; all audited', async () => {
  let r = await S.ops.post('/platform/expenses', { name: 'Netlify Pro', category: 'hosting', amount: 19, currency: 'usd', date: new Date().toISOString().slice(0, 10), vendor: 'Netlify', recurring: 'monthly' })
  assert.equal(r.status, 200, JSON.stringify(r.data))
  const id = r.data.id
  await S.ops.post('/platform/expenses', { name: 'Termii top-up', category: 'messaging', amount: 6, currency: 'usd', date: new Date().toISOString().slice(0, 10) })
  assert.equal((await S.ops.post('/platform/expenses', { name: 'Bad', amount: -1, date: '2026-01-01' })).status, 400)
  r = await S.ops.post(`/platform/expenses/${id}/receipt`, { name: 'inv.pdf', type: 'application/pdf', data: Buffer.from('%PDF-1.4 test').toString('base64') })
  assert.equal(r.status, 200)
  r = await S.ops.get(`/platform/expenses/${id}/receipt`)
  assert.match(String(r.data), /%PDF/)
  r = await S.ops.get('/platform/expenses?range=year')
  assert.equal(r.data.totals.usd, 25)
  assert.equal(r.data.by_category.messaging.usd, 6)
  assert.equal(r.data.pnl.usd.expenses, 25)
  assert.equal(r.data.pnl.usd.result, Math.round((r.data.pnl.usd.revenue - 25) * 100) / 100)
  assert.equal((await S.ops.del(`/platform/expenses/${id}`)).status, 200)
  const actions = (await S.ops.get('/platform/audit')).data.rows.map(x => x.action)
  for (const a of ['expense.created', 'expense.receipt_added', 'expense.deleted']) assert.ok(actions.includes(a), a)
  assert.equal((await S.a.post('/platform/expenses', { name: 'x', amount: 1, date: '2026-01-01' })).status, 403)
})

test('church actions, provider changes and admin grants are audited; messaging and health respond', async () => {
  assert.equal((await S.ops.patch(`/platform/orgs/${S.b.orgId}`, { status: 'suspended' })).status, 400, 'suspending needs confirmation')
  assert.equal((await S.ops.patch(`/platform/orgs/${S.b.orgId}`, { status: 'suspended', confirm: 'suspend' })).status, 200)
  assert.equal((await S.b.get('/people')).status, 403, 'suspended church loses access')
  await S.ops.patch(`/platform/orgs/${S.b.orgId}`, { status: 'active' })
  assert.equal((await S.ops.post('/platform/comms/provider', { channel: 'email', provider: 'mock_email' })).status, 200)
  let r = await S.ops.post('/platform/admins', { email: 'a@biz.test', confirm: 'a@biz.test' })
  assert.equal(r.status, 200)
  assert.equal((await S.a.adminLogin('a@biz.test')).status, 200)
  const aId = (await S.a.get('/me')).data.user.id
  assert.equal((await S.ops.del(`/platform/admins/${aId}`)).status, 200)
  assert.equal((await S.a.get('/platform/business')).status, 403, 'revoked access stops at the next request')
  const actions = (await S.ops.get('/platform/audit')).data.rows.map(x => x.action)
  for (const a of ['platform.org_suspended', 'platform.org_active', 'platform.comms_provider', 'admin.granted', 'admin.revoked']) assert.ok(actions.includes(a), a)
  r = await S.ops.get('/platform/messaging?range=30d')
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.whatsapp.automation.startsWith('Coming soon'), true)
  r = await S.ops.get('/platform/health')
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.database.ok, true)
  assert.ok(r.data.webhooks.events.length >= 4)
  r = await S.ops.get('/platform/pricing')
  assert.equal(r.data.plans.length, 2)
  // Logging out of the console doesn't touch the church session, and vice versa.
  await S.ops.post('/admin/auth/logout')
  assert.equal((await S.ops.get('/platform/business')).status, 403)
  assert.equal((await S.ops.get('/me')).status, 200)
})
