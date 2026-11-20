// Naira billing through Paystack: card, bank transfer and USSD. Switched on by PAYSTACK_SECRET_KEY
// (sk_live_… only in production; sk_test_… elsewhere).
// A church pays for a period (a month or a year) and is active until its paid-until date. Card payers
// are renewed automatically with the saved card; bank-transfer and USSD payers get a reminder with a
// payment link. Paystack tells us about every successful payment (webhook); each is applied once.
import crypto from 'node:crypto'
import { fb, plain } from './firebase.js'
import { HttpError, bad } from './http.js'
import { isProduction } from './env.js'
import { PLANS, RANK, price, billingStatus } from '../shared/plans.js'
import { onReferredChurchPaid } from './referrals.js'

const API = 'https://api.paystack.co'
const key = () => process.env.PAYSTACK_SECRET_KEY || ''
export const paystackEnabled = () => !!key() && (isProduction() || !key().startsWith('sk_live'))
export const paystackMode = () => (key().startsWith('sk_live') ? 'live' : 'test')
export const CHANNELS = ['card', 'bank_transfer', 'ussd', 'bank']
const DAY = 86_400_000

export async function paystack(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method, headers: { authorization: `Bearer ${key()}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.status === false) {
    console.error('Paystack API error', method, path, res.status, String(data?.message || '').slice(0, 300))
    throw new HttpError(res.status >= 500 ? 502 : 400, `The payment service said: ${data?.message || `error ${res.status}`}`)
  }
  return data.data
}

export const validPaystackSignature = (raw, sig) => {
  if (!key() || !sig) return false
  const want = crypto.createHmac('sha512', key()).update(raw).digest('hex')
  return want.length === String(sig).length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(String(sig)))
}

const addPeriod = (from, interval) => {
  const d = new Date(from)
  if (interval === 'yearly') d.setUTCFullYear(d.getUTCFullYear() + 1)
  else { const day = d.getUTCDate(); d.setUTCMonth(d.getUTCMonth() + 1); if (d.getUTCDate() < day) d.setUTCDate(0) }
  return d
}
const toD = (v) => (v?.toDate ? v.toDate() : v ? new Date(v) : null)

// What the church pays now for a plan, and the period it buys.
// Moving up mid-period: the unused part of the current period comes off the price. Renewing early or
// paying again for the same plan: the new period starts when the current one ends.
export function quote(org, plan, interval, now = new Date()) {
  if (!PLANS[plan] || plan === 'free') throw bad('Choose a paid plan.')
  const st = billingStatus(org, now)
  const b = org.billing || {}
  const full = price(plan, interval)
  const current = (st.state === 'active' || st.state === 'past_due') && b.provider === 'paystack' && PLANS[b.plan]
  if (current && b.plan === plan && b.interval === interval) {
    const start = st.renewsAt > now ? st.renewsAt : now
    return { amount: full, credit: 0, start, end: addPeriod(start, interval), kind: 'renewal' }
  }
  let credit = 0
  if (current && st.renewsAt > now && b.period_start) {
    const total = toD(st.renewsAt) - toD(b.period_start)
    credit = total > 0 ? Math.floor(price(b.plan, b.interval) * ((st.renewsAt - now) / total)) : 0
  }
  const kind = !current ? 'new' : RANK[plan] > RANK[b.plan] || (RANK[plan] === RANK[b.plan] && interval === 'yearly') ? 'upgrade' : 'change'
  return { amount: Math.max(100, full - credit), credit: Math.min(credit, full - 100), start: now, end: addPeriod(now, interval), kind }
}

export async function startPaystackCheckout({ org, user, plan, interval, origin }) {
  if (!paystackEnabled()) throw bad('Payments aren’t switched on yet.')
  const q = quote(org, plan, interval)
  const reference = `ghq_${org.id.slice(0, 12)}_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`
  const email = org.billing?.email || user.email
  const { db } = await fb()
  await db.collection('paystackRefs').doc(reference).set({ org_id: org.id, org_name: org.name, plan, interval, amount: q.amount, credit: q.credit, kind: q.kind, email, created_by: user.id, created_at: new Date(), applied: false })
  const tx = await paystack('POST', '/transaction/initialize', {
    email, amount: q.amount * 100, currency: 'NGN', reference, channels: CHANNELS,
    callback_url: `${origin}/app/settings?tab=billing&reference=${reference}`,
    metadata: { org_id: org.id, plan, interval, cancel_action: `${origin}/app/settings?tab=billing`, custom_fields: [{ display_name: 'Church', variable_name: 'church', value: org.name }, { display_name: 'Plan', variable_name: 'plan', value: `${PLANS[plan].name} (${interval})` }] },
  })
  return { url: tx.authorization_url, reference, amount: q.amount, credit: q.credit }
}

// Applies a successful Paystack payment (from the webhook, or when the church returns from checkout). Once per reference.
export async function applyPaystackPayment(reference, { verified } = {}) {
  const ref = String(reference || '').replace(/[^\w-]/g, '').slice(0, 100)
  if (!ref) throw bad('Missing payment reference.')
  const tx = verified || await paystack('GET', `/transaction/verify/${encodeURIComponent(ref)}`)
  const { db } = await fb()
  const pRef = db.collection('paystackRefs').doc(ref)
  const result = await db.runTransaction(async (t) => {
    const p = await t.get(pRef)
    if (!p.exists) return { ok: false, reason: 'unknown reference' }
    const pend = p.data()
    if (pend.applied) return { ok: true, duplicate: true, org_id: pend.org_id, plan: pend.plan, interval: pend.interval }
    if (tx.status !== 'success') { t.update(pRef, { last_status: tx.status || null, checked_at: new Date() }); return { ok: false, status: tx.status || 'pending', reason: tx.gateway_response || null } }
    if (String(tx.currency).toUpperCase() !== 'NGN' || Number(tx.amount) < pend.amount * 100) return { ok: false, reason: 'amount mismatch' }
    const oRef = db.collection('orgs').doc(pend.org_id)
    const org = { id: pend.org_id, ...(await t.get(oRef)).data() }
    const before = org.billing || {}
    const q = quote(org, pend.plan, pend.interval, new Date())
    const auth = tx.authorization || {}
    const card = auth.channel === 'card' ? { brand: auth.card_type || auth.brand || null, last4: auth.last4 || null, exp: auth.exp_month ? `${auth.exp_month}/${String(auth.exp_year).slice(-2)}` : null, bank: auth.bank || null } : null
    const reusable = auth.channel === 'card' && auth.reusable === true
    const billing = {
      provider: 'paystack', plan: pend.plan, interval: pend.interval, status: 'active', manual: false, currency: 'ngn',
      period_start: q.kind === 'renewal' ? (before.period_start || q.start) : q.start, next_payment_date: q.end,
      auto_renew: reusable ? (before.provider === 'paystack' && before.auto_renew === false ? false : true) : false,
      authorization_code: reusable ? auth.authorization_code : (before.authorization_code || null), card: card || before.card || null,
      channel: tx.channel || auth.channel || null, email: tx.customer?.email || pend.email, customer_code: tx.customer?.customer_code || before.customer_code || null,
      last_payment_at: new Date(), last_reference: ref, last_error: null, renewal_attempt: null, reminders: {},
    }
    t.update(oRef, { billing })
    t.update(pRef, { applied: true, applied_at: new Date(), paid_amount: Number(tx.amount) / 100, channel: billing.channel })
    t.set(db.collection('payments').doc(`ps_${ref}`), {
      provider: 'paystack', source: 'paystack', kind: 'subscription', org_id: org.id, org_name: org.name || null,
      invoice_id: ref, reference: ref, amount: Number(tx.amount) / 100, amount_refunded: 0, currency: 'ngn', status: 'paid',
      plan: pend.plan, interval: pend.interval, credit: pend.credit || 0, method: { type: billing.channel, brand: card?.brand || null, last4: card?.last4 || null },
      description: `${PLANS[pend.plan].name} plan, ${pend.interval}`, created_at: new Date(tx.created_at || tx.createdAt || Date.now()), paid_at: new Date(tx.paid_at || tx.paidAt || Date.now()),
      mode: paystackMode(), livemode: paystackMode() === 'live', fees: tx.fees != null ? Number(tx.fees) / 100 : null,
    })
    const wasPaying = before.provider === 'paystack' && PLANS[before.plan] && before.last_payment_at
    const kind = !wasPaying || (toD(before.next_payment_date) && toD(before.next_payment_date) < new Date(Date.now() - 7 * DAY)) ? 'started'
      : before.plan !== pend.plan ? (RANK[pend.plan] > RANK[before.plan] ? 'upgraded' : 'downgraded') : before.interval !== pend.interval ? 'interval_changed' : 'renewed'
    t.set(db.collection('subscriptionChanges').doc(`ps_${ref}`), { org_id: org.id, org_name: org.name || null, kind,
      from: { plan: before.plan || null, interval: before.interval || null, status: before.status || null }, to: { plan: pend.plan, interval: pend.interval, status: 'active' }, provider: 'paystack', at: new Date() })
    return { ok: true, org_id: org.id, plan: pend.plan, interval: pend.interval, kind, until: q.end }
  })
  if (result.ok && !result.duplicate && result.kind === 'started') await onReferredChurchPaid(result.org_id).catch(e => console.error('referral reward', e.message))
  return result
}

// Webhook: Paystack sends charge.success for every completed payment.
export async function handlePaystackEvent(evt) {
  if (evt?.event !== 'charge.success') return { ignored: evt?.event || 'unknown' }
  const ref = evt.data?.reference
  if (!String(ref || '').startsWith('ghq_')) return { ignored: 'not a GatherHQ payment' }
  return applyPaystackPayment(ref) // verified again with Paystack, never trusting the webhook body alone
}

// Daily: renew card payers on their renewal day; remind everyone else before and after their date.
export async function runPaystackRenewals({ now = new Date(), send } = {}) {
  if (!paystackEnabled()) return { skipped: true }
  const { db } = await fb()
  const snap = await db.collection('orgs').where('billing.provider', '==', 'paystack').limit(5000).get()
  let charged = 0, failed = 0, reminded = 0
  for (const o of snap.docs) {
    const org = { id: o.id, ...o.data() }
    const b = org.billing || {}
    if (org.status !== 'active' || !PLANS[b.plan] || !['active', 'past_due'].includes(b.status)) continue
    const due = toD(b.next_payment_date)
    if (!due) continue
    const days = Math.ceil((due - now) / DAY)
    const periodKey = due.toISOString().slice(0, 10)
    if (b.auto_renew && b.authorization_code) {
      if (days > 0 || b.renewal_attempt === periodKey) continue
      const reference = `ghq_${org.id.slice(0, 12)}_r${Date.now().toString(36)}`
      const amount = price(b.next_plan || b.plan, b.next_interval || b.interval)
      await o.ref.update({ 'billing.renewal_attempt': periodKey })
      await db.collection('paystackRefs').doc(reference).set({ org_id: org.id, org_name: org.name, plan: b.next_plan || b.plan, interval: b.next_interval || b.interval, amount, credit: 0, kind: 'renewal', email: b.email, created_by: 'system', created_at: now, applied: false })
      try {
        const tx = await paystack('POST', '/transaction/charge_authorization', { authorization_code: b.authorization_code, email: b.email, amount: amount * 100, currency: 'NGN', reference, metadata: { org_id: org.id, renewal: true } })
        if (tx.status === 'success') { await applyPaystackPayment(reference, { verified: tx }); charged++; continue }
        throw new Error(tx.gateway_response || 'The card was declined')
      } catch (e) {
        failed++
        await o.ref.update({ 'billing.status': 'past_due', 'billing.last_error': String(e.message || e).slice(0, 200) })
        if (send) await send(org, 'failed', { due, error: e.message }).catch(() => {})
      }
      continue
    }
    // Bank transfer and USSD payers: reminders 7 days before, 1 day before and on the day after.
    const stage = days <= 7 && days > 1 ? 'd7' : days === 1 || days === 0 ? 'd1' : days < 0 && days >= -1 ? 'due' : null
    if (!stage || b.reminders?.[`${periodKey}_${stage}`]) continue
    await o.ref.update({ [`billing.reminders.${periodKey}_${stage}`]: now })
    if (days < 0 && b.status === 'active') await o.ref.update({ 'billing.status': 'past_due' })
    if (send) { await send(org, stage, { due }).catch(() => {}); reminded++ }
  }
  return { charged, failed, reminded }
}

export const paystackOut = (b) => ({ autoRenew: !!b.auto_renew, canAutoRenew: !!b.authorization_code, card: b.card || null, channel: b.channel || null, email: b.email || null, nextPlan: b.next_plan || null, nextInterval: b.next_interval || null, lastPaymentAt: plain(b.last_payment_at) || null })
