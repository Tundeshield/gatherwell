// Billing through Paystack subscriptions. Switched on by PAYSTACK_SECRET_KEY.
// Plans are created in Paystack automatically the first time they're needed.
import crypto from 'node:crypto'
import { fb } from './firebase.js'
import { PLANS, CURRENCY, price, billingStatus } from '../shared/plans.js'

const API = 'https://api.paystack.co'
export const billingEnabled = () => !!process.env.PAYSTACK_SECRET_KEY
// Pricing rules (read-only after the trial) only apply once churches can actually pay.
export const billingEnforced = () => billingEnabled() && process.env.BILLING_ENFORCED !== 'false'
export const isExpired = (org) => billingEnforced() && billingStatus(org).state === 'expired'

async function paystack(method, path, body) {
  const res = await fetch(API + path, {
    method, headers: { authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.status === false) {
    const err = new Error(data.message || `Paystack error (${res.status})`)
    err.status = res.status; err.paystack = data
    throw err
  }
  return data.data
}

const planKey = (plan, interval) => `${plan}:${interval}`

// Finds or creates the Paystack plan for one of our plans and intervals.
export async function planCode(plan, interval) {
  const { db } = await fb()
  const ref = db.collection('platform').doc('billing')
  const saved = (await ref.get()).data()?.plans || {}
  const key = planKey(plan, interval)
  if (saved[key]) return saved[key]
  const name = `GatherHQ ${PLANS[plan].name} (${interval === 'yearly' ? 'yearly' : 'monthly'})`
  const amount = Math.round(price(plan, interval) * 100)
  const existing = (await paystack('GET', '/plan?perPage=100')).find(p => p.name === name && p.amount === amount && p.currency === CURRENCY)
  const code = existing?.plan_code || (await paystack('POST', '/plan', { name, amount, currency: CURRENCY, interval: interval === 'yearly' ? 'annually' : 'monthly' })).plan_code
  await ref.set({ plans: { ...saved, [key]: code } }, { merge: true })
  return code
}

async function planFromCode(code) {
  const { db } = await fb()
  const plans = (await db.collection('platform').doc('billing').get()).data()?.plans || {}
  const key = Object.keys(plans).find(k => plans[k] === code)
  if (!key) return null
  const [plan, interval] = key.split(':')
  return { plan, interval }
}

// Starts a payment for a plan. Returns the Paystack checkout URL.
export async function startCheckout({ org, user, plan, interval, callbackUrl }) {
  const { db } = await fb()
  const code = await planCode(plan, interval)
  let customer = org.billing?.customer_code
  if (!customer) {
    const [first, ...rest] = String(user.name || '').split(' ')
    const c = await paystack('POST', '/customer', { email: user.email, first_name: first || undefined, last_name: rest.join(' ') || undefined, metadata: { org_id: org.id, church: org.name } })
    customer = c.customer_code
    await db.collection('billingCustomers').doc(customer).set({ org_id: org.id, email: user.email, created_at: new Date() })
    await db.collection('orgs').doc(org.id).update({ billing: { ...(org.billing || {}), customer_code: customer, email: user.email } })
  }
  const tx = await paystack('POST', '/transaction/initialize', {
    email: org.billing?.email || user.email, amount: Math.round(price(plan, interval) * 100), currency: CURRENCY, plan: code,
    callback_url: callbackUrl, metadata: { org_id: org.id, plan, interval, cancel_action: callbackUrl },
  })
  return { url: tx.authorization_url, reference: tx.reference }
}

async function orgForCustomer(customerCode, metadata) {
  const { db } = await fb()
  const id = metadata?.org_id || (customerCode && (await db.collection('billingCustomers').doc(customerCode).get()).data()?.org_id)
  if (!id) return null
  const o = await db.collection('orgs').doc(id).get()
  return o.exists ? { id: o.id, ref: o.ref, ...o.data() } : null
}

async function setBilling(org, patch, extra = {}) {
  const billing = { ...(org.billing || {}), ...patch, updated_at: new Date() }
  const update = { billing, ...extra }
  // The church network plan switches on multiple branches.
  if (patch.plan === 'network' && patch.status === 'active') update.features = { ...(org.features || {}), branches: true }
  await org.ref.update(update)
  return billing
}

const addInterval = (date, interval) => { const d = new Date(date); interval === 'yearly' ? d.setFullYear(d.getFullYear() + 1) : d.setMonth(d.getMonth() + 1); return d }
const card = (a) => (a?.last4 ? { brand: a.card_type || a.brand || null, last4: a.last4, exp: a.exp_month && a.exp_year ? `${a.exp_month}/${String(a.exp_year).slice(-2)}` : null } : undefined)

// After the church returns from Paystack: confirm the payment straight away (the webhook may be slower).
export async function confirmPayment(org, reference) {
  const tx = await paystack('GET', `/transaction/verify/${encodeURIComponent(reference)}`)
  if (tx.status !== 'success' || tx.metadata?.org_id !== org.id) return { ok: false, status: tx.status }
  const plan = tx.metadata?.plan, interval = tx.metadata?.interval
  const { db } = await fb()
  const fresh = { ref: db.collection('orgs').doc(org.id), ...(await db.collection('orgs').doc(org.id).get()).data(), id: org.id }
  await setBilling(fresh, { plan, interval, status: 'active', last_payment_at: new Date(tx.paid_at || Date.now()),
    next_payment_date: fresh.billing?.next_payment_date && new Date(fresh.billing.next_payment_date) > new Date() ? fresh.billing.next_payment_date : addInterval(tx.paid_at || Date.now(), interval).toISOString(),
    customer_code: tx.customer?.customer_code || fresh.billing?.customer_code, card: card(tx.authorization) })
  return { ok: true, plan, interval }
}

export function validSignature(raw, signature) {
  if (!signature || !process.env.PAYSTACK_SECRET_KEY) return false
  const want = crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY).update(raw).digest('hex')
  return want.length === signature.length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(signature))
}

