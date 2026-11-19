// "Get this for your church": referral codes on public pages, the new church's extra month,
// and the referring church's free month once the new church starts paying.
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { setFirebase } from '../server/firebase.js'
import { handle } from '../server/app.js'
import { createFakeFirebase } from './fake-firebase.js'
import { onReferredChurchPaid, FREE_MONTH_DAYS } from '../server/referrals.js'

process.env.APP_ENV = 'staging'
process.env.GW_INSECURE_COOKIES = '1'
let fake
before(() => { fake = createFakeFirebase(); setFirebase(fake) })

let ipSeq = 0
function client() {
  const jar = new Map()
  const ip = `10.7.0.${++ipSeq}`
  const call = async (method, path, body) => {
    const init = { method, headers: { 'x-nf-client-connection-ip': ip, 'user-agent': 'test' } }
    if (jar.size) init.headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
    if (body !== undefined) { init.body = JSON.stringify(body); init.headers['content-type'] = 'application/json' }
    const res = await handle(new Request(`http://test.local/api${path}`, init))
    const set = res.headers.get('set-cookie'); if (set) { const [kv] = set.split(';'); const i = kv.indexOf('='); jar.set(kv.slice(0, i), kv.slice(i + 1)) }
    return { status: res.status, data: await res.json() }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}) }
}
async function signup(c, name, email, ref) {
  const r = await c.post('/auth/signup', { acceptTerms: true, orgName: name, name: 'Pastor', email, password: 'password123', ref })
  if (r.status === 201) await c.post('/auth/session', { idToken: fake.auth.signIn(email, 'password123') })
  return r
}
const ms = (v) => (v?.toDate ? v.toDate() : new Date(v)).getTime()
const orgDoc = (name) => [...fake.db._store].find(([k, v]) => /^orgs\/[^/]+$/.test(k) && v.name === name)
const DAY = 86_400_000

test('a church’s check-in page carries its referral code, and the code names the church', async () => {
  const a = client()
  assert.equal((await signup(a, 'Grace Chapel', 'grace@ref.test')).status, 201)
  const me = await a.get('/me')
  const g = await a.post('/gatherings', { name: 'Sunday Service', branchId: me.data.branches[0].id, startsAt: new Date().toISOString() })
  const pub = client()
  const page = await pub.get(`/public/g/${g.data.public_token}`)
  assert.match(page.data.ref, /^[a-z0-9]{7}$/)
  const mine = await a.get('/org/referrals')
  assert.equal(mine.data.code, page.data.ref, 'same code everywhere')
  assert.ok(mine.data.link.endsWith(`/?ref=${page.data.ref}`))
  const who = await pub.get(`/public/ref/${page.data.ref}`)
  assert.deepEqual(who.data, { orgName: 'Grace Chapel', bonusDays: FREE_MONTH_DAYS })
  assert.equal((await pub.get('/public/ref/nosuchcode')).status, 404)
})

test('signing up through a referral adds a month to the new church’s trial', async () => {
  const [, grace] = orgDoc('Grace Chapel')
  const code = grace.referral_code
  const b = client()
  assert.equal((await signup(b, 'New Hope', 'hope@ref.test', code)).status, 201)
  const [hopeKey, hope] = orgDoc('New Hope')
  const trialDays = Math.round((ms(hope.trial_ends_at) - ms(hope.created_at)) / DAY)
  assert.equal(trialDays, 14 + FREE_MONTH_DAYS)
  assert.equal(hope.referred_by.org_name, 'Grace Chapel')
  const list = await client().get('/org/referrals')
  assert.equal(list.status, 401)
  // Without a referral: the normal trial.
  await signup(client(), 'Plain Church', 'plain@ref.test')
  const [, plain] = orgDoc('Plain Church')
  assert.equal(Math.round((ms(plain.trial_ends_at) - ms(plain.created_at)) / DAY), 14)
  // A made-up code is ignored rather than blocking sign-up.
  assert.equal((await signup(client(), 'Odd Church', 'odd@ref.test', 'zzzzzzz')).status, 201)
  assert.equal(orgDoc('Odd Church')[1].referred_by, undefined)
  hopeKey
})

test('the referring church gets a free month once, when the new church starts paying', async () => {
  const [graceKey, before] = orgDoc('Grace Chapel')
  const [hopeKey] = orgDoc('New Hope')
  const hopeId = hopeKey.split('/')[1]
  const r1 = await onReferredChurchPaid(hopeId)
  assert.deepEqual(r1, { applied: true, how: 'trial_extended' })
  const after = fake.db._store.get(graceKey)
  assert.equal(Math.round((ms(after.trial_ends_at) - ms(before.trial_ends_at)) / DAY), FREE_MONTH_DAYS)
  assert.equal(await onReferredChurchPaid(hopeId), null, 'only once')
  const ref = fake.db._store.get(`referrals/${hopeId}`)
  assert.equal(ref.status, 'rewarded')
  // A church that wasn't referred: nothing happens.
  const [plainKey] = orgDoc('Plain Church')
  assert.equal(await onReferredChurchPaid(plainKey.split('/')[1]), null)
})

test('a paying referrer on Stripe gets a month’s credit on its next invoice', async () => {
  const [graceKey, grace] = orgDoc('Grace Chapel')
  fake.db._store.set(graceKey, { ...grace, billing: { provider: 'stripe', customer_id: 'cus_123', status: 'active', plan: 'church', interval: 'monthly', next_payment_date: new Date(Date.now() + 10 * DAY) } })
  const c = client()
  await signup(c, 'Third Church', 'third@ref.test', grace.referral_code)
  const calls = []
  const stripeFn = async (...a) => { calls.push(a); return {} }
  const r = await onReferredChurchPaid(orgDoc('Third Church')[0].split('/')[1], { stripeFn })
  assert.equal(r.how, 'stripe_credit')
  assert.equal(calls[0][1], '/customers/cus_123/balance_transactions')
  assert.ok(calls[0][2].amount < 0)
})
