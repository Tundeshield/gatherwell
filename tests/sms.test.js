// SMS for churches anywhere: routing by country, sender names, provider fallback, prepaid credit
// with reservations and settlements, Stripe credit purchases, opt-outs and isolation.
// Runs as staging against the in-memory Firestore and the test SMS providers.
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { setFirebase } from '../server/firebase.js'
import { handle } from '../server/app.js'
import { createFakeFirebase } from './fake-firebase.js'
import { runComms, processEnrolment, processMessage } from '../server/comms/engine.js'
import { clearConfigCache } from '../server/comms/providers.js'
import { SMS_ADAPTERS, hookToken } from '../server/comms/sms.js'
import { smsInfo, nextWeekdayAt, countryOf } from '../shared/comms.js'

process.env.APP_ENV = 'staging'
process.env.GW_INSECURE_COOKIES = '1'
process.env.PLATFORM_ADMIN_EMAILS = 'ops@gatherhq.test'
let fake
before(() => { fake = createFakeFirebase(); setFirebase(fake) })

let ipSeq = 0
function client() {
  let cookie = ''
  const ip = `10.9.0.${++ipSeq}`
  const call = async (method, path, body) => {
    const init = { method, headers: { 'x-nf-client-connection-ip': ip } }
    if (cookie) init.headers.cookie = cookie
    if (body !== undefined) { init.body = JSON.stringify(body); init.headers['content-type'] = 'application/json' }
    const res = await handle(new Request('http://test.local/api' + path, init))
    const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0]
    const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text()
    return { status: res.status, data }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), patch: (p, b) => call('PATCH', p, b), del: (p) => call('DELETE', p),
    login: (email, pw) => call('POST', '/auth/session', { idToken: fake.auth.signIn(email, pw) }) }
}
async function church(name, email, cc = '234') {
  const c = client()
  const r = await c.post('/auth/signup', { acceptTerms: true, orgName: name, name: 'Owner', email, password: 'password123', timezone: 'Africa/Lagos', defaultCountryCode: cc })
  assert.equal(r.status, 201, JSON.stringify(r.data))
  await c.login(email, 'password123')
  c.me = (await c.get('/me')).data
  return c
}
async function person(c, first, { email, phone, status = 'member', sms = true } = {}) {
  const r = await c.post('/people', { firstName: first, lastName: 'Sms', email, phone, status, branchId: c.me.branches[0].id })
  assert.equal(r.status, 200, JSON.stringify(r.data))
  if (sms && phone) assert.equal((await c.patch(`/people/${r.data.id}/consent`, { channel: 'sms', status: 'granted', source: 'form', wording: 'Can we text you about church events? (v1)' })).status, 200)
  return r.data.id
}
const db = () => fake.db
const ledgerOf = async (orgId) => (await db().collection('orgs').doc(orgId).collection('creditLedger').get()).docs.map(d => ({ id: d.id, ...d.data() }))
const deliveriesOf = async (orgId, messageId) => (await db().collection('orgs').doc(orgId).collection('deliveries').where('message_id', '==', messageId).get()).docs.map(d => ({ id: d.id, ...d.data() }))
const balance = async (orgId) => (await db().collection('orgs').doc(orgId).get()).data().credits?.balance || 0
const round = (n) => Math.round(n * 10000) / 10000
const S = {}
const sendSms = (c, audience, body = 'Hi {first_name}, see you on Sunday!') => c.post('/comms/messages', { channel: 'sms', when: 'now', body, audience })

test('setup: a Nigerian church with people at home and abroad, sender name approved, some credit', async () => {
  S.a = await church('Grace SMS', 'grace@sms.test')
  S.b = await church('Hope SMS', 'hope@sms.test')
  S.ops = await church('Ops', 'ops@gatherhq.test')
  S.org = S.a.me.org.id
  await S.ops.post('/platform/comms/provider', { channel: 'email', provider: 'mock_email' })
  S.ng1 = await person(S.a, 'Ada', { phone: '08031110001', email: 'ada@sms.test' })
  S.ng2 = await person(S.a, 'Bayo', { phone: '08031110002' })
  S.uk = await person(S.a, 'Ciara', { phone: '+447700900111' })
  S.us = await person(S.a, 'Dana', { phone: '+12025550123' })
  S.fr = await person(S.a, 'Élodie', { phone: '+33612345678' })
  S.noConsent = await person(S.a, 'Femi', { phone: '08031110006', sms: false })
  assert.equal((await S.a.post('/comms/sms/senders', { country: 'NG', value: 'GRACESMS' })).status, 200)
  await S.a.post('/comms/simulate/sender/NG', { status: 'approved' })
  await S.a.post('/comms/credits/test', { amount: 10 })
})

