// Billing through Stripe. Switched on by STRIPE_SECRET_KEY (sk_live_… or sk_test_…).
// Products and prices are created in Stripe automatically the first time they're needed,
// found again by their lookup keys (gatherhq_<plan>_<interval>).
import crypto from 'node:crypto'
import { fb } from './firebase.js'
import { HttpError, bad } from './http.js'
import { PLANS, CURRENCY, price, billingStatus } from '../shared/plans.js'

const API = 'https://api.stripe.com/v1'
import { stripeKeyAllowed } from './env.js'

const STRIPE_VERSION = '2024-06-20'
// Off when no key is set, and off outside production if someone sets a live key there by mistake.
export const billingEnabled = () => !!process.env.STRIPE_SECRET_KEY && stripeKeyAllowed(process.env.STRIPE_SECRET_KEY)
// Pricing rules (read-only after the trial) only apply once churches can actually pay.
export const billingEnforced = () => billingEnabled() && process.env.BILLING_ENFORCED !== 'false'
export const isExpired = (org) => billingEnforced() && billingStatus(org).state === 'expired'
const mode = () => (String(process.env.STRIPE_SECRET_KEY || '').startsWith('sk_live') ? 'live' : 'test')

// Stripe takes form-encoded bodies with bracketed keys: items[0][price]=…
function encode(obj, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === undefined) continue
    const key = prefix ? `${prefix}[${k}]` : k
    if (v === null) out.append(key, '')
    else if (Array.isArray(v)) v.forEach((x, i) => (typeof x === 'object' ? encode(x, `${key}[${i}]`, out) : out.append(`${key}[${i}]`, String(x))))
    else if (typeof v === 'object') encode(v, key, out)
    else out.append(key, String(v))
  }
  return out
}

