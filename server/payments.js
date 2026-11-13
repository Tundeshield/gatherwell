// Payment records for the GatherHQ admin console, built only from Stripe's own records:
// webhook events as they arrive, plus an on-demand sync from the Stripe API. One document per
// Stripe invoice (subscriptions) or payment intent (one-off purchases), in payments/{id}.
// Amounts are stored in major units (e.g. 49.00) with their currency; nothing is converted.
import { fb, plain } from './firebase.js'

const sec = (s) => (s ? new Date(s * 1000) : null)
const id = (x) => (typeof x === 'string' ? x : x?.id || null)
const money = (minor) => Math.round(Number(minor || 0)) / 100
const stripeMode = () => (String(process.env.STRIPE_SECRET_KEY || '').startsWith('sk_live') ? 'live' : 'test')

function invoicePlan(inv) {
  const line = inv.lines?.data?.find(l => l.price || l.plan) || null
  const price = line?.price || null
  const m = /^gatherhq_(church|network)_(monthly|yearly)$/.exec(price?.lookup_key || '')
  if (m) return { plan: m[1], interval: m[2] }
  const r = price?.recurring || line?.plan
  return { plan: inv.subscription_details?.metadata?.plan || null, interval: r ? ((r.interval === 'year') ? 'yearly' : 'monthly') : null }
}

function methodOf(charge) {
  const d = charge?.payment_method_details
  if (!d) return null
  const c = d.card
  return c ? { type: 'card', brand: c.brand || null, last4: c.last4 || null } : { type: d.type || null }
}

const INVOICE_STATUS = { paid: 'paid', open: 'open', void: 'void', uncollectible: 'uncollectible', draft: 'draft' }

export function fromInvoice(inv, orgId, extra = {}) {
  const charge = typeof inv.charge === 'object' ? inv.charge : null
  const refunded = charge ? money(charge.amount_refunded) : 0
  let status = INVOICE_STATUS[inv.status] || inv.status || 'open'
  if (status === 'open' && inv.attempt_count > 0 && !inv.paid) status = 'failed'
  if (status === 'paid' && refunded > 0) status = refunded >= money(inv.amount_paid) ? 'refunded' : 'partially_refunded'
  return {
    source: 'invoice', kind: inv.subscription ? 'subscription' : 'one_off',
    org_id: orgId || inv.subscription_details?.metadata?.org_id || inv.metadata?.org_id || null,
    customer_id: id(inv.customer), subscription_id: id(inv.subscription), invoice_id: inv.id, invoice_number: inv.number || null,
    payment_intent: id(inv.payment_intent), charge_id: id(inv.charge),
    amount: money(inv.status === 'paid' ? inv.amount_paid : inv.amount_due), amount_refunded: refunded, currency: String(inv.currency || '').toLowerCase(),
    status, failure_reason: inv.last_finalization_error?.message || null,
    attempt_count: inv.attempt_count || 0, ...invoicePlan(inv),
    method: methodOf(charge), description: inv.lines?.data?.[0]?.description || 'Subscription',
    created_at: sec(inv.created), paid_at: sec(inv.status_transitions?.paid_at), due_at: sec(inv.due_date || inv.next_payment_attempt),
    livemode: !!inv.livemode, mode: inv.livemode ? 'live' : 'test', ...extra,
  }
}

export function fromCharge(ch, orgId, extra = {}) {
  const refunded = money(ch.amount_refunded)
  let status = ch.status === 'succeeded' ? 'paid' : ch.status === 'failed' ? 'failed' : 'pending'
  if (status === 'paid' && refunded > 0) status = ch.refunded || refunded >= money(ch.amount) ? 'refunded' : 'partially_refunded'
  return {
    source: 'charge', kind: ch.invoice ? 'subscription' : 'one_off',
    org_id: orgId || ch.metadata?.org_id || null, customer_id: id(ch.customer), subscription_id: null, invoice_id: id(ch.invoice), invoice_number: null,
    payment_intent: id(ch.payment_intent), charge_id: ch.id,
    amount: money(ch.amount), amount_refunded: refunded, currency: String(ch.currency || '').toLowerCase(),
    status, failure_reason: ch.status === 'failed' ? (ch.failure_message || ch.outcome?.seller_message || 'Payment failed') : null,
    attempt_count: 0, plan: null, interval: null, purpose: ch.metadata?.kind === 'credits' ? 'messaging_credit' : null,
    method: methodOf(ch), description: ch.description || (ch.metadata?.kind === 'credits' ? 'Messaging credit' : 'One-off payment'),
    created_at: sec(ch.created), paid_at: ch.status === 'succeeded' ? sec(ch.created) : null, due_at: null,
    livemode: !!ch.livemode, mode: ch.livemode ? 'live' : 'test', ...extra,
  }
}