test('mixed-country audience: a cost per country, unsupported destinations and no consent explained', async () => {
  const r = await S.a.post('/comms/preview', { channel: 'sms', body: 'Hi {first_name}, see you on Sunday!', audience: { mode: 'filters', statuses: ['member'] } })
  assert.equal(r.status, 200, JSON.stringify(r.data))
  assert.equal(r.data.excluded.no_consent, 1)
  const e = r.data.estimate
  assert.deepEqual(Object.keys(e.byCountry).sort(), ['GB', 'NG', 'US'])
  assert.equal(e.byCountry.NG.count, 2)
  assert.equal(e.unroutable.unsupported_country.count, 1); assert.deepEqual(e.unroutable.unsupported_country.countries, ['FR'])
  assert.equal(e.cost, round(Object.values(e.byCountry).reduce((a, c) => a + c.cost, 0)))
  // US price includes the carrier surcharge configured for that route.
  assert.equal(e.byCountry.US.unit, 0.023)
})

test('long and Unicode messages are priced by segment', async () => {
  assert.equal(smsInfo('a'.repeat(160)).segments, 1)
  assert.equal(smsInfo('a'.repeat(161)).segments, 2)
  assert.equal(smsInfo('{'.repeat(80)).segments, 1, 'extension characters count twice')
  assert.equal(smsInfo('{'.repeat(81)).segments, 2)
  assert.equal(smsInfo('Hello 🙏').unicode, true)
  assert.equal(smsInfo('é'.repeat(70) + '🙏').segments, 2, 'emoji switch to 70/67 and count as two units')
  const long = 'Hi {first_name}, ' + 'this is a longer announcement about our harvest service. '.repeat(4)
  const r = await S.a.post('/comms/preview', { channel: 'sms', body: long, audience: { mode: 'people', people: [S.ng1] } })
  const segs = smsInfo(long.replace('{first_name}', 'Ada')).segments
  assert.ok(segs >= 2)
  assert.equal(r.data.estimate.cost, round(segs * r.data.estimate.byCountry.NG.unit))
})

test('different providers by country, reservations settle to the actual price, nothing charged for unsupported or failed', async () => {
  // Route the UK through provider B; Nigeria stays on A.
  let r = await S.ops.post('/platform/comms/sms', { routes: { NG: ['mock_sms', 'mock_sms_backup'], GB: ['mock_sms_backup', 'mock_sms'] } })
  assert.equal(r.status, 200, JSON.stringify(r.data))
  const before = await balance(S.org)
  r = await sendSms(S.a, { mode: 'filters', statuses: ['member'] })
  assert.equal(r.status, 200, JSON.stringify(r.data))
  const m = r.data.message
  assert.equal(r.data.progress.status, 'sent'); assert.equal(r.data.progress.sent, 4)
  const ds = await deliveriesOf(S.org, m.id)
  const by = Object.fromEntries(ds.map(d => [d.country, d]))
  assert.equal(by.NG.provider, 'mock_sms'); assert.equal(by.GB.provider, 'mock_sms_backup'); assert.equal(by.US.provider, 'mock_sms')
  assert.ok(!by.FR, 'the French number was never attempted')
  const msg = (await S.a.get(`/comms/messages/${m.id}`)).data.message
  assert.equal(msg.excluded.no_route, 1)
  // Each text: a reservation at the dearest eligible route, settled at the price actually used.
  const L = (await ledgerOf(S.org)).filter(e => ds.some(d => e.delivery_id === d.id))
  const ngRes = L.find(e => e.id === `r_${by.NG.id}`), ngSet = L.find(e => e.id === `s_${by.NG.id}`)
  assert.equal(ngRes.amount, -0.035, 'held at provider B’s higher price in case of fallback')
  assert.equal(ngSet.amount, 0.005); assert.equal(ngSet.actual_cost, 0.03)
  const spent = round(ds.reduce((a, d) => a + d.cost, 0))
  assert.equal(round(before - await balance(S.org)), spent, 'the balance moved by exactly the settled prices')
  assert.equal(ngRes.currency, 'USD')
})