async function stripe(method, path, params) {
  const get = method === 'GET'
  const qs = get && params ? `?${encode(params)}` : ''
  const res = await fetch(`${API}${path}${qs}`, {
    method,
    headers: { authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, 'stripe-version': STRIPE_VERSION, ...(get ? {} : { 'content-type': 'application/x-www-form-urlencoded' }) },
    body: get ? undefined : encode(params).toString(),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    console.error('Stripe API error', method, path, res.status, JSON.stringify(data?.error || data).slice(0, 500))
    throw new HttpError(res.status >= 500 ? 502 : 400, `The payment service said: ${data?.error?.message || `error ${res.status}`}`)
  }
  return data
}

const lookupKey = (plan, interval) => `gatherhq_${plan}_${interval}`
const toISO = (s) => (s ? new Date(s * 1000).toISOString() : null)

async function billingDoc() {
  const { db } = await fb()
  const ref = db.collection('platform').doc('billing')
  const all = (await ref.get()).data() || {}
  return { ref, all, prices: all.stripe?.[mode()]?.prices || {} }
}

// Finds or creates the Stripe product and price for one of our plans and intervals.
export async function priceId(plan, interval) {
  const { ref, all, prices } = await billingDoc()
  const key = lookupKey(plan, interval)
  if (prices[key]) return prices[key]
  const amount = Math.round(price(plan, interval) * 100)
  const found = (await stripe('GET', '/prices', { lookup_keys: [key], active: 'true', limit: 1 })).data?.[0]
  let id = found && found.unit_amount === amount && found.currency === CURRENCY.toLowerCase() ? found.id : null
  if (!id) {
    const productId = `gatherhq_${plan}`
    let product
    try { product = await stripe('GET', `/products/${productId}`) } catch { product = null }
    if (!product) product = await stripe('POST', '/products', { id: productId, name: `GatherHQ ${PLANS[plan].name}`, description: PLANS[plan].blurb, tax_code: 'txcd_10103001' })
    id = (await stripe('POST', '/prices', {
      product: product.id, currency: CURRENCY.toLowerCase(), unit_amount: amount, tax_behavior: 'exclusive',
      recurring: { interval: interval === 'yearly' ? 'year' : 'month' },
      nickname: `${PLANS[plan].name}, ${interval}`, lookup_key: key, transfer_lookup_key: true,
    })).id
  }
  const cur = all.stripe?.[mode()] || {}
  await ref.set({ stripe: { ...(all.stripe || {}), [mode()]: { ...cur, prices: { ...(cur.prices || {}), [key]: id } } } }, { merge: true })
  return id
}

function planFromPrice(p) {
  const m = /^gatherhq_(church|network)_(monthly|yearly)$/.exec(p?.lookup_key || '')
  if (m) return { plan: m[1], interval: m[2] }
  if (p?.recurring) return { interval: p.recurring.interval === 'year' ? 'yearly' : 'monthly' }
  return {}
}

async function setBilling(org, patch, extra = {}) {
  const billing = { ...(org.billing || {}), provider: 'stripe', manual: false, ...patch, updated_at: new Date() }
  const update = { billing, ...extra }
  // The church network plan switches on multiple branches.
  if (patch.plan === 'network' && patch.status === 'active') update.features = { ...(org.features || {}), branches: true }
  await org.ref.update(update)
  return billing
}

async function rememberCustomer(customerId, orgId, email) {
  if (!customerId) return
  const { db } = await fb()
  await db.collection('billingCustomers').doc(customerId).set({ org_id: orgId, email: email || null, provider: 'stripe', updated_at: new Date() }, { merge: true })
}

async function ensureCustomer(org, user) {
  const b = org.billing || {}
  if (b.provider === 'stripe' && b.customer_id && b.mode === mode()) return b.customer_id
  const c = await stripe('POST', '/customers', { email: b.email || user.email, name: org.name, metadata: { org_id: org.id, church: org.name } })
  await rememberCustomer(c.id, org.id, user.email)
  const { db } = await fb()
  await db.collection('orgs').doc(org.id).update({ billing: { ...b, provider: 'stripe', mode: mode(), customer_id: c.id, subscription_id: null, email: b.email || user.email } })
  return c.id
}

const cardFrom = (pm) => {
  const c = pm?.card
  return c?.last4 ? { brand: c.brand ? c.brand[0].toUpperCase() + c.brand.slice(1) : null, last4: c.last4, exp: c.exp_month && c.exp_year ? `${c.exp_month}/${String(c.exp_year).slice(-2)}` : null } : undefined
}

// A Stripe subscription → our billing fields.
async function fromSubscription(sub) {
  const item = sub.items?.data?.[0]
  const p = { ...planFromPrice(item?.price), ...(sub.metadata?.plan ? { plan: sub.metadata.plan } : {}) }
  if (!p.plan) Object.assign(p, planFromPrice(item?.price))
  const end = toISO(sub.current_period_end ?? item?.current_period_end)
  let pm = sub.default_payment_method
  if (typeof pm === 'string') pm = await stripe('GET', `/payment_methods/${pm}`).catch(() => null)
  const card = cardFrom(pm)
  const base = { ...p, subscription_id: sub.id, customer_id: typeof sub.customer === 'string' ? sub.customer : sub.customer?.id, mode: mode(), ...(card ? { card } : {}) }
  switch (sub.status) {
    case 'active':
    case 'trialing':
      if (sub.cancel_at_period_end || sub.cancel_at) return { ...base, status: 'cancelled', next_payment_date: toISO(sub.cancel_at) || end }
      return { ...base, status: 'active', next_payment_date: end, last_error: null }
    case 'past_due':
    case 'unpaid':
      return { ...base, status: 'past_due', next_payment_date: end || new Date().toISOString() }
    case 'incomplete':
      return null // first payment not finished yet; nothing changes
    default: // canceled, incomplete_expired, paused
      return { ...base, status: 'cancelled', next_payment_date: toISO(sub.ended_at || sub.canceled_at) || new Date().toISOString() }
  }
}

/**
 * Starts a plan. A church already paying through Stripe is switched straight away (charged or
 * credited the difference); otherwise this returns Stripe's checkout page URL.
 */
export async function startCheckout({ org, user, plan, interval, origin }) {
  const id = await priceId(plan, interval)
  const b = org.billing || {}
  const st = billingStatus(org)
  if (b.provider === 'stripe' && b.subscription_id && b.mode === mode() && (st.state === 'active' || st.state === 'past_due')) {
    const sub = await stripe('GET', `/subscriptions/${b.subscription_id}`)
    const updated = await stripe('POST', `/subscriptions/${sub.id}`, {
      items: [{ id: sub.items.data[0].id, price: id }], proration_behavior: 'create_prorations', cancel_at_period_end: 'false',
      metadata: { org_id: org.id, plan, interval },
    })
    const { db } = await fb()
    const patch = await fromSubscription(updated)
    await setBilling({ ref: db.collection('orgs').doc(org.id), ...org }, { ...patch, plan, interval })
    return { changed: true, plan, interval }
  }
  const customer = await ensureCustomer(org, user)
  const back = `${origin}/app/settings?tab=billing`
  const session = await stripe('POST', '/checkout/sessions', {
    mode: 'subscription', customer, client_reference_id: org.id,
    line_items: [{ price: id, quantity: 1 }],
    success_url: `${back}&session_id={CHECKOUT_SESSION_ID}`, cancel_url: back,
    allow_promotion_codes: 'true', billing_address_collection: 'auto',
    metadata: { org_id: org.id, plan, interval },
    subscription_data: { metadata: { org_id: org.id, plan, interval } },
    ...(process.env.STRIPE_AUTOMATIC_TAX === 'true' ? { automatic_tax: { enabled: 'true' }, customer_update: { address: 'auto', name: 'auto' }, tax_id_collection: { enabled: 'true' } } : {}),
  })
  return { url: session.url }
}

async function orgFor(customerId, metadata) {
  const { db } = await fb()
  const id = metadata?.org_id || (customerId && (await db.collection('billingCustomers').doc(customerId).get()).data()?.org_id)
  if (!id) return null
  const o = await db.collection('orgs').doc(String(id)).get()
  return o.exists ? { id: o.id, ref: o.ref, ...o.data() } : null
}

// After returning from Stripe's checkout: confirm straight away (the webhook may arrive a little later).
export async function confirmPayment(org, sessionId) {
  const s = await stripe('GET', `/checkout/sessions/${encodeURIComponent(sessionId)}`, { expand: ['subscription', 'subscription.default_payment_method'] })
  if (s.client_reference_id !== org.id) return { ok: false, status: 'not_found' }
  if (s.status !== 'complete' || !s.subscription) return { ok: false, status: s.status }
  const { db } = await fb()
  const fresh = { ref: db.collection('orgs').doc(org.id), ...(await db.collection('orgs').doc(org.id).get()).data(), id: org.id }
  const patch = await fromSubscription(s.subscription)
  if (!patch) return { ok: false, status: 'incomplete' }
  await rememberCustomer(patch.customer_id, org.id, s.customer_details?.email)
  await setBilling(fresh, { ...patch, last_payment_at: new Date() })
  return { ok: true, plan: patch.plan, interval: patch.interval }
}

// Stripe-Signature: t=<unix seconds>,v1=<hmac-sha256 hex of "t.rawBody">[,v1=…]
export function validSignature(raw, header, now = Date.now()) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET
  if (!header || !secret) return false
  const parts = String(header).split(',').map(p => p.trim().split('='))
  const t = parts.find(([k]) => k === 't')?.[1]
  const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v)
  if (!t || !sigs.length || Math.abs(now / 1000 - Number(t)) > 300) return false
  const want = crypto.createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex')
  return sigs.some(s => s.length === want.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(want)))
}

