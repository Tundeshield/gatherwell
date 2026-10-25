// Unauthenticated endpoints reached from QR codes and shared links.
// They never return member directories, internal IDs of people, or contact details.
import { fb, col, plain } from '../firebase.js'
import { bad, notFound, conflict, clientIp, str } from '../http.js'
import { rateLimit, normalizePhone, maskName, validateAnswers } from '../util.js'
import { recordCheckin } from '../domain.js'
import { createPerson } from './people.js'
import { createRegistration, eventStats } from './events.js'

const fold = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').trim().toLowerCase()

async function resolveLink(token, kind) {
  const { db } = await fb()
  const t = String(token || '').slice(0, 40)
  if (!/^[A-Za-z0-9]{6,40}$/.test(t)) return null
  const link = (await db.collection('publicLinks').doc(t).get()).data()
  if (!link || link.kind !== kind) return null
  const [os, rs] = await db.getAll(db.collection('orgs').doc(link.org_id), col(db, link.org_id, kind === 'gathering' ? 'gatherings' : 'events').doc(link.ref_id))
  if (!os.exists || !rs.exists || os.data().status !== 'active') return null
  const org = { id: os.id, ...os.data() }
  const item = { id: rs.id, ...rs.data() }
  let branchName = null
  if (item.branch_id) branchName = (await col(db, org.id, 'branches').doc(item.branch_id).get()).data()?.name || null
  return { db, org, item, branchName }
}

async function loadPublicGathering(token) {
  const r = await resolveLink(token, 'gathering')
  if (!r || r.item.status === 'draft') throw notFound('This check-in link is not valid. Please ask an usher for help.')
  return r
}

function assertOpen(g) {
  if (g.status !== 'open') throw bad(g.status === 'scheduled' ? 'Check-in has not opened yet.' : 'Check-in for this session has closed. Please see an usher.')
}

async function findByPhone(db, orgId, phoneNorm) {
  const ph = (await col(db, orgId, 'phones').doc(phoneNorm).get()).data()
  if (!ph) return null
  const p = await col(db, orgId, 'people').doc(ph.person_id).get()
  return p.exists && p.data().status !== 'archived' ? { id: p.id, ...p.data() } : null
}

