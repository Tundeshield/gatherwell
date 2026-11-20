// Plan limits by church size. The Free plan covers 50 people; paid plans cover more.
// Nobody is ever turned away at the door: check-in always works. What stops at the limit is adding
// people by hand or by import, and (on the Free plan) the automatic follow-ups and Monday Brief.
import { col } from './firebase.js'
import { PLANS, billingStatus, peopleLimit, branchLimit, planForSize, naira, price } from '../shared/plans.js'
import { paystackEnabled } from './paystack.js'
import { HttpError } from './http.js'

// Limits apply once churches can actually pay (PAYSTACK_SECRET_KEY set), unless switched off.
export const limitsEnforced = () => paystackEnabled() && process.env.BILLING_ENFORCED !== 'false'

export async function peopleCount(db, orgId) {
  const all = await col(db, orgId, 'people').count().get()
  const archived = await col(db, orgId, 'people').where('status', '==', 'archived').count().get()
  return all.data().count - archived.data().count
}

function limitError(st, limit, people) {
  const next = planForSize(people + 1)
  const where = st.state === 'free' ? `The Free plan covers up to ${limit} people` : `The ${PLANS[st.plan]?.name || ''} plan covers up to ${limit.toLocaleString()} people`
  return new HttpError(402, `${where}, and your church has ${people.toLocaleString()}. Move to ${PLANS[next].name} (from ${naira(price(next, 'yearly'))} a year) in Settings › Billing to add more. People can still check in at the door.`, { code: 'plan_limit', limit, people, suggested: next })
}

// Before adding `adding` people by hand or by import.
export async function assertRoomFor(db, org, adding = 1) {
  if (!limitsEnforced()) return
  const st = billingStatus(org)
  const limit = peopleLimit(st)
  if (limit == null) return
  const people = await peopleCount(db, org.id)
  if (people + adding > limit) throw limitError(st, limit, people)
}

export async function assertBranchRoom(db, org) {
  if (!limitsEnforced()) return
  const st = billingStatus(org)
  const limit = branchLimit(st)
  if (limit == null) return
  const n = (await col(db, org.id, 'branches').where('status', '==', 'active').count().get()).data().count
  if (n + 1 > limit) throw new HttpError(402, 'More than one branch needs the Network plan. Choose it in Settings › Billing.', { code: 'plan_limit_branches' })
}

// Free plan over its limit: automatic follow-ups, scheduled messages and the Monday Brief pause.
export async function automationPaused(db, org) {
  if (!limitsEnforced()) return false
  const st = billingStatus(org)
  if (st.state !== 'free') return false
  return (await peopleCount(db, org.id)) > PLANS.free.limit
}
