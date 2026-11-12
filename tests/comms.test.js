// Communications: send now, schedule, workflows, credits, consent, providers and isolation.
// Runs as staging (test providers allowed) against the in-memory Firestore.
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { setFirebase } from '../server/firebase.js'
import { handle } from '../server/app.js'
import { createFakeFirebase } from './fake-firebase.js'
import { runComms, processEnrolment } from '../server/comms/engine.js'
import { clearConfigCache } from '../server/comms/providers.js'
import { localToUtc, nextWeekdayAt } from '../shared/comms.js'

process.env.APP_ENV = 'staging'
process.env.GW_INSECURE_COOKIES = '1'
process.env.PLATFORM_ADMIN_EMAILS = 'ops@gatherhq.test'
let fake
before(() => { fake = createFakeFirebase(); setFirebase(fake) })

let ipSeq = 0
function client() {
  let cookie = ''
  const ip = `10.7.0.${++ipSeq}`
  const call = async (method, path, body) => {
    const init = { method, headers: { 'x-nf-client-connection-ip': ip } }
    if (cookie) init.headers.cookie = cookie
    if (body !== undefined) { init.body = JSON.stringify(body); init.headers['content-type'] = 'application/json' }
    const res = await handle(new Request('http://test.local/api' + path, init))
    const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0]
    const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text()
    return { status: res.status, data }
  }
  return {
    get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), patch: (p, b) => call('PATCH', p, b), del: (p) => call('DELETE', p),
    login: (email, pw) => call('POST', '/auth/session', { idToken: fake.auth.signIn(email, pw) }),
  }
}
async function church(name, email) {
  const c = client()
  const r = await c.post('/auth/signup', { acceptTerms: true, orgName: name, name: 'Owner', email, password: 'password123', timezone: 'Africa/Lagos', defaultCountryCode: '234' })
  assert.equal(r.status, 201, JSON.stringify(r.data))
  await c.login(email, 'password123')
  return c
}
async function person(c, first, { email, phone, status = 'member', consent = true } = {}) {
  c.branch ||= (await c.get('/me')).data.branches[0].id
  const r = await c.post('/people', { firstName: first, lastName: 'Test', email, phone, status, branchId: c.branch })
  assert.equal(r.status, 200, JSON.stringify(r.data))
  if (consent && phone) for (const ch of ['whatsapp', 'sms']) assert.equal((await c.patch(`/people/${r.data.id}/consent`, { channel: ch, status: 'granted', source: 'form' })).status, 200)
  return r.data.id
}
const S = {}

test('setup: two churches, the team switches email to the test provider', async () => {
  S.a = await church('Comms Church A', 'a@comms.test')
  S.b = await church('Comms Church B', 'b@comms.test')
  S.ops = await church('Ops', 'ops@gatherhq.test')
  let r = await S.a.post('/platform/comms/provider', { channel: 'email', provider: 'mock_email' })
  assert.equal(r.status, 403, 'churches cannot change providers')
  r = await S.ops.post('/platform/comms/provider', { channel: 'email', provider: 'mock_email' })
  assert.equal(r.status, 200, JSON.stringify(r.data))
  assert.equal(r.data.channels.email.active, 'mock_email')
  r = await S.ops.get('/platform/comms')
  assert.ok(!JSON.stringify(r.data).match(/re_[A-Za-z0-9]{8}/), 'no credential values')
  S.ada = await person(S.a, 'Ada', { email: 'ada@x.test', phone: '08031230001' })
  S.bayo = await person(S.a, 'Bayo', { email: 'bayo@x.test', phone: '08031230002' })
  S.chi = await person(S.a, 'Chi', { phone: '08031230003', consent: false }) // no email, no consent
  S.dan = await person(S.a, 'Dan', { email: 'dan@x.test', phone: '08031230004' })
  await S.a.patch(`/people/${S.dan}/consent`, { channel: 'email', status: 'withdrawn' })
})

