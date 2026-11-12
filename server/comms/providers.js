// Messaging providers behind one interface per channel. Screens and workflows never call a
// provider directly: they ask for a channel, and the active provider for that channel (set by the
// GatherHQ team in the admin console, stored in platform/comms) does the delivery.
//
// Adapter contract:
//   id, label, channel, billing: ['platform'] and/or 'church', idempotent (safe to resend a batch
//   with the same key), billsFailed (does the provider charge for failed messages),
//   reports: statuses it can report later (delivered, read…), needsTemplates (WhatsApp),
//   env: credentials it needs (secret values live in Netlify, never in the database),
//   available(): usable in this environment, test(): connection check,
//   send(batch, key): [{ ok, providerId, error, retry }] in the same order.
import crypto from 'node:crypto'
import { fb } from '../firebase.js'
import { isProduction } from '../env.js'
import { emailProvider, sendEmails } from '../email.js'

const hasEnv = (keys) => keys.every(k => !!process.env[k])

// --- email: Resend (real) -----------------------------------------------------------------
const resend = {
  id: 'resend', label: 'Resend', channel: 'email', billing: ['platform'], idempotent: true, billsFailed: false, reports: [], needsTemplates: false,
  env: ['RESEND_API_KEY', 'EMAIL_FROM_DOMAIN'],
  available: () => !!emailProvider(),
  async test() {
    const p = emailProvider()
    if (!p) return { ok: false, error: 'RESEND_API_KEY or EMAIL_FROM_DOMAIN is not set.' }
    const r = await fetch('https://api.resend.com/domains', { headers: { authorization: `Bearer ${p.key}` } }).catch(e => ({ ok: false, status: 0, e }))
    return r.ok ? { ok: true } : { ok: false, error: r.status === 401 || r.status === 403 ? 'The API key was rejected.' : `Couldn’t reach Resend (${r.status || 'network'}).` }
  },
  // batch items: { to, from, subject, html, text, reply_to, headers }
  async send(batch, key) {
    const res = await sendEmails(emailProvider(), batch.map(b => ({ from: b.from, to: [b.to], subject: b.subject, html: b.html, text: b.text, ...(b.reply_to ? { reply_to: b.reply_to } : {}), ...(b.headers ? { headers: b.headers } : {}) })), key)
    return res.map(r => ({ ok: !!r.ok, providerId: null, error: r.error || null, retry: !!r.retry, fatal: !!r.fatal, skipped: !!r.skipped }))
  },
}

// --- mock providers (staging and tests only) ----------------------------------------------
// They record what would have been sent and never contact anyone. A recipient whose phone
// number ends in 99, or whose email starts with "fail", fails, so failures can be tested.
function mock(channel, extra = {}) {
  return {
    id: `mock_${channel}`, label: `Test provider (${channel === 'sms' ? 'SMS' : channel === 'email' ? 'email' : 'WhatsApp'})`, channel,
    billing: channel === 'email' ? ['platform'] : ['platform', 'church'], idempotent: true, billsFailed: false,
    reports: channel === 'email' ? ['delivered'] : ['delivered', 'read'], needsTemplates: channel === 'whatsapp', env: [], mock: true,
    available: () => !isProduction(),
    test: async () => ({ ok: !isProduction(), error: isProduction() ? 'Test providers are switched off in production.' : null }),
    async send(batch) {
      return batch.map(b => {
        const fails = channel === 'email' ? /^fail/i.test(b.to) : /99$/.test(b.to)
        return fails ? { ok: false, error: channel === 'whatsapp' ? 'This number isn’t on WhatsApp (simulated).' : 'The number couldn’t be reached (simulated).' }
          : { ok: true, providerId: `mock_${crypto.randomBytes(6).toString('hex')}` }
      })
    },
    ...extra,
  }
}

export const ADAPTERS = {
  email: { resend, mock_email: mock('email') },
  whatsapp: { mock_whatsapp: mock('whatsapp') },
  sms: { mock_sms: mock('sms') },
}
// Providers researched but not built yet, shown to the team so the roadmap is visible.
export const PLANNED = {
  whatsapp: ['Meta Cloud API', 'Gupshup', 'Twilio', '360dialog'],
  sms: ['Twilio', 'Termii', 'Africa’s Talking', 'Vonage'],
  email: ['Amazon SES'],
}

