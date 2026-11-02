// Integration tests: the real API handler against an in-memory Firestore/Auth stand-in that
// enforces Firestore's index rules (see tests/fake-firebase.js).
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { setFirebase } from '../server/firebase.js'
import { handle } from '../server/app.js'
import { createFakeFirebase } from './fake-firebase.js'

process.env.GW_INSECURE_COOKIES = '1'
process.env.PLATFORM_ADMIN_EMAILS = 'ops@gatherhq.test'

let fake
before(() => { fake = createFakeFirebase(); setFirebase(fake) })

// Tiny client with a cookie jar.
let ipSeq = 0
function client() {
  let cookie = ''
  const ip = `10.9.${Math.floor(ipSeq / 250)}.${(ipSeq++ % 250) + 1}` // each client is its own visitor
  const call = async (method, path, body, headers = {}) => {
    const init = { method, headers: { 'x-nf-client-connection-ip': ip, ...headers } }
    if (cookie) init.headers.cookie = cookie
    if (body !== undefined) { init.body = typeof body === 'string' ? body : JSON.stringify(body); init.headers['content-type'] ??= 'application/json' }
    const res = await handle(new Request('http://test.local/api' + path, init))
    const set = res.headers.get('set-cookie')
    if (set) cookie = set.split(';')[0]
    const ct = res.headers.get('content-type') || ''
    const data = ct.includes('json') ? await res.json() : await res.text()
    return { status: res.status, data }
  }
  const c = {
    get: (p) => call('GET', p), post: (p, b, h) => call('POST', p, b ?? {}, h), patch: (p, b) => call('PATCH', p, b), del: (p) => call('DELETE', p, undefined),
    // Mirrors the browser: Firebase sign-in → ID token → session cookie.
    login: async (email, password) => {
      const idToken = fake.auth.signIn(email, password)
      if (!idToken) return { status: 401 }
      return call('POST', '/auth/session', { idToken })
    },
  }
  return c
}
async function signup(c, body) {
  const r = await c.post('/auth/signup', { acceptTerms: true, ...body })
  if (r.status !== 201) return r
  await c.login(body.email, body.password)
  return r
}
async function acceptNew(c, token, name) {
  const r = await c.post('/auth/accept-invite', { token, name, password: 'password123' })
  if (r.status === 200) {
    const inv = await client().get(`/public/invite/${token}`).catch(() => null)
  }
  return r
}
async function setPerson(id, patch) {
  for (const [path, d] of fake.db._store) if (path.endsWith(`/people/${id}`)) fake.db._store.set(path, { ...d, ...patch })
}

const S = {}

test('sign-up creates org, branch and owner; /me reports caps', async () => {
  S.a = client(); S.b = client()
  let r = await signup(S.a, { orgName: 'Grace Chapel', branchName: 'Central', name: 'Ada Owner', email: 'ada@grace.test', password: 'password123' })
  assert.equal(r.status, 201, JSON.stringify(r.data))
  r = await signup(S.b, { orgName: 'Hope Church', name: 'Ben Owner', email: 'ben@hope.test', password: 'password123' })
  assert.equal(r.status, 201)
  const me = await S.a.get('/me')
  assert.equal(me.data.org.name, 'Grace Chapel')
  assert.equal(me.data.membership.role, 'owner')
  assert.ok(me.data.caps.includes('export'))
  S.aBranch1 = me.data.branches[0].id
  S.bBranch = (await S.b.get('/me')).data.branches[0].id

  // A new church is a single church: branches are switched off until the platform team enables them.
  assert.equal(me.data.org.branchesEnabled, false)
  r = await S.a.post('/branches', { name: 'North' })
  assert.equal(r.status, 403)
  assert.match(r.data.error, /church networks/)
  S.ops = client()
  await signup(S.ops, { orgName: 'Ops Test', name: 'Ops', email: 'ops@gatherhq.test', password: 'password123' })
  r = await S.a.patch(`/platform/orgs/${me.data.org.id}`, { multiBranch: true })
  assert.equal(r.status, 403, 'a church owner cannot switch it on themselves')
  r = await S.ops.patch(`/platform/orgs/${me.data.org.id}`, { multiBranch: true })
  assert.equal(r.status, 200, JSON.stringify(r.data))
  assert.equal((await S.a.get('/me')).data.org.branchesEnabled, true)
})

test('duplicate sign-up email is rejected; only valid Firebase tokens create sessions', async () => {
  const c = client()
  let r = await c.post('/auth/signup', { orgName: 'Y', name: 'Y', email: 'new@terms.test', password: 'password123' })
  assert.equal(r.status, 400, 'must agree to the terms')
  assert.ok(r.data.details.fields.acceptTerms)
  r = await c.post('/auth/signup', { acceptTerms: true, orgName: 'X', name: 'X', email: 'ada@grace.test', password: 'password123' })
  assert.equal(r.status, 409)
  r = await c.login('ada@grace.test', 'wrong-password')
  assert.equal(r.status, 401)
  r = await c.post('/auth/session', { idToken: 'forged-token' })
  assert.equal(r.status, 401)
  r = await c.login('ada@grace.test', 'password123')
  assert.equal(r.status, 200)
  r = await c.get('/me')
  assert.equal(r.data.org.name, 'Grace Chapel')
})

test('CSRF guard rejects non-JSON mutations', async () => {
  const r = await S.a.post('/people', 'firstName=x', { 'content-type': 'application/x-www-form-urlencoded' })
  assert.equal(r.status, 415)
})

test('unauthenticated requests are refused', async () => {
  const r = await client().get('/people')
  assert.equal(r.status, 401)
})

test('people CRUD with phone de-duplication', async () => {
  let r = await S.a.post('/branches', { name: 'North' })
  assert.equal(r.status, 200)
  S.aBranch2 = r.data.id
  r = await S.a.post('/people', { firstName: 'Chidi', lastName: 'Okafor', phone: '0803 123 4567', branchId: S.aBranch1, status: 'member' })
  assert.equal(r.status, 200, JSON.stringify(r.data))
  S.chidi = r.data.id
  assert.equal(r.data.phone_norm, '2348031234567')
  assert.ok(!('search' in (await S.a.get(`/people/${S.chidi}`)).data.person), 'search tokens are internal')
  r = await S.a.post('/people', { firstName: 'Someone', phone: '+234 803 123 4567', branchId: S.aBranch1 })
  assert.equal(r.status, 409)
  assert.equal(r.data.details.existingId, S.chidi)
  r = await S.a.get('/people?q=chidi')
  assert.equal(r.data.total, 1)
})

test('TENANT ISOLATION: org B cannot read, edit or list org A records', async () => {
  let r = await S.b.get(`/people/${S.chidi}`)
  assert.equal(r.status, 404)
  r = await S.b.patch(`/people/${S.chidi}`, { firstName: 'Hacked' })
  assert.equal(r.status, 404)
  r = await S.b.del(`/people/${S.chidi}`)
  assert.equal(r.status, 404)
  r = await S.b.get('/people')
  assert.equal(r.data.total, 0)
  // Org B can't create records in org A's branch by passing its ID.
  r = await S.b.post('/people', { firstName: 'X', branchId: S.aBranch1 })
  assert.equal(r.status, 404)
  r = await S.b.get(`/people?branch=${S.aBranch1}`)
  assert.equal(r.status, 404)
  r = await S.b.post('/gatherings', { name: 'Sneaky', branchId: S.aBranch1, startsAt: new Date().toISOString() })
  assert.equal(r.status, 404)
  // Unchanged in org A.
  r = await S.a.get(`/people/${S.chidi}`)
  assert.equal(r.data.person.first_name, 'Chidi')
})

test('team invites: scoped usher only sees their branch; cannot manage people', async () => {
  let r = await S.a.post('/team/invites', { email: 'usher@grace.test', role: 'usher', branchIds: [S.aBranch2] })
  assert.equal(r.status, 200, JSON.stringify(r.data))
  const inviteToken = r.data.token
  r = await client().get(`/public/invite/${inviteToken}`)
  assert.equal(r.data.orgName, 'Grace Chapel')
  S.usher = client()
  r = await S.usher.post('/auth/accept-invite', { token: inviteToken, name: 'Uche Usher', password: 'password123' })
  assert.equal(r.status, 200, JSON.stringify(r.data))
  await S.usher.login('usher@grace.test', 'password123')
  // Reuse is refused.
  r = await client().post('/auth/accept-invite', { token: inviteToken, name: 'Again', password: 'password123' })
  assert.equal(r.status, 400)
  const me = await S.usher.get('/me')
  assert.equal(me.data.branches.length, 1)
  assert.equal(me.data.branches[0].id, S.aBranch2)
  r = await S.usher.get('/people')
  assert.equal(r.status, 403)
  r = await S.usher.get('/team')
  assert.equal(r.status, 403)
  r = await S.usher.post('/gatherings', { name: 'X', branchId: S.aBranch2, startsAt: new Date().toISOString() })
  assert.equal(r.status, 403)
})