test('provider switching through configuration only', async () => {
  let r = await S.ops.post('/platform/comms/sms', { routes: { NG: ['mock_sms_backup'], GB: ['mock_sms_backup'] } })
  assert.equal(r.status, 200)
  r = await sendSms(S.a, { mode: 'people', people: [S.ng2] })
  const [d] = await deliveriesOf(S.org, r.data.message.id)
  assert.equal(d.provider, 'mock_sms_backup')
  await S.ops.post('/platform/comms/sms', { routes: { NG: ['mock_sms', 'mock_sms_backup'], GB: ['mock_sms', 'mock_sms_backup'] } })
  // Switching a provider off removes it from routing.
  const cfg = (await S.ops.get('/platform/comms/sms')).data
  const providers = Object.fromEntries(cfg.providers.map(p => [p.id, { enabled: p.id === 'mock_sms_backup' ? false : p.enabled, countries: p.countries }]))
  r = await S.ops.post('/platform/comms/sms', { providers })
  assert.equal(r.status, 200, JSON.stringify(r.data))
  r = await sendSms(S.a, { mode: 'people', people: [S.uk] })
  assert.equal((await deliveriesOf(S.org, r.data.message.id))[0].provider, 'mock_sms')
  providers.mock_sms_backup.enabled = true
  await S.ops.post('/platform/comms/sms', { providers })
  // Churches can't touch provider configuration.
  assert.equal((await S.a.post('/platform/comms/sms', { routes: {} })).status, 403)
  assert.equal((await S.a.get('/platform/comms/sms')).status, 403)
})

test('fallback: a provider outage before sending moves the text to the next eligible provider, charged once', async () => {
  const id = await person(S.a, 'Gbenga', { phone: '08031110098' }) // ends 98: provider A is down for this number
  const before = await balance(S.org)
  const r = await sendSms(S.a, { mode: 'people', people: [id] })
  assert.equal(r.data.progress.sent, 1)
  const [d] = await deliveriesOf(S.org, r.data.message.id)
  assert.equal(d.provider, 'mock_sms_backup'); assert.equal(d.status, 'sent')
  assert.equal(round(before - await balance(S.org)), 0.035, 'charged once, at the price of the provider used')
  const L = (await ledgerOf(S.org)).filter(e => e.delivery_id === d.id)
  assert.deepEqual(L.map(e => e.type).sort(), ['reservation', 'settlement'])
})

test('permanent failures: no charge, no endless retries; a retry gets fresh ledger entries and never double-charges', async () => {
  const id = await person(S.a, 'Halima', { phone: '08031110099' }) // ends 99: unreachable
  const before = await balance(S.org)
  let r = await sendSms(S.a, { mode: 'people', people: [id] })
  assert.equal(r.data.progress.failed, 1)
  const mid = r.data.message.id
  let [d] = await deliveriesOf(S.org, mid)
  assert.equal(d.status, 'failed'); assert.equal(d.error, 'The number couldn’t be reached.')
  assert.equal(await balance(S.org), before, 'reservation released')
  r = await S.a.post(`/comms/messages/${mid}/retry`)
  assert.equal(r.status, 200, JSON.stringify(r.data))
  ;[d] = await deliveriesOf(S.org, mid)
  assert.equal(d.status, 'failed')
  assert.equal(await balance(S.org), before)
  const L = (await ledgerOf(S.org)).filter(e => e.delivery_id === d.id || String(e.id).includes(d.id))
  assert.equal(L.filter(e => e.type === 'reservation').length, 2); assert.equal(L.filter(e => e.type === 'release').length, 2)
  assert.equal(new Set(L.map(e => e.id)).size, L.length)
})