async function orgForCustomer(db, customerId) {
  if (!customerId) return null
  return (await db.collection('billingCustomers').doc(String(customerId)).get()).data()?.org_id || null
}

async function save(db, docId, row) {
  if (!docId) return
  const ref = db.collection('payments').doc(String(docId).slice(0, 200))
  const prev = (await ref.get()).data()
  // Never move a paid record back to failed/open because of an older event arriving late.
  if (prev && ['paid', 'refunded', 'partially_refunded'].includes(prev.status) && ['failed', 'open', 'pending'].includes(row.status)) return
  const clean = Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined))
  if (!clean.org_id && prev?.org_id) clean.org_id = prev.org_id
  if (!clean.org_id) clean.org_id = await orgForCustomer(db, clean.customer_id)
  await ref.set({ ...clean, updated_at: new Date() }, { merge: true })
}

// Called for every Stripe webhook (after signature check and de-duplication).
export async function recordStripeEvent(evt, orgId) {
  const { db } = await fb()
  const d = evt.data?.object || {}
  switch (evt.type) {
    case 'invoice.paid': case 'invoice.payment_succeeded': case 'invoice.payment_failed':
    case 'invoice.finalized': case 'invoice.voided': case 'invoice.marked_uncollectible': {
      if (!(d.amount_due > 0 || d.amount_paid > 0)) return // £0 trial invoices aren't payments
      const row = fromInvoice(d, orgId)
      if (evt.type === 'invoice.payment_failed') { row.status = 'failed'; row.failure_reason = d.last_finalization_error?.message || d.last_payment_error?.message || row.failure_reason || 'Payment failed' }
      if (evt.type === 'invoice.paid' || evt.type === 'invoice.payment_succeeded') row.status = row.amount_refunded > 0 ? row.status : 'paid'
      return save(db, d.id, row)
    }
    case 'checkout.session.completed': case 'checkout.session.async_payment_succeeded': {
      if (d.mode !== 'payment' || d.payment_status !== 'paid') return
      const pi = id(d.payment_intent) || d.id
      return save(db, pi, {
        source: 'checkout', kind: 'one_off', org_id: orgId || d.metadata?.org_id || d.client_reference_id || null, customer_id: id(d.customer),
        subscription_id: null, invoice_id: id(d.invoice), invoice_number: null, payment_intent: id(d.payment_intent), charge_id: null,
        amount: money(d.amount_total), amount_refunded: 0, currency: String(d.currency || '').toLowerCase(), status: 'paid',
        purpose: d.metadata?.kind === 'credits' ? 'messaging_credit' : null, description: d.metadata?.kind === 'credits' ? 'Messaging credit' : 'One-off payment',
        created_at: sec(d.created), paid_at: sec(evt.created), livemode: !!d.livemode, mode: d.livemode ? 'live' : 'test', checkout_session: d.id,
      })
    }
    case 'payment_intent.payment_failed': {
      if (d.invoice) return // covered by invoice.payment_failed
      return save(db, d.id, {
        source: 'payment_intent', kind: 'one_off', org_id: orgId || d.metadata?.org_id || null, customer_id: id(d.customer), payment_intent: d.id,
        amount: money(d.amount), amount_refunded: 0, currency: String(d.currency || '').toLowerCase(), status: 'failed',
        failure_reason: d.last_payment_error?.message || 'Payment failed', purpose: d.metadata?.kind === 'credits' ? 'messaging_credit' : null,
        description: d.metadata?.kind === 'credits' ? 'Messaging credit' : 'One-off payment', created_at: sec(d.created), livemode: !!d.livemode, mode: d.livemode ? 'live' : 'test',
      })
    }
    case 'charge.refunded': case 'charge.refund.updated': {
      const ch = evt.type === 'charge.refunded' ? d : null
      if (!ch) return
      const refunded = money(ch.amount_refunded)
      const status = ch.refunded || refunded >= money(ch.amount) ? 'refunded' : 'partially_refunded'
      const key = id(ch.invoice) || id(ch.payment_intent)
      if (!key) return
      const ref = db.collection('payments').doc(key)
      const prev = (await ref.get()).data()
      if (prev) return ref.set({ amount_refunded: refunded, status, refunded_at: sec(evt.created), updated_at: new Date() }, { merge: true })
      return save(db, key, { ...fromCharge(ch, orgId), status, refunded_at: sec(evt.created) })
    }
    default:
  }
}

