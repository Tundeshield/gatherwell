// Background work, run every minute by netlify/functions/scheduler.mjs:
//  • scheduled messages, recurring messages and workflow steps (every run)
//  • welcome-journey emails that have come due
//  • the Monday Pastor's Brief, at 7am in each church's own timezone
import { fb, col, toDate } from './firebase.js'
import { renderEmail, cleanBlocks } from '../shared/email.js'
import { journeyFor } from '../shared/automation.js'
import { emailProvider, fromAddress, sendEmails, unsubscribeUrl, siteOrigin } from './email.js'
import { brandingFor } from './routes/messages.js'
import { briefData, briefEmail } from './brief.js'
import { tzOffsetMs, weekKey } from './util.js'
import { isExpired, billingEnforced } from './billing.js'
import { billingStatus } from '../shared/plans.js'

const appOrigin = () => siteOrigin(null) || 'https://gatherhq.org'

// --- welcome journey -------------------------------------------------------------------
export function journeyMessage({ org, person, step, origin = appOrigin(), test = false }) {
  const cfg = journeyFor(org)[step]
  const branding = brandingFor(org)
  return {
    cfg, branding,
    email: renderEmail({
      org, branding, subject: (test ? '[Test] ' : '') + cfg.subject, preheader: cfg.preheader, blocks: cleanBlocks(cfg.blocks), person,
      unsubscribeUrl: test ? `${origin}/api/public/unsubscribe?test=1` : unsubscribeUrl(origin, org.id, person.id),
    }),
  }
}