// Paystack webhook events. Each is processed once.
export async function handleEvent(evt) {
  const { db } = await fb()
  const d = evt.data || {}
  const id = `${evt.event}_${d.id || d.subscription_code || d.invoice_code || d.reference || ''}`.replace(/[/.#[\]]/g, '_').slice(0, 200)
  try { await db.collection('billingEvents').doc(id).create({ event: evt.event, at: new Date() }) } catch { return { duplicate: true } }
  const org = await orgForCustomer(d.customer?.customer_code, d.metadata)
  if (!org) return { ignored: 'no church found' }
  const fromPlan = d.plan?.plan_code ? await planFromCode(d.plan.plan_code) : null
  switch (evt.event) {
    case 'charge.success':
      if (!fromPlan && !d.metadata?.plan) return { ignored: 'not a subscription payment' }
      await setBilling(org, { ...(fromPlan || { plan: d.metadata.plan, interval: d.metadata.interval }), status: 'active', last_payment_at: new Date(d.paid_at || Date.now()), card: card(d.authorization) })
      break
    case 'subscription.create':
      await setBilling(org, { ...(fromPlan || {}), status: 'active', subscription_code: d.subscription_code, email_token: d.email_token, next_payment_date: d.next_payment_date || null, card: card(d.authorization) })
      break
    case 'invoice.create':
    case 'invoice.update':
      if (d.paid || d.status === 'success') await setBilling(org, { status: 'active', next_payment_date: d.subscription?.next_payment_date || org.billing?.next_payment_date || null, last_payment_at: new Date(d.paid_at || Date.now()) })
      break
    case 'invoice.payment_failed':
      await setBilling(org, { status: 'past_due', last_error: d.description || 'Payment failed' })
      break
    case 'subscription.not_renew':
    case 'subscription.disable':
      if (!org.billing?.subscription_code || !d.subscription_code || d.subscription_code === org.billing.subscription_code) {
        await setBilling(org, { status: 'cancelled', next_payment_date: d.next_payment_date || org.billing?.next_payment_date || null })
      }
      break
    default:
      return { ignored: evt.event }
  }
  return { ok: true }
}

// A Paystack page where the church can change its card or cancel.
export async function manageLink(org) {
  const code = org.billing?.subscription_code
  if (!code) throw Object.assign(new Error('There’s no subscription to manage yet.'), { status: 400 })
  return (await paystack('GET', `/subscription/${code}/manage/link`)).link
}