const DEFAULT_ACTIVE = () => ({ email: 'resend', whatsapp: isProduction() ? null : 'mock_whatsapp', sms: isProduction() ? null : 'mock_sms' })

// --- platform configuration (active provider per channel, rates, credit packs) --------------
let cache = null
export async function platformConfig({ fresh = false } = {}) {
  if (cache && !fresh && Date.now() - cache.at < 30000) return cache.value
  const { db } = await fb()
  const d = (await db.collection('platform').doc('comms').get()).data() || {}
  const value = { active: { ...DEFAULT_ACTIVE(), ...(d.active || {}) }, disabled: d.disabled || [], rates: d.rates || null, packs: d.packs || null, updated_at: d.updated_at || null, updated_by: d.updated_by || null }
  cache = { at: Date.now(), value }
  return value
}
export function clearConfigCache() { cache = null }

export function adapterFor(channel, id) {
  return ADAPTERS[channel]?.[id] || null
}
// The provider that will deliver a channel right now, or null with a plain reason.
export async function activeProvider(channel) {
  const cfg = await platformConfig()
  const id = cfg.active[channel]
  if (!id) return { adapter: null, reason: 'not_set' }
  if (cfg.disabled.includes(id)) return { adapter: null, reason: 'disabled' }
  const a = adapterFor(channel, id)
  if (!a) return { adapter: null, reason: 'unknown' }
  if (!a.available()) return { adapter: null, reason: a.mock ? 'mock_in_production' : 'missing_credentials' }
  return { adapter: a, reason: null }
}

// Plain-language status for church admins (no provider names).
export async function channelStatus(org) {
  const out = {}
  for (const ch of Object.keys(ADAPTERS)) {
    const { adapter, reason } = await activeProvider(ch)
    const own = org?.comms?.channels?.[ch] || {}
    const billing = adapter && own.billing === 'church' && adapter.billing.includes('church') ? 'church' : (ch === 'email' ? 'included' : 'platform')
    out[ch] = {
      ready: !!adapter, simulated: !!adapter?.mock, billing,
      canChurchBill: !!adapter?.billing.includes('church'),
      needsTemplates: !!adapter?.needsTemplates,
      reason: adapter ? null : reason,
    }
  }
  return out
}

// Everything the GatherHQ team needs to manage providers. Credentials are reported only as
// set / not set: values never leave Netlify.
export async function providerOverview() {
  const cfg = await platformConfig({ fresh: true })
  const channels = {}
  for (const [ch, list] of Object.entries(ADAPTERS)) {
    channels[ch] = {
      active: cfg.active[ch] || null,
      providers: Object.values(list).map(a => ({
        id: a.id, label: a.label, billing: a.billing, reports: a.reports, needsTemplates: a.needsTemplates, mock: !!a.mock,
        credentials: a.env.map(k => ({ name: k, set: !!process.env[k] })), available: a.available(), disabled: cfg.disabled.includes(a.id),
      })),
      planned: PLANNED[ch] || [],
    }
  }
  return { channels, updated_at: cfg.updated_at, updated_by: cfg.updated_by }
}

export async function setProvider({ channel, provider, disabled, user }) {
  const { db } = await fb()
  const cfg = await platformConfig({ fresh: true })
  const active = { ...cfg.active }
  let off = [...cfg.disabled]
  if (provider !== undefined) {
    if (provider !== null && !adapterFor(channel, provider)) throw new Error('That provider isn’t available for this channel.')
    active[channel] = provider
  }
  if (disabled !== undefined && provider) off = disabled ? [...new Set([...off, provider])] : off.filter(x => x !== provider)
  await db.collection('platform').doc('comms').set({ active, disabled: off, updated_at: new Date(), updated_by: user?.email || null }, { merge: true })
  clearConfigCache()
  return providerOverview()
}

export const credentialsPresent = hasEnv
