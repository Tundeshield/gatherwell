// SMS for churches anywhere: provider adapters behind one contract, routing by destination
// country, sender identities per country, provider health, and encrypted credentials.
//
// Nothing outside this file knows which provider carried a message. The engine asks
// `routeFor()` for the eligible providers for a number, and calls `sendVia()` on one of them.
//
// Configuration lives in Firestore platform/comms.sms (edited in the admin console):
//   providers: { [id]: { enabled, countries: { [CC]: Capability } } }
//   routes:    { [CC]: [providerId, …fallbacks] }  (order of preference; others by price)
//   taxPct, lowAlerts: [20, 10], resumeWindowHours
// Capability: { verified, rate, surcharge, cost, senderTypes: ['alpha'|'number'|'shortcode'|'provider'],
//   registration: 'none'|'required', twoWay, promotional, route?: 'dnd'|'generic', from? }
//   rate and surcharge are what the church pays per segment (USD); cost is the provider's price,
//   for the GatherHQ team only.
//
// Adapter contract:
//   id, label, mock, env: credential field names, billsFailed: does the provider charge for
//   messages it accepted but couldn't deliver,
//   available(creds), test(creds) → { ok, error }
//   send({ to, from, body, key, callbackUrl, route }, creds) →
//     { accepted: true, providerId, segments?, providerCost?, currency? } or
//     { accepted: false, error: { code, message, transient, outcome: 'not_sent'|'unknown', scope: 'recipient'|'provider' } }
//   verify({ raw, headers, url, form, json }, creds) → boolean   (signature check where supported)
//   parse({ form, json }) → { reports: [{ providerId, status, error, segments, providerCost }], inbound: [{ from, text }] }
import crypto from 'node:crypto'
import { fb } from '../firebase.js'
import { isProduction } from '../env.js'
import { countryOf } from '../../shared/comms.js'

// --- plain-language errors -------------------------------------------------------------------
const ERR = {
  invalid_number: 'The phone number isn’t valid.',
  not_mobile: 'The number isn’t a mobile number.',
  unreachable: 'The number couldn’t be reached.',
  opted_out: 'This person has opted out of texts with the provider.',
  dnd: 'The number is on the national Do-Not-Disturb list.',
  sender_rejected: 'The sender name isn’t approved for this country.',
  country_blocked: 'Texts to this country aren’t enabled with the provider.',
  auth: 'The SMS provider rejected GatherHQ’s credentials.',
  provider_balance: 'The SMS provider account needs topping up.',
  rate_limited: 'The SMS provider was busy.',
  provider_down: 'The SMS provider couldn’t be reached.',
  timeout: 'No answer from the SMS provider, so it isn’t known whether the text went out.',
  unknown: 'The SMS provider couldn’t send it.',
}
export const errorText = (code) => ERR[code] || ERR.unknown
const fail = (code, { transient = false, outcome = 'not_sent', scope = 'recipient', detail = null } = {}) =>
  ({ accepted: false, error: { code, message: errorText(code), transient, outcome, scope, detail: detail ? String(detail).slice(0, 200) : null } })

async function call(url, init, ms = 10000) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), ms)
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal })
    const text = await res.text()
    let data = null; try { data = JSON.parse(text) } catch {}
    return { status: res.status, data, text }
  } catch (e) {
    // Aborted after the request may have reached the provider: the outcome is unknown.
    // Refused or unresolved before connecting: definitely not sent.
    const before = /ENOTFOUND|ECONNREFUSED|EAI_AGAIN|certificate/i.test(String(e?.cause?.code || e?.message))
    return { status: 0, error: before ? 'not_sent' : 'unknown' }
  } finally { clearTimeout(t) }
}
const fromHttp = (r, map = () => null) => {
  if (r.status === 0) return r.error === 'not_sent' ? fail('provider_down', { transient: true, scope: 'provider' }) : fail('timeout', { transient: true, outcome: 'unknown', scope: 'provider' })
  if (r.status === 401 || r.status === 403) return fail('auth', { scope: 'provider', detail: r.text })
  if (r.status === 429 || r.status === 503) return fail('rate_limited', { transient: true, scope: 'provider' })
  if (r.status >= 500) return fail('timeout', { transient: true, outcome: 'unknown', scope: 'provider', detail: r.text })
  return map(r) || fail('unknown', { detail: r.text })
}
const plus = (n) => `+${String(n).replace(/\D/g, '')}`
const hmac = (alg, key, data, enc = 'hex') => crypto.createHmac(alg, key).update(data).digest(enc)
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))