test('send an email now: exclusions explained, each person sent once, safe to retry', async () => {
  let r = await S.a.post('/comms/preview', { channel: 'email', audience: { mode: 'filters', statuses: ['member'] } })
  assert.equal(r.data.total, 4)
  assert.equal(r.data.eligible, 2)
  assert.equal(r.data.excluded.no_contact, 1, 'Chi has no email')
  assert.equal(r.data.excluded.opted_out, 1, 'Dan unsubscribed')
  r = await S.a.post('/comms/messages', { channel: 'email', when: 'now', subject: 'Hello {first_name}', body: 'News from church', audience: { mode: 'filters', statuses: ['member'] } })
  assert.equal(r.status, 200, JSON.stringify(r.data))
  const id = r.data.message.id
  assert.equal(r.data.progress.status, 'sent')
  assert.equal(r.data.progress.sent, 2)
  // Retrying the send or a scheduler run never sends again.
  await S.a.post(`/comms/messages/${id}/send`)
  await runComms({ deadline: Date.now() + 5000 })
  r = await S.a.get(`/comms/messages/${id}`)
  assert.equal(r.data.deliveries.length, 2)
  assert.equal(r.data.message.sent_count, 2)
  assert.ok(r.data.deliveries.every(d => d.status === 'sent'))
  // Simulated delivery reports
  r = await S.a.post(`/comms/simulate/message/${id}`, { status: 'delivered' })
  assert.equal(r.data.updated, 2)
  r = await S.a.get(`/comms/messages/${id}`)
  assert.equal(r.data.message.delivered_count, 2)
  // Duplicate makes a fresh draft
  r = await S.a.post(`/comms/messages/${id}/duplicate`)
  assert.equal((await S.a.get(`/comms/messages/${r.data.id}`)).data.message.status, 'draft')
})

test('automated WhatsApp is held back; SMS needs consent, a registered sender name and credit; paused when credit runs out', async () => {
  let r = await S.a.post('/comms/messages', { channel: 'whatsapp', when: 'now', body: 'Hi {first_name}', audience: { mode: 'filters', statuses: ['member'] } })
  assert.equal(r.status, 400); assert.match(r.data.error, /isn’t available yet/)
  r = await S.a.get('/comms/channels')
  assert.equal(r.data.channels.whatsapp.comingSoon, true); assert.equal(r.data.channels.whatsapp.ready, false)
  assert.equal(r.data.channels.sms.ready, true)
  // Nigeria needs a registered sender name before anything can be texted there.
  r = await S.a.post('/comms/preview', { channel: 'sms', body: 'Hi {first_name}, join us on Sunday!', audience: { mode: 'filters', statuses: ['member'] } })
  assert.equal(r.data.eligible, 3, 'Ada, Bayo, Dan agreed to SMS'); assert.equal(r.data.excluded.no_consent, 1, 'Chi did not')
  assert.equal(r.data.estimate.unroutable.sender_needed.count, 3)
  assert.equal((await S.a.post('/comms/sms/senders', { country: 'NG', value: 'COMMS A!' })).data.status, 'pending')
  r = await S.a.get('/comms/channels')
  assert.equal(r.data.sms.setup.find(x => x.country === 'NG').state, 'pending')
  await S.a.post('/comms/simulate/sender/NG', { status: 'approved' })
  r = await S.a.post('/comms/preview', { channel: 'sms', body: 'Hi {first_name}, join us on Sunday!', audience: { mode: 'filters', statuses: ['member'] } })
  assert.equal(r.data.estimate.reachable, 3); assert.equal(r.data.estimate.byCountry.NG.count, 3)
  assert.ok(r.data.estimate.cost > 0); assert.equal(r.data.estimate.enough, false)
  r = await S.a.post('/comms/messages', { channel: 'sms', when: 'now', body: 'Hi {first_name}, join us on Sunday!', audience: { mode: 'filters', statuses: ['member'] } })
  assert.equal(r.data.progress.status, 'paused'); assert.equal(r.data.progress.pauseReason, 'credits')
  const id = r.data.message.id
  r = await S.a.post('/comms/credits/test', { amount: 5 })
  assert.equal(r.data.balance, 5)
  r = await S.a.post(`/comms/messages/${id}/resume`)
  assert.equal(r.data.status, 'sent'); assert.equal(r.data.sent, 3)
  r = await S.a.get('/comms/channels')
  assert.ok(r.data.credits.balance < 5, 'credit was used')
  assert.equal(r.data.ledger.filter(e => e.type === 'reservation').length, 3)
  assert.equal(r.data.ledger.filter(e => e.type === 'settlement').length, 3)
  assert.equal(r.data.usage.month.count, 3)
  assert.ok(!JSON.stringify(r.data.ledger).includes('mock_sms'), 'no provider names for churches')
  r = await S.a.get(`/comms/messages/${id}`)
  assert.ok(r.data.deliveries.every(d => d.status === 'sent'))
})

