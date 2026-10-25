// Unauthenticated endpoints reached from QR codes and shared links.
// They never return member directories, internal IDs of people, or contact details.
import { one, tx } from '../db.js'
import { bad, notFound, conflict, clientIp, str } from '../http.js'
import { rateLimit, normalizePhone, maskName, validateAnswers } from '../util.js'
import { recordCheckin } from '../domain.js'
import { createRegistration, eventStats } from './events.js'

const fold = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').trim().toLowerCase()

async function loadPublicGathering(token) {
  const g = await one(`SELECT g.*, b.name AS branch_name, o.name AS org_name, o.settings AS org_settings, o.status AS org_status, o.timezone AS org_tz
                         FROM gatherings g JOIN branches b ON b.id = g.branch_id JOIN organisations o ON o.id = g.org_id
                        WHERE g.public_token = $1`, [String(token).slice(0, 40)])
  if (!g || g.org_status !== 'active' || g.status === 'draft') throw notFound('This check-in link is not valid. Please ask an usher for help.')
  return g
}

function assertOpen(g) {
  if (g.status !== 'open') throw bad(g.status === 'scheduled' ? 'Check-in has not opened yet.' : 'Check-in for this session has closed. Please see an usher.')
}

export default function (r) {
  r.get('/public/g/:token', { auth: 'public' }, async ({ params }) => {
    const g = await loadPublicGathering(params.token)
    return {
      orgName: g.org_name, branchName: g.branch_name, timezone: g.org_tz,
      gathering: { name: g.name, startsAt: g.starts_at, status: g.status, description: g.description },
      form: g.form,
    }
  })

  // Step 1 of returning check-in: phone → whether we recognise it, with a masked name hint only.
  r.post('/public/g/:token/lookup', { auth: 'public' }, async ({ req, params, body }) => {
    await rateLimit(`lookup:${clientIp(req)}`, 30, 600)
    const g = await loadPublicGathering(params.token)
    assertOpen(g)
    const phoneNorm = normalizePhone(body.phone, g.org_settings?.defaultCountryCode)
    if (!phoneNorm) throw bad('Please enter a valid phone number.')
    const p = await one(`SELECT id, first_name, last_name FROM people WHERE org_id = $1 AND phone_norm = $2 AND status <> 'archived'`, [g.org_id, phoneNorm])
    if (!p) return { found: false }
    // Whether they're already checked in is only revealed after the first-name confirmation.
    return { found: true, hint: maskName(p.first_name, p.last_name) }
  })

  r.post('/public/g/:token/checkin', { auth: 'public' }, async ({ req, params, body }) => {
    await rateLimit(`checkin:${clientIp(req)}`, 40, 600)
    const g = await loadPublicGathering(params.token)
    assertOpen(g)
    const org = { id: g.org_id, settings: g.org_settings }
    const cc = g.org_settings?.defaultCountryCode

    if (body.mode === 'returning') {
      const phoneNorm = normalizePhone(body.phone, cc)
      if (!phoneNorm) throw bad('Please enter a valid phone number.')
      await rateLimit(`confirm:${g.id}:${phoneNorm}`, 5, 900)
      const p = await one(`SELECT id, first_name FROM people WHERE org_id = $1 AND phone_norm = $2 AND status <> 'archived'`, [g.org_id, phoneNorm])
      // Second factor: the first name must match the record for that phone.
      if (!p || fold(p.first_name) !== fold(body.firstName)) throw bad("That name doesn't match our records for this number. Check the spelling, or ask an usher.")
      const res = await tx((c) => recordCheckin(c, { org, gathering: g, personId: p.id, method: 'qr' }))
      return { ok: true, firstName: p.first_name, alreadyCheckedIn: res.alreadyCheckedIn, firstTime: res.firstTime }
    }

    // New visitor.
    const { answers, errors } = validateAnswers(g.form || [], body.answers || {})
    if (Object.keys(errors).length) throw bad('Please check the highlighted fields.', { fields: errors })
    const phoneNorm = normalizePhone(answers.phone, cc)
    if (!phoneNorm) throw bad('Please check the highlighted fields.', { fields: { phone: 'Enter a valid phone number.' } })
    const first = str(answers.first_name, { required: true, max: 80, name: 'First name' })
    const exists = await one(`SELECT first_name, last_name FROM people WHERE org_id = $1 AND phone_norm = $2`, [g.org_id, phoneNorm])
    if (exists) throw conflict('This phone number is already registered with us.', { code: 'exists', hint: maskName(exists.first_name, exists.last_name) })

    const extra = {}
    for (const f of g.form || []) if (!f.core && answers[f.id] !== undefined) extra[f.id] = answers[f.id]
    const res = await tx(async (c) => {
      const p = await c.one(`INSERT INTO people (org_id, branch_id, first_name, last_name, phone, phone_norm, email, status, source)
                             VALUES ($1,$2,$3,$4,$5,$6,$7,'visitor','checkin') RETURNING id`,
        [g.org_id, g.branch_id, first, str(answers.last_name, { max: 80 }), str(answers.phone, { max: 40 }), phoneNorm,
          answers.email ? String(answers.email).toLowerCase().slice(0, 254) : null])
      return recordCheckin(c, { org, gathering: g, personId: p.id, method: 'qr', answers: extra })
    })
    return { ok: true, firstName: first, firstTime: res.firstTime }
  })

  // --- events -----------------------------------------------------------------------
  r.get('/public/e/:token', { auth: 'public' }, async ({ params }) => {
    const e = await loadPublicEvent(params.token)
    const s = await eventStats(e.id)
    return {
      orgName: e.org_name, branchName: e.branch_name, timezone: e.org_tz,
      event: {
        name: e.name, description: e.description, location: e.location, startsAt: e.starts_at, endsAt: e.ends_at, status: e.status,
        registrationOpensAt: e.registration_opens_at, registrationClosesAt: e.registration_closes_at,
        capacity: e.capacity, spotsLeft: e.capacity ? Math.max(0, e.capacity - s.registered) : null,
      },
      registration: registrationState(e),
      form: e.form,
    }
  })

  r.post('/public/e/:token/register', { auth: 'public' }, async ({ req, params, body }) => {
    await rateLimit(`register:${clientIp(req)}`, 20, 600)
    const e = await loadPublicEvent(params.token)
    const state = registrationState(e)
    if (state !== 'open') throw bad(state === 'not_yet' ? 'Registration has not opened yet.' : 'Registration for this event is closed.')
    const { answers, errors } = validateAnswers(e.form || [], body.answers || {})
    if (Object.keys(errors).length) throw bad('Please check the highlighted fields.', { fields: errors })
    const name = [answers.first_name, answers.last_name].filter(Boolean).join(' ').trim()
    if (!name) throw bad('Please check the highlighted fields.', { fields: { first_name: 'First name is required.' } })
    const extra = {}
    for (const f of e.form || []) if (!f.core && answers[f.id] !== undefined) extra[f.id] = answers[f.id]
    const reg = await tx((c) => createRegistration(c, {
      event: e, orgSettings: e.org_settings, name: name.slice(0, 160), phone: answers.phone || null,
      email: answers.email ? String(answers.email).toLowerCase() : null, answers: extra,
    }))
    return { ok: true, code: reg.code, status: reg.status, name: reg.name }
  })
}

async function loadPublicEvent(token) {
  const e = await one(`SELECT e.*, b.name AS branch_name, o.name AS org_name, o.settings AS org_settings, o.status AS org_status, o.timezone AS org_tz
                         FROM events e LEFT JOIN branches b ON b.id = e.branch_id JOIN organisations o ON o.id = e.org_id
                        WHERE e.public_token = $1`, [String(token).slice(0, 40)])
  if (!e || e.org_status !== 'active' || e.status === 'draft') throw notFound('This event link is not valid.')
  return e
}

function registrationState(e) {
  if (e.status === 'cancelled') return 'cancelled'
  if (e.status === 'postponed') return 'postponed'
  if (e.status === 'completed') return 'closed'
  const now = new Date()
  if (e.registration_opens_at && new Date(e.registration_opens_at) > now) return 'not_yet'
  if (e.registration_closes_at && new Date(e.registration_closes_at) < now) return 'closed'
  if (new Date(e.ends_at || e.starts_at) < now) return 'closed'
  return 'open'
}
