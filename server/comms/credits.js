// Prepaid messaging credit, in US dollars. Email never uses credit. SMS is paid from it.
//
// Every change to a balance is a ledger entry (orgs/{org}/creditLedger) written in the same
// transaction as the balance, and every entry has a deterministic id, so a retried job or a
// repeated webhook can never apply it twice:
//   p_{stripeSession}   purchase          + amount paid
//   r_{deliveryId}      reservation       − estimated cost, before the provider is called
//   s_{deliveryId}      settlement        + (reserved − actual), once the provider accepted it
//   x_{deliveryId}      release           + reserved, when nothing was sent
//   f_{deliveryId}      refund            + charged, when the provider later reports a failure
//                                           and does not bill failed messages
//   adj_* / test_*      adjustment / test top-up (staging) by the GatherHQ team
// The balance is what the church can still spend; reservations already count against it.
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
// WhatsApp price (kept for when church-owned WhatsApp arrives). SMS prices come from routing.
export function unitPrice(R, channel, { phoneNorm, category = 'marketing' }) {
  const c = countryOf(phoneNorm)
  if (channel === 'whatsapp') { const r = R.whatsapp?.[c] || R.whatsapp?.OTHER || {}; return Number(r[category === 'utility' ? 'utility' : 'marketing']) || 0 }
  return 0
}
export const money = (n) => Math.round(Number(n || 0) * 10000) / 10000
export const balanceOf = (org) => money(Number(org?.credits?.balance || 0))

// Low-balance level for a balance: 0 = fine, then one level per threshold crossed, 99 = empty.
function levelOf(balance, base, alerts) {
  if (balance <= 0) return 99
  if (!(base > 0)) return 0
  const pct = (balance / base) * 100
  return [...alerts].sort((a, b) => b - a).filter(t => pct <= t).length
}

/**
 * Writes one ledger entry and moves the balance in a single transaction.
 * id: deterministic entry id (repeat calls with the same id do nothing and return { duplicate }).
 * require: when true, refuses (ok:false) if the balance would go below zero.
 */
export async function ledgerEntry(orgId, { id, type, amount, require = false, description = null, messageId = null, deliveryId = null, enrolmentId = null, channel = null,
  count = null, country = null, segments = null, actualCost = null, provider = null, stripe = null, user = null, extra = {} }) {
  const { db } = await fb()
  const orgRef = db.collection('orgs').doc(orgId)
  const ref = col(db, orgId, 'creditLedger').doc(id || col(db, orgId, 'creditLedger').doc().id)
  const cfg = await platformConfig()
  return db.runTransaction(async (tx) => {
    const [o, e] = await tx.getAll(orgRef, ref)
    if (e.exists) return { ok: true, duplicate: true, balance: balanceOf(o.data()), entry: e.data() }
    const cur = o.data()?.credits || {}
    const balance = money(Number(cur.balance || 0) + Number(amount))
    if (require && balance < 0) return { ok: false, balance: money(cur.balance || 0) }
    const base = type === 'purchase' || type === 'test_topup' ? balance : Number(cur.alert_base || 0) // thresholds are a share of the balance after the last top-up
    const level = levelOf(balance, base, cfg.sms.lowAlerts || [20, 10])
    tx.set(ref, { org_id: orgId, type, amount: money(amount), currency: 'USD', balance_after: balance, description, message_id: messageId, delivery_id: deliveryId, enrolment_id: enrolmentId,
      channel, count, country, segments, actual_cost: actualCost, provider, stripe_session: stripe, created_at: new Date(), created_by: user?.id || null, created_by_name: user?.name || null, test: !isProduction(), ...extra })
    tx.update(orgRef, { credits: { balance, alert_base: base, alert_level: level, low: level > 0, last_purchase_at: type === 'purchase' ? new Date() : cur.last_purchase_at || null, updated_at: new Date() } })
    return { ok: true, balance, level, crossed: level > (cur.alert_level || 0) ? level : 0 }
  })
}

// Kept for top-ups and adjustments made from the app.
export async function addCredits(orgId, { amount, type, note = null, user = null, id = null }) {
  const r = await ledgerEntry(orgId, { id, type, amount, description: note, user })
  if (r.crossed) await import('./engine.js').then(m => m.notifyBalance(orgId, r.crossed)).catch(() => {})
  return r.balance
}

export const reserve = (orgId, deliveryId, amount, meta = {}) =>
  ledgerEntry(orgId, { id: `r_${deliveryId}`, type: 'reservation', amount: -money(amount), require: true, deliveryId, channel: 'sms', description: 'Held for a text message', ...meta })
export async function settle(orgId, deliveryId, reserved, actual, meta = {}) {
  return ledgerEntry(orgId, { id: `s_${deliveryId}`, type: 'settlement', amount: money(reserved - actual), deliveryId, channel: 'sms', actualCost: money(actual), count: 1,
    description: actual === reserved ? 'Text message sent' : `Text message sent (${actual < reserved ? 'fewer' : 'more'} parts than estimated)`, ...meta })
}
export const release = (orgId, deliveryId, reserved, meta = {}) =>
  ledgerEntry(orgId, { id: `x_${deliveryId}`, type: 'release', amount: money(reserved), deliveryId, channel: 'sms', description: 'Not sent, so not charged', ...meta })
export const refundFailed = (orgId, deliveryId, charged, meta = {}) =>
  ledgerEntry(orgId, { id: `f_${deliveryId}`, type: 'refund', amount: money(charged), deliveryId, channel: 'sms', description: 'Not delivered, so refunded', ...meta })
export const purchase = (orgId, sessionId, amount, meta = {}) =>
  ledgerEntry(orgId, { id: `p_${sessionId}`, type: 'purchase', amount: money(amount), stripe: sessionId, description: `Bought $${Number(amount).toFixed(2)} of messaging credit`, ...meta })

export async function ledger(orgId, limit = 50) {
  const { db } = await fb()
  const qs = await col(db, orgId, 'creditLedger').orderBy('created_at', 'desc').limit(limit).get()
  return qs.docs.map(d => { const x = d.data(); return { id: d.id, ...x, created_at: toDate(x.created_at) } })
}

// This month's SMS spending from settlements and refunds, by country.
export async function monthUsage(orgId) {
  const { db } = await fb()
  const since = new Date(); since.setUTCDate(1); since.setUTCHours(0, 0, 0, 0)
  const qs = await col(db, orgId, 'creditLedger').where('created_at', '>=', since).get()
  const out = { sms: { count: 0, segments: 0, cost: 0 }, byCountry: {}, purchases: 0, reserved: 0 }
  for (const d of qs.docs) {
    const x = d.data()
    if (x.type === 'settlement') {
      out.sms.count += 1; out.sms.segments += x.segments || 0; out.sms.cost = money(out.sms.cost + (x.actual_cost || 0))
      const c = (out.byCountry[x.country || 'OTHER'] ||= { count: 0, segments: 0, cost: 0 })
      c.count += 1; c.segments += x.segments || 0; c.cost = money(c.cost + (x.actual_cost || 0))
    }
    if (x.type === 'refund') { out.sms.cost = money(out.sms.cost - x.amount); const c = out.byCountry[x.country || 'OTHER']; if (c) c.cost = money(c.cost - x.amount) }
    if (x.type === 'purchase') out.purchases = money(out.purchases + x.amount)
  }
  return out
}
export { smsInfo }