test('schedule an SMS invitation for Friday 7pm: sent at the right time, recipients worked out then, never twice', async () => {
  const fri = nextWeekdayAt(new Date(), 'Africa/Lagos', [5], '19:00')
  const date = new Date(fri.getTime() + 3600e3).toISOString().slice(0, 10)
  let r = await S.a.post('/comms/messages', { channel: 'sms', when: 'later', sendDate: date, sendTime: '19:00', body: 'Hi {first_name}, join us on Sunday!', audience: { mode: 'filters', statuses: ['visitor'] } })
  assert.equal(r.status, 200, JSON.stringify(r.data))
  const m = r.data.message
  assert.equal(m.status, 'scheduled')
  assert.deepEqual(m.send_local, { date, time: '19:00' })
  assert.equal(m.send_at, localToUtc(date, '19:00', 'Africa/Lagos').toISOString())
  // A visitor added after scheduling is included, because recipients are worked out at send time.
  await person(S.a, 'Efe', { phone: '08031230005', status: 'visitor' })
  await runComms({ now: new Date(fri.getTime() - 60e3), deadline: Date.now() + 5000 })
  assert.equal((await S.a.get(`/comms/messages/${m.id}`)).data.message.status, 'scheduled', 'not before 7pm')
  await runComms({ now: new Date(fri.getTime() + 5e3), deadline: Date.now() + 5000 })
  await runComms({ now: new Date(fri.getTime() + 65e3), deadline: Date.now() + 5000 })
  r = await S.a.get(`/comms/messages/${m.id}`)
  assert.equal(r.data.message.status, 'sent')
  assert.equal(r.data.deliveries.length, 1)
  assert.equal(r.data.deliveries[0].name, 'Efe Test')
  // Editing a sent message is refused; cancelling a scheduled one stops it.
  assert.equal((await S.a.patch(`/comms/messages/${m.id}`, { channel: 'sms', when: 'later', sendDate: date, sendTime: '20:00', body: 'x' })).status, 400)
  r = await S.a.post('/comms/messages', { channel: 'email', when: 'later', sendDate: date, sendTime: '20:00', subject: 'Later', body: 'x', audience: { mode: 'filters', statuses: ['member'] } })
  const later = r.data.message.id
  assert.equal((await S.a.post(`/comms/messages/${later}/cancel`)).status, 200)
  await runComms({ now: new Date(fri.getTime() + 2 * 3600e3), deadline: Date.now() + 5000 })
  r = await S.a.get(`/comms/messages/${later}`)
  assert.equal(r.data.message.status, 'cancelled'); assert.equal(r.data.deliveries.length, 0)
})

