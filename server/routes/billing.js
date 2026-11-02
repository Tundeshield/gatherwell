import { bad, json } from '../http.js'
import { requireCap } from '../access.js'
import { audit } from '../util.js'
import { PLANS, INTERVALS, billingStatus } from '../../shared/plans.js'
import { billingEnabled, startCheckout, confirmPayment, validSignature, handleEvent, manageLink } from '../billing.js'

const out = (org) => {
  const s = billingStatus(org)
  const b = org.billing || {}
  return { ...s, ready: billingEnabled(), card: b.card || null, email: b.email || null, hasSubscription: b.provider === 'paddle' && !!b.customer_id && !b.manual, lastError: b.status === 'past_due' ? b.last_error || null : null }
}

export default function (r) {
  r.get('/billing', async ({ ctx }) => out(ctx.org))

  r.post('/billing/checkout', async ({ ctx, body }) => {
    requireCap(ctx, 'org.manage')
    if (!billingEnabled()) throw bad('Payments aren’t switched on yet. Your church can keep using GatherHQ for free in the meantime.')
    if (!PLANS[body.plan] || !INTERVALS[body.interval]) throw bad('Choose a plan.')
    const s = billingStatus(ctx.org)
    if (s.state === 'active' && !s.cancelling && !s.manual && s.plan === body.plan && s.interval === body.interval) throw bad('You’re already on this plan.')
    const res = await startCheckout({ org: ctx.org, user: ctx.user, plan: body.plan, interval: body.interval })
    await audit(ctx, res.changed ? 'billing.plan_changed' : 'billing.checkout_started', 'organisation', ctx.org.id, { plan: body.plan, interval: body.interval })
    return res
  })

  r.post('/billing/confirm', async ({ ctx, body }) => {
    requireCap(ctx, 'org.manage')
    const id = String(body.transactionId || '').replace(/[^\w-]/g, '').slice(0, 100)
    if (!id) throw bad('Missing payment reference.')
    const res = await confirmPayment(ctx.org, id)
    if (res.ok) await audit(ctx, 'billing.subscribed', 'organisation', ctx.org.id, { plan: res.plan, interval: res.interval })
    return res
  })

  r.post('/billing/manage', async ({ ctx }) => {
    requireCap(ctx, 'org.manage')
    return { url: await manageLink(ctx.org) }
  })

  // Paddle calls this for every payment and subscription change.
  r.post('/webhooks/paddle', { auth: 'public' }, async ({ req, raw, body }) => {
    if (!validSignature(raw || '', req.headers.get('paddle-signature'))) return json({ error: 'Invalid signature.' }, 401)
    const res = await handleEvent(body)
    return json({ ok: true, ...res })
  })
}
