// GatherHQ plans and prices (USD). Shared by the pricing page, the billing screen and the server.
export const CURRENCY = 'USD'
export const TRIAL_DAYS = 14
// Churches that signed up before the trial changed from 30 to 14 days keep the 30 days they were promised.
export const LEGACY_TRIAL_DAYS = 30
export const TRIAL_CHANGED_AT = '2026-11-12T16:30:00Z'
// Churches that existed before billing launched get a full trial from launch day.
export const BILLING_LAUNCH = '2026-11-02T00:00:00Z'

export const PLANS = {
  church: {
    key: 'church', name: 'Single church', monthly: 19, yearly: 190,
    blurb: 'Everything one congregation needs to welcome visitors and care for every member.',
    features: ['Unlimited people and team members', 'QR check-in and attendance reports', 'Children’s check-in with name labels and pickup codes', 'Visitor follow-ups and welcome emails', 'Monday Pastor’s Brief', 'Branded emails and one-tap WhatsApp', 'Events with registration and tickets'],
  },
  network: {
    key: 'network', name: 'Church network', monthly: 59, yearly: 590,
    blurb: 'For churches with several branches or campuses, led as one.',
    features: ['Everything in Single church', 'Unlimited branches and campuses', 'Branch-level team access', 'Reports across and by branch', 'Setup help for every branch'],
  },
}
export const INTERVALS = { monthly: 'Monthly', yearly: 'Yearly' }
export const price = (plan, interval) => PLANS[plan]?.[interval === 'yearly' ? 'yearly' : 'monthly']
// What a paying church is worth per month (yearly plans spread over 12 months).
export const monthlyValue = (plan, interval) => (PLANS[plan] ? (interval === 'yearly' ? PLANS[plan].yearly / 12 : PLANS[plan].monthly) : 0)

/**
 * Where a church stands. Returns { state, plan, interval, trialEndsAt, daysLeft, renewsAt }.
 * state: 'free' | 'trialing' | 'active' | 'past_due' | 'expired'
 */
const toD = (v) => (v && typeof v.toDate === 'function' ? v.toDate() : v ? new Date(v) : null)

export function billingStatus(org, now = new Date()) {
  const b = org?.billing || {}
  if (org?.plan === 'free') return { state: 'free', plan: 'free' }
  const renewsAt = toD(b.next_payment_date)
  // Arranged by the GatherHQ team (for example, paid by bank transfer): active until the paid-until date.
  if (b.manual && b.status === 'active') return renewsAt && renewsAt > now ? { state: 'active', plan: b.plan, interval: b.interval, renewsAt, manual: true } : { state: 'expired', plan: b.plan, lapsed: true }
  if (b.status === 'active') return { state: 'active', plan: b.plan, interval: b.interval, renewsAt }
  if (b.status === 'past_due') {
    // A week's grace to update the card.
    const graceEnds = new Date((renewsAt || now).getTime() + 7 * 86400e3)
    return graceEnds > now ? { state: 'past_due', plan: b.plan, interval: b.interval, renewsAt, graceEnds } : { state: 'expired', plan: b.plan, lapsed: true }
  }
  if (b.status === 'cancelled' && renewsAt && renewsAt > now) return { state: 'active', plan: b.plan, interval: b.interval, renewsAt, cancelling: true }
  if (b.status === 'cancelled') return { state: 'expired', plan: b.plan, lapsed: true }
  const own = toD(org?.trial_ends_at) || now
  // Churches from before 2 November get a full trial from launch day; that promise stays for churches created before the change.
  const created = toD(org?.created_at)
  const legacy = !created || created < new Date(TRIAL_CHANGED_AT)
  const launch = legacy ? new Date(new Date(BILLING_LAUNCH).getTime() + LEGACY_TRIAL_DAYS * 86400e3) : null
  const trialEndsAt = launch && launch > own ? launch : own
  const daysLeft = Math.ceil((trialEndsAt - now) / 86400e3)
  return daysLeft > 0 ? { state: 'trialing', plan: 'trial', trialEndsAt, daysLeft } : { state: 'expired', plan: 'trial', trialEndsAt }
}