// --- Twilio (Programmable Messaging) --------------------------------------------------------
// POST /2010-04-01/Accounts/{sid}/Messages.json; status callbacks signed with X-Twilio-Signature.
const twilio = {
  id: 'twilio', label: 'Twilio', env: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_MESSAGING_SERVICE_SID'], optional: ['TWILIO_MESSAGING_SERVICE_SID'], billsFailed: false,
  available: (c) => !!(c.TWILIO_ACCOUNT_SID && c.TWILIO_AUTH_TOKEN),
  auth: (c) => 'Basic ' + Buffer.from(`${c.TWILIO_ACCOUNT_SID}:${c.TWILIO_AUTH_TOKEN}`).toString('base64'),
  async test(c) {
    if (!this.available(c)) return { ok: false, error: 'Account SID or auth token missing.' }
    const r = await call(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(c.TWILIO_ACCOUNT_SID)}.json`, { headers: { authorization: this.auth(c) } })
    return r.status === 200 ? { ok: true, detail: `Account status: ${r.data?.status}` } : { ok: false, error: r.status === 401 ? 'Credentials rejected.' : `Unexpected response (${r.status || 'network'}).` }
  },
  async send({ to, from, body, callbackUrl }, c) {
    const form = new URLSearchParams({ To: plus(to), Body: body })
    if (from) form.set('From', from); else if (c.TWILIO_MESSAGING_SERVICE_SID) form.set('MessagingServiceSid', c.TWILIO_MESSAGING_SERVICE_SID)
    if (callbackUrl) form.set('StatusCallback', callbackUrl)
    const r = await call(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(c.TWILIO_ACCOUNT_SID)}/Messages.json`, { method: 'POST', headers: { authorization: this.auth(c), 'content-type': 'application/x-www-form-urlencoded' }, body: form })
    if (r.status === 201 || r.status === 200) return { accepted: true, providerId: r.data?.sid, segments: Number(r.data?.num_segments) || null, providerCost: r.data?.price ? Math.abs(Number(r.data.price)) : null, currency: r.data?.price_unit || null }
    return fromHttp(r, (x) => {
      const code = Number(x.data?.code)
      if ([21211, 21217, 21401, 21407].includes(code)) return fail('invalid_number', { detail: x.data?.message })
      if ([21612, 21614].includes(code)) return fail('not_mobile', { detail: x.data?.message })
      if (code === 21610) return fail('opted_out', { detail: x.data?.message })
      if ([21408, 21607].includes(code)) return fail('country_blocked', { scope: 'provider', detail: x.data?.message })
      if ([21212, 21606, 21659, 21660].includes(code)) return fail('sender_rejected', { scope: 'provider', detail: x.data?.message })
      if (code === 20003) return fail('auth', { scope: 'provider' })
      return null
    })
  },
  // Signature: base64 HMAC-SHA1 of the full callback URL followed by each POST field name and
  // value, sorted by name, keyed with the auth token.
  verify({ url, form, headers }, c) {
    if (!c.TWILIO_AUTH_TOKEN) return false
    const data = url + Object.keys(form || {}).sort().map(k => k + form[k]).join('')
    return same(hmac('sha1', c.TWILIO_AUTH_TOKEN, data, 'base64'), headers.get('x-twilio-signature') || '')
  },
  parse({ form }) {
    if (form.MessageStatus) {
      const s = form.MessageStatus
      const status = s === 'delivered' ? 'delivered' : ['failed', 'undelivered'].includes(s) ? 'failed' : null
      return { reports: status ? [{ providerId: form.MessageSid, status, error: status === 'failed' ? (form.ErrorCode === '30007' ? 'Filtered by the mobile network.' : ERR.unreachable) : null, segments: Number(form.NumSegments) || null }] : [], inbound: [] }
    }
    if (form.Body !== undefined && form.From) return { reports: [], inbound: [{ from: form.From, text: form.Body }] }
    return { reports: [], inbound: [] }
  },
}

