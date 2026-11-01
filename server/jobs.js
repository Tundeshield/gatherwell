// Background work, run every 15 minutes by netlify/functions/scheduler.mjs:
//  • welcome-journey emails that have come due
//  • the Monday Pastor's Brief, at 7am in each church's own timezone
import { fb, col, toDate } from './firebase.js'
import { renderEmail, cleanBlocks } from '../shared/email.js'
import { journeyFor } from '../shared/automation.js'
import { emailProvider, fromAddress, sendEmails, unsubscribeUrl, siteOrigin } from './email.js'
import { brandingFor } from './routes/messages.js'
import { briefData, briefEmail } from './brief.js'
import { tzOffsetMs, weekKey } from './util.js'
import { isExpired } from './billing.js'

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

export async function runScheduled({ now = new Date(), budgetMs = 20000 } = {}) {
  const deadline = Date.now() + budgetMs
  const journey = await runJourney({ now, deadline }).catch(e => { console.error('Journey run failed', e); return { error: e.message } })
  const briefs = await runBriefs({ now, deadline }).catch(e => { console.error('Brief run failed', e); return { error: e.message } })
  return { journey, briefs }
}

export { toDate }
