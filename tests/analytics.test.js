// Website visitors: cookieless daily counting, what's recorded, what's skipped, signup attribution,
// and the admin console's statistics (platform admins only).
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { setFirebase } from '../server/firebase.js'
import { handle } from '../server/app.js'
import { createFakeFirebase } from './fake-firebase.js'
import { parseAgent, sourceOf } from '../server/analytics.js'

process.env.APP_ENV = 'staging'
process.env.GW_INSECURE_COOKIES = '1'
process.env.PLATFORM_ADMIN_EMAILS = 'ops@gatherhq.test'
let fake
before(() => { fake = createFakeFirebase(); setFirebase(fake) })

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1'
const WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
const geo = (city, code, name) => ({ geo: { city, country: { code, name }, subdivision: { name: 'Lagos' }, timezone: 'Africa/Lagos' } })

function hit(body, { ip = '1.1.1.1', ua = IPHONE, cookie, nf } = {}) {
  const headers = { 'content-type': 'application/json', 'x-nf-client-connection-ip': ip, 'user-agent': ua, host: 'test.local' }
  if (cookie) headers.cookie = cookie
  return handle(new Request('http://test.local/api/t', { method: 'POST', headers, body: JSON.stringify(body) }), nf)
}
const visits = () => [...fake.db._store].filter(([k]) => k.startsWith('siteVisits/')).map(([, v]) => v)

let ipSeq = 0
function client() {
  const jar = new Map()
  const ip = `10.9.0.${++ipSeq}`
  const call = async (method, path, body, ua = WIN) => {
    const init = { method, headers: { 'x-nf-client-connection-ip': ip, 'user-agent': ua } }
    if (jar.size) init.headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
    if (body !== undefined) { init.body = JSON.stringify(body); init.headers['content-type'] = 'application/json' }
    const res = await handle(new Request(`http://test.local/api${path}`, init))
    const set = res.headers.get('set-cookie'); if (set) { const [kv] = set.split(';'); const i = kv.indexOf('='); jar.set(kv.slice(0, i), kv.slice(i + 1)) }
    return { status: res.status, data: await res.json() }
  }
  return { ip, call, get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}),
    adminLogin: (email) => call('POST', '/admin/auth/session', { idToken: fake.auth.signIn(email, 'password123') }) }
}

test('reads devices, browsers and where visitors came from', () => {
  assert.deepEqual(parseAgent(IPHONE), { device: 'Mobile', os: 'iOS', os_version: '17.4', browser: 'Safari', browser_version: '17' })
  assert.equal(parseAgent(WIN).browser, 'Chrome'); assert.equal(parseAgent(WIN).device, 'Desktop'); assert.equal(parseAgent(WIN).os_version, '10/11')
  assert.deepEqual(sourceOf({ refHost: 'www.google.com' }), { source: 'Google', channel: 'Search' })
  assert.deepEqual(sourceOf({ refHost: 'l.facebook.com' }), { source: 'Facebook', channel: 'Social' })
  assert.deepEqual(sourceOf({ utmSource: 'outreach', utmMedium: 'email' }), { source: 'Outreach', channel: 'Email' })
  assert.deepEqual(sourceOf({ ua: 'Mozilla/5.0 [FBAN/FBIOS;FBAV/400.0]' }), { source: 'Facebook', channel: 'Social' })
  assert.deepEqual(sourceOf({}), { source: 'Direct', channel: 'Direct' })
})