async function runJourney({ now, deadline }) {
  const provider = emailProvider()
  if (!provider) return { sent: 0, skipped: 0, waiting: true }
  const { db } = await fb()
  const due = await db.collection('jobs').where('due_at', '<=', now).orderBy('due_at', 'asc').limit(200).get()
  const orgs = new Map()
  let sent = 0, skipped = 0
  for (const job of due.docs) {
    if (Date.now() > deadline) break
    const j = job.data()
    if (j.kind !== 'journey') { await job.ref.delete(); continue }
    if (!orgs.has(j.org_id)) { const o = await db.collection('orgs').doc(j.org_id).get(); orgs.set(j.org_id, o.exists ? { id: o.id, ...o.data() } : null) }
    const org = orgs.get(j.org_id)
    const pRef = org && col(db, org.id, 'people').doc(j.person_id)
    const ps = pRef && await pRef.get()
    const p = ps?.exists ? { id: ps.id, ...ps.data() } : null
    const cfg = org && journeyFor(org)[j.step]
    // Skip quietly if things changed since it was queued.
    if (!org || org.status !== 'active' || isExpired(org) || !p || p.status === 'archived' || !cfg?.enabled || !p.email || p.email_opt_out || (p.journey || {})[j.step]) {
      await job.ref.delete(); skipped++; continue
    }
    const { branding, email } = journeyMessage({ org, person: p, step: j.step })
    const unsub = unsubscribeUrl(appOrigin(), org.id, p.id)
    const [res] = await sendEmails(provider, [{
      from: fromAddress(org, branding, provider.domain), to: [String(p.email).toLowerCase()], subject: email.subject, html: email.html, text: email.text,
      ...(branding.replyTo ? { reply_to: branding.replyTo } : {}), headers: { 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
    }], `journey-${job.id}`)
    if (res.retry) { await job.ref.update({ due_at: new Date(now.getTime() + 30 * 60e3), last_error: res.error || null }); continue }
    const stats = org.journey_stats || {}
    const s = stats[j.step] || { sent: 0, failed: 0 }
    if (res.ok) { s.sent++; sent++; await pRef.update({ journey: { ...(p.journey || {}), [j.step]: now } }) } else { s.failed++; s.last_error = res.error || null }
    stats[j.step] = { ...s, last_at: now }
    org.journey_stats = stats
    await db.collection('orgs').doc(org.id).update({ journey_stats: stats })
    await job.ref.delete()
  }
  return { sent, skipped }
}

// --- Monday brief ---------------------------------------------------------------------
// Owners, admins and attendance leads get the brief.
export const BRIEF_ROLES = ['owner', 'admin', 'lead']
export async function briefRecipients(org) {
  const { db } = await fb()
  const ms = await db.collection('memberships').where('org_id', '==', org.id).where('status', '==', 'active').get()
  const admins = ms.docs.map(d => d.data()).filter(m => BRIEF_ROLES.includes(m.role))
  const users = await Promise.all(admins.map(m => db.collection('users').doc(m.user_id).get()))
  return users.filter(u => u.exists && u.data().email && !u.data().brief_opt_out).map(u => ({ id: u.id, email: u.data().email, name: u.data().name }))
}

export async function buildBrief(org, now = new Date()) {
  const data = await briefData(org, now)
  const { subject, preheader, blocks } = briefEmail(org, data, appOrigin())
  const branding = brandingFor(org)
  const email = renderEmail({ org, branding, subject, preheader, blocks, person: {},
    unsubscribeUrl: `${appOrigin()}/app/settings?tab=account`, footerReason: 'You get this because you lead in GatherHQ.', unsubscribeLabel: 'Change email settings' })
  return { data, email, branding }
}

export async function sendBrief(org, { now = new Date(), to = null } = {}) {
  const provider = emailProvider()
  if (!provider) return { sent: 0, error: 'Email sending isn’t switched on.' }
  const recipients = to || await briefRecipients(org)
  if (!recipients.length) return { sent: 0 }
  const { email, branding } = await buildBrief(org, now)
  const results = await sendEmails(provider, recipients.map(r => ({
    from: fromAddress(org, { ...branding, fromName: 'GatherHQ' }, provider.domain), to: [r.email], subject: email.subject, html: email.html, text: email.text,
  })))
  return { sent: results.filter(r => r.ok).length, error: results.find(r => !r.ok)?.error || null }
}

// Local day and hour for a church.
function localNow(tz, now) {
  const d = new Date(now.getTime() + tzOffsetMs(tz, now))
  return { day: d.getUTCDay(), hour: d.getUTCHours() }
}

async function runBriefs({ now, deadline }) {
  if (!emailProvider()) return { sent: 0, waiting: true }
  const { db } = await fb()
  const orgs = await db.collection('orgs').where('status', '==', 'active').limit(5000).get()
  let churches = 0, emails = 0
  for (const o of orgs.docs) {
    if (Date.now() > deadline) break
    const org = { id: o.id, ...o.data() }
    if (org.settings?.briefEnabled === false || isExpired(org)) continue
    const tz = org.timezone || 'Africa/Lagos'
    const { day, hour } = localNow(tz, now)
    if (day !== 1 || hour < 7) continue // Mondays from 7am local time
    const wk = weekKey(now, tz)
    if (org.brief_week === wk) continue
    // Claim this week's brief first so it can never go out twice.
    const claimed = await db.runTransaction(async (tx) => {
      const cur = (await tx.get(o.ref)).data()
      if (cur.brief_week === wk) return false
      tx.update(o.ref, { brief_week: wk, brief_sent_at: now })
      return true
    })
    if (!claimed) continue
    try { const r = await sendBrief(org, { now }); emails += r.sent; churches++ }
    catch (e) { console.error('Brief failed', org.id, e); await o.ref.update({ brief_week: null }) } // retry next run
  }
  return { churches, emails }
}

// Trial reminders to church owners: 7, 3 and 1 day before the trial ends, and on the day it ends.
// Only once churches can actually pay. Each reminder is sent once.
export function trialStage(st, now = new Date()) {
  if (st.state === 'trialing') return st.daysLeft <= 1 ? 'd1' : st.daysLeft <= 3 ? 'd3' : st.daysLeft <= 7 ? 'd7' : null
  if (st.state === 'expired' && !st.lapsed && st.trialEndsAt && now - new Date(st.trialEndsAt) < 3 * 86400e3) return 'ended'
  return null
}

export function trialEmail(org, stage, st, origin = appOrigin()) {
  const url = `${origin}/app/settings?tab=billing`
  const when = st.trialEndsAt ? new Date(st.trialEndsAt).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: org.timezone || 'Africa/Lagos' }) : ''
  const days = { d7: '7 days', d3: '3 days', d1: '1 day' }[stage]
  const subject = stage === 'ended' ? `Your GatherHQ trial has ended` : `Your GatherHQ trial ends in ${days}`
  const blocks = stage === 'ended' ? [
    { type: 'heading', text: 'Your free trial has ended' },
    { type: 'text', text: `${org.name}’s free trial of GatherHQ ended on ${when}. Check-in, follow-ups and messages are paused until you choose a plan.\n\nEverything you’ve recorded is safe. Choose a plan and you’ll pick up exactly where you left off, from $19 a month, with a 30-day money-back guarantee.` },
    { type: 'button', label: 'Choose a plan', url },
  ] : [
    { type: 'heading', text: `Your free trial ends in ${days}` },
    { type: 'text', text: `${org.name}’s free trial of GatherHQ ends on ${when}. To keep checking people in, following up visitors and sending messages without a break, choose a plan before then.\n\nPlans start at $19 a month, or $190 a year (2 months free). Cancel any time, with a 30-day money-back guarantee.` },
    { type: 'button', label: 'Choose a plan', url },
  ]
  return renderEmail({ org, branding: { fromName: 'GatherHQ' }, subject, preheader: subject, blocks, person: {},
    unsubscribeUrl: url, footerReason: 'You get this because you own this church’s GatherHQ account.', unsubscribeLabel: 'Billing settings' })
}