// --- Termii --------------------------------------------------------------------------------
// POST {base}/api/sms/send; the base URL is shown in each Termii dashboard. Delivery reports are
// signed with X-Termii-Signature (HMAC-SHA512 of the raw body, keyed with the secret key).
const termii = {
  id: 'termii', label: 'Termii', env: ['TERMII_API_KEY', 'TERMII_SECRET_KEY', 'TERMII_WEBHOOK_SECRET', 'TERMII_BASE_URL'], optional: ['TERMII_SECRET_KEY', 'TERMII_WEBHOOK_SECRET', 'TERMII_BASE_URL'], billsFailed: true,
  base: (c) => (c.TERMII_BASE_URL || 'https://v3.api.termii.com').replace(/\/$/, ''),
  available: (c) => !!c.TERMII_API_KEY,
  async test(c) {
    if (!c.TERMII_API_KEY) return { ok: false, error: 'API key missing.' }
    const r = await call(`${this.base(c)}/api/get-balance?api_key=${encodeURIComponent(c.TERMII_API_KEY)}`, {})
    return r.status === 200 ? { ok: true, detail: `Balance: ${r.data?.balance ?? '?'} ${r.data?.currency ?? ''}` } : { ok: false, error: r.status === 401 ? 'API key rejected.' : `Unexpected response (${r.status || 'network'}).` }
  },
  async send({ to, from, body, route }, c) {
    const r = await call(`${this.base(c)}/api/sms/send`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ api_key: c.TERMII_API_KEY, to: String(to).replace(/\D/g, ''), from, sms: body, type: 'plain', channel: route === 'dnd' ? 'dnd' : 'generic' }) })
    if (r.status === 200 && r.data?.message_id) return { accepted: true, providerId: String(r.data.message_id) }
    return fromHttp(r, (x) => {
      const m = String(x.data?.message || x.text || '')
      if (/sender/i.test(m)) return fail('sender_rejected', { scope: 'provider', detail: m })
      if (/balance|insufficient/i.test(m)) return fail('provider_balance', { scope: 'provider', detail: m })
      if (/invalid.*(number|phone)|phone.*invalid/i.test(m)) return fail('invalid_number', { detail: m })
      return null
    })
  },
  // The dashboard's webhook "signing secret" (tsk_…) if set, otherwise the account secret key.
  verify({ raw, headers }, c) {
    const sig = headers.get('x-termii-signature') || ''
    return [c.TERMII_WEBHOOK_SECRET, c.TERMII_SECRET_KEY].filter(Boolean).some(k => same(hmac('sha512', k, raw || ''), sig))
  },
  parse({ json }) {
    const j = json || {}
    if (!j.message_id) return { reports: [], inbound: [] }
    const s = String(j.status || '').toLowerCase()
    const status = s.startsWith('delivered') ? 'delivered' : /fail|reject|dnd|expired/.test(s) ? 'failed' : null
    return { reports: status ? [{ providerId: String(j.message_id), status, error: status === 'failed' ? (/dnd/.test(s) ? ERR.dnd : ERR.unreachable) : null }] : [], inbound: [] }
  },
}