test('duplicate scheduler runs never send or charge twice', async () => {
  const fri = nextWeekdayAt(new Date(), 'Africa/Lagos', [5], '19:00')
  const date = new Date(fri.getTime() + 3600e3).toISOString().slice(0, 10)
  let r = await S.a.post('/comms/messages', { channel: 'sms', when: 'later', sendDate: date, sendTime: '19:00', body: 'Prayer at 7', audience: { mode: 'people', people: [S.ng1, S.ng2] } })
  const id = r.data.message.id
  const now = new Date(fri.getTime() + 5000)
  await Promise.all([runComms({ now, deadline: Date.now() + 5000 }), runComms({ now, deadline: Date.now() + 5000 }), processMessage(S.org, id, { now })])
  await runComms({ now: new Date(fri.getTime() + 70e3), deadline: Date.now() + 5000 })
  const ds = await deliveriesOf(S.org, id)
  assert.equal(ds.length, 2); assert.ok(ds.every(d => d.status === 'sent'))
  const L = (await ledgerOf(S.org)).filter(e => ds.some(d => e.delivery_id === d.id))
  assert.equal(L.filter(e => e.type === 'reservation').length, 2); assert.equal(L.filter(e => e.type === 'settlement').length, 2)
  r = await S.a.get(`/comms/messages/${id}`)
  assert.equal(r.data.message.sent_count, 2)
})

