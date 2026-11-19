// "Get this for your church": every church's public pages carry a referral link. A church that signs
// up through it gets an extra free month; the church that referred it gets a free month once the new
// church starts paying (so the reward can't be farmed with empty sign-ups).
import { randomBytes } from 'node:crypto'
import { fb } from './firebase.js'
import { billingStatus, monthlyValue } from '../shared/plans.js'
import { platformAudit } from './util.js'

export const FREE_MONTH_DAYS = 30
const DAY = 86_400_000
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'
const newCode = () => [...randomBytes(7)].map(b => ALPHABET[b % ALPHABET.length]).join('')
export const referralLink = (code, origin = 'https://gatherhq.org') => `${origin}/?ref=${code}`

// The church's referral code, created the first time it's needed.
export async function referralCode(db, org) {
  if (org.referral_code) return org.referral_code
  for (let i = 0; i < 5; i++) {
    const code = newCode()
    try {
      await db.runTransaction(async (tx) => {
        const ref = db.collection('referralCodes').doc(code)
        if ((await tx.get(ref)).exists) throw Object.assign(new Error('taken'), { taken: true })
        tx.set(ref, { org_id: org.id, created_at: new Date() })
        tx.update(db.collection('orgs').doc(org.id), { referral_code: code })
      })
      org.referral_code = code
      return code
    } catch (e) { if (!e.taken) throw e }
  }
  throw new Error('Could not create a referral code')
}

export async function orgForCode(db, code) {
  const c = String(code || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12)
  if (!c) return null
  const r = (await db.collection('referralCodes').doc(c).get()).data()
  if (!r) return null
  const o = await db.collection('orgs').doc(r.org_id).get()
  return o.exists && o.data().status === 'active' ? { id: o.id, code: c, ...o.data() } : null
}

// At sign-up: link the new church to the one that referred it and add its free month.
export async function recordReferral(db, { code, newOrg }) {
  const referrer = await orgForCode(db, code)
  if (!referrer || referrer.id === newOrg.id) return null
  const now = new Date()
  const orgRef = db.collection('orgs').doc(newOrg.id)
  const o = (await orgRef.get()).data()
  const trialEnds = new Date(Math.max(now.getTime(), (o.trial_ends_at?.toDate ? o.trial_ends_at.toDate() : new Date(o.trial_ends_at)).getTime()) + FREE_MONTH_DAYS * DAY)
  await orgRef.update({ referred_by: { org_id: referrer.id, org_name: referrer.name, code: referrer.code }, trial_ends_at: trialEnds })
  await db.collection('referrals').doc(newOrg.id).set({
    referrer_org_id: referrer.id, referrer_name: referrer.name, referred_org_id: newOrg.id, referred_name: newOrg.name, code: referrer.code,
    status: 'signed_up', referred_bonus_days: FREE_MONTH_DAYS, referrer_reward: null, created_at: now, qualified_at: null,
  })
  return referrer
}

// Gives a church one free month, whichever way it pays.
export async function grantFreeMonth(db, orgId, reason, { stripeFn } = {}) {
  const ref = db.collection('orgs').doc(orgId)
  const s = await ref.get()
  if (!s.exists) return { applied: false, how: 'church not found' }
  const org = { id: s.id, ...s.data() }
  const st = billingStatus(org)
  const b = org.billing || {}
  const now = new Date()
  if (st.state === 'trialing' || (st.state === 'expired' && !st.lapsed)) {
    const from = st.state === 'trialing' ? st.trialEndsAt : now
    await ref.update({ trial_ends_at: new Date(from.getTime() + FREE_MONTH_DAYS * DAY) })
    return { applied: true, how: 'trial_extended' }
  }
  if (b.manual && st.state === 'active' && st.renewsAt) {
    await ref.update({ 'billing.next_payment_date': new Date(st.renewsAt.getTime() + FREE_MONTH_DAYS * DAY) })
    return { applied: true, how: 'paid_until_extended' }
  }
  if (b.provider === 'stripe' && b.customer_id && stripeFn && ['active', 'past_due'].includes(st.state)) {
    const cents = Math.round(monthlyValue(b.plan, b.interval) * 100)
    if (cents > 0) {
      await stripeFn('POST', `/customers/${b.customer_id}/balance_transactions`, { amount: -cents, currency: 'usd', description: `GatherHQ referral: one free month (${reason})` })
      return { applied: true, how: 'stripe_credit', amount: cents / 100 }
    }
  }
  // Anything else (for example a lapsed plan): keep the month owed and apply it by hand.
  await ref.update({ referral_months_owed: (org.referral_months_owed || 0) + 1 })
  return { applied: false, how: 'owed' }
}

// When a referred church starts paying: reward the church that referred it (once).
export async function onReferredChurchPaid(orgId, { stripeFn } = {}) {
  const { db } = await fb()
  const ref = db.collection('referrals').doc(orgId)
  const claimed = await db.runTransaction(async (tx) => {
    const s = await tx.get(ref)
    if (!s.exists || s.data().status !== 'signed_up') return null
    tx.update(ref, { status: 'qualified', qualified_at: new Date() })
    return s.data()
  })
  if (!claimed) return null
  const reward = await grantFreeMonth(db, claimed.referrer_org_id, `referred ${claimed.referred_name}`, { stripeFn }).catch(e => ({ applied: false, how: 'error', error: e.message }))
  await ref.update({ referrer_reward: { ...reward, at: new Date() }, status: reward.applied ? 'rewarded' : 'qualified' })
  await platformAudit({ user: { id: 'system', email: null } }, 'referral.rewarded', { type: 'organisation', id: claimed.referrer_org_id }, { referred: claimed.referred_name, ...reward }).catch(() => {})
  return reward
}