// --- Africa's Talking -------------------------------------------------------------------------
// POST /version1/messaging (form). Delivery reports carry no signature, so the callback URL holds
// a secret token (checked for every provider).
const africastalking = {
  id: 'africastalking', label: 'Africa’s Talking', env: ['AT_USERNAME', 'AT_API_KEY'], billsFailed: true,
  base: (c) => (c.AT_USERNAME === 'sandbox' ? 'https://api.sandbox.africastalking.com' : 'https://api.africastalking.com'),
  available: (c) => !!(c.AT_USERNAME && c.AT_API_KEY),
  async test(c) {
    if (!this.available(c)) return { ok: false, error: 'Username or API key missing.' }
    const r = await call(`${this.base(c)}/version1/user?username=${encodeURIComponent(c.AT_USERNAME)}`, { headers: { apiKey: c.AT_API_KEY, accept: 'application/json' } })
    return r.status === 200 ? { ok: true, detail: `Balance: ${r.data?.UserData?.balance ?? '?'}` } : { ok: false, error: r.status === 401 ? 'Credentials rejected.' : `Unexpected response (${r.status || 'network'}).` }
  },
  async send({ to, from, body }, c) {
    const form = new URLSearchParams({ username: c.AT_USERNAME, to: plus(to), message: body })
    if (from) form.set('from', from)
    const r = await call(`${this.base(c)}/version1/messaging`, { method: 'POST', headers: { apiKey: c.AT_API_KEY, accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body: form })
    const rec = r.data?.SMSMessageData?.Recipients?.[0]
    if (r.status >= 200 && r.status < 300 && rec) {
      const sc = Number(rec.statusCode)
      if ([100, 101, 102].includes(sc)) { const m = String(rec.cost || '').match(/([A-Z]{3})\s*([\d.]+)/); return { accepted: true, providerId: rec.messageId, providerCost: m ? Number(m[2]) : null, currency: m ? m[1] : null } }
      if (sc === 403 || sc === 404) return fail(sc === 403 ? 'invalid_number' : 'not_mobile')
      if (sc === 402) return fail('sender_rejected', { scope: 'provider' })
      if (sc === 405) return fail('provider_balance', { scope: 'provider' })
      if (sc === 406) return fail('opted_out')
      if (sc === 409) return fail('dnd')
      if (sc === 407) return fail('country_blocked', { scope: 'provider' })
      if (sc >= 500) return fail('timeout', { transient: true, outcome: 'unknown', scope: 'provider' })
      return fail('unknown', { detail: rec.status })
    }
    return fromHttp(r)
  },
  verify: () => true, // relies on the callback token
  parse({ form }) {
    if (form.id && form.status) {
      const status = form.status === 'Success' ? 'delivered' : ['Failed', 'Rejected', 'AbsentSubscriber', 'Expired'].includes(form.status) ? 'failed' : null
      return { reports: status ? [{ providerId: form.id, status, error: status === 'failed' ? (form.failureReason === 'DeliveryFailure' || !form.failureReason ? ERR.unreachable : `Not delivered (${form.failureReason}).`) : null }] : [], inbound: [] }
    }
    if (form.from && form.text !== undefined) return { reports: [], inbound: [{ from: form.from, text: form.text }] }
    return { reports: [], inbound: [] }
  },
}

// --- test providers (staging and automated tests only) ---------------------------------------
// They never contact anyone. Numbers ending 99 fail permanently; numbers ending 98 make the
// primary test provider time out before sending, so fallback can be exercised.
function mockProvider(id, label, { flakyOn98 = false } = {}) {
  return {
    id, label, env: [], mock: true, billsFailed: false,
    available: () => !isProduction(),
    test: async () => (isProduction() ? { ok: false, error: 'Test providers are switched off in production.' } : { ok: true, detail: 'Simulated: nothing is really sent.' }),
    async send({ to, body }) {
      if (isProduction()) return fail('auth', { scope: 'provider' })
      if (/99$/.test(to)) return fail('unreachable')
      if (flakyOn98 && /98$/.test(to)) return fail('provider_down', { transient: true, scope: 'provider' })
      return { accepted: true, providerId: `${id}_${crypto.randomBytes(6).toString('hex')}`, segments: null }
    },
    verify: () => true,
    parse: ({ json }) => ({ reports: json?.providerId ? [{ providerId: json.providerId, status: json.status, error: json.error || null, segments: json.segments || null }] : [], inbound: json?.from ? [{ from: json.from, text: json.text }] : [] }),
  }
}

export const SMS_ADAPTERS = {
  twilio, termii, africastalking,
  mock_sms: mockProvider('mock_sms', 'Test SMS provider A', { flakyOn98: true }),
  mock_sms_backup: mockProvider('mock_sms_backup', 'Test SMS provider B'),
}

// --- configuration ---------------------------------------------------------------------------
// Real providers start switched off with nothing verified: a country is only offered once the
// GatherHQ team has checked the route, the price and the sender rules and ticked "verified".
// The notes describe each provider's published rules as a starting point for that check.
const cap = (rate, x = {}) => ({ verified: false, rate, surcharge: 0, cost: null, senderTypes: ['alpha'], registration: 'none', twoWay: false, promotional: true, ...x })
const DOCUMENTED = {
  twilio: { GB: cap(0.06, { senderTypes: ['alpha', 'number', 'provider'], note: 'Alphanumeric sender allowed, no registration; replies need a number.' }),
    US: cap(0.02, { senderTypes: ['provider'], registration: 'required', twoWay: true, note: 'Needs a registered toll-free or 10DLC number (A2P registration).' }),
    CA: cap(0.02, { senderTypes: ['provider'], twoWay: true, note: 'Long code or toll-free number; no alphanumeric senders.' }),
    IE: cap(0.09, { senderTypes: ['alpha', 'provider'] }), DE: cap(0.12, { senderTypes: ['alpha', 'provider'] }), AU: cap(0.07, { senderTypes: ['alpha', 'provider'] }) },
  termii: { NG: cap(0.03, { registration: 'required', route: 'dnd', sharedSender: 'GatherHQ', note: 'Sender ID must be registered with Termii; DND route reaches numbers on the DND list. Churches without their own approved name send as GatherHQ, with the church name at the start of the text.' }),
    GH: cap(0.04, { registration: 'required' }) },
  africastalking: { KE: cap(0.02, { registration: 'required', note: 'Alphanumeric sender IDs are registered per network.' }), UG: cap(0.03, { registration: 'required' }),
    TZ: cap(0.03, { registration: 'required' }), NG: cap(0.03, { registration: 'required', sharedSender: 'GatherHQ' }), GH: cap(0.04, { registration: 'required' }), RW: cap(0.03, { registration: 'required' }) },
}
// Staging: the test providers cover a spread of countries with realistic rules.
const MOCK_COUNTRIES = {
  NG: cap(0.03, { verified: true, registration: 'required', route: 'dnd' }), GH: cap(0.04, { verified: true, registration: 'required' }), KE: cap(0.02, { verified: true, registration: 'required' }),
  ZA: cap(0.03, { verified: true }), GB: cap(0.06, { verified: true, senderTypes: ['alpha', 'provider'] }), IE: cap(0.09, { verified: true }),
  US: cap(0.02, { verified: true, senderTypes: ['provider'], twoWay: true, surcharge: 0.003 }), CA: cap(0.02, { verified: true, senderTypes: ['provider'], twoWay: true }),
  CI: cap(0.05, { verified: true }), DE: cap(0.12, { verified: true }),
}
export function defaultSmsConfig() {
  const prod = isProduction()
  return {
    providers: {
      twilio: { enabled: false, countries: DOCUMENTED.twilio },
      termii: { enabled: false, countries: DOCUMENTED.termii },
      africastalking: { enabled: false, countries: DOCUMENTED.africastalking },
      ...(prod ? {} : {
        mock_sms: { enabled: true, countries: MOCK_COUNTRIES },
        mock_sms_backup: { enabled: true, countries: { NG: { ...MOCK_COUNTRIES.NG, rate: 0.035 }, GB: { ...MOCK_COUNTRIES.GB, rate: 0.065 } } },
      }),
    },
    routes: prod ? {} : { NG: ['mock_sms', 'mock_sms_backup'], GB: ['mock_sms', 'mock_sms_backup'] },
    taxPct: 0, lowAlerts: [20, 10], resumeWindowHours: 48, placeholder: true,
  }
}
export function mergeSmsConfig(stored) {
  const d = defaultSmsConfig()
  if (!stored) return d
  const providers = { ...d.providers }
  for (const [id, p] of Object.entries(stored.providers || {})) if (SMS_ADAPTERS[id]) providers[id] = { ...(d.providers[id] || {}), ...p, countries: { ...(p.countries || d.providers[id]?.countries || {}) } }
  if (isProduction()) { delete providers.mock_sms; delete providers.mock_sms_backup }
  return { ...d, ...stored, providers, routes: stored.routes || d.routes }
}

// --- credentials: Netlify environment first, then the encrypted store ------------------------
// Values typed into the admin console are encrypted with AES-256-GCM using COMMS_SECRET_KEY
// (a Netlify secret) and stored in platform/commsSecrets. They are never sent back to a browser.
const encKey = () => (process.env.COMMS_SECRET_KEY ? crypto.createHash('sha256').update(process.env.COMMS_SECRET_KEY).digest() : null)
export const canStoreSecrets = () => !!encKey()
function seal(obj) {
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', encKey(), iv)
  const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()])
  return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') }
}
function open(s) {
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', encKey(), Buffer.from(s.iv, 'base64'))
    d.setAuthTag(Buffer.from(s.tag, 'base64'))
    return JSON.parse(Buffer.concat([d.update(Buffer.from(s.data, 'base64')), d.final()]).toString('utf8'))
  } catch { return {} }
}
let credCache = { at: 0, v: {} }
export async function credentials(id, { fresh = false } = {}) {
  const a = SMS_ADAPTERS[id]
  if (!a) return {}
  if (fresh || Date.now() - credCache.at > 30000) {
    credCache = { at: Date.now(), v: {} }
    if (encKey()) {
      const { db } = await fb()
      const qs = await db.collection('platform').doc('commsSecrets').collection('providers').get()
      for (const d of qs.docs) credCache.v[d.id] = open(d.data().sealed || {})
    }
  }
  const stored = credCache.v[id] || {}
  return Object.fromEntries(a.env.map(k => [k, process.env[k] || stored[k] || '']))
}
export async function credentialStatus(id) {
  const c = await credentials(id)
  const a = SMS_ADAPTERS[id]
  return a.env.map(k => ({ name: k, set: !!c[k], from: process.env[k] ? 'netlify' : c[k] ? 'stored' : null, optional: (a.optional || []).includes(k) }))
}
export async function saveCredentials(id, values, user) {
  const a = SMS_ADAPTERS[id]
  if (!a || a.mock) throw new Error('Unknown provider.')
  if (!encKey()) throw new Error('Set COMMS_SECRET_KEY as a secret in Netlify before storing credentials here, or add the provider’s variables in Netlify directly.')
  const { db } = await fb()
  const ref = db.collection('platform').doc('commsSecrets').collection('providers').doc(id)
  const cur = encKey() ? open((await ref.get()).data()?.sealed || {}) : {}
  const next = { ...cur }
  for (const k of a.env) if (typeof values?.[k] === 'string') { const v = values[k].trim(); if (v) next[k] = v.slice(0, 500); else delete next[k] }
  await ref.set({ sealed: seal(next), updated_at: new Date(), updated_by: user?.email || null, fields: Object.keys(next) })
  credCache.at = 0
}

