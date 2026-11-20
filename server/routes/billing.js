import { bad, json } from '../http.js'
import { requireCap } from '../access.js'
import { audit } from '../util.js'
import { fb } from '../firebase.js'
import { PLANS, INTERVALS, RANK, billingStatus, peopleLimit, branchLimit, price } from '../../shared/plans.js'
import { siteOrigin } from '../email.js'
import { validSignature, handleEvent, manageLink } from '../billing.js'
import { paystackEnabled, startPaystackCheckout, applyPaystackPayment, validPaystackSignature, handlePaystackEvent, paystackOut, quote } from '../paystack.js'
import { peopleCount } from '../limits.js'

async function out(org) {
  const s = billingStatus(org)
  const b = org.billing || {}
  const { db } = await fb()
  return {
    ...s, ready: paystackEnabled(), people: await peopleCount(db, org.id), limit: peopleLimit(s), branchLimit: branchLimit(s),
    provider: b.provider || null, ...paystackOut(b),
    // Churches that subscribed by card in dollars before naira billing keep managing that subscription with Stripe.
    legacyStripe: b.provider === 'stripe' && !!b.subscription_id && ['active', 'past_due'].includes(s.state),
    lastError: s.state === 'past_due' ? b.last_error || null : null,
  }
}

export default function (r) {
  r.get('/billing', async ({ ctx }) => out(ctx.org))

  // What a plan would cost right now (after any credit for the current period).
  r.get('/billing/quote', async ({ ctx, query }) => {
    if (!PLANS[query.plan] || query.plan === 'free' || !INTERVALS[query.interval]) throw bad('Choose a plan.')
    const q = quote(ctx.org, query.plan, query.interval)
    return { amount: q.amount, credit: q.credit, full: price(query.plan, query.interval), until: q.end.toISOString(), kind: q.kind }
  })

  r.post('/billing/checkout', async ({ ctx, body, url }) => {
    requireCap(ctx, 'org.manage')
    if (!paystackEnabled()) throw bad('Payments aren’t switched on yet. Your church can keep using GatherHQ in the meantime.')
    if (!PLANS[body.plan] || body.plan === 'free' || !INTERVALS[body.interval]) throw bad('Choose a plan.')
    const s = billingStatus(ctx.org)
    const b = ctx.org.billing || {}
    // Moving to a smaller plan while paid up: it takes effect at the next renewal, with no charge now.
    if (s.state === 'active' && b.provider === 'paystack' && (RANK[body.plan] < RANK[b.plan] || (body.plan === b.plan && body.interval === 'monthly' && b.interval === 'yearly'))) {
      const { db } = await fb()
      await db.collection('orgs').doc(ctx.org.id).update({ 'billing.next_plan': body.plan, 'billing.next_interval': body.interval })
      await audit(ctx, 'billing.change_scheduled', 'organisation', ctx.org.id, { plan: body.plan, interval: body.interval })
      return { scheduled: true, from: s.renewsAt?.toISOString() }
    }
    const res = await startPaystackCheckout({ org: ctx.org, user: ctx.user, plan: body.plan, interval: body.interval, origin: siteOrigin(url) })
    await audit(ctx, 'billing.checkout_started', 'organisation', ctx.org.id, { plan: body.plan, interval: body.interval, amount: res.amount })
    return res
  })

  // After returning from Paystack's payment page.
  r.post('/billing/confirm', async ({ ctx, body }) => {
    requireCap(ctx, 'org.manage')
    const res = await applyPaystackPayment(body.reference)
    if (res.ok && res.org_id !== ctx.org.id) throw bad('This payment belongs to another church.')
    if (res.ok && !res.duplicate) await audit(ctx, 'billing.paid', 'organisation', ctx.org.id, { plan: res.plan, interval: res.interval })
    return { ok: res.ok, status: res.status || (res.ok ? 'success' : 'pending'), plan: res.plan, interval: res.interval, reason: res.ok ? null : res.reason || null }
  })

  r.post('/billing/auto-renew', async ({ ctx, body }) => {
    requireCap(ctx, 'org.manage')
    const b = ctx.org.billing || {}
    if (b.provider !== 'paystack') throw bad('There’s no naira plan to change.')
    const on = !!body.on
    if (on && !b.authorization_code) throw bad('Pay once by card to turn on automatic renewal.')
    const { db } = await fb()
    await db.collection('orgs').doc(ctx.org.id).update({ 'billing.auto_renew': on })
    await audit(ctx, on ? 'billing.auto_renew_on' : 'billing.auto_renew_off', 'organisation', ctx.org.id)
    return { ok: true, autoRenew: on }
  })

  r.post('/billing/cancel-change', async ({ ctx }) => {
    requireCap(ctx, 'org.manage')
    const { db } = await fb()
    await db.collection('orgs').doc(ctx.org.id).update({ 'billing.next_plan': null, 'billing.next_interval': null })
    return { ok: true }
  })

  // Legacy dollar subscriptions (Stripe): the card portal.
  r.post('/billing/manage', async ({ ctx, url }) => {
    requireCap(ctx, 'org.manage')
    return { url: await manageLink(ctx.org, siteOrigin(url)) }
  })

  r.post('/webhooks/paystack', { auth: 'public' }, async ({ req, raw, body }) => {
    if (!validPaystackSignature(raw || '', req.headers.get('x-paystack-signature'))) return json({ error: 'Invalid signature.' }, 401)
    const { db } = await fb()
    const id = `ps_${String(body?.data?.id || body?.data?.reference || 'unknown').slice(0, 100)}_${body?.event || ''}`
    const log = db.collection('billingEvents').doc(id)
    await log.set({ provider: 'paystack', type: body?.event || null, reference: body?.data?.reference || null, received_at: new Date() }, { merge: true })
    let res
    try { res = await handlePaystackEvent(body) } catch (e) {
      await log.set({ ok: false, error: String(e.message || e).slice(0, 300), done_at: new Date() }, { merge: true }).catch(() => {})
      throw e
    }
    await log.set({ ok: true, result: res?.ignored ? `ignored: ${res.ignored}` : res?.ok ? 'processed' : `not applied: ${res?.reason || res?.status}`, done_at: new Date() }, { merge: true }).catch(() => {})
    return json({ ok: true })
  })

  // Stripe (dollar subscriptions from before naira billing) keeps notifying us about those.
  r.post('/webhooks/stripe', { auth: 'public' }, async ({ req, raw, body }) => {
    if (!validSignature(raw || '', req.headers.get('stripe-signature'))) return json({ error: 'Invalid signature.' }, 401)
    const { db } = await fb()
    const log = db.collection('billingEvents').doc(String(body.id || '').slice(0, 200) || 'unknown')
    let res
    try { res = await handleEvent(body) } catch (e) {
      await log.set({ ok: false, error: String(e.message || e).slice(0, 300), done_at: new Date() }, { merge: true }).catch(() => {})
      throw e
    }
    if (!res?.duplicate) await log.set({ ok: true, result: res?.ignored ? `ignored: ${res.ignored}` : 'processed', done_at: new Date() }, { merge: true }).catch(() => {})
    return json({ ok: true, ...res })
  })
}