export default function (r) {
  r.get('/public/g/:token', { auth: 'public' }, async ({ params }) => {
    const { org, item: g, branchName } = await loadPublicGathering(params.token)
    return {
      orgName: org.name, branchName, timezone: org.timezone,
      gathering: { name: g.name, startsAt: plain(g.starts_at), status: g.status, description: g.description || null },
      form: g.form,
    }
  })

  // Step 1 of returning check-in: phone → whether we recognise it, with a masked name hint only.
  // Whether they're already checked in is only revealed after the first-name confirmation.
  r.post('/public/g/:token/lookup', { auth: 'public' }, async ({ req, params, body }) => {
    await rateLimit(`lookup:${clientIp(req)}`, 30, 600)
    const { db, org, item: g } = await loadPublicGathering(params.token)
    assertOpen(g)
    const phoneNorm = normalizePhone(body.phone, org.settings?.defaultCountryCode)
    if (!phoneNorm) throw bad('Please enter a valid phone number.')
    const p = await findByPhone(db, org.id, phoneNorm)
    if (!p) return { found: false }
    return { found: true, hint: maskName(p.first_name, p.last_name) }
  })

  r.post('/public/g/:token/checkin', { auth: 'public' }, async ({ req, params, body }) => {
    await rateLimit(`checkin:${clientIp(req)}`, 40, 600)
    const { db, org, item: g } = await loadPublicGathering(params.token)
    assertOpen(g)
    const cc = org.settings?.defaultCountryCode

    if (body.mode === 'returning') {
      const phoneNorm = normalizePhone(body.phone, cc)
      if (!phoneNorm) throw bad('Please enter a valid phone number.')
      await rateLimit(`confirm:${g.id}:${phoneNorm}`, 5, 900)
      const p = await findByPhone(db, org.id, phoneNorm)
      // Second factor: the first name must match the record for that phone.
      if (!p || fold(p.first_name) !== fold(body.firstName)) throw bad("That name doesn't match our records for this number. Check the spelling, or ask an usher.")
      const res = await recordCheckin({ org, gathering: g, personId: p.id, method: 'qr' })
      return { ok: true, firstName: p.first_name, alreadyCheckedIn: res.alreadyCheckedIn, firstTime: res.firstTime }
    }

    // New visitor.
    const { answers, errors } = validateAnswers(g.form || [], body.answers || {})
    if (Object.keys(errors).length) throw bad('Please check the highlighted fields.', { fields: errors })
    const phoneNorm = normalizePhone(answers.phone, cc)
    if (!phoneNorm) throw bad('Please check the highlighted fields.', { fields: { phone: 'Enter a valid phone number.' } })
    const first = str(answers.first_name, { required: true, max: 80, name: 'First name' })
    const extra = {}
    for (const f of g.form || []) if (!f.core && answers[f.id] !== undefined) extra[f.id] = answers[f.id]
    let person
    try {
      person = await createPerson({ org }, {
        first_name: first, last_name: str(answers.last_name, { max: 80 }), phone: str(answers.phone, { max: 40 }), phone_norm: phoneNorm,
        email: answers.email ? String(answers.email).toLowerCase().slice(0, 254) : null, status: 'visitor',
      }, { branch_id: g.branch_id, source: 'checkin' })
    } catch (e) {
      if (e.status === 409) {
        const ex = await findByPhone(db, org.id, phoneNorm)
        throw conflict('This phone number is already registered with us.', { code: 'exists', hint: ex ? maskName(ex.first_name, ex.last_name) : '•••' })
      }
      throw e
    }
    const res = await recordCheckin({ org, gathering: g, personId: person.id, method: 'qr', answers: extra })
    return { ok: true, firstName: first, firstTime: res.firstTime }
  })

  // --- events -----------------------------------------------------------------------
  r.get('/public/e/:token', { auth: 'public' }, async ({ params }) => {
    const res = await resolveLink(params.token, 'event')
    if (!res || res.item.status === 'draft') throw notFound('This event link is not valid.')
    const { org, item: e, branchName } = res
    const s = eventStats(e)
    return {
      orgName: org.name, branchName, timezone: org.timezone,
      event: {
        name: e.name, description: e.description, location: e.location, startsAt: plain(e.starts_at), endsAt: plain(e.ends_at), status: e.status,
        registrationOpensAt: plain(e.registration_opens_at), registrationClosesAt: plain(e.registration_closes_at),
        capacity: e.capacity, spotsLeft: e.capacity ? Math.max(0, e.capacity - s.registered) : null,
      },
      registration: registrationState(e),
      form: e.form,
    }
  })

  r.post('/public/e/:token/register', { auth: 'public' }, async ({ req, params, body }) => {
    await rateLimit(`register:${clientIp(req)}`, 20, 600)
    const res = await resolveLink(params.token, 'event')
    if (!res || res.item.status === 'draft') throw notFound('This event link is not valid.')
    const { org, item: e } = res
    const state = registrationState(e)
    if (state !== 'open') throw bad(state === 'not_yet' ? 'Registration has not opened yet.' : 'Registration for this event is closed.')
    const { answers, errors } = validateAnswers(e.form || [], body.answers || {})
    if (Object.keys(errors).length) throw bad('Please check the highlighted fields.', { fields: errors })
    const name = [answers.first_name, answers.last_name].filter(Boolean).join(' ').trim()
    if (!name) throw bad('Please check the highlighted fields.', { fields: { first_name: 'First name is required.' } })
    const extra = {}
    for (const f of e.form || []) if (!f.core && answers[f.id] !== undefined) extra[f.id] = answers[f.id]
    const reg = await createRegistration({ orgId: org.id, event: e, orgSettings: org.settings, name: name.slice(0, 160), phone: answers.phone || null,
      email: answers.email ? String(answers.email).toLowerCase() : null, answers: extra })
    return { ok: true, code: reg.code, status: reg.status, name: reg.name }
  })
}

function registrationState(e) {
  if (e.status === 'cancelled') return 'cancelled'
  if (e.status === 'postponed') return 'postponed'
  if (e.status === 'completed') return 'closed'
  const now = new Date()
  const d = (v) => (v ? (v.toDate ? v.toDate() : new Date(v)) : null)
  if (e.registration_opens_at && d(e.registration_opens_at) > now) return 'not_yet'
  if (e.registration_closes_at && d(e.registration_closes_at) < now) return 'closed'
  if (d(e.ends_at || e.starts_at) < now) return 'closed'
  return 'open'
}