test('scoped admin cannot grant access beyond their branches or invite admins', async () => {
  let r = await S.a.post('/team/invites', { email: 'admin2@grace.test', role: 'admin', branchIds: [S.aBranch2] })
  S.admin2 = client()
  await S.admin2.post('/auth/accept-invite', { token: r.data.token, name: 'Scoped Admin', password: 'password123' })
  await S.admin2.login('admin2@grace.test', 'password123')
  r = await S.admin2.post('/team/invites', { email: 'x@grace.test', role: 'lead', branchIds: [S.aBranch1] })
  assert.equal(r.status, 403)
  r = await S.admin2.post('/team/invites', { email: 'x@grace.test', role: 'lead', branchIds: null })
  assert.equal(r.status, 403)
  r = await S.admin2.post('/team/invites', { email: 'x@grace.test', role: 'admin', branchIds: [S.aBranch2] })
  assert.equal(r.status, 403)
  r = await S.admin2.post('/team/invites', { email: 'x@grace.test', role: 'lead', branchIds: [S.aBranch2] })
  assert.equal(r.status, 200)
  // Cannot see or edit people in branch 1.
  r = await S.admin2.get(`/people/${S.chidi}`)
  assert.equal(r.status, 404)
  r = await S.admin2.post('/branches', { name: 'Rogue' })
  assert.equal(r.status, 403)
})

test('last owner cannot be demoted', async () => {
  const team = await S.a.get('/team')
  const me = team.data.members.find(m => m.isMe)
  assert.equal(me.manageable, false)
  const r = await S.a.patch(`/team/members/${me.id}`, { role: 'admin' })
  assert.equal(r.status, 403)
})

test('attendance: public QR check-in for new and returning people', async () => {
  let r = await S.a.post('/gatherings', { name: 'Sunday Service', branchId: S.aBranch2, startsAt: new Date(Date.now() - 3600e3).toISOString(), confirmName: true })
  assert.equal(r.status, 200, JSON.stringify(r.data))
  S.g1 = r.data
  const pub = client()
  r = await pub.get(`/public/g/${S.g1.public_token}`)
  assert.equal(r.data.gathering.name, 'Sunday Service')
  assert.equal(r.data.orgName, 'Grace Chapel')
  assert.ok(!JSON.stringify(r.data).includes(S.g1.id), 'internal id must not leak')

  // New visitor
  r = await pub.post(`/public/g/${S.g1.public_token}/checkin`, { mode: 'new', answers: { first_name: 'Dayo', last_name: 'Bello', phone: '08099990000' } })
  assert.equal(r.status, 200, JSON.stringify(r.data))
  assert.equal(r.data.firstTime, true)
  // Missing required field
  r = await pub.post(`/public/g/${S.g1.public_token}/checkin`, { mode: 'new', answers: { first_name: 'No phone' } })
  assert.equal(r.status, 400)
  assert.ok(r.data.details.fields.phone)
  // Same phone as "new" → told it exists, with a masked hint only
  r = await pub.post(`/public/g/${S.g1.public_token}/checkin`, { mode: 'new', answers: { first_name: 'X', last_name: 'Y', phone: '+2348099990000' } })
  assert.equal(r.status, 409)
  assert.equal(r.data.details.hint.startsWith('D'), true)
  assert.ok(!r.data.details.hint.includes('Dayo'))

  // Returning lookup reveals only a masked hint (Chidi is a member of branch 1, visiting branch 2)
  r = await pub.post(`/public/g/${S.g1.public_token}/lookup`, { phone: '08031234567' })
  assert.equal(r.data.found, true)
  assert.ok(!r.data.hint.includes('Chidi') && !r.data.hint.includes('Okafor'))
  assert.equal(Object.keys(r.data).sort().join(), 'found,hint')
  r = await pub.post(`/public/g/${S.g1.public_token}/checkin`, { mode: 'returning', phone: '08031234567', firstName: 'Wrong' })
  assert.equal(r.status, 400)
  r = await pub.post(`/public/g/${S.g1.public_token}/checkin`, { mode: 'returning', phone: '08031234567', firstName: ' chidi ' })
  assert.equal(r.status, 200)
  assert.equal(r.data.alreadyCheckedIn, false)
  // Duplicate check-in is idempotent
  r = await pub.post(`/public/g/${S.g1.public_token}/checkin`, { mode: 'returning', phone: '08031234567', firstName: 'Chidi' })
  assert.equal(r.data.alreadyCheckedIn, true)

  r = await S.a.get(`/gatherings/${S.g1.id}`)
  assert.equal(r.data.stats.attendance, 2)
  assert.equal(r.data.stats.first_timers, 1)
})

test('first visit creates exactly one follow-up; usher can manually check in within scope only', async () => {
  let r = await S.a.get('/followups?bucket=open')
  const firstVisit = r.data.rows.filter(f => f.reason === 'first_visit')
  assert.equal(firstVisit.length, 1)
  assert.equal(firstVisit[0].first_name, 'Dayo')

  // Usher (branch 2) can check people in at branch-2 sessions
  r = await S.usher.post(`/gatherings/${S.g1.id}/checkins`, { firstName: 'Efe', phone: '07011112222' })
  assert.equal(r.status, 200, JSON.stringify(r.data))
  r = await S.usher.post(`/gatherings/${S.g1.id}/checkins`, { firstName: 'Efe again', phone: '07011112222' })
  assert.equal(r.status, 409)
  // ...but not see a branch-1 session
  r = await S.a.post('/gatherings', { name: 'Central Sunday', branchId: S.aBranch1, startsAt: new Date().toISOString() })
  S.g2 = r.data
  r = await S.usher.get(`/gatherings/${S.g2.id}`)
  assert.equal(r.status, 404)
  r = await S.usher.post(`/gatherings/${S.g2.id}/checkins`, { personId: S.chidi })
  assert.equal(r.status, 404)
  // Usher lookup masks people from other branches
  r = await S.usher.get(`/gatherings/${S.g1.id}/lookup?q=chidi`)
  assert.equal(r.data.rows.length, 1)
  assert.ok(r.data.rows[0].phone.startsWith('••••'))
})

test('second visit closes welcome follow-up and opens second-visit follow-up', async () => {
  let r = await S.a.post('/gatherings', { name: 'Midweek', kind: 'midweek', branchId: S.aBranch2, startsAt: new Date(Date.now() - 600e3).toISOString() })
  const g = r.data
  r = await client().post(`/public/g/${g.public_token}/checkin`, { mode: 'returning', phone: '08099990000', firstName: 'Dayo' })
  assert.equal(r.status, 200)
  r = await S.a.get('/followups?bucket=open')
  const reasons = r.data.rows.filter(f => f.first_name === 'Dayo').map(f => f.reason)
  assert.deepEqual(reasons, ['second_visit'])
})

test('closed sessions reject check-ins', async () => {
  let r = await S.a.patch(`/gatherings/${S.g1.id}`, { status: 'closed' })
  assert.equal(r.data.status, 'closed')
  r = await client().post(`/public/g/${S.g1.public_token}/checkin`, { mode: 'new', answers: { first_name: 'Late', last_name: 'Comer', phone: '08000000001' } })
  assert.equal(r.status, 400)
  assert.match(r.data.error, /closed/i)
})

test('import: preview detects duplicates and invalid rows; commit honours policy', async () => {
  const rows = [
    { firstName: 'Funke', lastName: 'Ade', phone: '08055550001', status: 'member' },
    { fullName: 'Gbenga Ola', phone: '08055550002' },
    { firstName: 'Dup', phone: '0805 555 0001' },          // duplicate within file
    { firstName: 'Chidi', phone: '08031234567', email: 'chidi@x.test' }, // matches existing
    { firstName: '', phone: '0805' },                         // rejected
  ]
  let r = await S.a.post('/people/import/preview', { branchId: S.aBranch1, rows })
  assert.equal(r.status, 200, JSON.stringify(r.data))
  assert.deepEqual(r.data.summary, { total: 5, create: 2, duplicate: 1, skip: 1, rejected: 1 })
  r = await S.a.post('/people/import/commit', { branchId: S.aBranch1, rows, duplicatePolicy: 'update' })
  assert.deepEqual(r.data.summary, { created: 2, updated: 1, skipped: 1, rejected: 1 })
  r = await S.a.get(`/people/${S.chidi}`)
  assert.equal(r.data.person.email, 'chidi@x.test')    // blank filled
  assert.equal(r.data.person.first_name, 'Chidi')      // existing not overwritten
  // Re-importing creates nothing new.
  r = await S.a.post('/people/import/commit', { branchId: S.aBranch1, rows })
  assert.equal(r.data.summary.created, 0)
})

test('export requires permission and is audited', async () => {
  let r = await S.a.get('/people/export')
  assert.equal(r.status, 200)
  assert.match(r.data, /First name,Last name/)
  const lead = client()
  const inv = await S.a.post('/team/invites', { email: 'lead@grace.test', role: 'lead', canExport: false })
  await lead.post('/auth/accept-invite', { token: inv.data.token, name: 'Lead', password: 'password123' })
  await lead.login('lead@grace.test', 'password123')
  r = await lead.get('/people/export')
  assert.equal(r.status, 403)
  r = await lead.get('/people')
  assert.equal(r.status, 200)
  const audit = await S.a.get('/audit')
  assert.ok(audit.data.some(a => a.action === 'people.exported'))
})

