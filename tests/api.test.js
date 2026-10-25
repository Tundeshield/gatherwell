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
function client() {
  let cookie = ''
  const call = async (method, path, body, headers = {}) => {
    const init = { method, headers: { ...headers } }
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
  const r = await c.post('/auth/signup', body)
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
})

test('duplicate sign-up email is rejected; only valid Firebase tokens create sessions', async () => {
  const c = client()
  let r = await c.post('/auth/signup', { orgName: 'X', name: 'X', email: 'ada@grace.test', password: 'password123' })
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
  let r = await S.a.post('/gatherings', { name: 'Sunday Service', branchId: S.aBranch2, startsAt: new Date(Date.now() - 3600e3).toISOString() })
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
  assert.match(r.data.error, /nothing was sent/)
  // Usher overview only includes what they may see
  r = await S.usher.get('/overview')
  assert.equal(r.status, 200)
  assert.equal(r.data.followups, undefined)
  assert.equal(r.data.people, undefined)
})

test('platform admin area is separate from church ownership', async () => {
  let r = await S.a.get('/platform/summary')
  assert.equal(r.status, 403)
  const ops = client()
  await signup(ops, { orgName: 'Ops Test', name: 'Ops', email: 'ops@gatherhq.test', password: 'password123' })
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
