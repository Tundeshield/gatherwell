// Billing through Paddle (merchant of record: Paddle handles sales tax and VAT worldwide).
// Switched on by PADDLE_API_KEY + PADDLE_CLIENT_TOKEN. PADDLE_ENV = 'sandbox' (testing) or 'production'.
// Products and prices are created in Paddle automatically the first time they're needed.
import crypto from 'node:crypto'
import { fb } from './firebase.js'
import { HttpError, bad } from './http.js'
import { PLANS, CURRENCY, price, billingStatus } from '../shared/plans.js'

const env = () => (process.env.PADDLE_ENV === 'production' ? 'production' : 'sandbox')
const API = () => (env() === 'production' ? 'https://api.paddle.com' : 'https://sandbox-api.paddle.com')
export const billingEnabled = () => !!process.env.PADDLE_API_KEY && !!process.env.PADDLE_CLIENT_TOKEN
// Pricing rules (read-only after the trial) only apply once churches can actually pay.
export const billingEnforced = () => billingEnabled() && process.env.BILLING_ENFORCED !== 'false'
export const isExpired = (org) => billingEnforced() && billingStatus(org).state === 'expired'

async function paddle(method, path, body) {
  const res = await fetch(API() + path, {
    method, headers: { authorization: `Bearer ${process.env.PADDLE_API_KEY}`, 'content-type': 'application/json', 'paddle-version': '1' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    console.error('Paddle API error', method, path, res.status, JSON.stringify(data?.error || data).slice(0, 500))
    throw new HttpError(res.status >= 500 ? 502 : 400, `The payment service said: ${data?.error?.detail || `error ${res.status}`}`)
  }
  return data.data
}

const priceKey = (plan, interval) => `${plan}:${interval}`

async function billingDoc() {
  const { db } = await fb()
  const ref = db.collection('platform').doc('billing')
  const d = (await ref.get()).data() || {}
  return { ref, prices: d.paddle?.[env()]?.prices || {}, products: d.paddle?.[env()]?.products || {}, all: d }
}

// Finds or creates the Paddle product and price for one of our plans and intervals.
export async function priceId(plan, interval) {
  const { ref, prices, products, all } = await billingDoc()
  const key = priceKey(plan, interval)
  if (prices[key]) return prices[key]
  let productId = products[plan]
  if (!productId) {
    const existing = (await paddle('GET', '/products?status=active&per_page=200')) || []
    productId = existing.find(p => p.custom_data?.gatherhq_plan === plan)?.id
      || (await paddle('POST', '/products', { name: `GatherHQ ${PLANS[plan].name}`, tax_category: 'saas', description: PLANS[plan].blurb, custom_data: { gatherhq_plan: plan } })).id
  }
  const amount = String(Math.round(price(plan, interval) * 100))
  const existingPrices = (await paddle('GET', `/prices?product_id=${productId}&status=active&per_page=200`)) || []
  const found = existingPrices.find(p => p.custom_data?.gatherhq_key === key && p.unit_price?.amount === amount && p.unit_price?.currency_code === CURRENCY)
  const id = found?.id || (await paddle('POST', '/prices', {
    product_id: productId, description: `${PLANS[plan].name}, ${interval === 'yearly' ? 'yearly' : 'monthly'}`, name: interval === 'yearly' ? 'Yearly' : 'Monthly',
    unit_price: { amount, currency_code: CURRENCY }, billing_cycle: { interval: interval === 'yearly' ? 'year' : 'month', frequency: 1 },
    custom_data: { gatherhq_key: key },
  })).id
  const cur = all.paddle?.[env()] || {}
  await ref.set({ paddle: { ...(all.paddle || {}), [env()]: { ...cur, products: { ...(cur.products || {}), [plan]: productId }, prices: { ...(cur.prices || {}), [key]: id } } } }, { merge: true })
  return id
}

async function planFromPrice(id) {
  if (!id) return null
  const { prices } = await billingDoc()
  const key = Object.keys(prices).find(k => prices[k] === id)
  if (!key) return null
  const [plan, interval] = key.split(':')
  return { plan, interval }
}

/**
 * Starts a plan. A church already paying through Paddle is switched straight away (charged or
 * credited the difference); otherwise this returns what the browser needs to open Paddle's checkout.
 */
export async function startCheckout({ org, user, plan, interval }) {
  const id = await priceId(plan, interval)
  const b = org.billing || {}
  const st = billingStatus(org)
  if (b.subscription_id && b.provider === 'paddle' && (st.state === 'active' || st.state === 'past_due')) {
    await paddle('PATCH', `/subscriptions/${b.subscription_id}`, { items: [{ price_id: id, quantity: 1 }], proration_billing_mode: 'prorated_immediately', ...(st.cancelling ? { scheduled_change: null } : {}) })
    const { db } = await fb()
    await setBilling({ ref: db.collection('orgs').doc(org.id), ...org }, { plan, interval, status: 'active' })
    return { changed: true, plan, interval }
  }
  return {
    provider: 'paddle', environment: env(), token: process.env.PADDLE_CLIENT_TOKEN, priceId: id,
    customer: b.customer_id ? { id: b.customer_id } : { email: b.email || user.email },
    customData: { org_id: org.id, plan, interval },
  }
}

async function orgFor(customerId, customData) {
  const { db } = await fb()
  const id = customData?.org_id || (customerId && (await db.collection('billingCustomers').doc(customerId).get()).data()?.org_id)
  if (!id) return null
  const o = await db.collection('orgs').doc(String(id)).get()
  return o.exists ? { id: o.id, ref: o.ref, ...o.data() } : null
}

async function setBilling(org, patch, extra = {}) {
  const billing = { ...(org.billing || {}), provider: 'paddle', manual: false, ...patch, updated_at: new Date() }
  const update = { billing, ...extra }
  // The church network plan switches on multiple branches.
  if (patch.plan === 'network' && patch.status === 'active') update.features = { ...(org.features || {}), branches: true }
  await org.ref.update(update)
  return billing
}

const cardFrom = (tx) => {
  const c = (tx?.payments || []).find(p => p.status === 'captured' || p.captured_at)?.method_details?.card || tx?.payments?.[0]?.method_details?.card
  return c?.last4 ? { brand: c.type ? c.type[0].toUpperCase() + c.type.slice(1) : null, last4: c.last4, exp: c.expiry_month && c.expiry_year ? `${c.expiry_month}/${String(c.expiry_year).slice(-2)}` : null } : undefined
}

// A Paddle subscription → our billing fields.
async function fromSubscription(sub) {
  const item = sub.items?.[0]
  const p = (await planFromPrice(item?.price?.id || item?.price_id)) || (sub.custom_data?.plan ? { plan: sub.custom_data.plan, interval: sub.custom_data.interval } : {})
  const base = { ...p, subscription_id: sub.id, customer_id: sub.customer_id }
  const endsAt = sub.current_billing_period?.ends_at || null
  switch (sub.status) {
    case 'active':
    case 'trialing':
      if (sub.scheduled_change?.action === 'cancel') return { ...base, status: 'cancelled', next_payment_date: sub.scheduled_change.effective_at || endsAt }
      return { ...base, status: 'active', next_payment_date: sub.next_billed_at || endsAt, last_error: null }
    case 'past_due':
      return { ...base, status: 'past_due', next_payment_date: sub.next_billed_at || endsAt || new Date().toISOString() }
    default: // canceled, paused
      return { ...base, status: 'cancelled', next_payment_date: sub.canceled_at || endsAt || new Date().toISOString() }
  }
}

async function rememberCustomer(customerId, orgId, email) {
  if (!customerId) return
  const { db } = await fb()
  await db.collection('billingCustomers').doc(customerId).set({ org_id: orgId, email: email || null, provider: 'paddle', updated_at: new Date() }, { merge: true })
}

// After checkout completes in the browser: confirm straight away (the webhook may arrive a little later).
export async function confirmPayment(org, transactionId) {
  const tx = await paddle('GET', `/transactions/${encodeURIComponent(transactionId)}`)
  if (tx.custom_data?.org_id !== org.id) return { ok: false, status: 'not_found' }
  if (!['paid', 'completed'].includes(tx.status)) return { ok: false, status: tx.status }
  const { db } = await fb()
  const fresh = { ref: db.collection('orgs').doc(org.id), ...(await db.collection('orgs').doc(org.id).get()).data(), id: org.id }
  await rememberCustomer(tx.customer_id, org.id)
  let patch = { customer_id: tx.customer_id, last_payment_at: new Date(tx.billed_at || tx.updated_at || Date.now()), card: cardFrom(tx) ?? fresh.billing?.card ?? null }
  if (tx.subscription_id) patch = { ...patch, ...(await fromSubscription(await paddle('GET', `/subscriptions/${tx.subscription_id}`))) }
  else patch = { ...patch, plan: tx.custom_data?.plan, interval: tx.custom_data?.interval, status: 'active' }
  await setBilling(fresh, patch)
  return { ok: true, plan: patch.plan, interval: patch.interval }
}

// Paddle-Signature: ts=<unix seconds>;h1=<hmac-sha256 hex of "ts:rawBody">
export function validSignature(raw, header, now = Date.now()) {
  const secret = process.env.PADDLE_WEBHOOK_SECRET
  if (!header || !secret) return false
  const parts = Object.fromEntries(String(header).split(';').map(p => p.split('=').map(s => s.trim())))
  const ts = Number(parts.ts)
  if (!ts || !parts.h1 || Math.abs(now / 1000 - ts) > 300) return false
  const want = crypto.createHmac('sha256', secret).update(`${parts.ts}:${raw}`).digest('hex')
  return want.length === parts.h1.length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(parts.h1))
}

// Paddle notifications. Each event is processed once; older events never overwrite newer state.
export async function handleEvent(evt) {
  const { db } = await fb()
  const d = evt.data || {}
  const eventId = String(evt.event_id || `${evt.event_type}_${d.id}_${evt.occurred_at}`).replace(/[/.#[\]]/g, '_').slice(0, 200)
  try { await db.collection('billingEvents').doc(eventId).create({ event: evt.event_type, at: new Date() }) } catch { return { duplicate: true } }
  const org = await orgFor(d.customer_id, d.custom_data)
  if (!org) return { ignored: 'no church found' }
  const at = evt.occurred_at || new Date().toISOString()
  const newer = !org.billing?.event_at || at >= org.billing.event_at
  if (String(evt.event_type).startsWith('subscription.')) {
    if (!newer) return { ignored: 'older event' }
    await rememberCustomer(d.customer_id, org.id)
    await setBilling(org, { ...(await fromSubscription(d)), event_at: at })
    return { ok: true }
  }
  switch (evt.event_type) {
    case 'transaction.completed':
    case 'transaction.paid': {
      if (!d.subscription_id && !d.custom_data?.plan) return { ignored: 'not a subscription payment' }
      await rememberCustomer(d.customer_id, org.id)
      const patch = { customer_id: d.customer_id, last_payment_at: new Date(d.billed_at || at), last_error: null }
      const card = cardFrom(d); if (card) patch.card = card
      if (d.subscription_id) patch.subscription_id = d.subscription_id
      if (org.billing?.status === 'past_due' || !org.billing?.status) patch.status = 'active'
      if (!org.billing?.plan && d.custom_data?.plan) Object.assign(patch, { plan: d.custom_data.plan, interval: d.custom_data.interval })
      await setBilling(org, patch)
      return { ok: true }
    }
    case 'transaction.payment_failed': {
      const reason = (d.payments || []).find(p => p.error_code)?.error_code
      await setBilling(org, { last_error: reason ? `Payment failed (${String(reason).replace(/_/g, ' ')})` : 'Payment failed' })
      return { ok: true }
    }
    default:
      return { ignored: evt.event_type }
  }
}

// Paddle's customer page, where the church can update their card, see invoices or cancel.
export async function manageLink(org) {
  const b = org.billing || {}
  if (!b.customer_id || b.provider !== 'paddle') throw bad('There’s no subscription to manage yet.')
  const s = await paddle('POST', `/customers/${b.customer_id}/portal-sessions`, b.subscription_id ? { subscription_ids: [b.subscription_id] } : {})
  return s.urls?.general?.overview
}