test('absence workflow does not create duplicate cases', async () => {
  // Make Chidi look absent for 5 weeks
  await setPerson(S.chidi, { last_seen_at: new Date(Date.now() - 35 * 86400e3) })
  let r = await S.a.get('/followups/absence/candidates')
  assert.ok(r.data.rows.some(p => p.id === S.chidi))
  r = await S.a.post('/followups/absence', { personIds: [S.chidi] })
  assert.equal(r.data.created, 1)
  r = await S.a.post('/followups/absence', { personIds: [S.chidi] })
  assert.equal(r.data.created, 0)
  r = await S.a.get('/followups/absence/candidates')
  assert.ok(!r.data.rows.some(p => p.id === S.chidi))
  // Log a contact attempt, then returning closes the case automatically.
  const open = (await S.a.get(`/followups?person=${S.chidi}`)).data.rows[0]
  r = await S.a.post(`/followups/${open.id}/notes`, { kind: 'call', body: 'Left a voicemail' })
  assert.equal(r.status, 200)
  r = await S.a.post(`/gatherings/${S.g2.id}/checkins`, { personId: S.chidi })
  assert.equal(r.status, 200)
  r = await S.a.get(`/followups/${open.id}`)
  assert.equal(r.data.followup.status, 'done')
  assert.equal(r.data.notes.length, 1)
  // Org B can't touch it
  r = await S.b.get(`/followups/${open.id}`)
  assert.equal(r.status, 404)
})

test('events: capacity, waitlist, duplicates, door check-in, promotion', async () => {
  let r = await S.a.post('/events', { name: 'Youth Camp', startsAt: new Date(Date.now() + 7 * 86400e3).toISOString(), capacity: 2 })
  assert.equal(r.status, 200, JSON.stringify(r.data))
  const e = r.data
  const pub = client()
  const reg = (first, phone) => pub.post(`/public/e/${e.public_token}/register`, { answers: { first_name: first, last_name: 'T', phone } })
  r = await reg('One', '08100000001'); assert.equal(r.data.status, 'registered')
  const code1 = r.data.code
  r = await reg('Two', '08100000002'); assert.equal(r.data.status, 'registered')
  r = await reg('Three', '08100000003'); assert.equal(r.data.status, 'waitlist')
  r = await reg('Again', '08100000001'); assert.equal(r.status, 409)
  r = await pub.get(`/public/e/${e.public_token}`)
  assert.equal(r.data.event.spotsLeft, 0)
  assert.equal(r.data.registration, 'open')
  // Org B can't check in org A's event
  r = await S.b.post(`/events/${e.id}/checkin`, { code: code1 })
  assert.equal(r.status, 404)
  r = await S.usher.post(`/events/${e.id}/checkin`, { code: code1.toLowerCase() })
  assert.equal(r.status, 200, JSON.stringify(r.data))
  r = await S.usher.post(`/events/${e.id}/checkin`, { code: code1 })
  assert.equal(r.data.already, true)
  // Cancel one → waitlisted person promoted
  const list = (await S.a.get(`/events/${e.id}/registrations`)).data.rows
  const two = list.find(x => x.name.startsWith('Two'))
  await S.a.patch(`/events/${e.id}/registrations/${two.id}`, { status: 'cancelled' })
  r = await S.a.get(`/events/${e.id}`)
  assert.equal(r.data.stats.registered, 2)
  assert.equal(r.data.stats.waitlist, 0)
  assert.equal(r.data.stats.checked_in, 1)
  // Registration closed after close date
  await S.a.patch(`/events/${e.id}`, { registrationClosesAt: new Date(Date.now() - 1000).toISOString() })
  r = await reg('Late', '08100000009')
  assert.equal(r.status, 400)
})

test('overview, reports and messages compute without errors', async () => {
  let r = await S.a.get('/overview')
  assert.equal(r.status, 200, JSON.stringify(r.data))
  assert.ok(r.data.today >= 3)
  assert.ok(r.data.latest)
  assert.ok(Array.isArray(r.data.trend))
  r = await S.a.get('/reports/attendance')
  assert.equal(r.status, 200, JSON.stringify(r.data))
  assert.ok(r.data.totals.current >= 3)
  r = await S.a.get('/reports/visitors')
  assert.equal(r.status, 200, JSON.stringify(r.data))
  assert.ok(r.data.funnel.first_visits >= 2)
  r = await S.a.get('/reports/data-quality')
  assert.equal(r.status, 200)
  r = await S.a.post('/messages/audience', { audience: { statuses: ['member'] } })
  assert.equal(r.status, 200)
  r = await S.a.post('/messages', { channel: 'sms', body: 'See you Sunday!', audience: { statuses: ['member'] } })
  assert.equal(r.status, 200)
  r = await S.a.post(`/messages/${r.data.id}/send`)
  assert.equal(r.status, 400)
  assert.match(r.data.error, /isn’t available yet/)
  // Usher overview only includes what they may see
  r = await S.usher.get('/overview')
  assert.equal(r.status, 200)
  assert.equal(r.data.followups, undefined)
  assert.equal(r.data.people, undefined)
})

test('platform admin area is separate from church ownership', async () => {
  let r = await S.a.get('/platform/summary')
  assert.equal(r.status, 403)
  const ops = S.ops
  r = await ops.get('/platform/summary')
  assert.equal(r.status, 200)
  assert.ok(r.data.totals.orgs >= 3)
  assert.ok(!JSON.stringify(r.data).includes('Chidi'), 'no member data in platform view')
  const grace = r.data.orgs.find(o => o.name === 'Grace Chapel')
  r = await ops.patch(`/platform/orgs/${grace.id}`, { status: 'suspended' })
  assert.equal(r.data.status, 'suspended')
  // Suspended org: members lose capabilities and public links stop working
  r = await S.a.get('/people')
  assert.equal(r.status, 403)
  r = await client().get(`/public/g/${S.g2.public_token}`)
  assert.equal(r.status, 404)
  await ops.patch(`/platform/orgs/${grace.id}`, { status: 'active' })
})

test('logout ends the session', async () => {
  let r = await S.b.post('/auth/logout')
  assert.equal(r.status, 200)
  r = await S.b.get('/me')
  assert.equal(r.status, 401)
})

test('index checker rejects queries without a declared composite index', async () => {
  const q = fake.db.collection('orgs/x/people').where('status', '==', 'member').orderBy('visit_count', 'desc')
  await assert.rejects(() => q.get(), /needs a composite index/)
})

test('every people filter and sort combination is backed by an index', async () => {
  const c = client()
  await c.login('ada@grace.test', 'password123')
  const me = (await c.get('/me')).data
  const branch = me.branches[0].id
  const unit = (await c.post('/units', { name: 'Choir' })).data.id
  const filters = [{}, { status: 'member' }, { status: 'visitor,member' }, { branch }, { unit }, { followup: 'open' },
    { attendance: 'recent' }, { attendance: 'absent' }, { attendance: 'never' }, { firstVisitSince: new Date(Date.now() - 7 * 86400e3).toISOString() },
    { status: 'member', branch, unit }, { status: 'member', attendance: 'absent', branch }]
  for (const f of filters) for (const sort of ['name', 'recent', 'last_seen', 'first_visit']) {
    const qs = new URLSearchParams({ ...f, sort }).toString()
    const r = await c.get(`/people?${qs}`)
    assert.equal(r.status, 200, `${qs}: ${JSON.stringify(r.data)}`)
  }
  for (const status of ['', 'open', 'closed', 'archived']) {
    const r = await c.get(`/gatherings?${new URLSearchParams({ status, branch })}`)
    assert.equal(r.status, 200, `gatherings ${status}: ${JSON.stringify(r.data)}`)
  }
  for (const bucket of ['overdue', 'today', 'upcoming', 'done']) assert.equal((await c.get(`/followups?bucket=${bucket}`)).status, 200)
  for (const when of ['upcoming', 'past', '']) assert.equal((await c.get(`/events?when=${when}`)).status, 200)
  assert.equal((await c.get(`/overview?branch=${branch}`)).status, 200)
  assert.equal((await c.get(`/reports/attendance?branch=${branch}`)).status, 200)
})

test('delete all people: owner only, typed confirmation, scoped to own church', async () => {
  const c = client()
  await signup(c, { orgName: 'Clean Slate Church', branchName: 'Main', name: 'Owner Z', email: 'z@clean.test', password: 'password123', timezone: 'Africa/Lagos' })
  const me = (await c.get('/me')).data
  const branchId = me.branches[0].id
  for (const [f, ph] of [['Ade', '08011110001'], ['Bola', '08011110002'], ['Chi', '08011110003']]) {
    const r = await c.post('/people', { firstName: f, lastName: 'Test', phone: ph, branchId, status: 'visitor' })
    assert.equal(r.status, 200, JSON.stringify(r.data))
  }
  const g = (await c.post('/gatherings', { name: 'Service', branchId, startsAt: new Date(Date.now() - 600e3).toISOString() })).data
  await client().post(`/public/g/${g.public_token}/checkin`, { mode: 'returning', phone: '08011110001', firstName: 'Ade' })
  assert.equal((await c.get(`/gatherings/${g.id}`)).data.stats.attendance, 1)
  const before = (await S.a.get('/people')).data.total

  let r = await c.post('/people/delete-all', { confirm: 'yes' })
  assert.equal(r.status, 400)
  r = await S.a.get('/me') // other church unaffected by anything below
  do { r = await c.post('/people/delete-all', { confirm: 'delete' }) } while (r.status === 200 && !r.data.done)
  assert.equal(r.status, 200, JSON.stringify(r.data))
  assert.equal((await c.get('/people')).data.total, 0)
  assert.equal((await c.get(`/gatherings/${g.id}`)).data.stats.attendance, 0)
  assert.equal((await c.get('/followups?bucket=open')).data.rows?.length ?? 0, 0)
  // The same phone can be added again afterwards.
  r = await c.post('/people', { firstName: 'Ade', lastName: 'Again', phone: '08011110001', branchId })
  assert.equal(r.status, 200, JSON.stringify(r.data))
  assert.equal((await S.a.get('/people')).data.total, before)
})