test('delivery reports: a provider that doesn’t bill failures refunds once; webhooks need the secret token', async () => {
  const r = await sendSms(S.a, { mode: 'people', people: [S.ng1] })
  const [d] = await deliveriesOf(S.org, r.data.message.id)
  const before = await balance(S.org)
  const post = (t, body) => handle(new Request(`http://test.local/api/webhooks/sms/mock_sms?t=${t}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
  assert.equal((await post('wrong', { providerId: d.provider_id, status: 'failed' })).status, 404)
  const ok = await post(hookToken('mock_sms'), { providerId: d.provider_id, status: 'failed' })
  assert.equal(ok.status, 200)
  assert.equal((await post(hookToken('mock_sms'), { providerId: d.provider_id, status: 'failed' })).status, 200, 'repeat is acknowledged')
  assert.equal(round(await balance(S.org) - before), d.cost, 'refunded exactly once')
  const [after] = await deliveriesOf(S.org, r.data.message.id)
  assert.equal(after.status, 'failed')
})

test('insufficient credit pauses texts but email keeps going; low-balance warnings; nothing sent late in a burst', async () => {
  // A journey with an email step and an SMS step.
  let r = await S.a.post('/comms/workflows', { preset: 'scratch' })
  const wf = r.data
  const steps = [
    { id: 'e1', type: 'send', channel: 'email', title: 'Welcome', subject: 'Welcome {first_name}', body: 'Glad you came.' },
    { id: 's1', type: 'send', channel: 'sms', title: 'Invite', body: 'Hi {first_name}, see you Sunday!' },
    { id: 'z', type: 'end' },
  ]
  r = await S.a.patch(`/comms/workflows/${wf.id}`, { steps, trigger: { type: 'tag_added', tagId: (await S.a.post('/tags', { name: 'Journey' })).data.id } })
  assert.equal(r.status, 200, JSON.stringify(r.data))
  S.tag = r.data.workflow.trigger.tagId
  assert.equal((await S.a.post(`/comms/workflows/${wf.id}/status`, { status: 'active' })).status, 200)
  // Spend the balance down to nothing.
  await S.a.post('/comms/credits/test-reset')
  r = await S.a.post(`/comms/workflows/${wf.id}/status`, { status: 'paused' })
  r = await S.a.post(`/comms/workflows/${wf.id}/status`, { status: 'active' })
  assert.equal(r.status, 400, 'can’t switch on an SMS journey with no credit'); assert.match(r.data.error, /Add messaging credit/)
  await S.a.post('/comms/credits/test', { amount: 0.03 })
  assert.equal((await S.a.post(`/comms/workflows/${wf.id}/status`, { status: 'active' })).status, 200)
  await S.a.post('/comms/credits/test-reset')
  await S.a.post('/people/tags', { ids: [S.ng1], add: [S.tag] })
  const rows = (await S.a.get(`/comms/workflows/${wf.id}/people`)).data.rows
  const enr = rows[0]
  const t0 = new Date(nextWeekdayAt(new Date(), 'Africa/Lagos', [2], '11:00'))
  await processEnrolment(S.org, enr.id, { now: t0 })
  let e = (await S.a.get(`/comms/workflows/${wf.id}/people`)).data.rows[0]
  assert.ok(e.history.some(h => h.type === 'send' && h.result === 'sent' && /Welcome/.test(h.text)), 'email still sent')
  assert.ok(e.history.some(h => /Waiting for messaging credit/.test(h.text)))
  r = await S.a.get('/comms/channels')
  assert.equal(r.data.resume.journeys.length, 1, 'shows exactly what will resume')
  // Topping up resumes it within the sending window.
  const pre = await balance(S.org)
  await S.a.post('/comms/credits/test', { amount: 1 })
  await processEnrolment(S.org, enr.id, { now: new Date(t0.getTime() + 3600e3) })
  e = (await S.a.get(`/comms/workflows/${wf.id}/people`)).data.rows[0]
  assert.equal(e.status, 'completed'); assert.ok(e.history.some(h => /Sent Invite/.test(h.text)))
  assert.ok(await balance(S.org) < pre + 1)
  // Someone blocked for longer than the resume window is skipped, not texted days late.
  await S.a.post('/comms/credits/test-reset')
  await S.a.post('/people/tags', { ids: [S.ng2], add: [S.tag] })
  const enr2 = (await S.a.get(`/comms/workflows/${wf.id}/people`)).data.rows.find(x => x.person_id === S.ng2)
  await processEnrolment(S.org, enr2.id, { now: t0 })
  await S.a.post('/comms/credits/test', { amount: 1 })
  await processEnrolment(S.org, enr2.id, { now: new Date(t0.getTime() + 49 * 3600e3) })
  e = (await S.a.get(`/comms/workflows/${wf.id}/people`)).data.rows.find(x => x.person_id === S.ng2)
  assert.ok(e.history.some(h => /waited too long/.test(h.text)), JSON.stringify(e.history))
  // Warnings were recorded as the balance fell.
  const notices = (await db().collection('orgs').doc(S.org).collection('notices').get()).docs.map(d => d.data())
  assert.ok(notices.some(n => n.level === 99), 'an empty balance was flagged')
})

test('a person who comes back is not sent the rest of a first-visit journey', async () => {
  await S.a.post('/comms/credits/test', { amount: 5 })
  let r = await S.a.post('/comms/workflows', { preset: 'welcome' })
  const wf = r.data
  assert.equal(wf.exit_on_return, true)
  assert.equal((await S.a.post(`/comms/workflows/${wf.id}/status`, { status: 'active' })).status, 200)
  const g = await S.a.post('/gatherings', { name: 'Sunday', branchId: S.a.me.branches[0].id, startsAt: new Date(Date.now() - 3600e3).toISOString(), confirmName: true })
  const pub = client()
  r = await pub.post(`/public/g/${g.data.public_token}/checkin`, { mode: 'new', answers: { first_name: 'Ike', last_name: 'Back', phone: '08031110077' } })
  const enr = (await S.a.get(`/comms/workflows/${wf.id}/people`)).data.rows[0]
  // Ike attends again (midweek) before the Friday invitation.
  await db().collection('orgs').doc(S.org).collection('people').doc(enr.person_id).update({ last_seen_at: new Date(Date.now() + 86400e3) })
  const fri = nextWeekdayAt(new Date(Date.now() + 2 * 86400e3), 'Africa/Lagos', [5], '18:00')
  await processEnrolment(S.org, enr.id, { now: new Date(Date.now() + 2000) })
  await processEnrolment(S.org, enr.id, { now: new Date(fri.getTime() + 8 * 86400e3) })
  const e = (await S.a.get(`/comms/workflows/${wf.id}/people`)).data.rows[0]
  assert.equal(e.status, 'completed')
  assert.ok(e.history.some(h => /came back/.test(h.text)))
  assert.ok(!e.history.some(h => h.type === 'send' && h.result === 'sent'))
  await S.a.post(`/comms/workflows/${wf.id}/status`, { status: 'paused' })
})

test('missing and rejected sender names block that country only', async () => {
  const c = await church('Sender Test', 'sender@sms.test')
  await c.post('/comms/credits/test', { amount: 5 })
  const ng = await person(c, 'Kemi', { phone: '08031110021' })
  const uk = await person(c, 'Liam', { phone: '+447700900222' })
  let r = await c.post('/comms/preview', { channel: 'sms', body: 'Hi', audience: { mode: 'people', people: [ng, uk] } })
  assert.equal(r.data.estimate.reachable, 1, 'the UK needs no registration')
  assert.equal(r.data.estimate.unroutable.sender_needed.count, 1)
  r = await c.get('/comms/channels')
  assert.equal(r.data.sms.setup.find(x => x.country === 'NG').state, 'needs_sender')
  assert.equal(r.data.sms.setup.find(x => x.country === 'GB').state, 'ready')
  await c.post('/comms/sms/senders', { country: 'NG', value: 'SENDERTEST' })
  await c.post('/comms/simulate/sender/NG', { status: 'rejected' })
  r = await c.post('/comms/preview', { channel: 'sms', body: 'Hi', audience: { mode: 'people', people: [ng] } })
  assert.equal(r.data.estimate.unroutable.sender_rejected.count, 1)
  // A decided request leaves the team's queue; a new name joins it.
  r = await S.ops.get('/platform/comms/sms')
  assert.ok(!r.data.senderRequests.some(x => x.org_name === 'Sender Test'))
  await c.post('/comms/sms/senders', { country: 'NG', value: 'SENDTEST2' })
  r = await S.ops.get('/platform/comms/sms')
  assert.ok(r.data.senderRequests.some(x => x.org_name === 'Sender Test' && x.value === 'SENDTEST2'))
})

test('SMS opt-out: STOP by text withdraws consent at once; other replies pause journeys', async () => {
  // A STOP arriving through a provider webhook, matched by phone number.
  const res = await handle(new Request(`http://test.local/api/webhooks/sms/mock_sms?t=${hookToken('mock_sms')}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from: '+2348031110002', text: 'stop' }) }))
  assert.equal(res.status, 200)
  const p = (await db().collection('orgs').doc(S.org).collection('people').doc(S.ng2).get()).data()
  assert.equal(p.consent.sms.status, 'withdrawn'); assert.equal(p.consent.sms.source, 'reply')
  const r = await S.a.post('/comms/preview', { channel: 'sms', body: 'x', audience: { mode: 'people', people: [S.ng2] } })
  assert.equal(r.data.excluded.opted_out, 1)
})

test('buying credit: Stripe Checkout in test mode; credit only from a verified webhook, once', async () => {
  Object.assign(process.env, { STRIPE_SECRET_KEY: 'sk_test_credits', STRIPE_WEBHOOK_SECRET: 'whsec_credits' })
  const realFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (u, init = {}) => {
    if (!String(u).startsWith('https://api.stripe.com')) return realFetch(u, init)
    const path = new URL(u).pathname.replace('/v1', '')
    calls.push([path, Object.fromEntries(new URLSearchParams(init.body || ''))])
    const ok = (data) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } })
    if (path === '/customers') return ok({ id: 'cus_sms' })
    if (path === '/checkout/sessions') return ok({ id: 'cs_credit_1', url: 'https://checkout.stripe.com/c/pay/cs_credit_1' })
    return ok({})
  }
  const hook = (evt) => { const raw = JSON.stringify(evt); const t = Math.floor(Date.now() / 1000); const sig = `t=${t},v1=${crypto.createHmac('sha256', 'whsec_credits').update(`${t}.${raw}`).digest('hex')}`
    return handle(new Request('http://test.local/api/webhooks/stripe', { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': sig }, body: raw })) }
  try {
    assert.equal((await S.a.post('/comms/credits/checkout', { amount: 7 })).status, 400, 'only the configured amounts')
    let r = await S.a.post('/comms/credits/checkout', { amount: 25 })
    assert.equal(r.status, 200, JSON.stringify(r.data)); assert.match(r.data.url, /checkout\.stripe\.com/)
    const sess = calls.find(c => c[0] === '/checkout/sessions')[1]
    assert.equal(sess.mode, 'payment'); assert.equal(sess['line_items[0][price_data][unit_amount]'], '2500'); assert.equal(sess['metadata[kind]'], 'credits')
    const before = await balance(S.org)
    const session = { id: 'cs_credit_1', object: 'checkout.session', mode: 'payment', payment_status: 'paid', amount_total: 2500, currency: 'usd', customer: 'cus_sms', client_reference_id: S.org, metadata: { org_id: S.org, kind: 'credits', amount: '25' } }
    // An unpaid session (e.g. bank transfer pending) adds nothing.
    await hook({ id: 'evt_c0', type: 'checkout.session.completed', created: 1, data: { object: { ...session, payment_status: 'unpaid' } } })
    assert.equal(await balance(S.org), before)
    // Paid: credited once, even if Stripe delivers the event twice or sends a second event for the same session.
    await hook({ id: 'evt_c1', type: 'checkout.session.completed', created: 2, data: { object: session } })
    await hook({ id: 'evt_c1', type: 'checkout.session.completed', created: 2, data: { object: session } })
    await hook({ id: 'evt_c2', type: 'checkout.session.async_payment_succeeded', created: 3, data: { object: session } })
    assert.equal(round(await balance(S.org) - before), 25)
    const p = (await ledgerOf(S.org)).filter(e => e.type === 'purchase')
    assert.equal(p.length, 1); assert.equal(p[0].stripe_session, 'cs_credit_1'); assert.equal(p[0].currency, 'USD')
    // A forged webhook is refused.
    const bad = await handle(new Request('http://test.local/api/webhooks/stripe', { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=00' }, body: JSON.stringify({ id: 'evt_x', type: 'checkout.session.completed', data: { object: { ...session, id: 'cs_forged' } } }) }))
    assert.equal(bad.status, 401)
  } finally {
    globalThis.fetch = realFetch
    delete process.env.STRIPE_SECRET_KEY; delete process.env.STRIPE_WEBHOOK_SECRET
  }
})

test('church isolation: another church sees none of the texts, credit, senders or deliveries', async () => {
  const r = await S.b.get('/comms/channels')
  assert.equal(r.data.credits.balance, 0)
  assert.equal(r.data.ledger.length, 0)
  assert.ok(!r.data.sms.setup.some(x => x.sender))
  assert.equal((await S.b.get('/comms/usage')).data.rows.length, 0)
  const msgs = (await S.a.get('/comms/messages')).data.rows
  assert.equal((await S.b.get(`/comms/messages/${msgs[0].id}`)).status, 404)
  assert.equal((await S.b.post('/comms/preview', { channel: 'sms', body: 'x', audience: { mode: 'people', people: [S.ng1] } })).data.total, 0)
})

test('one-tap WhatsApp still works; automated WhatsApp stays unavailable', async () => {
  let r = await S.a.post('/messages', { channel: 'whatsapp', body: 'Hi {first_name}!', audience: { statuses: ['member'] } })
  assert.equal(r.status, 200, JSON.stringify(r.data))
  r = await S.a.get(`/messages/${r.data.id}/whatsapp`)
  assert.ok(r.data.recipients.length > 0)
  r = await S.a.post('/comms/workflows', { preset: 'welcome', channel: 'whatsapp' })
  assert.ok(r.data.steps.every(s => s.type !== 'send' || s.channel !== 'whatsapp'), 'presets never pick WhatsApp')
  assert.equal((await S.a.post('/comms/messages', { channel: 'whatsapp', when: 'later', sendDate: '2030-01-01', sendTime: '10:00', body: 'x', audience: { mode: 'filters', statuses: ['member'] } })).status, 400)
})

test('provider adapters: request format, error normalisation and signature checks (no network)', async () => {
  const real = globalThis.fetch
  const seen = []
  let reply = null
  globalThis.fetch = async (u, init) => { seen.push([String(u), init]); return new Response(JSON.stringify(reply.body), { status: reply.status }) }
  try {
    const tw = SMS_ADAPTERS.twilio
    const creds = { TWILIO_ACCOUNT_SID: 'AC123', TWILIO_AUTH_TOKEN: 'secret' }
    reply = { status: 201, body: { sid: 'SM1', status: 'queued', num_segments: '2' } }
    let r = await tw.send({ to: '447700900111', from: 'GRACE', body: 'Hi', callbackUrl: 'https://x/cb' }, creds)
    assert.deepEqual([r.accepted, r.providerId, r.segments], [true, 'SM1', 2])
    const form = new URLSearchParams(seen[0][1].body)
    assert.equal(form.get('To'), '+447700900111'); assert.equal(form.get('From'), 'GRACE'); assert.equal(form.get('StatusCallback'), 'https://x/cb')
    reply = { status: 400, body: { code: 21211, message: 'Invalid To' } }
    r = await tw.send({ to: '1', body: 'x' }, creds)
    assert.equal(r.error.code, 'invalid_number'); assert.equal(r.error.scope, 'recipient')
    reply = { status: 503, body: {} }
    r = await tw.send({ to: '1', body: 'x' }, creds)
    assert.equal(r.error.transient, true); assert.equal(r.error.outcome, 'not_sent')
    reply = { status: 500, body: {} }
    r = await tw.send({ to: '1', body: 'x' }, creds)
    assert.equal(r.error.outcome, 'unknown', 'a 5xx might have been accepted: never resent elsewhere')
    // Twilio signature: HMAC-SHA1 of URL + sorted params.
    const params = { MessageSid: 'SM1', MessageStatus: 'delivered' }
    const url = 'https://gatherhq.org/api/webhooks/sms/twilio?t=abc'
    const sig = crypto.createHmac('sha1', 'secret').update(url + 'MessageSidSM1MessageStatusdelivered').digest('base64')
    assert.equal(tw.verify({ url, form: params, headers: new Headers({ 'x-twilio-signature': sig }) }, creds), true)
    assert.equal(tw.verify({ url, form: params, headers: new Headers({ 'x-twilio-signature': 'nope' }) }, creds), false)
    assert.deepEqual(tw.parse({ form: params }).reports[0], { providerId: 'SM1', status: 'delivered', error: null, segments: null })
    // Termii
    const te = SMS_ADAPTERS.termii
    reply = { status: 200, body: { code: 'ok', message_id: '9001', message: 'Successfully Sent' } }
    r = await te.send({ to: '2348031110001', from: 'GRACE', body: 'Hi', route: 'dnd' }, { TERMII_API_KEY: 'k' })
    assert.equal(r.providerId, '9001')
    assert.equal(JSON.parse(seen.at(-1)[1].body).channel, 'dnd')
    const raw = JSON.stringify({ message_id: '9001', status: 'Delivered' })
    assert.equal(te.verify({ raw, headers: new Headers({ 'x-termii-signature': crypto.createHmac('sha512', 'sk').update(raw).digest('hex') }) }, { TERMII_SECRET_KEY: 'sk' }), true)
    assert.equal(te.parse({ json: JSON.parse(raw) }).reports[0].status, 'delivered')
    // Africa's Talking
    const at = SMS_ADAPTERS.africastalking
    reply = { status: 201, body: { SMSMessageData: { Recipients: [{ statusCode: 101, number: '+254700000001', status: 'Success', cost: 'KES 0.8000', messageId: 'ATX1' }] } } }
    r = await at.send({ to: '254700000001', body: 'Hi' }, { AT_USERNAME: 'sandbox', AT_API_KEY: 'k' })
    assert.deepEqual([r.accepted, r.providerId, r.providerCost, r.currency], [true, 'ATX1', 0.8, 'KES'])
    assert.match(seen.at(-1)[0], /sandbox/)
    reply = { status: 201, body: { SMSMessageData: { Recipients: [{ statusCode: 409, status: 'DoNotDisturbRejection' }] } } }
    r = await at.send({ to: '254700000001', body: 'Hi' }, { AT_USERNAME: 'u', AT_API_KEY: 'k' })
    assert.equal(r.error.code, 'dnd')
  } finally { globalThis.fetch = real }
  assert.equal(countryOf('14165550000'), 'CA'); assert.equal(countryOf('12025550000'), 'US'); assert.equal(countryOf('2250700000000'), 'CI')
})

test('provider credentials are stored encrypted and never returned', async () => {
  process.env.COMMS_SECRET_KEY = 'test-master-key'
  let r = await S.ops.post('/platform/comms/sms/credentials', { provider: 'twilio', values: { TWILIO_ACCOUNT_SID: 'ACsecret123', TWILIO_AUTH_TOKEN: 'tok_very_secret' } })
  assert.equal(r.status, 200, JSON.stringify(r.data))
  assert.ok(r.data.credentials.every(c => !('value' in c)))
  r = await S.ops.get('/platform/comms/sms')
  assert.ok(!JSON.stringify(r.data).includes('tok_very_secret'))
  assert.equal(r.data.providers.find(p => p.id === 'twilio').credentials.find(c => c.name === 'TWILIO_AUTH_TOKEN').set, true)
  const stored = (await db().collection('platform').doc('commsSecrets').collection('providers').doc('twilio').get()).data()
  assert.ok(!JSON.stringify(stored).includes('tok_very_secret'), 'encrypted at rest')
  assert.equal((await S.a.post('/platform/comms/sms/credentials', { provider: 'twilio', values: {} })).status, 403)
  delete process.env.COMMS_SECRET_KEY
  clearConfigCache()
})