// Pulls Stripe's invoices and one-off charges (current key's mode) into payments/. Idempotent.
export async function syncFromStripe({ stripe, max = 500 } = {}) {
  const { db } = await fb()
  let invoices = 0, charges = 0, after
  for (let page = 0; page < 10 && invoices < max; page++) {
    const r = await stripe('GET', '/invoices', { limit: 100, expand: ['data.charge'], ...(after ? { starting_after: after } : {}) })
    for (const inv of r.data || []) {
      if (inv.status === 'draft' || !(inv.amount_due > 0 || inv.amount_paid > 0)) continue
      await save(db, inv.id, fromInvoice(inv, null)); invoices++
    }
    if (!r.has_more || !r.data?.length) break
    after = r.data[r.data.length - 1].id
  }
  after = undefined
  for (let page = 0; page < 10 && charges < max; page++) {
    const r = await stripe('GET', '/charges', { limit: 100, ...(after ? { starting_after: after } : {}) })
    for (const ch of r.data || []) {
      if (ch.invoice) continue // already recorded through its invoice
      await save(db, id(ch.payment_intent) || ch.id, fromCharge(ch, null)); charges++
    }
    if (!r.has_more || !r.data?.length) break
    after = r.data[r.data.length - 1].id
  }
  await db.collection('platform').doc('payments').set({ synced_at: new Date(), synced_mode: stripeMode(), last: { invoices, charges } }, { merge: true })
  return { invoices, charges }
}

export const paymentOut = (snap) => {
  const p = snap.data()
  return {
    id: snap.id, org_id: p.org_id || null, kind: p.kind, source: p.source, status: p.status, amount: p.amount || 0, amount_refunded: p.amount_refunded || 0,
    currency: p.currency || 'usd', plan: p.plan || null, interval: p.interval || null, purpose: p.purpose || null, description: p.description || null,
    method: p.method || null, failure_reason: p.failure_reason || null, attempt_count: p.attempt_count || 0,
    customer_id: p.customer_id || null, subscription_id: p.subscription_id || null, invoice_id: p.invoice_id || null, invoice_number: p.invoice_number || null,
    payment_intent: p.payment_intent || null, charge_id: p.charge_id || null, checkout_session: p.checkout_session || null,
    created_at: plain(p.created_at) || null, paid_at: plain(p.paid_at) || null, refunded_at: plain(p.refunded_at) || null, due_at: plain(p.due_at) || null,
    mode: p.mode || 'test',
  }
}

// --- revenue maths (pure; tested) --------------------------------------------------------------
// Gross = money collected (paid, incl. later refunded); refunds = amounts refunded; net = gross - refunds.
// Failed, open, void and pending payments are never revenue. Trials have no payments, so never count.
export function revenueOf(rows, { from, to } = {}) {
  const inRange = (d) => d && (!from || d >= from) && (!to || d < to)
  const by = {}
  for (const p of rows) {
    const cur = p.currency || 'usd'
    const b = (by[cur] ||= { gross: 0, refunds: 0, net: 0, subscription: 0, one_off: 0, payments: 0, failed: 0, failed_amount: 0, open: 0, open_amount: 0 })
    const paidAt = p.paid_at ? new Date(p.paid_at) : null
    if (['paid', 'refunded', 'partially_refunded'].includes(p.status) && inRange(paidAt)) {
      b.gross += p.amount; b.payments++
      b[p.kind === 'subscription' ? 'subscription' : 'one_off'] += p.amount
    }
    const refAt = p.refunded_at ? new Date(p.refunded_at) : paidAt
    if (p.amount_refunded > 0 && inRange(refAt)) b.refunds += p.amount_refunded
    const at = p.created_at ? new Date(p.created_at) : null
    if (p.status === 'failed' && inRange(at)) { b.failed++; b.failed_amount += p.amount }
    if (['open', 'uncollectible'].includes(p.status)) { b.open++; b.open_amount += p.amount }
  }
  for (const b of Object.values(by)) {
    for (const k of ['gross', 'refunds', 'subscription', 'one_off', 'failed_amount', 'open_amount']) b[k] = Math.round(b[k] * 100) / 100
    b.net = Math.round((b.gross - b.refunds) * 100) / 100
  }
  return by
}

export function monthlySeries(rows, months = 12, now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1))
  const out = Array.from({ length: months }, (_, i) => {
    const f = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1))
    const t = new Date(Date.UTC(f.getUTCFullYear(), f.getUTCMonth() + 1, 1))
    return { month: f.toISOString().slice(0, 7), ...revenueOf(rows, { from: f, to: t }) }
  })
  return out
}