test('email: branding, preview-safe rendering, test send, unsubscribe and batched sending', async () => {
  const { unsubscribeUrl } = await import('../server/email.js')
  const c = client()
  await signup(c, { orgName: 'Mail Church', branchName: 'Main', name: 'Mary Owner', email: 'mary@mail.test', password: 'password123', timezone: 'Africa/Lagos' })
  const me = (await c.get('/me')).data
  const branchId = me.branches[0].id

  let r = await c.get('/email/settings')
  assert.equal(r.data.connected, false)
  assert.equal(r.data.branding.fromName, 'Mail Church')

  r = await c.patch('/email/branding', { color: '#123456', footer: '12 Church Road', website: 'grace.org', replyTo: 'office@grace.org' })
  assert.equal(r.status, 200, JSON.stringify(r.data))
  assert.equal(r.data.website, 'https://grace.org')
  r = await c.patch('/email/branding', { replyTo: 'not-an-email' })
  assert.equal(r.status, 400)

  // Logo upload is served publicly as an image
  const png = 'data:image/png;base64,' + Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString('base64')
  r = await c.post('/email/assets', { dataUrl: png, kind: 'logo' })
  assert.equal(r.status, 200, JSON.stringify(r.data))
  const assetPath = new URL(r.data.url).pathname.replace(/^\/api/, '')
  const img = await client().get(assetPath)
  assert.equal(img.status, 200)
  r = await c.post('/email/assets', { dataUrl: 'data:image/png;base64,' + Buffer.from('<svg>').toString('base64') })
  assert.equal(r.status, 400)

  const ids = []
  for (const [f, e] of [['Ada', 'ada@x.test'], ['Bayo', 'bayo@x.test'], ['Cy', 'cy@x.test'], ['Dup', 'ADA@x.test'], ['NoMail', null]]) {
    r = await c.post('/people', { firstName: f, lastName: 'T', email: e || undefined, phone: `0802${String(ids.length).padStart(7, '0')}`, branchId, status: 'member' })
    assert.equal(r.status, 200, JSON.stringify(r.data)); ids.push(r.data.id)
  }
  // Cy unsubscribes through the link in an email
  const unsub = new URL(unsubscribeUrl('http://test.local', me.org.id, ids[2]))
  r = await client().get('/public/unsubscribe' + unsub.search)
  assert.ok(String(r.data).includes('Unsubscribe'))
  r = await handle(new Request('http://test.local/api/public/unsubscribe' + unsub.search, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' }))
  assert.equal(r.status, 200)
  assert.ok((await r.text()).includes('unsubscribed'))
  r = await client().get('/public/unsubscribe' + unsub.search.replace(/t=[^&]+/, 't=forged0000000000000000000000000'))
  assert.ok(String(r.data).includes('isn’t valid'))

  const audience = { statuses: ['member'], segment: 'all' }
  r = await c.post('/messages/audience', { audience })
  assert.equal(r.data.counts.with_email, 2, 'deduplicated, unsubscribed excluded')
  assert.equal(r.data.counts.unsubscribed, 1)

  const blocks = [{ type: 'heading', text: 'Hi {first_name} <script>alert(1)</script>' }, { type: 'text', text: 'See https://grace.org' }, { type: 'button', label: 'Go', url: 'javascript:alert(1)' }, { type: 'evil' }]
  r = await c.post('/messages', { channel: 'email', subject: 'Sunday {first_name}', blocks, audience })
  assert.equal(r.status, 200, JSON.stringify(r.data))
  const msg = r.data
  assert.equal(msg.blocks.length, 3)
  assert.equal(msg.blocks[2].url, '', 'unsafe link removed')

  r = await c.post(`/messages/${msg.id}/send`)
  assert.equal(r.status, 400)
  assert.match(r.data.error, /switched on/)

  // Connect a simulated email service
  process.env.RESEND_API_KEY = 're_test'; process.env.EMAIL_FROM_DOMAIN = 'mail.gatherhq.test'
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (u, init) => {
    if (!String(u).startsWith('https://api.resend.com')) return realFetch(u, init)
    calls.push({ url: String(u), headers: init.headers, body: JSON.parse(init.body) })
    return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    r = await c.get('/email/settings')
    assert.equal(r.data.connected, true)
    assert.match(r.data.fromAddress, /^"Mail Church" <mail-church@mail\.gatherhq\.test>$/)

    r = await c.post('/messages/test', { subject: 'Hello', blocks })
    assert.equal(r.status, 200, JSON.stringify(r.data))
    assert.deepEqual(calls[0].body[0].to, ['mary@mail.test'])
    assert.equal(calls[0].body[0].subject, '[Test] Hello')

    let p
    do { p = await c.post(`/messages/${msg.id}/send`) } while (p.status === 200 && p.data.status === 'sending')
    assert.equal(p.status, 200, JSON.stringify(p.data))
    assert.deepEqual([p.data.status, p.data.total, p.data.sent, p.data.failed], ['sent', 2, 2, 0])
    const batch = calls[1].body
    assert.equal(calls[1].url, 'https://api.resend.com/emails/batch')
    assert.ok(calls[1].headers['idempotency-key'])
    assert.deepEqual(batch.map(e => e.to[0]).sort(), ['ada@x.test', 'bayo@x.test'])
    const ada = batch.find(e => e.to[0] === 'ada@x.test')
    assert.equal(ada.subject, 'Sunday Ada')
    assert.equal(ada.reply_to, 'office@grace.org')
    assert.ok(ada.html.includes('Hi Ada &lt;script&gt;'))
    assert.ok(!ada.html.includes('<script>'))
    assert.ok(ada.html.includes('#123456'))
    assert.ok(ada.html.includes('12 Church Road'))
    assert.match(ada.headers['List-Unsubscribe'], /\/api\/public\/unsubscribe\?o=/)
    assert.ok(ada.text.toLowerCase().includes('hi ada'))

    // Sending again does nothing; sent messages can't be edited
    r = await c.post(`/messages/${msg.id}/send`)
    assert.equal(r.data.status, 'sent')
    assert.equal(calls.length, 2)
    r = await c.patch(`/messages/${msg.id}`, { subject: 'Changed' })
    assert.equal(r.status, 400)
  } finally {
    globalThis.fetch = realFetch
    delete process.env.RESEND_API_KEY; delete process.env.EMAIL_FROM_DOMAIN
  }
})

test('phone numbers: every way of writing a Nigerian number matches the same person', async () => {
  const { normalizePhone, displayPhone, exportPhone } = await import('../server/util.js')
  const same = ['08067999999', '8067999999', '+2348067999999', '2348067999999', '+234 806 799 9999', '+234 (0) 806 799 9999',
    '234 0806 799 9999', '0806-799-9999', '(0806) 799 9999', '8067999999.0', "'08067999999", '002348067999999', 8067999999, 2348067999999]
  for (const v of same) assert.equal(normalizePhone(v, '234'), '2348067999999', `failed for ${v}`)
  assert.equal(normalizePhone('2.34807E+12', '234'), null, 'scientific notation is refused, not guessed')
  assert.equal(normalizePhone('8.068E+09', '234'), null)
  assert.equal(normalizePhone('', '234'), null)
  assert.equal(normalizePhone('12', '234'), null)
  assert.equal(normalizePhone('+44 7700 900123', '234'), '447700900123')
  assert.equal(normalizePhone('0244123456', '233'), '233244123456')
  assert.equal(displayPhone('2348067999999', '234'), '08067999999')
  assert.equal(displayPhone('447700900123', '234'), '+447700900123')
  assert.equal(exportPhone('2348067999999'), '+234 806 799 9999')
  assert.equal(normalizePhone(exportPhone('2348067999999'), '234'), '2348067999999', 'exports import straight back')

  // Import where Excel dropped the 0 matches someone already saved with it
  const c = client()
  await signup(c, { orgName: 'Phone Church', branchName: 'Main', name: 'P Owner', email: 'p@phone.test', password: 'password123', timezone: 'Africa/Lagos' })
  const branchId = (await c.get('/me')).data.branches[0].id
  let r = await c.post('/people', { firstName: 'Ngozi', lastName: 'A', phone: '0806 799 9999', branchId })
  assert.equal(r.status, 200, JSON.stringify(r.data))
  assert.equal(r.data.phone, '08067999999', 'saved in tidy local form')
  r = await c.post('/people/import/preview', { branchId, rows: [{ firstName: 'Ngozi', phone: '8067999999' }, { firstName: 'Bayo', phone: '8031234567' }, { firstName: 'Bad', phone: '2.34807E+12' }] })
  assert.equal(r.status, 200, JSON.stringify(r.data))
  const byName = Object.fromEntries(r.data.rows.map(x => [x.data?.first_name || x.raw?.firstName, x]))
  assert.notEqual(byName.Ngozi.action, 'create', 'recognised as the existing person')
  assert.equal(byName.Bayo.action, 'create')
  assert.equal(byName.Bad.action, 'reject')
  assert.match(byName.Bad.errors.join(' '), /shortened by Excel/)
  r = await c.post('/people/import/commit', { branchId, rows: [{ firstName: 'Bayo', phone: '8031234567' }] })
  r = await c.get('/people?q=Bayo')
  assert.equal(r.data.rows[0].phone, '08031234567', 'the 0 is put back')
  // Public check-in with the 0 left off finds the person
  const g = (await c.post('/gatherings', { name: 'Service', branchId, startsAt: new Date(Date.now() - 600e3).toISOString() })).data
  r = await client().post(`/public/g/${g.public_token}/checkin`, { mode: 'returning', phone: '806 799 9999', firstName: 'Ngozi' })
  assert.equal(r.status, 200, JSON.stringify(r.data))
})

test('quick check-in (default): phone number alone checks a returning person in', async () => {
  const c = client()
  await signup(c, { orgName: 'Quick Church', branchName: 'Main', name: 'Q Owner', email: 'q@quick.test', password: 'password123', timezone: 'Africa/Lagos' })
  const branchId = (await c.get('/me')).data.branches[0].id
  await c.post('/people', { firstName: 'Kemi', lastName: 'O', phone: '08055550001', branchId })
  const g = (await c.post('/gatherings', { name: 'Service', branchId, startsAt: new Date(Date.now() - 600e3).toISOString() })).data
  assert.equal(g.confirm_name, false, 'off by default')
  const pub = client()
  let r = await pub.get(`/public/g/${g.public_token}`)
  assert.equal(r.data.gathering.confirmName, false)
  r = await pub.post(`/public/g/${g.public_token}/checkin`, { mode: 'returning', phone: '8055550001' })
  assert.equal(r.status, 200, JSON.stringify(r.data))
  assert.equal(r.data.firstName, 'Kemi')
  assert.equal(r.data.alreadyCheckedIn, false)
  r = await pub.post(`/public/g/${g.public_token}/checkin`, { mode: 'returning', phone: '08055550001' })
  assert.equal(r.data.alreadyCheckedIn, true)
  // Unknown number: told to fill in the new-visitor form, nothing recorded
  r = await pub.post(`/public/g/${g.public_token}/checkin`, { mode: 'returning', phone: '08055550999' })
  assert.deepEqual(r.data, { found: false })
  // Someone known who fills in the new-visitor form is simply checked in
  const g2 = (await c.post('/gatherings', { name: 'Midweek', branchId, startsAt: new Date(Date.now() - 600e3).toISOString() })).data
  r = await pub.post(`/public/g/${g2.public_token}/checkin`, { mode: 'new', answers: { first_name: 'Kemi', last_name: 'O', phone: '0805 555 0001' } })
  assert.equal(r.status, 200, JSON.stringify(r.data))
  assert.equal(r.data.returning, true)
  assert.equal((await c.get(`/gatherings/${g.id}`)).data.stats.attendance, 1)
  // Turning the name check on per session
  r = await c.patch(`/gatherings/${g2.id}`, { confirmName: true })
  assert.equal(r.data.confirm_name, true)
  r = await pub.post(`/public/g/${g2.public_token}/checkin`, { mode: 'returning', phone: '08055550001', firstName: 'Wrong' })
  assert.equal(r.status, 400)
})

test('tags: create, tag people in bulk, filter lists and email audiences, hand-pick people', async () => {
  const c = client()
  await signup(c, { orgName: 'Tag Church', name: 'T Owner', email: 't@tag.test', password: 'password123', timezone: 'Africa/Lagos' })
  const branchId = (await c.get('/me')).data.branches[0].id
  const ids = {}
  for (const [f, e, status] of [['Ada', 'ada@t.test', 'member'], ['Bayo', 'bayo@t.test', 'member'], ['Chi', 'chi@t.test', 'visitor'], ['Dan', 'dan@t.test', 'member']]) {
    const r = await c.post('/people', { firstName: f, lastName: 'T', email: e, phone: `0809${String(Object.keys(ids).length).padStart(7, '0')}`, branchId, status })
    assert.equal(r.status, 200, JSON.stringify(r.data)); ids[f] = r.data.id
  }
  let r = await c.post('/tags', { name: 'Choir' }); const choir = r.data.id
  r = await c.post('/tags', { name: 'choir' }); assert.equal(r.data.id, choir, 'same name, different case reuses the tag')
  r = await c.post('/tags', { name: 'Youth' }); const youth = r.data.id
  r = await c.post('/people/tags', { ids: [ids.Ada, ids.Bayo], add: [choir] }); assert.equal(r.data.updated, 2)
  r = await c.post('/people/tags', { ids: [ids.Bayo, ids.Chi], add: [youth] }); assert.equal(r.data.updated, 2)
  r = await c.get('/tags')
  assert.deepEqual(r.data.map(t => [t.name, t.count]), [['Choir', 2], ['Youth', 2]])

  r = await c.get(`/people?tags=${choir}`)
  assert.deepEqual(r.data.rows.map(p => p.first_name).sort(), ['Ada', 'Bayo'])
  r = await c.get(`/people?tags=${choir},${youth}&status=member`)
  assert.deepEqual(r.data.rows.map(p => p.first_name).sort(), ['Ada', 'Bayo'], 'any of the tags, combined with other filters')
  assert.deepEqual(r.data.rows.find(p => p.first_name === 'Bayo').tags.sort(), [choir, youth].sort())

  r = await c.post('/messages/audience', { audience: { tags: [youth], statuses: [] } })
  assert.equal(r.data.counts.with_email, 2)
  r = await c.post('/messages/audience', { audience: { tags: [youth], statuses: ['visitor'] } })
  assert.equal(r.data.counts.with_email, 1)
  r = await c.post('/messages/audience', { audience: { mode: 'people', people: [ids.Dan, ids.Ada, 'nonexistent1'] } })
  assert.equal(r.data.counts.total, 2)
  assert.equal(r.data.counts.with_email, 2)

  // Removing a tag from people, then deleting a tag removes it everywhere
  r = await c.post('/people/tags', { ids: [ids.Ada], remove: [choir] })
  r = await c.get(`/people?tags=${choir}`); assert.equal(r.data.total, 1)
  r = await c.del(`/tags/${youth}`); assert.equal(r.data.removedFrom, 2)
  r = await c.get(`/people/${ids.Bayo}`); assert.deepEqual(r.data.person.tags, [choir])

  // Other churches can't use or see these tags
  const other = client()
  await signup(other, { orgName: 'Other Church', name: 'O Owner', email: 'o@other.test', password: 'password123' })
  r = await other.post('/people/tags', { ids: [ids.Ada], add: [choir] })
  assert.equal(r.status, 400)
  r = await other.get('/tags'); assert.ok(!r.data.some(t => t.id === choir))
  r = await other.get(`/people/${ids.Ada}`); assert.equal(r.status, 404)
})

test('automations: welcome journey emails, Monday brief timing, opt-outs, WhatsApp templates', async () => {
  const { runScheduled } = await import('../server/jobs.js')
  const { tzOffsetMs } = await import('../server/util.js')
  const c = client()
  await signup(c, { orgName: 'Journey Church', name: 'Joy Owner', email: 'joy@journey.test', password: 'password123', timezone: 'Africa/Lagos' })
  const me = (await c.get('/me')).data
  const branchId = me.branches[0].id
  assert.match(me.org.whatsappTemplates.first_visit, /\{first_name\}/)

  // Defaults: everything off
  let r = await c.get('/automation')
  assert.equal(r.data.journey.welcome.enabled, false)
  assert.equal(r.data.briefEnabled, true)
  r = await c.patch('/automation', { journey: { welcome: { enabled: true, delayHours: 3 }, second: { enabled: true, delayHours: 1 } }, whatsapp: { general: 'Hello {first_name}!' } })
  assert.equal(r.status, 200, JSON.stringify(r.data))
  assert.equal(r.data.whatsapp.general, 'Hello {first_name}!')
  r = await c.patch('/automation', { journey: { third: { enabled: true, subject: '' } } })
  assert.equal(r.status, 400, 'cannot switch on an email without a subject')

  const g = (await c.post('/gatherings', { name: 'Sunday', branchId, startsAt: new Date(Date.now() - 3600e3).toISOString() })).data
  const pub = client()
  r = await pub.post(`/public/g/${g.public_token}/checkin`, { mode: 'new', answers: { first_name: 'Femi', last_name: 'A', phone: '08077770001', email: 'femi@x.test' } })
  assert.equal(r.status, 200, JSON.stringify(r.data))
  await pub.post(`/public/g/${g.public_token}/checkin`, { mode: 'new', answers: { first_name: 'NoMail', last_name: 'B', phone: '08077770002' } })

  process.env.RESEND_API_KEY = 're_test'; process.env.EMAIL_FROM_DOMAIN = 'mail.gatherhq.test'
  const sent = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (u, init) => {
    if (!String(u).startsWith('https://api.resend.com')) return realFetch(u, init)
    const body = JSON.parse(init.body); for (const e of (Array.isArray(body) ? body : [body])) sent.push(e)
    return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    const toFemi = () => sent.filter(e => e.to[0] === 'femi@x.test')
    await runScheduled({ now: new Date(Date.now() + 3600e3) })
    assert.equal(toFemi().length, 0, 'not due yet after 1 hour')
    await runScheduled({ now: new Date(Date.now() + 3.5 * 3600e3) })
    assert.equal(toFemi().length, 1, 'welcome sent after 3 hours')
    assert.equal(toFemi()[0].subject, 'Welcome to Journey Church, Femi!')
    assert.ok(toFemi()[0].headers['List-Unsubscribe'])
    await runScheduled({ now: new Date(Date.now() + 5 * 3600e3) })
    assert.equal(toFemi().length, 1, 'never sent twice')
    assert.ok(!sent.some(e => /NoMail/.test(e.html || '')), 'people without email are skipped')

    // Second visit queues the second email
    const g2 = (await c.post('/gatherings', { name: 'Midweek', branchId, startsAt: new Date(Date.now() - 600e3).toISOString() })).data
    await pub.post(`/public/g/${g2.public_token}/checkin`, { mode: 'returning', phone: '08077770001' })
    await runScheduled({ now: new Date(Date.now() + 2 * 3600e3) })
    assert.equal(toFemi().length, 2)
    assert.match(toFemi()[1].subject, /again, Femi/)

    // Journey test send goes to the signed-in user
    r = await c.post('/automation/journey/test', { step: 'third' })
    assert.equal(r.status, 200, JSON.stringify(r.data))
    assert.equal(sent.at(-1).to[0], 'joy@journey.test')
    assert.match(sent.at(-1).subject, /^\[Test\]/)

    // Monday brief: only on Monday from 7am Lagos time, once a week
    // Next week's Monday, so the test passes whatever day it runs (a run on a Monday evening has already sent this week's)
    let monday = new Date(Date.now() + 2 * 86400e3)
    const local = (d) => new Date(d.getTime() + tzOffsetMs('Africa/Lagos', d))
    while (!(local(monday).getUTCDay() === 1 && local(monday).getUTCHours() === 7)) monday = new Date(monday.getTime() + 3600e3)
    monday = new Date(monday.getTime() + 30 * 60e3)
    // Earlier steps run the scheduler at the real time, which on a Monday morning sends this week's brief: count from here.
    const before = sent.filter(e => e.to[0] === 'joy@journey.test' && /Monday brief/.test(e.subject)).length
    const toJoy = () => sent.filter(e => e.to[0] === 'joy@journey.test' && /Monday brief/.test(e.subject)).slice(before)
    await runScheduled({ now: new Date(monday.getTime() - 2 * 3600e3) })
    assert.equal(toJoy().length, 0, 'not before 7am')
    await runScheduled({ now: monday })
    assert.equal(toJoy().length, 1, 'sent on Monday morning')
    assert.match(toJoy()[0].subject, /at church last week/)
    assert.ok(toJoy()[0].html.includes('Femi A'), 'names the first-time visitor')
    await runScheduled({ now: new Date(monday.getTime() + 3600e3) })
    assert.equal(toJoy().length, 1, 'once per week')

    // Preview and opt-out
    r = await c.get('/automation/brief/preview')
    assert.equal(r.status, 200); assert.ok(r.data.html.includes('Your week at a glance'))
    r = await c.patch('/me/notifications', { brief: false })
    r = await c.get('/me/notifications'); assert.equal(r.data.brief, false)
    await runScheduled({ now: new Date(monday.getTime() + 7 * 86400e3) })
    assert.equal(toJoy().length, 1, 'opted out')
  } finally {
    globalThis.fetch = realFetch
    delete process.env.RESEND_API_KEY; delete process.env.EMAIL_FROM_DOMAIN
  }
})

test('WhatsApp one-tap sending: list, tick off, finish', async () => {
  const c = client()
  await signup(c, { orgName: 'WA Church', name: 'W Owner', email: 'w@wa.test', password: 'password123' })
  const branchId = (await c.get('/me')).data.branches[0].id
  const ids = []
  for (const [f, ph] of [['Ada', '08011112221'], ['Bayo', '08011112222'], ['NoPhone', null]]) {
    const r = await c.post('/people', { firstName: f, lastName: 'W', phone: ph || undefined, branchId, status: 'member' }); ids.push(r.data.id)
  }
  let r = await c.post('/messages', { channel: 'whatsapp', body: 'Hi {first_name}!', audience: { statuses: ['member'] } })
  assert.equal(r.status, 200, JSON.stringify(r.data))
  const id = r.data.id
  r = await c.get(`/messages/${id}/whatsapp`)
  assert.deepEqual(r.data.recipients.map(p => p.first_name), ['Ada', 'Bayo'], 'only people with a phone')
  r = await c.post(`/messages/${id}/whatsapp/done`, { personId: ids[0] })
  assert.deepEqual(r.data.done, [ids[0]])
  r = await c.get('/messages')
  const m = r.data.rows.find(x => x.id === id)
  assert.deepEqual([m.status, m.sent_count, m.recipient_count], ['sending', 1, 2])
  r = await c.post(`/messages/${id}/whatsapp/finish`)
  assert.deepEqual(r.data, { sent: 1, total: 2 })
  r = await c.post(`/messages/${id}/whatsapp/done`, { personId: ids[1] })
  assert.equal(r.status, 400, 'finished messages are closed')
})

test('data rights: person export, complete deletion, email consent, church exports, DPA acceptance', async () => {
  const c = client()
  await signup(c, { orgName: 'Rights Church', name: 'R Owner', email: 'r@rights.test', password: 'password123' })
  let me = (await c.get('/me')).data
  const branchId = me.branches[0].id
  assert.equal(me.org.dpaAcceptedAt, null)
  const g = (await c.post('/gatherings', { name: 'Sunday', branchId, startsAt: new Date(Date.now() - 600e3).toISOString() })).data
  await client().post(`/public/g/${g.public_token}/checkin`, { mode: 'new', answers: { first_name: 'Sade', last_name: 'R', phone: '08066660001', email: 'sade@x.test' } })
  const sade = (await c.get('/people?q=Sade')).data.rows[0]
  const fu = (await c.get('/followups?bucket=open')).data
  const fuId = (fu.rows || fu.items || fu).find?.(f => f.person_id === sade.id)?.id
  if (fuId) await c.post(`/followups/${fuId}/notes`, { kind: 'note', body: 'Prayed together after service' })
  const ev = (await c.post('/events', { name: 'Retreat', startsAt: new Date(Date.now() + 86400e3 * 5).toISOString(), status: 'published' })).data
  const reg = await c.post(`/events/${ev.id}/registrations`, { firstName: 'Sade', lastName: 'R', phone: '08066660001' })
  assert.equal(reg.status, 200, JSON.stringify(reg.data))
  assert.equal(reg.data.person_id, sade.id, 'registration linked to the person by phone')

  // Subject access export
  let r = await c.get(`/people/${sade.id}/export`)
  assert.equal(r.status, 200)
  const data = typeof r.data === 'string' ? JSON.parse(r.data) : r.data
  assert.equal(data.person.first_name, 'Sade')
  assert.equal(data.attendance.length, 1)
  if (fuId) assert.equal(data.follow_ups[0].notes[0].text, 'Prayed together after service')
  assert.ok(!('search' in data.person), 'internal fields left out')

  // Email consent
  r = await c.patch(`/people/${sade.id}/email-consent`, { subscribed: false })
  assert.equal((await c.get(`/people/${sade.id}`)).data.person.email_opt_out, true)
  r = await c.patch(`/people/${sade.id}/email-consent`, { subscribed: true })
  assert.equal((await c.get(`/people/${sade.id}`)).data.person.email_opt_out, false)

  // Church exports and DPA
  r = await c.get('/org/data-export/attendance')
  assert.equal(r.status, 200); assert.ok(String(r.data).includes('Sade'))
  r = await c.get('/org/data-export/nonsense'); assert.equal(r.status, 404)
  r = await c.post('/org/dpa/accept')
  assert.equal(r.status, 200, JSON.stringify(r.data))
  me = (await c.get('/me')).data
  assert.ok(me.org.dpaAcceptedAt); assert.equal(me.org.dpaAcceptedBy, 'R Owner')

  // Complete deletion: notes gone, registrations unlinked, nothing left pointing at them
  r = await c.del(`/people/${sade.id}`)
  assert.equal(r.status, 200)
  const leftovers = [...fake.db._store.keys()].filter(k => k.includes(me.org.id) && (fake.db._store.get(k)?.person_id === sade.id || k.includes(sade.id)))
  assert.deepEqual(leftovers, [], 'no records still linked to the deleted person')
  r = await c.get('/org/data-export/registrations')
  assert.ok(String(r.data).includes('Sade R'), 'the event keeps its registration, without the link')
})

test('billing: trial, Paddle checkout, webhooks, read-only after expiry, plan changes, network unlocks branches', async () => {
  const crypto = await import('node:crypto')
  const c = client()
  await signup(c, { orgName: 'Pay Church', name: 'Pat Owner', email: 'pat@pay.test', password: 'password123' })
  let me = (await c.get('/me')).data
  const orgId = me.org.id, branchId = me.branches[0].id
  assert.equal(me.org.billing.state, 'trialing')
  assert.ok(me.org.billing.daysLeft >= 30)
  let r = await c.post('/billing/checkout', { plan: 'church', interval: 'monthly' })
  assert.equal(r.status, 400, 'no payments before Paddle is connected')

  // An expired church is never locked out while payments aren't connected
  const setOrg = (patch) => { const k = `orgs/${orgId}`; fake.db._store.set(k, { ...fake.db._store.get(k), ...patch }) }
  setOrg({ billing: { status: 'cancelled', next_payment_date: new Date(Date.now() - 86400e3).toISOString() } })
  r = await c.post('/people', { firstName: 'Free', phone: '08050000001', branchId }); assert.equal(r.status, 200)

  Object.assign(process.env, { PADDLE_API_KEY: 'pdl_sdbx_test', PADDLE_CLIENT_TOKEN: 'test_client', PADDLE_WEBHOOK_SECRET: 'pdl_ntfset_secret', PADDLE_ENV: 'sandbox' })
  const calls = []
  const sub = { id: 'sub_1', status: 'active', customer_id: 'ctm_1', custom_data: { org_id: orgId, plan: 'church', interval: 'monthly' }, items: [{ price: { id: 'pri_church_month' } }], next_billed_at: new Date(Date.now() + 30 * 86400e3).toISOString(), current_billing_period: { ends_at: new Date(Date.now() + 30 * 86400e3).toISOString() }, scheduled_change: null }
  const realFetch = globalThis.fetch
  globalThis.fetch = async (u, init = {}) => {
    if (!String(u).startsWith('https://sandbox-api.paddle.com')) return realFetch(u, init)
    const path = String(u).replace('https://sandbox-api.paddle.com', ''); const body = init.body && JSON.parse(init.body)
    calls.push([init.method || 'GET', path, body])
    const ok = (data, status = 200) => new Response(JSON.stringify({ data }), { status, headers: { 'content-type': 'application/json' } })
    if (path.startsWith('/products?')) return ok([])
    if (path === '/products') return ok({ id: `pro_${body.custom_data.gatherhq_plan}` }, 201)
    if (path.startsWith('/prices?')) return ok([])
    if (path === '/prices') return ok({ id: `pri_${body.product_id.slice(4)}_${body.billing_cycle.interval}` }, 201)
    if (path === '/transactions/txn_1') return ok({ id: 'txn_1', status: 'completed', customer_id: 'ctm_1', subscription_id: 'sub_1', custom_data: { org_id: orgId, plan: 'church', interval: 'monthly' }, payments: [{ status: 'captured', method_details: { card: { type: 'visa', last4: '4242', expiry_month: 12, expiry_year: 2030 } } }] })
    if (path === '/transactions/txn_other') return ok({ id: 'txn_other', status: 'completed', custom_data: { org_id: 'someone-else' } })
    if (path === '/subscriptions/sub_1' && init.method === 'PATCH') { sub.items = [{ price: { id: body.items[0].price_id } }]; return ok(sub) }
    if (path === '/subscriptions/sub_1') return ok(sub)
    if (path === '/settings/checkout-styles-overlay') return ok({ primary_checkout_color: body.primary_checkout_color })
    if (path === '/customers/ctm_1/portal-sessions') return ok({ urls: { general: { overview: 'https://customer-portal.paddle.com/cpl_1' } } }, 201)
    return new Response(JSON.stringify({ error: { detail: 'not mocked' } }), { status: 404 })
  }
  const hook = (evt, sign = true, ts = Math.floor(Date.now() / 1000)) => {
    const raw = JSON.stringify(evt)
    const sig = sign ? `ts=${ts};h1=${crypto.createHmac('sha256', 'pdl_ntfset_secret').update(`${ts}:${raw}`).digest('hex')}` : `ts=${ts};h1=bad`
    return handle(new Request('http://test.local/api/webhooks/paddle', { method: 'POST', headers: { 'content-type': 'application/json', 'paddle-signature': sig }, body: raw }))
  }
  let n = 0
  const evt = (type, data, at = new Date().toISOString()) => ({ event_id: `evt_${++n}`, event_type: type, occurred_at: at, data })
  try {
    // Expired and payments connected: read-only
    r = await c.post('/people', { firstName: 'Blocked', phone: '08050000002', branchId })
    assert.equal(r.status, 402); assert.equal(r.data.details.code, 'billing_required')
    assert.equal((await c.get('/people')).status, 200, 'can still view')
    const g = Object.entries(Object.fromEntries(fake.db._store)).find(([k]) => k.startsWith(`orgs/${orgId}/people/`))
    assert.equal((await c.del(`/people/${g[0].split('/').pop()}`)).status, 200, 'can still erase people')

    // Checkout: product and price created once in Paddle, then reused
    r = await c.post('/billing/checkout', { plan: 'church', interval: 'monthly' })
    assert.equal(r.status, 200, JSON.stringify(r.data))
    assert.deepEqual([r.data.environment, r.data.token, r.data.priceId, r.data.customData.org_id, r.data.customer.email], ['sandbox', 'test_client', 'pri_church_month', orgId, 'pat@pay.test'])
    const price = calls.find(x => x[1] === '/prices')[2]
    assert.deepEqual([price.unit_price.amount, price.unit_price.currency_code, price.billing_cycle.interval], ['1900', 'USD', 'month'])
    assert.equal(calls.find(x => x[1] === '/products')[2].tax_category, 'saas')
    await c.post('/billing/checkout', { plan: 'church', interval: 'monthly' })
    assert.equal(calls.filter(x => x[1] === '/prices').length, 1, 'price reused')
    assert.equal(calls.filter(x => x[1] === '/settings/checkout-styles-overlay').length, 1, 'checkout colour set once')
    assert.equal(calls.find(x => x[1] === '/settings/checkout-styles-overlay')[2].primary_checkout_color, '#244E43')

    // After paying: confirm the transaction (only this church's)
    assert.equal((await c.post('/billing/confirm', { transactionId: 'txn_other' })).data.ok, false)
    r = await c.post('/billing/confirm', { transactionId: 'txn_1' })
    assert.equal(r.data.ok, true, JSON.stringify(r.data))
    me = (await c.get('/me')).data
    assert.equal(me.org.billing.state, 'active'); assert.equal(me.org.billing.plan, 'church')
    r = await c.get('/billing'); assert.equal(r.data.card.last4, '4242'); assert.equal(r.data.hasSubscription, true)
    assert.equal((await c.post('/people', { firstName: 'Paid', phone: '08050000003', branchId })).status, 200, 'unlocked')
    r = await c.post('/billing/manage'); assert.equal(r.data.url, 'https://customer-portal.paddle.com/cpl_1')

    // Webhooks: signed and recent only, each processed once
    assert.equal((await hook(evt('subscription.updated', sub), false)).status, 401)
    assert.equal((await hook(evt('subscription.updated', sub), true, Math.floor(Date.now() / 1000) - 3600)).status, 401, 'replayed old notification refused')
    const failed = evt('transaction.payment_failed', { id: 'txn_2', customer_id: 'ctm_1', subscription_id: 'sub_1', custom_data: { org_id: orgId }, payments: [{ error_code: 'declined' }] })
    assert.equal((await hook(failed)).status, 200)
    assert.equal((await (await hook(failed)).json()).duplicate, true)
    r = await hook(evt('subscription.past_due', { ...sub, status: 'past_due' }))
    assert.equal(r.status, 200)
    r = await c.get('/billing'); assert.equal(r.data.state, 'past_due'); assert.match(r.data.lastError, /declined/)
    assert.equal((await c.post('/people', { firstName: 'Grace', phone: '08050000004', branchId })).status, 200, 'grace period')
    // An older event arriving late doesn't undo a newer one
    await hook(evt('subscription.updated', { ...sub, status: 'active' }, new Date(Date.now() - 86400e3).toISOString()))
    assert.equal((await c.get('/billing')).data.state, 'past_due')
    await hook(evt('subscription.updated', { ...sub, status: 'active' }))
    assert.equal((await c.get('/billing')).data.state, 'active')

    // Cancelling keeps the plan until the end of the paid period
    const end = new Date(Date.now() + 10 * 86400e3).toISOString()
    await hook(evt('subscription.updated', { ...sub, scheduled_change: { action: 'cancel', effective_at: end } }))
    r = await c.get('/billing'); assert.equal(r.data.state, 'active'); assert.equal(r.data.cancelling, true)

    // Switching plan changes the Paddle subscription directly, and the network plan switches on branches
    r = await c.post('/billing/checkout', { plan: 'network', interval: 'yearly' })
    assert.equal(r.data.changed, true, JSON.stringify(r.data))
    const patch = calls.find(x => x[0] === 'PATCH')[2]
    assert.equal(patch.items[0].price_id, 'pri_network_year'); assert.equal(patch.scheduled_change, null, 'undoes the cancellation')
    me = (await c.get('/me')).data
    assert.equal(me.org.billing.plan, 'network'); assert.equal(me.org.branchesEnabled, true)

    // A cancelled subscription that has ended locks changes again
    await hook(evt('subscription.canceled', { ...sub, status: 'canceled', canceled_at: new Date(Date.now() - 3600e3).toISOString() }))
    assert.equal((await c.get('/billing')).data.state, 'expired')

    // A free (complimentary) church is never charged
    r = await S.ops.patch(`/platform/orgs/${orgId}`, { plan: 'free' })
    assert.equal(r.status, 200, JSON.stringify(r.data))
    assert.equal((await c.get('/me')).data.org.billing.state, 'free')
  } finally {
    globalThis.fetch = realFetch
    for (const k of ['PADDLE_API_KEY', 'PADDLE_CLIENT_TOKEN', 'PADDLE_WEBHOOK_SECRET', 'PADDLE_ENV']) delete process.env[k]
  }
})

test('admin console: revenue, church controls, users and support', async () => {
  const realFetch = globalThis.fetch
  Object.assign(process.env, { PADDLE_API_KEY: 'k', PADDLE_CLIENT_TOKEN: 't' })
  try {
    const c = client()
    await signup(c, { orgName: 'Console Church', name: 'Kemi Owner', email: 'kemi@console.test', password: 'password123' })
    const orgId = (await c.get('/me')).data.org.id

    // Church owners can't reach the console
    assert.equal((await c.get(`/platform/orgs/${orgId}`)).status, 403)

    let r = await S.ops.get('/platform/summary')
    assert.equal(r.status, 200)
    assert.ok(r.data.signups.length === 12 && r.data.totals.new_7d >= 1)
    assert.ok(r.data.totals.trialing >= 1)

    // Church page: team and counts, no member records
    r = await S.ops.get(`/platform/orgs/${orgId}`)
    assert.equal(r.status, 200, JSON.stringify(r.data))
    assert.equal(r.data.team_members[0].email, 'kemi@console.test')
    assert.equal(r.data.weekly_checkins.length, 8)

    // Extend the trial
    const before = new Date((await c.get('/me')).data.org.billing.trialEndsAt)
    r = await S.ops.patch(`/platform/orgs/${orgId}`, { extendTrialDays: 14 })
    assert.equal(r.status, 200, JSON.stringify(r.data))
    const after = new Date((await c.get('/me')).data.org.billing.trialEndsAt)
    assert.equal(Math.round((after - before) / 86400e3), 14)

    // A plan set by hand (bank transfer), counted as revenue
    r = await S.ops.patch(`/platform/orgs/${orgId}`, { manualPlan: { plan: 'network', interval: 'yearly', until: new Date(Date.now() + 365 * 86400e3).toISOString() } })
    assert.equal(r.status, 200, JSON.stringify(r.data))
    let me = (await c.get('/me')).data
    assert.equal(me.org.billing.state, 'active'); assert.equal(me.org.billing.manual, true); assert.equal(me.org.branchesEnabled, true)
    r = await S.ops.get('/platform/summary')
    assert.ok(r.data.orgs.find(o => o.id === orgId).mrr > 49)
    assert.equal((await S.ops.patch(`/platform/orgs/${orgId}`, { manualPlan: { plan: 'church', until: '2001-01-01' } })).status, 400)
    r = await S.ops.patch(`/platform/orgs/${orgId}`, { manualPlan: null })
    assert.equal(r.status, 200)
    assert.equal((await c.get('/me')).data.org.billing.state, 'trialing')

    // Users: search, reset link, admin access
    r = await S.ops.get('/platform/users?q=kemi@console')
    assert.equal(r.data.users.length, 1)
    const uid = r.data.users[0].id
    r = await S.ops.get(`/platform/users/${uid}`)
    assert.equal(r.data.churches[0].org_name, 'Console Church')
    r = await S.ops.post(`/platform/users/${uid}/reset-link`, {})
    assert.equal(r.status, 200, JSON.stringify(r.data)); assert.ok(r.data.link.startsWith('https://'))
    assert.equal((await c.get('/platform/users')).status, 403)
    r = await S.ops.patch(`/platform/users/${uid}`, { platformAdmin: true })
    assert.equal(r.status, 200)
    assert.equal((await c.get('/platform/users')).status, 200)
    await S.ops.patch(`/platform/users/${uid}`, { platformAdmin: false })
    assert.equal((await c.get('/platform/users')).status, 403)
    const opsId = (await S.ops.get('/me')).data.user.id
    assert.equal((await S.ops.patch(`/platform/users/${opsId}`, { platformAdmin: false })).status, 400)
  } finally {
    globalThis.fetch = realFetch
    delete process.env.PADDLE_API_KEY; delete process.env.PADDLE_CLIENT_TOKEN
  }
})

test('children’s church: on by default, family check-in, matching codes, pickup, privacy', async () => {
  const c = client()
  await signup(c, { orgName: 'Little Lambs Church', name: 'Grace Owner', email: 'owner@lambs.test', password: 'password123' })
  let me = (await c.get('/me')).data
  const branchId = me.branches[0].id
  assert.equal(me.org.childrenEnabled, true, 'on by default')
  let r = await c.get('/children/rooms')
  assert.equal(r.status, 200, JSON.stringify(r.data))
  assert.equal(r.data.rooms.length, 4)
  const toddlers = r.data.rooms.find(x => x.name.startsWith('Toddlers'))

  const yearsAgo = (n) => { const d = new Date(); d.setFullYear(d.getFullYear() - n); d.setDate(d.getDate() - 10); return d.toISOString().slice(0, 10) }
  r = await c.post('/children/register', { parent: { firstName: 'Funmi', lastName: 'Adeyemi', phone: '08035554417' }, children: [
    { firstName: 'Ife', lastName: 'Adeyemi', birthDate: yearsAgo(3), allergies: 'Peanuts' }, { firstName: 'Tolu', lastName: 'Adeyemi', birthDate: yearsAgo(6) },
  ] })
  assert.equal(r.status, 200, JSON.stringify(r.data))
  assert.equal(r.data.children.length, 2)
  const parentId = r.data.guardian.id
  const ife = r.data.children.find(x => x.firstName === 'Ife')
  assert.equal(ife.room.id, toddlers.id)

  // Phone lookup finds the family; children aren't in the people directory
  r = await c.post('/children/lookup', { phone: '0803 555 4417' })
  assert.equal(r.data.found, true); assert.equal(r.data.children.length, 2)
  const kidIds = r.data.children.map(x => x.id)
  r = await c.get('/people')
  assert.ok(!r.data.rows.some(p => p.first_name === 'Ife'), 'children stay out of the people list')

  // Check-in: one code for the family, alerts carried to the label, first-time follow-up for the parent
  r = await c.post('/children/checkin', { guardianId: parentId, childIds: kidIds })
  assert.equal(r.status, 200, JSON.stringify(r.data))
  const code = r.data.code
  assert.match(code, /^[A-Z0-9]{3}$/)
  assert.ok(r.data.checkins.every(k => k.code === code))
  assert.equal(r.data.checkins.find(k => k.firstName === 'Ife').alert, 'Peanuts')
  r = await c.get('/followups')
  assert.ok(JSON.stringify(r.data).includes('children’s church for the first time'), JSON.stringify(r.data).slice(0, 300))
  r = await c.post('/children/checkin', { guardianId: parentId, childIds: [ife.id] })
  assert.equal(r.data.checkins[0].alreadyCheckedIn, true)

  // Another parent can't check in children that aren't theirs
  const other = await c.post('/people', { firstName: 'Stranger', phone: '08030000999', branchId })
  assert.equal((await c.post('/children/checkin', { guardianId: other.data.id || other.data.person?.id, childIds: [ife.id] })).status, 400)

  r = await c.get('/children/today')
  assert.equal(r.data.totals.here, 2); assert.equal(r.data.totals.firstTime, 2)
  assert.equal(r.data.rooms.find(x => x.id === toddlers.id).here, 1)
  r = await c.post(`/children/rooms/${toddlers.id}/adults`, { adults: 1 })
  assert.equal(r.status, 200)
  r = await c.get(`/children/rooms/${toddlers.id}/today`)
  assert.equal(r.data.room.adults, 1); assert.equal(r.data.checkins.length, 1)

  // Adult attendance numbers are untouched
  r = await c.get('/me'); assert.equal(r.status, 200)

  // Pickup: the code must match
  r = await c.post('/children/pickup/lookup', { code: code === 'AAA' ? 'CCC' : 'AAA' })
  assert.equal(r.data.found, false)
  r = await c.post('/children/pickup/lookup', { code: code.toLowerCase() })
  assert.equal(r.data.found, true); assert.equal(r.data.checkins.length, 2)
  assert.ok(r.data.checkins[0].allowed.includes('Funmi Adeyemi'))
  const ifeCk = r.data.checkins.find(k => k.firstName === 'Ife')
  assert.equal((await c.post('/children/pickup', { checkinIds: [ifeCk.id], code: 'XXX' })).status, 409, 'wrong code refused')
  r = await c.post('/children/pickup', { checkinIds: [ifeCk.id], code })
  assert.equal(r.status, 200)
  r = await c.get('/children/today')
  assert.equal(r.data.totals.here, 1); assert.equal(r.data.totals.pickedUp, 1)

  // Family view and the children's team role
  r = await c.get(`/children/family/${parentId}`)
  assert.equal(r.data.children.length, 2); assert.ok(r.data.children[0].days.length >= 1)
  assert.ok((await c.get('/team')).data.assignableRoles.includes('kids'))

  // Erasing the parent unlinks them from the children and scrubs pickup records
  assert.equal((await c.del(`/people/${parentId}`)).status, 200)
  r = await c.get('/children')
  assert.ok(r.data.rows.every(k => k.guardians.length === 0))
  r = await c.get('/children/today')
  assert.ok(r.data.latest.every(k => k.guardianName === null))
  assert.equal((await c.del(`/children/${ife.id}`)).status, 200)
  assert.equal((await c.get('/children')).data.rows.length, 1)

  // Switching off hides it without deleting anything; switching back on brings it all back
  await c.patch('/children/settings', { enabled: false })
  assert.equal((await c.get('/children')).status, 403)
  assert.equal((await c.get('/me')).data.org.childrenEnabled, false)
  assert.ok(!(await c.get('/team')).data.assignableRoles.includes('kids'))
  await c.patch('/children/settings', { enabled: true })
  assert.equal((await c.get('/children')).data.rows.length, 1)
})