test('first-time visitor workflow: waits, sends, pauses on a reply and asks a person to follow up', async () => {
  let r = await S.a.post('/comms/workflows', { preset: 'welcome' })
  assert.equal(r.status, 200)
  const wf = r.data
  assert.equal(wf.status, 'draft')
  assert.deepEqual(wf.steps.filter(s => s.type === 'send').map(s => s.channel), ['email', 'sms'], 'welcome email, then an SMS invitation')
  // A WhatsApp step can't be switched on.
  r = await S.a.patch(`/comms/workflows/${wf.id}`, { steps: wf.steps.map(s => s.type === 'send' && s.channel === 'sms' ? { ...s, channel: 'whatsapp' } : s) })
  assert.ok(r.data.problems.some(p => /Coming soon/.test(p)))
  r = await S.a.patch(`/comms/workflows/${wf.id}`, { steps: wf.steps, name: 'Welcome' })
  assert.equal(r.status, 200, JSON.stringify(r.data))
  assert.ok(r.data.estimate.perPerson > 0, 'the SMS cost per person is shown')
  r = await S.a.post(`/comms/workflows/${wf.id}/status`, { status: 'active' })
  assert.equal(r.status, 200, JSON.stringify(r.data))
  // A first-time visitor checks in.
  const me = (await S.a.get('/me')).data
  r = await S.a.post('/gatherings', { name: 'Sunday Service', branchId: me.branches[0].id, startsAt: new Date(Date.now() - 3600e3).toISOString(), confirmName: true })
  const pub = client()
  r = await pub.post(`/public/g/${r.data.public_token}/checkin`, { mode: 'new', answers: { first_name: 'Femi', last_name: 'New', phone: '08031230006' } })
  assert.equal(r.status, 200, JSON.stringify(r.data))
  r = await S.a.get(`/comms/workflows/${wf.id}/people`)
  assert.equal(r.data.rows.length, 1)
  const enr = r.data.rows[0]
  const femi = enr.person_id
  // Femi gave no email, so the welcome email is skipped (and says why).
  const monday = nextWeekdayAt(new Date(), 'Africa/Lagos', [1], '10:00')
  await processEnrolment(me.org.id, enr.id, { now: new Date() })
  await processEnrolment(me.org.id, enr.id, { now: new Date(monday.getTime() + 1000) })
  r = await S.a.get(`/comms/workflows/${wf.id}/people`)
  assert.ok(r.data.rows[0].history.some(h => /no contact details/.test(h.text)), JSON.stringify(r.data.rows[0].history))
  // With consent, the Friday invitation goes out; then Femi replies and the workflow pauses.
  await S.a.patch(`/people/${femi}/consent`, { channel: 'sms', status: 'granted' })
  const friday = nextWeekdayAt(monday, 'Africa/Lagos', [5], '18:00')
  await processEnrolment(me.org.id, enr.id, { now: new Date(friday.getTime() + 1000) })
  r = await S.a.get(`/comms/workflows/${wf.id}/people`)
  assert.ok(r.data.rows[0].history.some(h => h.type === 'send' && h.result === 'sent'))
  r = await S.a.post('/comms/simulate/reply', { personId: femi, channel: 'sms', text: 'Thanks! Can someone call me?' })
  assert.equal(r.data.paused, 1)
  r = await S.a.get(`/comms/workflows/${wf.id}/people`)
  assert.equal(r.data.rows[0].status, 'paused_reply')
  r = await S.a.get('/followups?status=open')
  assert.ok(JSON.stringify(r.data).includes('Reply from Femi'), 'the team is asked to follow up')
  // Resume: they did not return on Sunday, so a task is created and the workflow ends.
  assert.equal((await S.a.post(`/comms/enrolments/${enr.id}/resume`)).status, 200)
  const sunday = nextWeekdayAt(friday, 'Africa/Lagos', [0], '15:00')
  await processEnrolment(me.org.id, enr.id, { now: new Date(friday.getTime() + 2000) })
  await processEnrolment(me.org.id, enr.id, { now: new Date(sunday.getTime() + 1000) })
  r = await S.a.get(`/comms/workflows/${wf.id}/people`)
  assert.equal(r.data.rows[0].status, 'completed')
  assert.ok(r.data.rows[0].history.some(h => h.type === 'task'))
  // STOP is an opt-out, not just a reply.
  r = await S.a.post('/comms/simulate/reply', { personId: femi, channel: 'sms', text: 'STOP' })
  assert.equal(r.data.optedOut, true)
  r = await S.a.post('/comms/preview', { channel: 'sms', body: 'x', audience: { mode: 'people', people: [femi] } })
  assert.equal(r.data.excluded.opted_out, 1)
  // Pause stops new steps.
  r = await S.a.post(`/comms/workflows/${wf.id}/status`, { status: 'paused' })
  assert.equal(r.data.workflow.status, 'paused')
})