// --- provider health --------------------------------------------------------------------------
const healthRef = (db, id) => db.collection('platform').doc('commsHealth').collection('providers').doc(id)
let healthCache = { at: 0, v: {} }
export async function health({ fresh = false } = {}) {
  if (!fresh && Date.now() - healthCache.at < 15000) return healthCache.v
  const { db } = await fb()
  const qs = await db.collection('platform').doc('commsHealth').collection('providers').get()
  healthCache = { at: Date.now(), v: Object.fromEntries(qs.docs.map(d => [d.id, d.data()])) }
  return healthCache.v
}
export async function recordHealth(id, ok, error = null) {
  const { db } = await fb()
  const ref = healthRef(db, id)
  await db.runTransaction(async (tx) => {
    const h = (await tx.get(ref)).data() || {}
    const n = ok ? 0 : (h.consecutive_failures || 0) + 1
    tx.set(ref, ok ? { consecutive_failures: 0, last_ok_at: new Date(), ok_count: (h.ok_count || 0) + 1, down_until: null }
      : { consecutive_failures: n, last_error: error, last_error_at: new Date(), fail_count: (h.fail_count || 0) + 1, down_until: n >= 5 ? new Date(Date.now() + 10 * 60e3) : h.down_until || null }, { merge: true })
  })
  healthCache.at = 0
}
const isDown = (h) => !!h?.down_until && new Date(h.down_until.toDate ? h.down_until.toDate() : h.down_until) > new Date()

