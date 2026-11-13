// The communications engine: one-time and scheduled messages, recurring messages, workflow
// enrolments and steps, replies and opt-outs. Everything that must happen later goes through one
// queue (top-level `commsQueue`, one pointer per item) that the scheduler checks every minute.
//
// Safety rules:
//  • Each recipient of each message has exactly one delivery record (orgs/{org}/deliveries/{id}),
//    created before the provider is called. A retry never sends to someone already handled.
//  • A message or enrolment is processed under a short lease, so two scheduler runs can't overlap.
//  • Recipients of a group message are worked out when it is sent, not when it was scheduled.
//  • Consent, contact details and opt-outs are re-checked at the moment of sending.
import crypto from 'node:crypto'
import { fb, col, toDate, plain, getMany, F } from '../firebase.js'
import { renderEmail, cleanBlocks, blocksFromBody } from '../../shared/email.js'
import { fillText, nextSendingTime, nextWeekdayAt, nextRecurrence, localParts, zonedToUtc, DEFAULT_QUIET, isStopWord, smsInfo, countryName, WHATSAPP_AUTOMATION } from '../../shared/comms.js'
import { cleanAudience, audiencePeople, brandingFor } from '../routes/messages.js'
import { fromAddress, unsubscribeUrl, siteOrigin, emailProvider, sendEmails } from '../email.js'
import { activeProvider, platformConfig, smsCountries } from './providers.js'
import { rates, unitPrice, addCredits, balanceOf, money, reserve, settle, release, refundFailed } from './credits.js'
import { routeFor, sendVia, ROUTE_REASON, SMS_ADAPTERS, errorText } from './sms.js'
import { followupDoc, followupCounters } from '../domain.js'
import { isExpired } from '../billing.js'

const appOrigin = () => siteOrigin(null) || 'https://gatherhq.org'
const BATCH = 50
const LEASE_MS = 45000
const tzOf = (org) => org.timezone || 'Africa/Lagos'
const quietOf = (org) => ({ start: Number(org.settings?.quietStart ?? DEFAULT_QUIET.start), end: Number(org.settings?.quietEnd ?? DEFAULT_QUIET.end) })
const personName = (p) => [p.first_name, p.last_name].filter(Boolean).join(' ')

// --- queue -----------------------------------------------------------------------------------
const qref = (db, orgId, kind, id) => db.collection('commsQueue').doc(`${orgId}_${kind}_${id}`)
export async function enqueue(orgId, kind, refId, dueAt) {
  const { db } = await fb()
  await qref(db, orgId, kind, refId).set({ org_id: orgId, kind, ref_id: refId, due_at: dueAt, updated_at: new Date() })
}
export async function dequeue(orgId, kind, refId) {
  const { db } = await fb()
  await qref(db, orgId, kind, refId).delete().catch(() => {})
}

// --- who can be reached ----------------------------------------------------------------------
export function reachable(channel, p) {
  if (!p || p.status === 'archived') return { ok: false, why: 'ineligible' }
  if (channel === 'email') {
    const e = String(p.email || '').trim().toLowerCase()
    if (!e) return { ok: false, why: 'no_contact' }
    if (p.email_opt_out || p.consent?.email?.status === 'withdrawn') return { ok: false, why: 'opted_out' }
    return { ok: true, to: e }
  }
  if (!p.phone_norm) return { ok: false, why: 'no_contact' }
  const c = p.consent?.[channel]?.status
  if (c === 'withdrawn') return { ok: false, why: 'opted_out' }
  if (c !== 'granted') return { ok: false, why: 'no_consent' }
  return { ok: true, to: p.phone_norm }
}
export function sortRecipients(channel, people) {
  const eligible = [], excluded = { no_contact: 0, no_consent: 0, opted_out: 0, duplicate: 0 }
  const seen = new Set()
  for (const p of people) {
    const r = reachable(channel, p)
    if (!r.ok) { if (excluded[r.why] !== undefined) excluded[r.why]++; continue }
    if (seen.has(r.to)) { excluded.duplicate++; continue }
    seen.add(r.to); eligible.push({ p, to: r.to })
  }
  return { eligible, excluded }
}

// Who pays for a channel for this church: 'included' (email), 'platform' (credits) or 'church'.
export function billingFor(org, channel, adapter) {
  if (channel === 'email') return 'included'
  return org.comms?.channels?.[channel]?.billing === 'church' && adapter?.billing.includes('church') ? 'church' : 'platform'
}

export async function smsSenders(db, orgId) {
  const qs = await col(db, orgId, 'smsSenders').get()
  return Object.fromEntries(qs.docs.map(d => [d.id, d.data()]))
}
// Splits SMS recipients into those with a working route and those without, with the cost per
// country. Uses each person's own text (names change the length) and the preferred route.
export async function smsPlan(org, eligible, content = {}) {
  const { db } = await fb()
  const cfg = (await platformConfig()).sms
  const senders = await smsSenders(db, org.id)
  const routable = [], unroutable = {}, byCountry = {}
  let cost = 0
  for (const x of eligible) {
    const r = await routeFor(cfg, org, senders, x.to, { category: content.category })
    if (!r.candidates.length) { (unroutable[r.reason] ||= { count: 0, countries: [] }).count++; if (!unroutable[r.reason].countries.includes(r.country)) unroutable[r.reason].countries.push(r.country); continue }
    const seg = Math.max(1, smsInfo(fillText(content.body, vars(org, x.p))).segments)
    const unit = r.candidates[0].unit
    const c = (byCountry[r.country] ||= { count: 0, segments: 0, unit, cost: 0 })
    c.count++; c.segments += seg; c.cost = money(c.cost + seg * unit); cost += seg * unit
    routable.push(x)
  }
  return { routable, unroutable, byCountry, cost: money(cost) }
}
export async function estimate(org, channel, eligible, content = {}) {
  if (channel === 'email') return { billing: 'included', cost: 0, balance: balanceOf(org), enough: true }
  if (channel === 'sms') {
    const plan = await smsPlan(org, eligible, content)
    return { billing: 'platform', cost: plan.cost, balance: balanceOf(org), enough: balanceOf(org) >= plan.cost, byCountry: plan.byCountry, unroutable: plan.unroutable, reachable: plan.routable.length, estimated: true }
  }
  const { adapter } = await activeProvider(channel)
  const billing = billingFor(org, channel, adapter)
  if (billing !== 'platform') return { billing, cost: 0, balance: balanceOf(org), enough: true }
  const R = await rates()
  const cost = money(eligible.reduce((s, x) => s + unitPrice(R, channel, { phoneNorm: x.to, category: content.category }), 0))
  return { billing, cost, balance: balanceOf(org), enough: balanceOf(org) >= cost, placeholderRates: !!R.placeholder }
}

