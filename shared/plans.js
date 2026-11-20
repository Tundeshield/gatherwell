// GatherHQ plans and prices, in naira, priced by church size. Shared by the pricing page,
// the billing screen and the server. Paid with Paystack (card, bank transfer, USSD).
export const CURRENCY = 'NGN'
export const TRIAL_DAYS = 14
// Churches that signed up before the trial changed from 30 to 14 days keep the 30 days they were promised.
export const LEGACY_TRIAL_DAYS = 30
export const TRIAL_CHANGED_AT = '2026-11-12T16:30:00Z'
// Churches that existed before billing launched get a full trial from launch day.
export const BILLING_LAUNCH = '2026-11-02T00:00:00Z'

// limit: how many people (not archived) the plan covers; null = no limit. branches: null = unlimited.
export const PLANS = {
  free: {
    key: 'free', name: 'Free', monthly: 0, yearly: 0, limit: 50, branches: 1,
    blurb: 'For church plants and small fellowships getting started.',
    features: ['Up to 50 people', 'Every feature included', 'QR check-in and attendance', 'First-timer follow-ups and the Monday Brief', 'Children’s check-in and events', 'Unlimited team members'],
  },
  growing: {
    key: 'growing', name: 'Growing', monthly: 10000, yearly: 100000, limit: 300, branches: 1,
    blurb: 'For a growing congregation that wants to follow up every visitor.',
    features: ['Up to 300 people', 'Every feature included', 'Automatic first-timer follow-ups', 'Monday Pastor’s Brief', 'Events with registration and tickets', 'Branded emails and one-tap WhatsApp'],
  },
  established: {
    key: 'established', name: 'Established', monthly: 25000, yearly: 250000, limit: 1000, branches: 1,
    blurb: 'For established churches with several services and departments.',
    features: ['Up to 1,000 people', 'Every feature included', 'Departments and service units', 'Attendance reports by service', 'Children’s check-in with pickup codes'],
  },
  network: {
    key: 'network', name: 'Network', monthly: 60000, yearly: 600000, limit: null, branches: null,
    blurb: 'For churches with several branches or campuses, led as one.',
    features: ['Unlimited people', 'Every feature included', 'Unlimited branches and campuses', 'Branch-level team access', 'Reports across and by branch', 'Setup help for every branch'],
  },
}
export const PAID_PLANS = ['growing', 'established', 'network']
// Card subscriptions taken out in US dollars (Stripe) before naira billing. Kept for those churches only.
export const LEGACY_USD = { church: { name: 'Single church', monthly: 19, yearly: 190 }, network: { name: 'Church network', monthly: 59, yearly: 590 } }
export const RANK = { free: 0, growing: 1, established: 2, network: 3 }
export const INTERVALS = { yearly: 'Yearly', monthly: 'Monthly' }
export const DEFAULT_INTERVAL = 'yearly'
export const price = (plan, interval) => PLANS[plan]?.[interval === 'yearly' ? 'yearly' : 'monthly']
// What a paying church is worth per month (yearly plans spread over 12 months), in naira.
export const monthlyValue = (plan, interval) => (PLANS[plan] ? (interval === 'yearly' ? PLANS[plan].yearly / 12 : PLANS[plan].monthly) : 0)
export const naira = (n) => `₦${Math.round(n).toLocaleString('en-NG')}`
// The smallest paid plan that covers this many people.
export const planForSize = (people) => PAID_PLANS.find(k => PLANS[k].limit == null || people <= PLANS[k].limit)

/**
 * Where a church stands. Returns { state, plan, interval, trialEndsAt, daysLeft, renewsAt }.
 * state: 'trialing' | 'free' (the Free plan, after the trial) | 'active' | 'past_due' | 'comp' (free access given by GatherHQ)
 */
const toD = (v) => (v && typeof v.toDate === 'function' ? v.toDate() : v ? new Date(v) : null)

export function billingStatus(org, now = new Date()) {
  const b = org?.billing || {}
  // Given free use of every feature by the GatherHQ team (stored as org.plan = 'free').
  if (org?.plan === 'free') return { state: 'comp', plan: 'comp' }
  const renewsAt = toD(b.next_payment_date)
  const paid = (PLANS[b.plan] && b.plan !== 'free') || (b.provider === 'stripe' && LEGACY_USD[b.plan])
  if (paid) {
    // Paystack and plans arranged by the GatherHQ team: paid until a date. Then a week's grace to renew.
    if ((b.provider === 'paystack' || b.manual) && ['active', 'past_due', 'cancelled'].includes(b.status) && renewsAt) {
      if (renewsAt > now) return { state: 'active', plan: b.plan, interval: b.interval, renewsAt, manual: !!b.manual, cancelling: b.status === 'cancelled', autoRenew: !!b.auto_renew }
      const graceEnds = new Date(renewsAt.getTime() + 7 * 86400e3)
      if (graceEnds > now && b.status !== 'cancelled') return { state: 'past_due', plan: b.plan, interval: b.interval, renewsAt, graceEnds, manual: !!b.manual }
      return { ...afterTrial(org, now), lapsed: true, lapsedPlan: b.plan }
    }
    // Card subscriptions through Stripe (churches that subscribed in dollars before naira billing).
    if (b.status === 'active') return { state: 'active', plan: b.plan, interval: b.interval, renewsAt }
    if (b.status === 'past_due') {
      const graceEnds = new Date((renewsAt || now).getTime() + 7 * 86400e3)
      if (graceEnds > now) return { state: 'past_due', plan: b.plan, interval: b.interval, renewsAt, graceEnds }
    }
    if (b.status === 'cancelled' && renewsAt && renewsAt > now) return { state: 'active', plan: b.plan, interval: b.interval, renewsAt, cancelling: true }
  }
  return afterTrial(org, now)
}

// No paid plan: the free trial (everything, any size), then the Free plan.
function afterTrial(org, now) {
  const own = toD(org?.trial_ends_at) || now
  // Churches from before 2 November get a full trial from launch day; that promise stays for churches created before the change.
  const created = toD(org?.created_at)
  const legacy = !created || created < new Date(TRIAL_CHANGED_AT)
  const launch = legacy ? new Date(new Date(BILLING_LAUNCH).getTime() + LEGACY_TRIAL_DAYS * 86400e3) : null
  const trialEndsAt = launch && launch > own ? launch : own
  const daysLeft = Math.ceil((trialEndsAt - now) / 86400e3)
  return daysLeft > 0 ? { state: 'trialing', plan: 'trial', trialEndsAt, daysLeft } : { state: 'free', plan: 'free', trialEndsAt }
}

// How many people the church's current plan covers (null = no limit). The trial has no limit.
export function peopleLimit(st) {
  if (st.state === 'trialing' || st.state === 'comp') return null
  if (st.state === 'free') return PLANS.free.limit
  return PLANS[st.plan]?.limit ?? null
}
export function branchLimit(st) {
  if (st.state === 'trialing' || st.state === 'comp') return null
  return PLANS[st.state === 'free' ? 'free' : st.plan]?.branches ?? null
}