// --- sender identities ------------------------------------------------------------------------
// orgs/{org}/smsSenders/{CC}: { type: 'alpha'|'number', value, status: 'draft'|'pending'|'approved'|'rejected',
//   approved_for: [providerIds], note }
export const cleanSenderName = (s) => String(s || '').replace(/[^A-Za-z0-9 ]/g, '').trim().slice(0, 11)
function senderFor(pid, c, church, sender) {
  const types = c.senderTypes || []
  const approved = sender?.status === 'approved' && (!sender.approved_for?.length || sender.approved_for.includes(pid))
  if (c.registration === 'required') {
    if (types.includes('provider') && !types.includes('alpha')) return { ok: true, from: c.from || null, type: 'provider' } // provider-managed registered number
    if (approved && sender?.value) return { ok: true, from: sender.value, type: sender.type || 'alpha' }
    // A registered platform-wide name (e.g. GatherHQ): the church's name goes at the start of the text instead.
    if (c.sharedSender) return { ok: true, from: c.sharedSender, type: 'alpha', shared: true }
    if (!sender?.value || sender.status === 'draft' || !sender.status) return { ok: false, reason: 'sender_needed' }
    if (sender.status === 'rejected') return { ok: false, reason: 'sender_rejected' }
    if (!approved) return { ok: false, reason: 'sender_pending' }
    return { ok: true, from: sender.value, type: sender.type || 'alpha' }
  }
  if (sender?.value && approved && types.includes(sender.type || 'alpha')) return { ok: true, from: sender.value, type: sender.type || 'alpha' }
  if (types.includes('alpha')) return { ok: true, from: cleanSenderName(sender?.value || church.sms_sender || church.name) || null, type: 'alpha' }
  if (types.includes('provider') || types.includes('number')) return { ok: true, from: c.from || null, type: 'provider' }
  return { ok: false, reason: 'sender_needed' }
}