test('a weekly email every Monday at 10am creates exactly one message per week', async () => {
  let r = await S.a.post('/comms/workflows', { preset: 'regular' })
  const wf = r.data
  assert.equal(wf.trigger.type, 'schedule')
  r = await S.a.post(`/comms/workflows/${wf.id}/status`, { status: 'active' })
  assert.equal(r.status, 200, JSON.stringify(r.data))
  const next = new Date(r.data.workflow.next_run_at)
  assert.equal(next.toISOString(), nextWeekdayAt(new Date(), 'Africa/Lagos', [1], '10:00').toISOString())
  await runComms({ now: new Date(next.getTime() + 1000), deadline: Date.now() + 5000 })
  await runComms({ now: new Date(next.getTime() + 61000), deadline: Date.now() + 5000 })
  await runComms({ now: new Date(next.getTime() + 121000), deadline: Date.now() + 5000 })
  r = await S.a.get('/comms/messages')
  const runs = r.data.rows.filter(m => m.workflow_id === wf.id)
  assert.equal(runs.length, 1)
  assert.equal(runs[0].status, 'sent')
  r = await S.a.get(`/comms/workflows/${wf.id}`)
  assert.equal(new Date(r.data.workflow.next_run_at).getTime(), next.getTime() + 7 * 86400e3)
})

test('event reminder workflow: starts on registration, sends the day before', async () => {
  let r = await S.a.post('/comms/workflows', { preset: 'event_reminder', channel: 'email' })
  const wf = r.data
  assert.equal((await S.a.post(`/comms/workflows/${wf.id}/status`, { status: 'active' })).status, 200)
  const starts = new Date(Date.now() + 5 * 86400e3)
  r = await S.a.post('/events', { name: 'Youth Camp', startsAt: starts.toISOString(), status: 'published' })
  assert.equal(r.status, 200, JSON.stringify(r.data))
  const pub = client()
  r = await pub.post(`/public/e/${r.data.public_token}/register`, { answers: { first_name: 'Ada', last_name: 'Test', phone: '08031230001' } })
  assert.equal(r.status, 200, JSON.stringify(r.data))
  r = await S.a.get(`/comms/workflows/${wf.id}/people`)
  assert.equal(r.data.rows.length, 1, 'Ada, a known person, was enrolled')
})

test('church B can see nothing of church A’s communications', async () => {
  const a = await S.a.get('/comms/messages')
  const id = a.data.rows[0].id
  assert.equal((await S.b.get(`/comms/messages/${id}`)).status, 404)
  assert.equal((await S.b.post(`/comms/messages/${id}/cancel`)).status, 404)
  const wfs = (await S.a.get('/comms/workflows')).data.rows
  assert.equal((await S.b.get(`/comms/workflows/${wfs[0].id}`)).status, 404)
  assert.equal((await S.b.get('/comms/messages')).data.rows.length, 0)
  assert.equal((await S.b.get('/comms/workflows')).data.rows.length, 0)
  assert.equal((await S.b.post('/comms/simulate/reply', { personId: S.ada, channel: 'whatsapp', text: 'hi' })).data.ok, false)
  const ch = (await S.b.get('/comms/channels')).data
  assert.equal(ch.credits.balance, 0, 'credits are per church')
})

test('switching provider keeps history; a channel with no working provider refuses to send', async () => {
  let r = await S.ops.post('/platform/comms/provider', { channel: 'email', provider: 'resend' })
  assert.equal(r.status, 200)
  clearConfigCache()
  r = await S.a.post('/comms/messages', { channel: 'email', when: 'now', subject: 'x', body: 'y', audience: { mode: 'filters', statuses: ['member'] } })
  assert.equal(r.status, 400)
  assert.match(r.data.error, /Email isn’t connected/)
  assert.ok((await S.a.get('/comms/messages')).data.rows.some(m => m.status === 'sent'), 'old messages are still there')
  await S.ops.post('/platform/comms/provider', { channel: 'email', provider: 'mock_email' })
  clearConfigCache()
})

test('test providers are switched off in production', async () => {
  const old = process.env.APP_ENV
  process.env.APP_ENV = 'production'
  clearConfigCache()
  try {
    const r = await S.a.get('/comms/channels')
    assert.equal(r.data.channels.whatsapp.ready, false)
    assert.equal(r.data.channels.sms.ready, false)
    assert.equal((await S.a.post('/comms/credits/test', { amount: 5 })).status, 403)
  } finally { process.env.APP_ENV = old; clearConfigCache() }
})
