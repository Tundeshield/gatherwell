// SMS setup, usage, credit purchases, provider webhooks, and the GatherHQ team's provider console.
import { fb, col, plain, toDate } from '../firebase.js'
import { bad, notFound, forbidden, str, oneOf, json } from '../http.js'
import { requireCap } from '../access.js'
import { audit, rateLimit } from '../util.js'
import { countryOf, countryName, smsInfo, WHATSAPP_AUTOMATION, DEFAULT_QUIET } from '../../shared/comms.js'
import { isProduction } from '../env.js'
import { siteOrigin } from '../email.js'
import { billingEnabled, startCreditCheckout } from '../billing.js'
import { channelStatus, platformConfig, clearConfigCache, smsCountries } from '../comms/providers.js'
import { packs, ledger, monthUsage, balanceOf } from '../comms/credits.js'
import { SMS_ADAPTERS, credentialStatus, saveCredentials, canStoreSecrets, credentials, health, checkHookToken, cleanSenderName, routeForCountry, errorText } from '../comms/sms.js'
import { smsSenders, providerReport, smsInbound } from '../comms/engine.js'

const iso = (v) => (v ? toDate(v).toISOString() : null)
const stagingOnly = () => { if (isProduction()) throw forbidden('This is only available on staging.') }
const CC = /^[A-Z]{2}$/

// Church-facing ledger entry: no provider names or provider costs.
const entryOut = (e) => ({ id: e.id, type: e.type, amount: e.amount, currency: e.currency || 'USD', balance_after: e.balance_after, description: e.description || e.note || null,
  country: e.country || null, segments: e.segments || null, actual_cost: e.actual_cost ?? null, message_id: e.message_id || null, created_at: iso(e.created_at), test: !!e.test })