// Texts sent under a shared platform sender name start with the church's name, so people know who it's from.
export function brandSms(org, body, candidate) {
  if (!candidate?.shared) return body
  const name = String(org?.name || '').trim()
  if (!name || body.trim().toLowerCase().startsWith(name.toLowerCase())) return body
  return `${name}: ${body}`
}

// --- routing ------------------------------------------------------------------------------------
export const unitPriceOf = (c, taxPct = 0) => Math.round((Number(c.rate || 0) + Number(c.surcharge || 0)) * (1 + Number(taxPct || 0) / 100) * 10000) / 10000
/**
 * Eligible providers for one number, best first. Each: { id, from, country, unit (USD per segment,
 * what the church pays), route, cap }. Empty list → { reason } in plain terms.
 */
export const routeFor = (cfg, org, senders, phoneNorm, opts) => routeForCountry(cfg, org, senders, countryOf(phoneNorm), opts)
export async function routeForCountry(cfg, org, senders, country, { category = 'marketing', exclude = [] } = {}) {
  const hs = await health()
  const sender = senders?.[country] || null
  const candidates = []
  let reason = 'unsupported_country'
  for (const [id, p] of Object.entries(cfg.providers || {})) {
    const a = SMS_ADAPTERS[id]
    const c = p.countries?.[country]
    if (!a || !p.enabled || !c?.verified || exclude.includes(id)) continue
    if (category === 'marketing' && c.promotional === false) { reason = 'type_not_allowed'; continue }
    if (!a.available(await credentials(id))) { reason = reason === 'unsupported_country' ? 'provider_unavailable' : reason; continue }
    if (isDown(hs[id])) { reason = 'provider_down'; continue }
    const s = senderFor(id, c, org, sender)
    if (!s.ok) { reason = s.reason; continue }
    candidates.push({ id, from: s.from, senderType: s.type, shared: !!s.shared, country, unit: unitPriceOf(c, cfg.taxPct), route: c.route || null, cap: c })
  }
  const pref = cfg.routes?.[country] || []
  const rank = (id) => { const i = pref.indexOf(id); return i < 0 ? 999 : i }
  candidates.sort((x, y) => rank(x.id) - rank(y.id) || x.unit - y.unit)
  return candidates.length ? { country, candidates } : { country, candidates: [], reason }
}
export const ROUTE_REASON = {
  unsupported_country: (cc) => `GatherHQ can’t send texts to numbers in ${cc} yet.`,
  provider_unavailable: (cc) => `Texts to ${cc} aren’t switched on yet.`,
  provider_down: () => 'The SMS service for this country is having problems. GatherHQ will try again shortly.',
  sender_needed: (cc) => `A sender name has to be registered before texts can go to numbers in ${cc}.`,
  sender_pending: (cc) => `Your sender name for ${cc} is waiting for approval.`,
  sender_rejected: (cc) => `Your sender name for ${cc} was not approved. Choose another in Channels & usage.`,
  type_not_allowed: (cc) => `Only reminders and updates can be texted to ${cc}, not invitations or announcements.`,
}