// Emails owners and admins once each time the balance drops past a warning level.
export async function notifyBalance(orgId, level) {
  const { db } = await fb()
  const org = await loadOrg(db, orgId)
  if (!org) return
  const text = level >= 99 ? 'Your messaging credit has run out. Text messages are paused until you add credit; emails keep going.' : `Your messaging credit is running low ($${balanceOf(org).toFixed(2)} left).`
  await col(db, orgId, 'notices').add({ kind: 'credit', level, text, created_at: new Date() }).catch(() => {})
  const provider = emailProvider()
  if (!provider) return
  const ms = await db.collection('memberships').where('org_id', '==', orgId).where('status', '==', 'active').get()
  const users = await Promise.all(ms.docs.map(d => d.data()).filter(m => ['owner', 'admin'].includes(m.role)).map(m => db.collection('users').doc(m.user_id).get()))
  const to = users.filter(u => u.exists && u.data().email).map(u => u.data().email)
  const link = `${appOrigin()}/app/communications/channels`
  if (to.length) await sendEmails(provider, to.map(addr => ({ from: `GatherHQ <hello@${provider.domain}>`, to: [addr], subject: level >= 99 ? 'Your messaging credit has run out' : 'Your messaging credit is running low',
    text: `${text}\n\nAdd credit: ${link}`, html: `<p>${text}</p><p><a href="${link}">Add credit</a></p>` })), `credit-${orgId}-${level}-${Date.now() >> 22}`).catch(() => {})
}

// Sends SMS rows one by one through the routing layer. Each recipient: one delivery record,
// one reservation, at most one accepted provider call. Stops (creditsStop) when credit runs out.
async function sendSmsRows(db, org, { rows, content, ctx = {}, messageId = null, enrolmentId = null }) {
  const cfg = (await platformConfig()).sms
  const senders = await smsSenders(db, org.id)
  let sent = 0, failed = 0, skipped = 0, cost = 0, retry = false, creditsStop = false, lastError = null
  const crossed = []
  for (const r of rows) {
    const ref = col(db, org.id, 'deliveries').doc(r.deliveryId)
    const snap = await ref.get()
    const prev = snap.exists ? snap.data() : null
    if (prev && !['queued', 'sending'].includes(prev.status)) continue // already handled
    if (prev?.status === 'sending' && prev.calling_at) { await ref.update({ status: 'unknown', error: 'Interrupted while sending. Not retried, to avoid a duplicate.' }); continue }
    const body = fillText(content.body, vars(org, r.p, ctx))
    const info = smsInfo(body)
    const segments = Math.max(1, info.segments)
    const route = await routeFor(cfg, org, senders, r.to, { category: content.category })
    const base = { message_id: messageId, enrolment_id: enrolmentId, person_id: r.p.id, name: personName(r.p), channel: 'sms', to: r.to, billing: 'platform', country: route.country, segments, preview: body.slice(0, 300), test: false }
    if (!prev) await ref.set({ ...base, status: 'sending', error: null, cost: 0, attempts: 0, created_at: new Date() })
    if (!route.candidates.length) {
      const msg = (ROUTE_REASON[route.reason] || ROUTE_REASON.unsupported_country)(countryName(route.country))
      if (route.reason === 'provider_down') { await ref.update({ status: 'queued', error: msg }); retry = true; lastError = msg; continue }
      await ref.update({ status: 'failed', error: msg, error_code: route.reason }); failed++; lastError = msg; continue
    }
    const held = money(segments * Math.max(...route.candidates.map(c => c.unit)))
    const meta = { messageId, enrolmentId, country: route.country, segments }
    const lk = prev?.ledger_round ? `${r.deliveryId}~${prev.ledger_round}` : r.deliveryId // a retry after a release gets fresh ledger ids
    const res = await reserve(org.id, lk, held, meta)
    if (!res.ok) {
      await ref.update({ status: 'queued', error: 'Waiting for messaging credit.' }); creditsStop = true
      // Tell the church once: mark the balance as exhausted and email the admins.
      const orgRef = db.collection('orgs').doc(org.id)
      const first = await db.runTransaction(async (tx) => { const c = (await tx.get(orgRef)).data()?.credits || {}; if (c.alert_level === 99) return false; tx.update(orgRef, { 'credits.alert_level': 99, 'credits.low': true }); return true })
      if (first) crossed.push(99)
      break
    }
    if (res.crossed) crossed.push(res.crossed)
    let outcome = null, lastErr = null, transient = false
    for (const cand of route.candidates) {
      await ref.update({ calling_at: new Date(), provider: cand.id, attempts: F.inc(1) })
      const x = await sendVia(cand, { to: r.to, body, key: r.deliveryId, origin: appOrigin() })
      if (x.accepted) {
        const seg = Math.max(1, Number(x.segments) || segments)
        const actual = money(seg * cand.unit)
        const st = await settle(org.id, lk, held, actual, { ...meta, segments: seg, provider: cand.id, extra: { provider_cost: x.providerCost ?? null, provider_currency: x.currency || null } })
        if (st.crossed) crossed.push(st.crossed)
        await ref.update({ status: 'sent', ledger_key: lk, provider: cand.id, provider_id: x.providerId || null, sent_at: new Date(), cost: actual, segments: seg, calling_at: null, error: null, sender: cand.from || null })
        if (x.providerId) await db.collection('providerMessages').doc(`${cand.id}_${x.providerId}`.slice(0, 300)).set({ org_id: org.id, delivery_id: r.deliveryId, message_id: messageId })
        await db.collection('smsContacts').doc(r.to).set({ last_org: org.id, orgs: F.union(org.id), updated_at: new Date() }, { merge: true })
        sent++; cost += actual; outcome = 'sent'; break
      }
      lastErr = x.error
      if (x.error.outcome === 'unknown') { outcome = 'unknown'; break } // never risk a duplicate
      if (x.error.scope === 'recipient') { outcome = 'failed'; break } // the number is the problem: another provider won't help
      transient = transient || x.error.transient // provider problem: try the next eligible provider
    }
    if (outcome === 'sent') continue
    if (outcome === 'unknown') {
      await ref.update({ status: 'unknown', error: errorText('timeout'), error_code: 'timeout', calling_at: null, reconcile: true })
      lastError = errorText('timeout'); continue // the reservation stays until the provider's records are checked
    }
    const attempts = (prev?.attempts || 0) + route.candidates.length
    await release(org.id, lk, held, meta)
    if (outcome !== 'failed' && transient && attempts < 6) {
      await ref.update({ status: 'queued', error: lastErr?.message || null, calling_at: null, ledger_round: F.inc(1) })
      retry = true; lastError = lastErr?.message || null
      continue
    }
    await ref.update({ status: 'failed', error: lastErr?.message || errorText('unknown'), error_code: lastErr?.code || 'unknown', calling_at: null }); failed++; lastError = lastErr?.message
  }
  for (const lvl of [...new Set(crossed)]) await notifyBalance(org.id, lvl).catch(() => {})
  return { sent, failed, skipped, cost: money(cost), retry, creditsStop, lastError }
}