export default function (r) {
  // --- church: SMS setup by country -----------------------------------------------------------
  async function smsSetup(ctx) {
    const { db } = await fb()
    const cfg = (await platformConfig()).sms
    const [qs, senders, live] = await Promise.all([col(db, ctx.org.id, 'people').where('status', 'in', ['visitor', 'member']).limit(3000).get(), smsSenders(db, ctx.org.id), smsCountries()])
    const counts = {}
    for (const d of qs.docs) { const p = d.data(); if (p.phone_norm) { const c = countryOf(p.phone_norm); counts[c] = counts[c] || { people: 0, consented: 0 }; counts[c].people++; if (p.consent?.sms?.status === 'granted') counts[c].consented++ } }
    const home = countryOf(String(ctx.org.settings?.defaultCountryCode || '')) // the church's own country, if known
    const list = [...new Set([...Object.keys(counts), ...Object.keys(senders), ...(home !== 'OTHER' ? [home] : [])])]
    const rows = []
    for (const cc of list) {
      const offered = live[cc] || []
      const needsRegistration = offered.length > 0 && offered.every(o => o.registration === 'required' && !(o.senderTypes || []).includes('provider'))
      const s = senders[cc] || null
      const route = cc === 'OTHER' ? { candidates: [], reason: 'unsupported_country' } : await routeForCountry(cfg, ctx.org, senders, cc, { category: 'utility' })
      const best = route.candidates[0]
      const state = !offered.length ? 'unsupported' : route.candidates.length ? 'ready' : route.reason === 'sender_pending' ? 'pending' : route.reason === 'sender_rejected' ? 'rejected' : route.reason === 'provider_down' ? 'issue' : 'needs_sender'
      rows.push({ country: cc, name: countryName(cc), people: counts[cc]?.people || 0, consented: counts[cc]?.consented || 0, state, needsRegistration,
        price: best ? best.unit : null, senderType: best?.senderType || null, from: best?.senderType === 'alpha' ? best.from : null, twoWay: !!best?.cap?.twoWay,
        sender: s ? { value: s.value, type: s.type || 'alpha', status: s.status, note: s.note || null, submitted_at: iso(s.submitted_at) } : null })
    }
    rows.sort((a, b) => (b.country === home) - (a.country === home) || b.people - a.people)
    return rows
  }

  r.get('/comms/channels', async ({ ctx }) => {
    requireCap(ctx, 'messages.manage')
    const { db } = await fb()
    const cfg = await platformConfig()
    const [entries, usage, packList, setup, channels, blocked, paused] = await Promise.all([
      ledger(ctx.org.id, 40), monthUsage(ctx.org.id), packs(), smsSetup(ctx), channelStatus(ctx.org),
      col(db, ctx.org.id, 'enrolments').where('blocked', '==', 'credits').limit(200).get(),
      col(db, ctx.org.id, 'messages').where('status', '==', 'paused').get(),
    ])
    const avg = usage.sms.count ? usage.sms.cost / usage.sms.count : (setup.find(x => x.price)?.price || 0)
    return {
      channels, timezone: ctx.org.timezone || 'UTC', staging: !isProduction(), whatsappAutomation: WHATSAPP_AUTOMATION,
      quiet: { start: Number(ctx.org.settings?.quietStart ?? DEFAULT_QUIET.start), end: Number(ctx.org.settings?.quietEnd ?? DEFAULT_QUIET.end) },
      emailLimit: Number(process.env.EMAIL_DAILY_LIMIT || 2000),
      credits: { balance: balanceOf(ctx.org), packs: packList, purchases: billingEnabled(), placeholder: !!cfg.sms.placeholder, level: ctx.org.credits?.alert_level || 0, lowAlerts: cfg.sms.lowAlerts, taxPct: cfg.sms.taxPct || 0,
        capacity: avg > 0 ? Math.floor(balanceOf(ctx.org) / avg) : null, resumeWindowHours: cfg.sms.resumeWindowHours },
      sms: { setup, senderName: ctx.org.sms_sender || cleanSenderName(ctx.org.name) },
      usage: { month: usage.sms, byCountry: Object.entries(usage.byCountry).map(([cc, x]) => ({ country: cc, name: countryName(cc), ...x })) },
      ledger: entries.map(entryOut),
      resume: {
        journeys: blocked.docs.map(d => ({ id: d.id, person: d.data().person_name, workflow: d.data().workflow_name, since: iso(d.data().blocked_since) })),
        messages: paused.docs.filter(d => d.data().pause_reason === 'credits').map(d => ({ id: d.id, title: d.data().subject || d.data().body?.slice(0, 60), remaining: Math.max(0, (d.data().recipient_count || 0) - (d.data().sent_count || 0) - (d.data().failed_count || 0)) })),
      },
    }
  })

  // Recent texts and their outcomes, explained in plain words.
  r.get('/comms/usage', async ({ ctx }) => {
    requireCap(ctx, 'messages.manage')
    const { db } = await fb()
    const qs = await col(db, ctx.org.id, 'deliveries').where('channel', '==', 'sms').limit(400).get()
    const rows = qs.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => toDate(b.created_at) - toDate(a.created_at)).slice(0, 100)
    return { rows: rows.map(x => ({ id: x.id, name: x.name, country: x.country, countryName: countryName(x.country), status: x.status, segments: x.segments || null, cost: x.cost || 0, error: x.error || null, at: iso(x.sent_at || x.created_at), message_id: x.message_id || null, workflow: !!x.enrolment_id })) }
  })

  // The sender name a church asks to use in one country.
  r.post('/comms/sms/senders', async ({ ctx, body }) => {
    requireCap(ctx, 'org.manage')
    const country = String(body.country || '').toUpperCase()
    if (!CC.test(country)) throw bad('Choose a country.')
    const value = cleanSenderName(body.value)
    if (value.length < 3) throw bad('Sender names are 3 to 11 letters or numbers, for example GRACECHURCH.', { fields: { value: 'Use 3 to 11 letters or numbers.' } })
    const live = (await smsCountries())[country] || []
    const needs = live.some(o => o.registration === 'required')
    const { db } = await fb()
    const ref = col(db, ctx.org.id, 'smsSenders').doc(country)
    const cur = (await ref.get()).data()
    if (cur?.status === 'approved' && cur.value === value) return { ok: true, status: 'approved' }
    const data = { country, type: 'alpha', value, status: needs ? 'pending' : 'approved', approved_for: [], note: str(body.note, { max: 300 }) || null, submitted_at: new Date(), submitted_by: ctx.user.name, updated_at: new Date() }
    await ref.set(data)
    if (needs) await db.collection('smsSenderRequests').doc(`${ctx.org.id}_${country}`).set({ org_id: ctx.org.id, org_name: ctx.org.name, country, value, status: 'pending', submitted_at: new Date(), contact: ctx.user.email })
    await audit(ctx, 'sms.sender_requested', 'organisation', ctx.org.id, { country, value })
    return { ok: true, status: data.status }
  })

  // --- church: buying credit (Stripe Checkout, one-off payment) -----------------------------
  r.post('/comms/credits/checkout', async ({ ctx, body, url }) => {
    requireCap(ctx, 'org.manage')
    if (!billingEnabled()) throw bad('Buying credit isn’t switched on yet.')
    const list = await packs()
    const amount = Number(body.amount)
    if (!list.includes(amount)) throw bad('Choose one of the credit amounts.')
    await rateLimit(`credits:${ctx.org.id}`, 20, 3600)
    const res = await startCreditCheckout({ org: ctx.org, user: ctx.user, amount, origin: siteOrigin(url) })
    await audit(ctx, 'credits.checkout_started', 'organisation', ctx.org.id, { amount })
    return res
  })

  // --- provider webhooks: delivery reports and incoming texts --------------------------------
  r.post('/webhooks/sms/:provider', { auth: 'public', form: true }, async ({ req, url, params }) => {
    const id = String(params.provider)
    const a = SMS_ADAPTERS[id]
    if (!a || !checkHookToken(id, url.searchParams.get('t'))) return json({ error: 'Not found.' }, 404)
    const raw = (await req.text()).slice(0, 100000)
    const ct = req.headers.get('content-type') || ''
    let form = {}, parsed = null
    if (ct.includes('json')) { try { parsed = JSON.parse(raw) } catch { return json({ error: 'Invalid JSON.' }, 400) } }
    else form = Object.fromEntries(new URLSearchParams(raw))
    const fullUrl = `${siteOrigin(url)}${url.pathname}${url.search}`
    if (!a.verify({ raw, headers: req.headers, url: fullUrl, form, json: parsed }, await credentials(id))) return json({ error: 'Invalid signature.' }, 401)
    // Each provider event is applied once.
    const { db } = await fb()
    const { createHash } = await import('node:crypto')
    try { await db.collection('smsEvents').doc(`${id}_${createHash('sha256').update(raw).digest('hex').slice(0, 40)}`).create({ provider: id, at: new Date() }) } catch { return json({ ok: true, duplicate: true }) }
    const { reports, inbound } = a.parse({ form, json: parsed })
    for (const x of reports) await providerReport(id, x.providerId, x.status, x.error)
    for (const m of inbound) await smsInbound(m.from, m.text)
    return json({ ok: true })
  })

  // --- staging helpers ----------------------------------------------------------------------
  r.post('/comms/simulate/sender/:country', async ({ ctx, params, body }) => {
    stagingOnly(); requireCap(ctx, 'messages.manage')
    const { db } = await fb()
    const ref = col(db, ctx.org.id, 'smsSenders').doc(String(params.country).toUpperCase().slice(0, 2))
    if (!(await ref.get()).exists) throw notFound('No sender name for that country.')
    const status = oneOf(body.status, ['approved', 'rejected'], { fallback: 'approved' })
    await ref.update({ status, approved_for: [], note: status === 'rejected' ? 'Rejected (simulated).' : null, decided_at: new Date() })
    await db.collection('smsSenderRequests').doc(`${ctx.org.id}_${ref.id}`).set({ status, decided_at: new Date() }, { merge: true })
    return { ok: true }
  })
  // A delivery report as a provider would send it, through the real report path.
  r.post('/comms/simulate/sms-report/:id', async ({ ctx, params, body }) => {
    stagingOnly(); requireCap(ctx, 'messages.manage')
    const { db } = await fb()
    const d = (await col(db, ctx.org.id, 'deliveries').doc(String(params.id).slice(0, 200)).get()).data()
    if (!d?.provider_id) throw bad('That text has no provider reference.')
    return { ok: await providerReport(d.provider, d.provider_id, oneOf(body.status, ['delivered', 'failed'], { fallback: 'delivered' }), body.status === 'failed' ? errorText('unreachable') : null) }
  })
  r.post('/comms/simulate/sms-inbound', async ({ ctx, body }) => {
    stagingOnly(); requireCap(ctx, 'messages.manage')
    return smsInbound(String(body.from || ''), str(body.text, { max: 500, required: true, name: 'Text' }))
  })

  // --- GatherHQ team: providers, routing, credentials, health ---------------------------------
  async function platformSms() {
    const { db } = await fb()
    const cfg = (await platformConfig({ fresh: true })).sms
    const hs = await health({ fresh: true })
    const providers = []
    for (const [id, a] of Object.entries(SMS_ADAPTERS)) {
      if (a.mock && isProduction()) continue
      const p = cfg.providers[id] || { enabled: false, countries: {} }
      providers.push({ id, label: a.label, mock: !!a.mock, enabled: !!p.enabled, billsFailed: a.billsFailed, credentials: await credentialStatus(id), available: a.available(await credentials(id)),
        health: hs[id] ? { failures: hs[id].consecutive_failures || 0, ok: hs[id].ok_count || 0, failed: hs[id].fail_count || 0, lastError: hs[id].last_error || null, lastErrorAt: iso(hs[id].last_error_at), lastOkAt: iso(hs[id].last_ok_at), downUntil: iso(hs[id].down_until) } : null,
        countries: p.countries || {} })
    }
    const requests = await db.collection('smsSenderRequests').where('status', '==', 'pending').limit(100).get()
    return { providers, routes: cfg.routes || {}, taxPct: cfg.taxPct || 0, lowAlerts: cfg.lowAlerts, resumeWindowHours: cfg.resumeWindowHours, placeholder: !!cfg.placeholder,
      canStoreSecrets: canStoreSecrets(), senderRequests: requests.docs.map(d => ({ id: d.id, ...plain(d.data()) })), packs: await packs() }
  }
  r.get('/platform/comms/sms', { auth: 'platform' }, async () => platformSms())

  const okNum = (v, max = 5) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max
  const TYPES = ['alpha', 'number', 'shortcode', 'provider']
  function cleanCap(c = {}) {
    if (!okNum(c.rate) || (c.surcharge != null && !okNum(c.surcharge)) || (c.cost != null && !okNum(c.cost))) throw bad('Rates must be numbers between 0 and 5 (US dollars per text segment).')
    const senderTypes = (c.senderTypes || []).filter(t => TYPES.includes(t))
    if (!senderTypes.length) throw bad('Choose at least one sender type for each country.')
    return { verified: !!c.verified, rate: c.rate, surcharge: c.surcharge || 0, cost: c.cost ?? null, senderTypes, registration: c.registration === 'required' ? 'required' : 'none', twoWay: !!c.twoWay,
      promotional: c.promotional !== false, route: c.route === 'dnd' ? 'dnd' : null, from: c.from ? String(c.from).slice(0, 20) : null, note: c.note ? String(c.note).slice(0, 300) : null }
  }
  r.post('/platform/comms/sms', { auth: 'platform' }, async ({ ctx, body }) => {
    const cur = (await platformConfig({ fresh: true })).sms
    const next = { providers: {}, routes: {}, taxPct: cur.taxPct, lowAlerts: cur.lowAlerts, resumeWindowHours: cur.resumeWindowHours, placeholder: cur.placeholder }
    for (const [id, p] of Object.entries(body.providers || cur.providers)) {
      if (!SMS_ADAPTERS[id]) continue
      if (SMS_ADAPTERS[id].mock && isProduction()) continue
      const countries = {}
      for (const [cc, c] of Object.entries(p.countries || {})) { if (!CC.test(cc)) throw bad(`“${cc}” isn’t a country code.`); countries[cc] = cleanCap(c) }
      next.providers[id] = { enabled: !!p.enabled, countries }
    }
    for (const [cc, list] of Object.entries(body.routes || cur.routes || {})) {
      if (!CC.test(cc)) continue
      const ids = [...new Set((list || []).filter(x => SMS_ADAPTERS[x]))].slice(0, 4)
      if (ids.length) next.routes[cc] = ids
    }
    if (body.taxPct !== undefined) { if (!okNum(Number(body.taxPct), 50)) throw bad('Tax must be between 0 and 50%.'); next.taxPct = Number(body.taxPct) }
    if (Array.isArray(body.lowAlerts)) next.lowAlerts = body.lowAlerts.map(Number).filter(n => n > 0 && n < 100).slice(0, 3)
    if (body.resumeWindowHours !== undefined) next.resumeWindowHours = Math.min(168, Math.max(1, Number(body.resumeWindowHours) || 48))
    if (body.placeholder !== undefined) next.placeholder = !!body.placeholder
    const { db } = await fb()
    const patch = { sms: next, updated_at: new Date(), updated_by: ctx.user.email }
    if (Array.isArray(body.packs)) { const list = body.packs.map(Number).filter(n => n >= 1 && n <= 1000).slice(0, 6); if (list.length) patch.packs = list }
    await db.collection('platform').doc('comms').set(patch, { merge: true })
    clearConfigCache()
    await audit(ctx, 'platform.sms_config', 'platform', 'comms')
    return platformSms()
  })
  r.post('/platform/comms/sms/credentials', { auth: 'platform' }, async ({ ctx, body }) => {
    const id = String(body.provider || '')
    if (!SMS_ADAPTERS[id] || SMS_ADAPTERS[id].mock) throw bad('Unknown provider.')
    try { await saveCredentials(id, body.values || {}, ctx.user) } catch (e) { throw bad(e.message) }
    await audit(ctx, 'platform.sms_credentials', 'platform', id) // values are never logged
    return { credentials: await credentialStatus(id) }
  })
  r.post('/platform/comms/sms/test', { auth: 'platform' }, async ({ body }) => {
    const a = SMS_ADAPTERS[String(body.provider || '')]
    if (!a) throw bad('Unknown provider.')
    return a.test(await credentials(a.id, { fresh: true }))
  })
  r.post('/platform/comms/sms/sender', { auth: 'platform' }, async ({ ctx, body }) => {
    const [orgId, country] = String(body.id || '').split('_')
    if (!orgId || !CC.test(country || '')) throw bad('Unknown request.')
    const status = oneOf(body.status, ['approved', 'rejected', 'pending'], { name: 'Status' })
    const providers = (body.providers || []).filter(x => SMS_ADAPTERS[x])
    const { db } = await fb()
    const ref = col(db, orgId, 'smsSenders').doc(country)
    if (!(await ref.get()).exists) throw notFound()
    await ref.update({ status, approved_for: providers, note: str(body.note, { max: 300 }) || null, decided_at: new Date(), decided_by: ctx.user.email })
    await db.collection('smsSenderRequests').doc(`${orgId}_${country}`).update({ status, decided_at: new Date() })
    await audit(ctx, 'platform.sms_sender', 'organisation', orgId, { country, status })
    return platformSms()
  })
  // Recent SMS failures across churches (counts and reasons only, no message text).
  r.get('/platform/comms/sms/failures', { auth: 'platform' }, async () => {
    const { db } = await fb()
    const runs = await db.collection('platform').doc('commsHealth').collection('providers').get()
    return { providers: runs.docs.map(d => ({ id: d.id, ...plain(d.data()) })) }
  })
}