test('one visitor per day, with pages, time, location and device; no IP stored', async () => {
  let r = await hit({ k: 'pv', path: '/', ref: 'https://www.google.com/search?q=church+app', utm: { campaign: 'nov' }, screen: '390x844', viewport: '390x700', dpr: 3, lang: 'en-NG', langs: ['en-NG', 'yo'], tz: 'Africa/Lagos', touch: true }, { nf: geo('Lekki', 'NG', 'Nigeria') })
  assert.equal(r.status, 200)
  await hit({ k: 'eng', path: '/', s: 25 })
  await hit({ k: 'pv', path: '/pricing' })
  await hit({ k: 'eng', path: '/pricing', s: 40 })
  await hit({ k: 'pv', path: '/signup' })
  const v = visits()
  assert.equal(v.length, 1, 'same visitor, same day = one visitor')
  const x = v[0]
  assert.equal(x.pageviews, 3); assert.equal(x.engaged_s, 65)
  assert.deepEqual(x.pages.map(p => [p.p, p.s]), [['/', 25], ['/pricing', 40], ['/signup', 0]])
  assert.equal(x.city, 'Lekki'); assert.equal(x.country_code, 'NG'); assert.equal(x.source, 'Google'); assert.equal(x.channel, 'Search')
  assert.equal(x.referrer, 'www.google.com/search', 'referrer keeps no query string')
  assert.equal(x.utm.campaign, 'nov'); assert.equal(x.device, 'Mobile'); assert.equal(x.screen, '390x844')
  assert.deepEqual(x.events, ['pricing_page', 'signup_page'])
  assert.equal(x.landing, '/'); assert.equal(x.exit, '/signup')
  assert.ok(!JSON.stringify(x).includes('1.1.1.1'), 'IP address never stored')
  // A different browser on the same connection is a different visitor.
  await hit({ k: 'pv', path: '/' }, { ua: WIN })
  assert.equal(visits().length, 2)
})

test('skips bots, private pages and engagement without a page view', async () => {
  const before = visits().length
  await hit({ k: 'pv', path: '/' }, { ua: 'Googlebot/2.1 (+http://www.google.com/bot.html)', ip: '2.2.2.2' })
  await hit({ k: 'pv', path: '/c/abc123' }, { ip: '2.2.2.3' })
  await hit({ k: 'pv', path: '/app/people' }, { ip: '2.2.2.4' })
  await hit({ k: 'eng', path: '/', s: 30 }, { ip: '2.2.2.5' })
  assert.equal(visits().length, before)
})

test('marks a visit that ends in a church signup', async () => {
  const c = client()
  await hit({ k: 'pv', path: '/signup' }, { ip: c.ip, ua: WIN })
  const r = await c.post('/auth/signup', { acceptTerms: true, orgName: 'Visitor Chapel', name: 'Pastor', email: 'pastor@visit.test', password: 'password123' })
  assert.equal(r.status, 201)
  const v = visits().find(x => x.converted_org_name === 'Visitor Chapel')
  assert.ok(v, 'visit linked to the new church'); assert.ok(v.events.includes('signed_up'))
})

test('statistics are for platform admins only, and add up', async () => {
  const outsider = client()
  assert.equal((await outsider.get('/platform/visitors')).status, 401)

  const ops = client()
  await ops.post('/auth/signup', { acceptTerms: true, orgName: 'Ops', name: 'Ops', email: 'ops@gatherhq.test', password: 'password123' })
  assert.equal((await ops.adminLogin('ops@gatherhq.test')).status, 200)
  // The admin's own visit is marked and left out by default.
  await hit({ k: 'pv', path: '/' }, { ip: '3.3.3.3', cookie: 'ghq_admin=x' })

  let r = await ops.get('/platform/visitors?range=today')
  assert.equal(r.status, 200, JSON.stringify(r.data))
  const d = r.data
  assert.equal(d.kpis.visitors, 3); assert.equal(d.internal_excluded, 1)
  assert.equal(d.kpis.signups, 1); assert.equal(d.kpis.signup_page, 2)
  assert.equal(d.breakdowns.source.find(s => s.key === 'Google').count, 1)
  assert.equal(d.breakdowns.country.find(c => c.key === 'Nigeria').code, 'NG')
  assert.equal(d.breakdowns.page.find(p => p.key === '/pricing').views, 1)
  assert.equal(d.series.reduce((a, s) => a + s.visitors, 0), 3)
  assert.equal(d.visitors.length, 3)

  r = await ops.get('/platform/visitors?range=today&f_device=Mobile')
  assert.equal(r.data.kpis.visitors, 1)
  r = await ops.get('/platform/visitors?range=today&internal=1')
  assert.equal(r.data.kpis.visitors, 4)

  const one = r.data.visitors.find(v => v.city === 'Lekki')
  r = await ops.get(`/platform/visitors/${one.id}`)
  assert.equal(r.status, 200); assert.equal(r.data.pages.length, 3)
})