// --- content ---------------------------------------------------------------------------------
const eventDate = (org, iso) => (iso ? new Date(iso).toLocaleString('en-GB', { timeZone: tzOf(org), weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' }) : '')
const vars = (org, p, ctx = {}) => ({ first_name: p.first_name || '', last_name: p.last_name || '', church_name: brandingFor(org).fromName || org.name, event_name: ctx.event_name || '', event_date: ctx.event_date || eventDate(org, ctx.event_starts_at) })
function payloadFor(org, channel, content, x, ctx = {}) {
  const p = x.p
  if (channel === 'email') {
    const branding = brandingFor(org)
    const v = vars(org, p, ctx)
    const blocks = (content.blocks?.length ? cleanBlocks(content.blocks) : blocksFromBody(content.body)).map(b => ({ ...b, ...(b.text ? { text: fillText(b.text, { ...v, first_name: '{first_name}', last_name: '{last_name}', church_name: '{church_name}' }) } : {}) }))
    const unsub = unsubscribeUrl(appOrigin(), org.id, p.id)
    const e = renderEmail({ org, branding, subject: fillText(content.subject, { ...v, first_name: '{first_name}', last_name: '{last_name}', church_name: '{church_name}' }), preheader: content.preheader, blocks, person: p, unsubscribeUrl: unsub })
    return { to: x.to, from: fromAddress(org, branding, process.env.EMAIL_FROM_DOMAIN || 'mail.gatherhq.org'), subject: e.subject, html: e.html, text: e.text,
      ...(branding.replyTo ? { reply_to: branding.replyTo } : {}), headers: { 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }, preview: e.text.slice(0, 300) }
  }
  const body = fillText(content.body, vars(org, p, ctx))
  return { to: x.to, body, template: content.templateName || null, category: content.category || 'marketing', preview: body.slice(0, 300) }
}

// Sends one batch, idempotently. rows: [{ deliveryId, p, to }]
async function sendRows(db, org, { channel, adapter, billing, rows, content, ctx, key, messageId = null, enrolmentId = null }) {
  const refs = rows.map(r => col(db, org.id, 'deliveries').doc(r.deliveryId))
  const snaps = await getMany(db, refs)
  const now = new Date()
  const todo = []
  const prep = db.batch()
  rows.forEach((r, i) => {
    const s = snaps[i]
    if (s.exists) {
      const st = s.data().status
      if (st === 'queued' || (st === 'sending' && adapter.idempotent)) todo.push(r)
      else if (st === 'sending') prep.update(refs[i], { status: 'unknown', error: 'Interrupted while sending. Not retried, to avoid a duplicate.' })
      return
    }
    prep.set(refs[i], { message_id: messageId, enrolment_id: enrolmentId, person_id: r.p.id, name: personName(r.p), channel, to: r.to, provider: adapter.id, billing,
      status: 'sending', error: null, cost: 0, created_at: now, test: !!adapter.mock })
    todo.push(r)
  })
  await prep.commit()
  if (!todo.length) return { sent: 0, failed: 0, cost: 0 }
  const R = billing === 'platform' ? await rates() : null
  const payloads = todo.map(r => payloadFor(org, channel, content, r, ctx))
  const prices = todo.map((r, i) => (R ? unitPrice(R, channel, { phoneNorm: r.to, category: content.category, body: payloads[i].body }) : 0))
  let results
  try { results = await adapter.send(payloads, key) } catch (e) { results = todo.map(() => ({ ok: false, error: e.message, retry: true })) }
  const done = db.batch()
  let sent = 0, failed = 0, skipped = 0, cost = 0, retry = false, fatal = null
  todo.forEach((r, i) => {
    const x = results[i] || { ok: false, error: 'No result from the provider.' }
    const ref = col(db, org.id, 'deliveries').doc(r.deliveryId)
    if (x.retry) { retry = true; done.update(ref, { status: 'queued', error: x.error || null }); return }
    if (x.fatal) fatal = x.error
    if (x.ok) {
      sent++; cost += prices[i]
      done.update(ref, { status: 'sent', provider_id: x.providerId || null, sent_at: now, cost: prices[i], preview: payloads[i].preview })
      if (x.providerId) done.set(db.collection('providerMessages').doc(`${adapter.id}_${x.providerId}`), { org_id: org.id, delivery_id: r.deliveryId, message_id: messageId })
    } else {
      const c = adapter.billsFailed ? prices[i] : 0
      cost += c
      if (x.skipped) skipped++; else failed++
      done.update(ref, { status: x.skipped ? 'skipped' : 'failed', error: x.error || 'Not delivered.', cost: c })
    }
  })
  await done.commit()
  cost = money(cost)
  if (billing === 'platform' && cost > 0) await addCredits(org.id, { amount: -cost, type: 'usage', channel, count: sent, messageId, enrolmentId })
  if (billing === 'church' && sent > 0) await addCredits(org.id, { amount: 0, type: 'church_billed', channel, count: sent, messageId, enrolmentId, note: 'Paid by your church directly to the provider' })
  return { sent, failed, skipped, cost, retry, fatal }
}

async function loadOrg(db, orgId) {
  const s = await db.collection('orgs').doc(orgId).get()
  return s.exists ? { id: s.id, ...s.data() } : null
}

// --- messages --------------------------------------------------------------------------------
const CHUNK = 2000
const dailyLimit = () => Number(process.env.EMAIL_DAILY_LIMIT || 2000)

/**
 * Sends (or continues sending) a message. Safe to call from the browser and the scheduler at the
 * same time. Returns { status, total, sent, failed, nextAt } — nextAt when more work remains.
 */
export async function processMessage(orgId, messageId, { budgetMs = 7000, now = new Date() } = {}) {
  const { db } = await fb()
  const ref = col(db, orgId, 'messages').doc(messageId)
  const t0 = Date.now()
  const claim = await db.runTransaction(async (tx) => {
    const s = await tx.get(ref)
    if (!s.exists) return { gone: true }
    const m = s.data()
    if (!['scheduled', 'sending'].includes(m.status)) return { done: m }
    if (m.status === 'scheduled' && toDate(m.send_at) > new Date(now.getTime() + 1000)) return { notYet: m }
    if (m.lease_until && toDate(m.lease_until).getTime() > t0) return { busy: m }
    tx.update(ref, { lease_until: new Date(t0 + budgetMs + LEASE_MS) })
    return { m }
  })
  const progress = (d, extra = {}) => ({ status: d.status, total: d.recipient_count || 0, sent: d.sent_count || 0, failed: d.failed_count || 0, error: d.last_error || null, pauseReason: d.pause_reason || null, ...extra })
  if (claim.gone) return { status: 'gone', nextAt: null }
  if (claim.done) return progress(claim.done, { nextAt: null })
  if (claim.notYet) return progress(claim.notYet, { nextAt: toDate(claim.notYet.send_at) })
  if (claim.busy) return progress(claim.busy, { busy: true, nextAt: new Date(Date.now() + 60000) })
  let m = { id: messageId, ...claim.m }
  const release = (patch) => ref.update({ lease_until: null, updated_at: new Date(), ...patch })
  const org = await loadOrg(db, orgId)
  if (!org || org.status !== 'active' || isExpired(org)) { await release({ status: 'paused', pause_reason: 'subscription' }); return progress({ ...m, status: 'paused', pause_reason: 'subscription' }, { nextAt: null }) }
  const sms = m.channel === 'sms'
  let adapter = null
  if (m.channel === 'whatsapp' && !WHATSAPP_AUTOMATION) {
    await release({ status: 'paused', pause_reason: 'channel', last_error: 'Automated WhatsApp isn’t available yet, so nothing was sent. Use the one-tap WhatsApp option, or send it by SMS or email.' })
    return progress({ ...m, status: 'paused', pause_reason: 'channel' }, { nextAt: null })
  }
  if (sms) { if (!Object.keys(await smsCountries()).length) adapter = null; else adapter = { id: 'routed', idempotent: true } }
  else adapter = (await activeProvider(m.channel)).adapter
  if (!adapter) { await release({ status: 'paused', pause_reason: 'channel', last_error: `${sms ? 'SMS' : m.channel === 'whatsapp' ? 'WhatsApp' : 'Email'} isn’t connected, so nothing was sent.` }); return progress({ ...m, status: 'paused', pause_reason: 'channel' }, { nextAt: null }) }
  const content = { subject: m.subject, preheader: m.preheader, blocks: m.blocks, body: m.body, category: m.category, templateName: m.template_name }

  // First run: work out who receives it, now.
  if (m.status === 'scheduled') {
    const ctx = { org, user: null, branchScope: m.scope || null }
    let people
    try { people = await audiencePeople(ctx, cleanAudience(m.audience)) } catch (e) { await release({ status: 'failed', last_error: e.message }); return progress({ ...m, status: 'failed', last_error: e.message }, { nextAt: null }) }
    let { eligible, excluded } = sortRecipients(m.channel, people)
    let smsEst = null
    if (sms) {
      const plan = await smsPlan(org, eligible, content)
      excluded = { ...excluded, no_route: Object.values(plan.unroutable).reduce((a, x) => a + x.count, 0) }
      eligible = plan.routable
      smsEst = { cost: plan.cost, byCountry: plan.byCountry, unroutable: plan.unroutable }
    }
    if (!eligible.length) {
      const err = 'Nobody in this audience could receive it when it was due to send.'
      await release({ status: 'failed', last_error: err, excluded, audience_total: people.length })
      return progress({ ...m, status: 'failed', last_error: err }, { nextAt: null })
    }
    const billing = sms ? 'platform' : billingFor(org, m.channel, adapter)
    if (billing === 'platform') {
      const est = smsEst ? { cost: smsEst.cost, balance: balanceOf(org), enough: balanceOf(org) >= smsEst.cost } : await estimate(org, m.channel, eligible, content)
      if (!est.enough) {
        await release({ status: 'paused', pause_reason: 'credits', estimate: est.cost, last_error: `Not enough messaging credit: this needs about $${est.cost.toFixed(2)} and the balance is $${est.balance.toFixed(2)}.` })
        return progress({ ...m, status: 'paused', pause_reason: 'credits' }, { nextAt: null })
      }
    }
    if (m.channel === 'email') {
      const today = new Date().toISOString().slice(0, 10)
      const orgRef = db.collection('orgs').doc(orgId)
      const over = await db.runTransaction(async (tx) => {
        const u = (await tx.get(orgRef)).data().email_usage
        const used = u?.day === today ? u.count : 0
        if (used + eligible.length > dailyLimit()) return Math.max(0, dailyLimit() - used)
        tx.update(orgRef, { email_usage: { day: today, count: used + eligible.length } })
        return null
      })
      if (over !== null) {
        const err = `This would go over your church’s daily email limit (${dailyLimit().toLocaleString()} a day). ${over.toLocaleString()} left today.`
        await release({ status: 'paused', pause_reason: 'limit', last_error: err })
        return progress({ ...m, status: 'paused', pause_reason: 'limit' }, { nextAt: null })
      }
    }
    const rows = eligible.map(x => ({ p: x.p.id, to: x.to, f: x.p.first_name || '', l: x.p.last_name || '' }))
    const chunks = Math.ceil(rows.length / CHUNK)
    for (let i = 0; i < chunks; i++) await ref.collection('queue').doc(String(i)).set({ rows: rows.slice(i * CHUNK, (i + 1) * CHUNK) })
    const patch = { status: 'sending', recipient_count: rows.length, excluded, audience_total: people.length, billing, provider: adapter.id, cursor: 0, queue_chunks: chunks, ...(smsEst ? { estimate: smsEst.cost, by_country: smsEst.byCountry, unroutable: smsEst.unroutable } : {}),
      send_id: crypto.randomBytes(4).toString('hex'), started_at: new Date(), sent_count: 0, failed_count: 0, skipped_count: 0, cost: 0, last_error: null, pause_reason: null }
    await ref.update(patch)
    m = { ...m, ...patch }
  }

  const rows = []
  for (let i = 0; i < (m.queue_chunks || 0); i++) rows.push(...((await ref.collection('queue').doc(String(i)).get()).data()?.rows || []))
  let { cursor = 0, sent_count: sent = 0, failed_count: failed = 0, skipped_count: skipped = 0, cost = 0 } = m
  let lastError = m.last_error || null, stop = null
  while (cursor < rows.length && Date.now() - t0 < budgetMs) {
    const slice = rows.slice(cursor, cursor + BATCH).map(x => ({ deliveryId: `${m.id}_${x.p}`, p: { id: x.p, first_name: x.f, last_name: x.l }, to: x.to }))
    if (sms) {
      const r = await sendSmsRows(db, org, { rows: slice, content, messageId: m.id })
      sent += r.sent; failed += r.failed; cost = money(cost + r.cost)
      if (r.failed) lastError = 'Some messages couldn’t be delivered. See the list below.'
      if (r.creditsStop) { stop = 'credits'; lastError = `Paused: messaging credit ran out after ${sent.toLocaleString()} messages. Emails are not affected.`; await ref.update({ sent_count: sent, failed_count: failed, cost }); break }
      if (r.retry) { stop = 'retry'; lastError = r.lastError || 'The SMS service was busy. Trying again shortly.'; await ref.update({ sent_count: sent, failed_count: failed, cost }); break }
      cursor += slice.length
      await ref.update({ cursor, sent_count: sent, failed_count: failed, cost, last_error: lastError })
      continue
    }
    if (m.billing === 'platform') {
      const fresh = await loadOrg(db, orgId)
      const est = await estimate(fresh, m.channel, slice, content)
      if (!est.enough) { stop = 'credits'; lastError = `Paused: messaging credit ran out after ${sent.toLocaleString()} messages.`; break }
    }
    const r = await sendRows(db, org, { channel: m.channel, adapter, billing: m.billing, rows: slice, content, ctx: {}, key: `${m.id}-${m.send_id}-${cursor}`, messageId: m.id })
    if (r.fatal) { stop = 'fatal'; lastError = r.fatal; break }
    if (r.retry) { stop = 'retry'; lastError = 'The provider was busy. Trying again shortly.'; break }
    sent += r.sent; failed += r.failed; skipped += r.skipped || 0; cost = money(cost + r.cost)
    if (r.failed) lastError = 'Some messages couldn’t be delivered. See the list below.'
    cursor += slice.length
    await ref.update({ cursor, sent_count: sent, failed_count: failed, skipped_count: skipped, cost, last_error: lastError })
  }
  const finished = cursor >= rows.length
  const status = stop === 'fatal' ? 'failed' : stop === 'credits' ? 'paused' : finished ? 'sent' : 'sending'
  const patch = { status, last_error: lastError, pause_reason: stop === 'credits' ? 'credits' : null }
  if (finished) patch.sent_at = new Date()
  await release(patch)
  const nextAt = status === 'sending' ? new Date(Date.now() + (stop === 'retry' ? 120000 : 0)) : null
  return progress({ ...m, ...patch, sent_count: sent, failed_count: failed }, { nextAt })
}

// Resend only the failed deliveries of a message (never the successful ones).
export async function retryFailed(orgId, messageId) {
  const { db } = await fb()
  const ref = col(db, orgId, 'messages').doc(messageId)
  const m = (await ref.get()).data()
  if (!m || !['sent', 'failed'].includes(m.status)) return { retried: 0 }
  const org = await loadOrg(db, orgId)
  const sms = m.channel === 'sms'
  const { adapter } = sms ? { adapter: { id: 'routed' } } : await activeProvider(m.channel)
  if (!adapter) return { retried: 0, error: 'This channel isn’t connected.' }
  const failedSnap = await col(db, orgId, 'deliveries').where('message_id', '==', messageId).get()
  const failedRows = failedSnap.docs.filter(d => d.data().status === 'failed').slice(0, 500)
  if (!failedRows.length) return { retried: 0 }
  const b = db.batch(); failedRows.forEach(d => b.update(d.ref, { status: 'queued', retried_at: new Date(), ...(sms ? { ledger_round: F.inc(1), calling_at: null } : {}) })); await b.commit()
  const people = await getMany(db, failedRows.map(d => col(db, orgId, 'people').doc(d.data().person_id)))
  const rows = []
  const gone = db.batch()
  failedRows.forEach((d, i) => {
    const p = people[i].exists ? { id: people[i].id, ...people[i].data() } : null
    const r = reachable(m.channel, p)
    if (r.ok) rows.push({ deliveryId: d.id, p, to: r.to })
    else gone.update(d.ref, { status: 'skipped', error: 'No longer eligible to receive it.' })
  })
  await gone.commit()
  const content = { subject: m.subject, preheader: m.preheader, blocks: m.blocks, body: m.body, category: m.category, templateName: m.template_name }
  if (sms) for (const r of rows) { const d = (await col(db, orgId, 'deliveries').doc(r.deliveryId).get()).data(); r.round = d?.ledger_round }
  const res = sms ? await sendSmsRows(db, org, { rows, content, messageId })
    : await sendRows(db, org, { channel: m.channel, adapter, billing: m.billing || billingFor(org, m.channel, adapter), rows, content, ctx: {}, key: `${messageId}-retry-${Date.now()}`, messageId })
  await ref.update({ sent_count: F.inc(res.sent), failed_count: F.inc(res.failed - rows.length), cost: F.inc(res.cost), last_error: res.failed ? 'Some messages still couldn’t be delivered.' : null })
  return { retried: rows.length, sent: res.sent, failed: res.failed }
}

// --- workflows -------------------------------------------------------------------------------
export const enrolmentId = (wfId, key) => `${wfId}_${key}`.slice(0, 200)

export async function enrol(org, wf, person, { context = {}, key = null } = {}) {
  const { db } = await fb()
  const id = enrolmentId(wf.id, key || person.id)
  const ref = col(db, org.id, 'enrolments').doc(id)
  const now = new Date()
  try {
    await ref.create({ workflow_id: wf.id, workflow_name: wf.name, person_id: person.id, person_name: personName(person), status: 'active', step_id: wf.steps?.[0]?.id || null, step_index: 0,
      next_at: now, wait_until: null, started_at: now, context, history: [{ at: now, type: 'start', text: 'Started' }], replied_at: null, attempts: 0, test: false })
  } catch { return null } // already enrolled
  await col(db, org.id, 'workflows').doc(wf.id).update({ enrolled_count: F.inc(1), active_count: F.inc(1) }).catch(() => {})
  await enqueue(org.id, 'enrolment', id, now)
  return id
}

// Fire a trigger for one person. `match` filters workflows by their trigger settings.
export async function fireTrigger(orgId, type, { personId, context = {}, key = null, match = () => true }) {
  const { db } = await fb()
  const wfs = (await col(db, orgId, 'workflows').where('status', '==', 'active').get()).docs.map(d => ({ id: d.id, ...d.data() }))
    .filter(w => w.trigger?.type === type && match(w.trigger))
  if (!wfs.length) return 0
  const org = await loadOrg(db, orgId)
  const ps = await col(db, orgId, 'people').doc(personId).get()
  if (!org || !ps.exists || ps.data().status === 'archived') return 0
  const person = { id: ps.id, ...ps.data() }
  let n = 0
  for (const w of wfs) if (await enrol(org, w, person, { context, key: key ? `${person.id}_${key}` : null })) n++
  return n
}

function waitUntil(w = {}, org, enr, now) {
  const tz = tzOf(org)
  if (w.kind === 'until_day') return nextWeekdayAt(now, tz, [Number(w.weekday ?? 1)], w.time)
  if (w.kind === 'until_time') return nextWeekdayAt(now, tz, null, w.time)
  if (w.kind === 'before_event') {
    const starts = enr.context?.event_starts_at ? new Date(enr.context.event_starts_at) : null
    if (!starts) return now
    const p = localParts(starts, tz)
    const day = new Date(Date.UTC(p.y, p.mo - 1, p.d - Number(w.days ?? 1)))
    const [h, mi] = String(w.time || '10:00').split(':').map(Number)
    const at = zonedToUtc({ y: day.getUTCFullYear(), mo: day.getUTCMonth() + 1, d: day.getUTCDate(), h, mi }, tz)
    return at > now ? at : now
  }
  const unit = w.unit === 'minutes' ? 60e3 : w.unit === 'hours' ? 3600e3 : 86400e3
  return new Date(now.getTime() + Math.max(0, Number(w.amount ?? 2)) * unit)
}

async function evaluate(db, org, step, enr, person) {
  switch (step.condition) {
    case 'attended': return !!person.last_seen_at && toDate(person.last_seen_at) > toDate(enr.started_at)
    case 'replied': return !!enr.replied_at
    case 'has_tag': return (person.tags || []).includes(step.tagId)
    case 'opted_out': return reachable(step.channel || 'whatsapp', person).why === 'opted_out'
    case 'registered': {
      if (!enr.context?.event_id) return false
      const qs = await col(db, org.id, 'registrations').where('event_id', '==', enr.context.event_id).where('person_id', '==', person.id).get()
      return qs.docs.some(d => d.data().status !== 'cancelled')
    }
    default: return false
  }
}

export async function createWorkflowTask(org, person, wf, { title, dueHours = 48, assigneeId = null, assigneeName = null, reason = 'workflow' }) {
  const { db } = await fb()
  const pRef = col(db, org.id, 'people').doc(person.id)
  const lock = col(db, org.id, 'followupKeys').doc(`${person.id}_${reason}_${wf.id}`.slice(0, 200))
  return db.runTransaction(async (tx) => {
    const [ps, ls] = await tx.getAll(pRef, lock)
    if (!ps.exists || ls.exists) return null
    const p = ps.data()
    const ref = col(db, org.id, 'followups').doc()
    tx.set(ref, { ...followupDoc({ branchId: p.branch_id, person: p, personId: person.id, reason, title: fillText(title, vars(org, p)).slice(0, 200), dueAt: new Date(Date.now() + Number(dueHours || 48) * 3600e3), assigneeId, assigneeName }), workflow_id: wf.id, workflow_name: wf.name })
    tx.set(lock, { followup_id: ref.id, created_at: new Date() })
    tx.update(pRef, followupCounters(p, { add: [reason] }))
    return ref.id
  })
}

/** Runs an enrolment forward until it has to wait. Returns { nextAt } or { done: true }. */
export async function processEnrolment(orgId, id, { now = new Date() } = {}) {
  const { db } = await fb()
  const ref = col(db, orgId, 'enrolments').doc(id)
  const claim = await db.runTransaction(async (tx) => {
    const s = await tx.get(ref)
    if (!s.exists) return { gone: true }
    const e = s.data()
    if (e.status !== 'active') return { gone: true }
    if (e.lease_until && toDate(e.lease_until) > now) return { busy: true }
    tx.update(ref, { lease_until: new Date(now.getTime() + LEASE_MS) })
    return { e }
  })
  if (claim.gone) return { done: true }
  if (claim.busy) return { nextAt: new Date(now.getTime() + 60000) }
  const e = { id, ...claim.e }
  const history = [...(e.history || [])]
  const log = (type, text, extra = {}) => { history.push({ at: new Date(), type, text, ...extra }); if (history.length > 60) history.splice(1, history.length - 60) }
  const finish = async (patch) => {
    await ref.update({ ...patch, history, lease_until: null, updated_at: new Date() })
    if (patch.status && patch.status !== 'active') await col(db, orgId, 'workflows').doc(e.workflow_id).update({ active_count: F.inc(-1), ...(patch.status === 'completed' ? { completed_count: F.inc(1) } : {}) }).catch(() => {})
  }
  const org = await loadOrg(db, orgId)
  const wfSnap = await col(db, orgId, 'workflows').doc(e.workflow_id).get()
  const wf = wfSnap.exists ? { id: wfSnap.id, ...wfSnap.data() } : null
  if (!org || !wf || wf.status === 'archived') { log('end', 'The workflow was removed'); await finish({ status: 'exited' }); return { done: true } }
  if (wf.status !== 'active') { await finish({}); return { nextAt: new Date(now.getTime() + 15 * 60e3) } } // paused: hold
  if (org.status !== 'active' || isExpired(org)) { await finish({}); return { nextAt: new Date(now.getTime() + 6 * 3600e3) } }
  const ps = await col(db, orgId, 'people').doc(e.person_id).get()
  const person = ps.exists ? { id: ps.id, ...ps.data() } : null
  if (!person || person.status === 'archived') { log('end', 'This person is no longer in your people list'); await finish({ status: 'exited' }); return { done: true } }

  const steps = wf.steps || []
  let idx = steps.findIndex(s => s.id === e.step_id)
  if (idx < 0) idx = Math.min(e.step_index || 0, steps.length)
  let waitUntilAt = e.wait_until ? toDate(e.wait_until) : null
  for (let guard = 0; guard < 12; guard++) {
    const step = steps[idx]
    const next = () => { idx++; waitUntilAt = null }
    if (!step) { log('end', 'Finished'); await finish({ status: 'completed', step_id: null, step_index: idx, wait_until: null, completed_at: new Date() }); return { done: true } }
    const at = { step_id: step.id, step_index: idx }
    if (step.type === 'end') { log('end', 'Finished'); await finish({ status: 'completed', ...at, wait_until: null, completed_at: new Date() }); return { done: true } }
    if (step.type === 'wait') {
      if (!waitUntilAt) {
        const until = waitUntil(step.wait, org, e, now)
        if (until > now) { log('wait', `Waiting until ${until.toISOString()}`, { until }); await finish({ ...at, wait_until: until, next_at: until }); return { nextAt: until } }
      } else if (waitUntilAt > now) { await finish({ ...at }); return { nextAt: waitUntilAt } }
      next(); continue
    }
    if (step.type === 'send') {
      const q = quietOf(org)
      const allowed = nextSendingTime(now, tzOf(org), q)
      if (allowed > now) { log('wait', 'Waiting for sending hours', { until: allowed }); await finish({ ...at, wait_until: null, next_at: allowed }); return { nextAt: allowed } }
      if (wf.exit_on_return && ['first_visit', 'second_visit', 'absent'].includes(wf.trigger?.type) && person.last_seen_at && toDate(person.last_seen_at) > toDate(e.started_at)) {
        log('end', 'They came back, so the rest of this workflow was cancelled'); await finish({ status: 'completed', step_id: null, wait_until: null, completed_at: new Date(), ended_by: 'returned' }); return { done: true }
      }
      if (step.channel === 'whatsapp' && !WHATSAPP_AUTOMATION) { log('skip', 'Not sent: automated WhatsApp isn’t available yet', { result: 'skipped' }); next(); continue }
      const r = reachable(step.channel, person)
      if (!r.ok) { log('skip', `Message not sent: ${r.why === 'no_consent' ? 'no consent for this channel' : r.why === 'opted_out' ? 'they opted out' : 'no contact details'}`, { result: 'skipped' }); next(); continue }
      if (step.channel === 'sms') {
        const window = Number((await platformConfig()).sms.resumeWindowHours || 48) * 3600e3
        const dueSince = e.blocked_since ? toDate(e.blocked_since) : null
        if (dueSince && now - dueSince > window) { log('skip', 'Not sent: it waited too long for messaging credit, so it was skipped rather than sent late', { result: 'skipped' }); e.blocked = null; e.blocked_since = null; await ref.update({ blocked: null, blocked_since: null }); next(); continue }
        const row = { deliveryId: `e_${id}_${step.id}`.slice(0, 200), p: person, to: r.to }
        const res = await sendSmsRows(db, org, { rows: [row], content: { body: step.body, category: step.category }, ctx: e.context || {}, enrolmentId: id })
        if (res.creditsStop) {
          log('wait', 'Waiting for messaging credit', { result: 'blocked' })
          const retryAt = new Date(now.getTime() + 3600e3)
          await finish({ ...at, blocked: 'credits', blocked_since: e.blocked_since || now, next_at: retryAt }); return { nextAt: retryAt }
        }
        if (res.retry && (e.attempts || 0) < 3) { log('retry', 'The SMS service was busy; trying again', { result: 'retry' }); await finish({ ...at, attempts: (e.attempts || 0) + 1, next_at: new Date(now.getTime() + 15 * 60e3) }); return { nextAt: new Date(now.getTime() + 15 * 60e3) } }
        log('send', res.sent ? `Sent ${step.title || 'a text'}` : `Couldn’t send ${step.title || 'the text'}${res.lastError ? `: ${res.lastError}` : ''}`, { result: res.sent ? 'sent' : 'failed', delivery_id: row.deliveryId })
        e.attempts = 0; if (e.blocked) { await ref.update({ blocked: null, blocked_since: null }); e.blocked = null; e.blocked_since = null } next(); continue
      }
      const { adapter } = await activeProvider(step.channel)
      if (!adapter) { log('wait', 'Waiting: this channel isn’t connected', { result: 'blocked' }); await finish({ ...at, next_at: new Date(now.getTime() + 3600e3) }); return { nextAt: new Date(now.getTime() + 3600e3) } }
      if (step.channel === 'whatsapp' && adapter.needsTemplates) {
        const t = step.templateId ? (await db.collection('orgs').doc(org.id).collection('templates').doc(String(step.templateId)).get()).data() : null
        if (t?.whatsapp?.status !== 'approved') { log('skip', 'Message not sent: its WhatsApp template isn’t approved', { result: 'failed' }); next(); continue }
      }
      const billing = billingFor(org, step.channel, adapter)
      const content = { subject: step.subject, preheader: step.preheader, blocks: step.blocks, body: step.body, category: step.category, templateName: step.templateName }
      const row = { deliveryId: `e_${id}_${step.id}`.slice(0, 200), p: person, to: r.to }
      if (billing === 'platform') {
        const est = await estimate(org, step.channel, [row], content)
        if (!est.enough) { log('wait', 'Waiting for messaging credit', { result: 'blocked' }); await finish({ ...at, blocked: 'credits', next_at: new Date(now.getTime() + 3600e3) }); return { nextAt: new Date(now.getTime() + 3600e3) } }
      }
      const res = await sendRows(db, org, { channel: step.channel, adapter, billing, rows: [row], content, ctx: e.context || {}, key: row.deliveryId, enrolmentId: id })
      if (res.retry && (e.attempts || 0) < 3) { log('retry', 'The provider was busy; trying again', { result: 'retry' }); await finish({ ...at, attempts: (e.attempts || 0) + 1, next_at: new Date(now.getTime() + 15 * 60e3) }); return { nextAt: new Date(now.getTime() + 15 * 60e3) } }
      log('send', res.sent ? `Sent ${step.title || 'a message'}` : `Couldn’t send ${step.title || 'the message'}`, { result: res.sent ? 'sent' : 'failed', delivery_id: row.deliveryId })
      e.attempts = 0; next(); continue
    }
    if (step.type === 'check') {
      const yes = await evaluate(db, org, step, e, person)
      const outcome = yes ? (step.ifYes || 'continue') : (step.ifNo || 'continue')
      log('check', `${step.condition === 'attended' ? 'Attended again' : step.condition === 'replied' ? 'Replied' : step.condition === 'registered' ? 'Registered' : step.condition === 'has_tag' ? 'Has the tag' : 'Opted out'}: ${yes ? 'yes' : 'no'}`, { result: yes ? 'yes' : 'no' })
      if (outcome === 'end') { log('end', 'Finished'); await finish({ status: 'completed', ...at, completed_at: new Date() }); return { done: true } }
      if (outcome === 'task') {
        await createWorkflowTask(org, person, wf, { title: step.taskTitle || `Follow up with {first_name} (${wf.name})`, assigneeId: step.assigneeId || wf.owner_id || null, assigneeName: step.assigneeName || null })
        log('task', 'Created a follow-up task'); await finish({ status: 'completed', ...at, completed_at: new Date() }); return { done: true }
      }
      next(); continue
    }
    if (step.type === 'task') {
      await createWorkflowTask(org, person, wf, { title: step.title || `Follow up with {first_name}`, dueHours: step.dueHours, assigneeId: step.assigneeId || null, assigneeName: step.assigneeName || null })
      log('task', 'Created a follow-up task'); next(); continue
    }
    if (step.type === 'tag' && step.tagId) {
      const t = await col(db, orgId, 'tags').doc(step.tagId).get()
      if (t.exists) { await ps.ref.update({ tags: F.union(step.tagId), updated_at: new Date() }); log('tag', `Tagged “${t.data().name}”`) }
      next(); continue
    }
    if (step.type === 'start_workflow' && step.workflowId) {
      const other = await col(db, orgId, 'workflows').doc(step.workflowId).get()
      if (other.exists && other.data().status === 'active') { await enrol(org, { id: other.id, ...other.data() }, person, { context: e.context, key: `${person.id}_from_${wf.id}` }); log('move', `Moved to “${other.data().name}”`) }
      log('end', 'Finished'); await finish({ status: 'completed', ...at, completed_at: new Date() }); return { done: true }
    }
    next()
  }
  await finish({ step_index: idx, step_id: steps[idx]?.id || null })
  return { nextAt: new Date(now.getTime() + 60000) }
}

// --- recurring ("send regularly") workflows ---------------------------------------------------
export async function scheduleRecurring(org, wf, after = new Date()) {
  const { db } = await fb()
  const next = nextRecurrence(wf.trigger?.schedule, tzOf(org), after)
  if (!next) { await dequeue(org.id, 'recurring', wf.id); await col(db, org.id, 'workflows').doc(wf.id).update({ next_run_at: null }); return null }
  await enqueue(org.id, 'recurring', wf.id, next)
  await col(db, org.id, 'workflows').doc(wf.id).update({ next_run_at: next })
  return next
}
export async function processRecurring(orgId, wfId, dueAt) {
  const { db } = await fb()
  const s = await col(db, orgId, 'workflows').doc(wfId).get()
  if (!s.exists || s.data().status !== 'active') return { done: true }
  const wf = { id: s.id, ...s.data() }
  const org = await loadOrg(db, orgId)
  const step = (wf.steps || []).find(x => x.type === 'send')
  const occurrence = toDate(dueAt)
  if (step) {
    const id = `${wf.id}_${occurrence.getTime()}`
    try {
      await col(db, orgId, 'messages').doc(id).create({
        channel: step.channel, subject: step.subject || null, preheader: step.preheader || null, blocks: step.blocks || [], body: step.body || '', category: step.category || 'marketing', template_name: step.templateName || null,
        audience: cleanAudience(wf.trigger.audience || {}), status: 'scheduled', mode: 'recurring', send_at: occurrence, workflow_id: wf.id, workflow_name: wf.name, scope: wf.scope || null,
        recipient_count: 0, created_by: wf.created_by || null, created_by_name: wf.name, created_at: new Date(), updated_at: new Date(),
      })
      await enqueue(orgId, 'message', id, occurrence)
      await col(db, orgId, 'workflows').doc(wf.id).update({ runs: F.inc(1), last_run_at: occurrence })
    } catch {} // this occurrence was already created
  }
  const next = nextRecurrence(wf.trigger?.schedule, tzOf(org), new Date(occurrence.getTime() + 60000))
  if (!next) { await col(db, orgId, 'workflows').doc(wf.id).update({ status: 'completed', next_run_at: null }); return { done: true } }
  await col(db, orgId, 'workflows').doc(wf.id).update({ next_run_at: next })
  return { nextAt: next }
}

// --- "hasn't attended for N weeks", checked hourly ---------------------------------------------
async function absenceSweep(db, now) {
  const marker = db.collection('platform').doc('commsCron')
  const go = await db.runTransaction(async (tx) => {
    const m = (await tx.get(marker)).data() || {}
    if (m.absence_at && now - toDate(m.absence_at) < 55 * 60e3) return false
    tx.set(marker, { absence_at: now }, { merge: true })
    return true
  })
  if (!go) return 0
  const trig = await db.collection('commsTriggers').where('type', '==', 'absent').get()
  let n = 0
  for (const t of trig.docs) {
    const { org_id: orgId, workflow_id: wfId } = t.data()
    const ws = await col(db, orgId, 'workflows').doc(wfId).get()
    if (!ws.exists || ws.data().status !== 'active') continue
    const wf = { id: ws.id, ...ws.data() }
    const org = await loadOrg(db, orgId)
    const cutoff = new Date(now.getTime() - Number(wf.trigger.weeks || 3) * 7 * 86400e3)
    const qs = await col(db, orgId, 'people').where('last_seen_at', '<', cutoff).limit(500).get()
    for (const d of qs.docs) {
      const p = { id: d.id, ...d.data() }
      if (!['member', 'visitor'].includes(p.status) || !(p.visit_count > 0)) continue
      const seen = toDate(p.last_seen_at).toISOString().slice(0, 10)
      if (await enrol(org, wf, p, { key: `${p.id}_${seen}` })) n++
    }
  }
  return n
}

// --- the scheduler entry point ---------------------------------------------------------------
export async function runComms({ now = new Date(), deadline = Date.now() + 18000 } = {}) {
  const started = Date.now()
  const { db } = await fb()
  const qs = await db.collection('commsQueue').where('due_at', '<=', now).orderBy('due_at', 'asc').limit(100).get()
  const stats = { messages: 0, enrolments: 0, recurring: 0, errors: 0 }
  for (const d of qs.docs) {
    if (Date.now() > deadline) break
    const j = d.data()
    let r
    try {
      if (j.kind === 'message') { r = await processMessage(j.org_id, j.ref_id, { budgetMs: Math.max(2000, Math.min(8000, deadline - Date.now() - 1000)), now }); stats.messages++ }
      else if (j.kind === 'enrolment') { r = await processEnrolment(j.org_id, j.ref_id, { now }); stats.enrolments++ }
      else if (j.kind === 'recurring') { r = await processRecurring(j.org_id, j.ref_id, j.due_at); stats.recurring++ }
      else r = { done: true }
    } catch (e) {
      console.error('comms job failed', d.id, e)
      stats.errors++
      r = { nextAt: new Date(Date.now() + 5 * 60e3) }
      await d.ref.update({ last_error: String(e.message || e).slice(0, 300), attempts: F.inc(1) }).catch(() => {})
    }
    if (r?.nextAt) await d.ref.update({ due_at: r.nextAt, updated_at: new Date() })
    else await d.ref.delete()
  }
  try { stats.absence = await absenceSweep(db, now) } catch (e) { console.error('absence sweep', e) }
  await db.collection('schedulerRuns').add({ at: now, kind: 'comms', ...stats, took_ms: Date.now() - started }).catch(() => {})
  return stats
}

// --- inbound replies, opt-outs and delivery reports ---------------------------------------------
export async function handleInbound(orgId, { channel, personId, text }) {
  const { db } = await fb()
  const pRef = col(db, orgId, 'people').doc(personId)
  const ps = await pRef.get()
  if (!ps.exists) return { ok: false }
  const p = { id: ps.id, ...ps.data() }
  const org = await loadOrg(db, orgId)
  await col(db, orgId, 'inbox').add({ person_id: p.id, person_name: personName(p), channel, text: String(text).slice(0, 2000), created_at: new Date(), stop: isStopWord(text) })
  if (isStopWord(text)) {
    await pRef.update({ [`consent.${channel}`]: { status: 'withdrawn', at: new Date(), source: 'reply', wording: String(text).slice(0, 40) }, updated_at: new Date() })
    return { ok: true, optedOut: true }
  }
  const enr = await col(db, orgId, 'enrolments').where('person_id', '==', p.id).where('status', '==', 'active').get()
  let paused = 0
  for (const d of enr.docs) {
    const e = d.data()
    const ws = await col(db, orgId, 'workflows').doc(e.workflow_id).get()
    const wf = ws.exists ? { id: ws.id, ...ws.data() } : null
    const history = [...(e.history || []), { at: new Date(), type: 'reply', text: `Replied: “${String(text).slice(0, 80)}”` }]
    if (wf && wf.pause_on_reply !== false) {
      await d.ref.update({ replied_at: new Date(), status: 'paused_reply', history })
      await dequeue(orgId, 'enrolment', d.id)
      await col(db, orgId, 'workflows').doc(wf.id).update({ active_count: F.inc(-1) }).catch(() => {})
      await createWorkflowTask(org, p, wf, { title: `Reply from {first_name}: “${String(text).slice(0, 80)}”`, dueHours: 24, assigneeId: wf.owner_id || null, reason: 'reply' })
      paused++
    } else await d.ref.update({ replied_at: new Date(), history })
  }
  return { ok: true, paused }
}

const RANK = { queued: 0, sending: 1, sent: 2, delivered: 3, read: 4 }
export async function updateDelivery(orgId, deliveryId, status, error = null) {
  const { db } = await fb()
  const ref = col(db, orgId, 'deliveries').doc(deliveryId)
  const d = (await ref.get()).data()
  if (!d) return false
  if (status !== 'failed' && (RANK[status] ?? -1) <= (RANK[d.status] ?? -1)) return false
  await ref.update({ status, ...(status === 'failed' ? { error: error || 'Not delivered.' } : {}), [`${status}_at`]: new Date() })
  if (d.message_id) {
    const inc = {}
    if (status === 'delivered' || status === 'read') { if ((RANK[d.status] ?? 0) < 3) inc.delivered_count = F.inc(1); if (status === 'read') inc.read_count = F.inc(1) }
    if (status === 'failed' && d.status !== 'failed') { inc.failed_count = F.inc(1); if (d.status === 'sent') inc.sent_count = F.inc(-1) }
    if (Object.keys(inc).length) await col(db, orgId, 'messages').doc(d.message_id).update(inc)
  }
  return true
}
export async function providerReport(adapterId, providerId, status, error) {
  const { db } = await fb()
  const m = (await db.collection('providerMessages').doc(`${adapterId}_${providerId}`.slice(0, 300)).get()).data()
  if (!m) return false
  const changed = await updateDelivery(m.org_id, m.delivery_id, status, error)
  // A provider that doesn't bill undelivered texts: give the credit back, once.
  if (changed && status === 'failed' && SMS_ADAPTERS[adapterId] && !SMS_ADAPTERS[adapterId].billsFailed) {
    const d = (await col(db, m.org_id, 'deliveries').doc(m.delivery_id).get()).data()
    if (d?.cost > 0) await refundFailed(m.org_id, d.ledger_key || m.delivery_id, d.cost, { messageId: d.message_id, enrolmentId: d.enrolment_id, country: d.country })
  }
  return changed
}

// A text from a phone number to a provider number. STOP opts the number out of SMS at every
// church that has texted it through GatherHQ; any other reply goes to the church that texted
// it most recently.
export async function smsInbound(fromNumber, text) {
  const { db } = await fb()
  const phone = String(fromNumber || '').replace(/\D/g, '')
  const c = (await db.collection('smsContacts').doc(phone).get()).data()
  if (!c) return { ok: false }
  const orgs = isStopWord(text) ? (c.orgs || [c.last_org]) : [c.last_org]
  let n = 0
  for (const orgId of orgs) {
    const link = (await col(db, orgId, 'phones').doc(phone).get()).data()
    if (!link?.person_id) continue
    await handleInbound(orgId, { channel: 'sms', personId: link.person_id, text }); n++
  }
  return { ok: n > 0 }
}

export { plain }
