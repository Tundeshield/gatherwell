// GatherHQ plans and prices (USD). Shared by the pricing page, the billing screen and the server.
export const CURRENCY = 'USD'
export const TRIAL_DAYS = 30
// Churches that existed before billing launched get a full trial from launch day.
export const BILLING_LAUNCH = '2026-11-02T00:00:00Z'

export const PLANS = {
  church: {
    key: 'church', name: 'Single church', monthly: 19, yearly: 190,
    blurb: 'Everything one congregation needs to welcome visitors and care for every member.',
    features: ['Unlimited people and team members', 'QR check-in and attendance reports', 'Visitor follow-ups and welcome emails', 'Monday Pastor’s Brief', 'Branded email and WhatsApp messages', 'Events with registration and tickets'],
  },
  network: {
    key: 'network', name: 'Church network', monthly: 59, yearly: 590,
    blurb: 'For churches with several branches or campuses, led as one.',
    features: ['Everything in Single church', 'Unlimited branches and campuses', 'Branch-level team access', 'Reports across and by branch', 'Priority support'],
  },
}
export const INTERVALS = { monthly: 'Monthly', yearly: 'Yearly' }
export const price = (plan, interval) => PLANS[plan]?.[interval === 'yearly' ? 'yearly' : 'monthly']

/**
 * Where a church stands. Returns { state, plan, interval, trialEndsAt, daysLeft, renewsAt }.
 * state: 'free' | 'trialing' | 'active' | 'past_due' | 'expired'
 */
const toD = (v) => (v && typeof v.toDate === 'function' ? v.toDate() : v ? new Date(v) : null)

export function billingStatus(org, now = new Date()) {
  const b = org?.billing || {}
  if (org?.plan === 'free') return { state: 'free', plan: 'free' }
  const renewsAt = toD(b.next_payment_date)
  if (b.status === 'active') return { state: 'active', plan: b.plan, interval: b.interval, renewsAt }
  if (b.status === 'past_due') {
    // A week's grace to update the card.
    const graceEnds = new Date((renewsAt || now).getTime() + 7 * 86400e3)
    return graceEnds > now ? { state: 'past_due', plan: b.plan, interval: b.interval, renewsAt, graceEnds } : { state: 'expired', plan: b.plan, lapsed: true }
  }
  if (b.status === 'cancelled' && renewsAt && renewsAt > now) return { state: 'active', plan: b.plan, interval: b.interval, renewsAt, cancelling: true }
  if (b.status === 'cancelled') return { state: 'expired', plan: b.plan, lapsed: true }
  const own = toD(org?.trial_ends_at) || now
  const launch = new Date(new Date(BILLING_LAUNCH).getTime() + TRIAL_DAYS * 86400e3)
  const trialEndsAt = own > launch ? own : launch
  const daysLeft = Math.ceil((trialEndsAt - now) / 86400e3)
  return daysLeft > 0 ? { state: 'trialing', plan: 'trial', trialEndsAt, daysLeft } : { state: 'expired', plan: 'trial', trialEndsAt }
}
