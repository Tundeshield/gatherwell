// Messaging credits: a prepaid balance per church, in US dollars, for channels where GatherHQ pays
// the provider. Rates and credit packs are configuration (platform/comms), not code.
//
// The default rates below are PLACEHOLDERS for staging, based on the Nov 2026 research:
// WhatsApp at about 1.5x Meta's Oct 2026 rate card; SMS at about cost + 30% on international
// routes. They must be confirmed once providers and commercial terms are chosen.
import { fb, col, toDate } from '../firebase.js'
import { countryOf, smsInfo } from '../../shared/comms.js'
import { platformConfig } from './providers.js'
import { isProduction } from '../env.js'

export const DEFAULT_RATES = {
  currency: 'USD',
  placeholder: true,
  whatsapp: {
    NG: { marketing: 0.08, utility: 0.011 }, GH: { marketing: 0.034, utility: 0.006 }, KE: { marketing: 0.034, utility: 0.006 },
    ZA: { marketing: 0.057, utility: 0.015 }, GB: { marketing: 0.096, utility: 0.033 }, US: { marketing: 0.038, utility: 0.0051 },
    IN: { marketing: 0.018, utility: 0.0021 }, DE: { marketing: 0.205, utility: 0.083 }, OTHER: { marketing: 0.08, utility: 0.02 },
  },
  sms: { // per segment
    NG: 0.05, GH: 0.05, KE: 0.05, ZA: 0.18, GB: 0.073, US: 0.011, IN: 0.11, DE: 0.146, OTHER: 0.15,
  },
}
export const DEFAULT_PACKS = [10, 25, 50]

export async function rates() {
  const cfg = await platformConfig()
  return cfg.rates || DEFAULT_RATES
}
export async function packs() {
  const cfg = await platformConfig()
  return cfg.packs || DEFAULT_PACKS
}

// What one message to one person costs the church, in dollars.
export function unitPrice(R, channel, { phoneNorm, category = 'marketing', body = '' }) {
  const c = countryOf(phoneNorm)
  if (channel === 'whatsapp') { const r = R.whatsapp?.[c] || R.whatsapp?.OTHER || {}; return Number(r[category === 'utility' ? 'utility' : 'marketing']) || 0 }
  if (channel === 'sms') return (Number(R.sms?.[c] ?? R.sms?.OTHER) || 0) * Math.max(1, smsInfo(body).segments)
  return 0
}
export const round2 = (n) => Math.round(n * 100) / 100
export const money = (n) => Math.round(n * 10000) / 10000

export const balanceOf = (org) => money(Number(org?.credits?.balance || 0))

// Adds a ledger entry and moves the balance, atomically. `amount` is negative for usage.
export async function addCredits(orgId, { amount, type, note = null, messageId = null, enrolmentId = null, channel = null, count = null, user = null }) {
  const { db } = await fb()
  const orgRef = db.collection('orgs').doc(orgId)
  const ref = col(db, orgId, 'creditLedger').doc()
  return db.runTransaction(async (tx) => {
    const o = (await tx.get(orgRef)).data() || {}
    const balance = money(Number(o.credits?.balance || 0) + amount)
    tx.set(ref, { type, amount: money(amount), balance_after: balance, note, message_id: messageId, enrolment_id: enrolmentId, channel, count, created_at: new Date(), created_by: user?.id || null, created_by_name: user?.name || null, test: !isProduction() })
    tx.update(orgRef, { credits: { balance, updated_at: new Date(), low: balance < 2 } })
    return balance
  })
}

export async function ledger(orgId, limit = 50) {
  const { db } = await fb()
  const qs = await col(db, orgId, 'creditLedger').orderBy('created_at', 'desc').limit(limit).get()
  return qs.docs.map(d => { const x = d.data(); return { id: d.id, ...x, created_at: toDate(x.created_at) } })
}

// This month's usage by channel, from the ledger.
export async function monthUsage(orgId) {
  const { db } = await fb()
  const since = new Date(); since.setUTCDate(1); since.setUTCHours(0, 0, 0, 0)
  const qs = await col(db, orgId, 'creditLedger').where('created_at', '>=', since).get()
  const out = { whatsapp: { count: 0, cost: 0 }, sms: { count: 0, cost: 0 }, church_billed: { count: 0 } }
  for (const d of qs.docs) {
    const x = d.data()
    if (x.type === 'usage' && out[x.channel]) { out[x.channel].count += x.count || 0; out[x.channel].cost = money(out[x.channel].cost - x.amount) }
    if (x.type === 'church_billed') out.church_billed.count += x.count || 0
  }
  return out
}