// The callback URL providers report delivery to, with a token only GatherHQ can make.
const hookSecret = () => process.env.SMS_WEBHOOK_SECRET || process.env.COMMS_SECRET_KEY || process.env.EMAIL_SIGNING_SECRET || (isProduction() ? null : 'staging-sms-webhooks')
export const hookToken = (id) => (hookSecret() ? hmac('sha256', hookSecret(), `sms-webhook:${id}`).slice(0, 32) : null)
export const checkHookToken = (id, t) => !!hookToken(id) && same(hookToken(id), String(t || ''))
export const callbackUrl = (origin, id) => (origin && hookToken(id) ? `${origin}/api/webhooks/sms/${id}?t=${hookToken(id)}` : null)

export async function sendVia(candidate, { to, body, key, origin }) {
  const a = SMS_ADAPTERS[candidate.id]
  const creds = await credentials(candidate.id)
  let r
  try { r = await a.send({ to, from: candidate.from, body, key, route: candidate.route, callbackUrl: callbackUrl(origin, candidate.id) }, creds) }
  catch (e) { r = fail('timeout', { transient: true, outcome: 'unknown', scope: 'provider', detail: e.message }) }
  if (r.accepted || r.error?.scope === 'recipient') await recordHealth(candidate.id, true).catch(() => {})
  else await recordHealth(candidate.id, false, r.error?.code).catch(() => {})
  return r
}