async function runTrialReminders({ now, deadline }) {
  const provider = emailProvider()
  if (!provider || !billingEnforced()) return { sent: 0, waiting: true }
  const { db } = await fb()
  const orgs = await db.collection('orgs').where('status', '==', 'active').limit(5000).get()
  let sent = 0
  for (const o of orgs.docs) {
    if (Date.now() > deadline) break
    const org = { id: o.id, ...o.data() }
    const st = billingStatus(org, now)
    const stage = trialStage(st, now)
    if (!stage || org.trial_reminders?.[stage]) continue
    const claimed = await db.runTransaction(async (tx) => {
      const cur = (await tx.get(o.ref)).data()
      if (cur.trial_reminders?.[stage]) return false
      tx.update(o.ref, { trial_reminders: { ...(cur.trial_reminders || {}), [stage]: now } })
      return true
    })
    if (!claimed) continue
    const ms = await db.collection('memberships').where('org_id', '==', org.id).where('status', '==', 'active').get()
    const owners = ms.docs.map(d => d.data()).filter(m => m.role === 'owner')
    const users = await Promise.all(owners.map(m => db.collection('users').doc(m.user_id).get()))
    const to = users.filter(u => u.exists && u.data().email).map(u => u.data().email)
    if (!to.length) continue
    const email = trialEmail(org, stage, st)
    const res = await sendEmails(provider, to.map(addr => ({ from: `GatherHQ <hello@${provider.domain}>`, to: [addr], subject: email.subject, html: email.html, text: email.text })))
    sent += res.filter(r => r.ok).length
  }
  return { sent }
}

export async function runScheduled({ now = new Date(), budgetMs = 20000, legacy = true } = {}) {
  const deadline = Date.now() + budgetMs
  // Communications (scheduled messages, workflows) run every minute so 10am means 10am.
  const { runComms } = await import('./comms/engine.js')
  const comms = await runComms({ now, deadline: Date.now() + Math.floor(budgetMs * 0.6) }).catch(e => { console.error('Comms run failed', e); return { error: e.message } })
  if (!legacy) return { comms }
  const journey = await runJourney({ now, deadline }).catch(e => { console.error('Journey run failed', e); return { error: e.message } })
  const briefs = await runBriefs({ now, deadline }).catch(e => { console.error('Brief run failed', e); return { error: e.message } })
  const trials = await runTrialReminders({ now, deadline }).catch(e => { console.error('Trial reminders failed', e); return { error: e.message } })
  return { comms, journey, briefs, trials }
}

export { toDate }