// Stripe notifications. Each event is processed once; older events never overwrite newer state.
export async function handleEvent(evt) {
  const { db } = await fb()
  const d = evt.data?.object || {}
  try { await db.collection('billingEvents').doc(String(evt.id).slice(0, 200)).create({ event: evt.type, provider: 'stripe', at: new Date() }) } catch { return { duplicate: true } }
  const customerId = typeof d.customer === 'string' ? d.customer : d.customer?.id
  const meta = d.metadata?.org_id ? d.metadata : d.subscription_details?.metadata || (d.client_reference_id ? { org_id: d.client_reference_id } : null)
  const org = await orgFor(customerId, meta)
  if (!org) return { ignored: 'no church found' }
  const at = evt.created || Math.floor(Date.now() / 1000)
  const newer = !org.billing?.event_at || typeof org.billing.event_at !== 'number' || at >= org.billing.event_at
  switch (evt.type) {
    case 'checkout.session.completed': {
      if (d.mode !== 'subscription' || !d.subscription) return { ignored: 'not a subscription' }
      const sub = await stripe('GET', `/subscriptions/${d.subscription}`, { expand: ['default_payment_method'] })
      const patch = await fromSubscription(sub)
      if (!patch) return { ignored: 'incomplete' }
      await rememberCustomer(customerId, org.id, d.customer_details?.email)
      await setBilling(org, { ...patch, last_payment_at: new Date(), event_at: at })
      return { ok: true }
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      if (!newer) return { ignored: 'older event' }
      const patch = await fromSubscription(d)
      if (!patch) return { ignored: 'incomplete' }
      await rememberCustomer(customerId, org.id)
      await setBilling(org, { ...patch, event_at: at })
      return { ok: true }
    }
    case 'invoice.paid':
    case 'invoice.payment_succeeded': {
      if (!d.subscription) return { ignored: 'not a subscription invoice' }
      const patch = { last_payment_at: new Date((d.status_transitions?.paid_at || at) * 1000), last_error: null }
      if (org.billing?.status === 'past_due') patch.status = 'active'
      await setBilling(org, patch)
      return { ok: true }
    }
    case 'invoice.payment_failed': {
      if (!d.subscription) return { ignored: 'not a subscription invoice' }
      const reason = d.last_finalization_error?.message || d.last_payment_error?.message
      await setBilling(org, { last_error: reason ? `Payment failed: ${reason}` : 'Payment failed' })
      return { ok: true }
    }
    default:
      return { ignored: evt.type }
  }
}

// Stripe's customer page, where the church can update their card, see invoices or cancel.
export async function manageLink(org, origin) {
  const b = org.billing || {}
  if (b.provider !== 'stripe' || !b.customer_id) throw bad('There’s no subscription to manage yet.')
  const s = await stripe('POST', '/billing_portal/sessions', { customer: b.customer_id, return_url: `${origin}/app/settings?tab=billing` })
  return s.url
}
