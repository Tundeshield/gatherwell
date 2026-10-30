import { fb, col, docOut, plain, toDate } from '../firebase.js'
import { bad, notFound, str, oneOf, uuid, date, isUuid } from '../http.js'
import { requireCap, branchFilter } from '../access.js'
import { audit, rateLimit, shortId } from '../util.js'
import { findPeople, STATUSES } from './people.js'
import { toCsv, csvResponse } from '../domain.js'
import { renderEmail, cleanBlocks, cleanBranding, blocksFromBody } from '../../shared/email.js'
import { emailProvider, fromAddress, sendEmails, unsubscribeUrl, checkUnsubToken, siteOrigin, parseImage } from '../email.js'

const CHANNELS = ['sms', 'email', 'whatsapp']
const LABEL = { sms: 'SMS', email: 'Email', whatsapp: 'WhatsApp' }
const CHUNK = 2000 // recipients per queue document
const BATCH = 100 // emails per provider call
const dailyLimit = () => Number(process.env.EMAIL_DAILY_LIMIT || 2000)

export function providerFor(channel) {
  if (channel === 'email') return emailProvider() ? 'resend' : null
  return { sms: process.env.SMS_PROVIDER, whatsapp: process.env.WHATSAPP_PROVIDER }[channel] || null
}

function cleanAudience(a = {}) {
  return {
    branch: a.branch && isUuid(a.branch) ? a.branch : null,
    statuses: (Array.isArray(a.statuses) ? a.statuses : []).filter(s => STATUSES.includes(s) && s !== 'archived'),
    unit: a.unit && isUuid(a.unit) ? a.unit : null,
    segment: oneOf(a.segment, ['all', 'first_timers_30d', 'absent', 'recent'], { name: 'Segment', fallback: 'all' }),
  }
}

async function audiencePeople(ctx, audience) {
  await branchFilter(ctx, audience.branch)
  const q = { branch: audience.branch || undefined, unit: audience.unit || undefined, status: audience.statuses.length ? audience.statuses.join(',') : undefined }
  if (audience.segment === 'absent') q.attendance = 'absent'
  if (audience.segment === 'recent') q.attendance = 'recent'
  if (audience.segment === 'first_timers_30d') q.firstVisitSince = new Date(Date.now() - 30 * 86400000).toISOString()
  return (await findPeople(ctx, q, { all: true })).rows
}

// People who can actually receive an email: has an address, hasn't unsubscribed, one email each.
function emailRecipients(people) {
  const seen = new Set()
  return people.filter(p => {
    const e = String(p.email || '').trim().toLowerCase()
    if (!e || p.email_opt_out || seen.has(e)) return false
    seen.add(e); return true
  })
}

export function brandingFor(org) {
  const b = org.email_branding || {}
  return cleanBranding({ fromName: b.fromName || org.name, replyTo: b.replyTo || org.contact_email || '', color: b.color, logoUrl: b.logoUrl, footer: b.footer, website: b.website })
}

const plainText = (blocks) => cleanBlocks(blocks).map(b => b.text || b.label || '').filter(Boolean).join('\n\n').slice(0, 2000)
const htmlPage = (title, body) => new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
<body style="margin:0;background:#F6F7F3;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#243447"><div style="max-width:460px;margin:64px auto;padding:32px;background:#fff;border-radius:16px;border:1px solid #E3E7E1;text-align:center">${body}</div></body></html>`,
{ status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })
const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

const out = (m) => {
  const blocks = m.channel === 'email' ? (m.blocks?.length ? m.blocks : blocksFromBody(m.body)) : []
  return { id: m.id, channel: m.channel, subject: m.subject || null, preheader: m.preheader || null, body: m.body || '', blocks, audience: m.audience, status: m.status,
    recipient_count: m.recipient_count || 0, sent_count: m.sent_count || 0, failed_count: m.failed_count || 0, last_error: m.last_error || null,
    created_by_name: m.created_by_name || null, created_at: m.created_at, updated_at: m.updated_at, sent_at: m.sent_at || null }
}

function readContent(channel, body, { partial = false } = {}) {
  const c = {}
  if (channel === 'email') {
    if (!partial || body.subject !== undefined) c.subject = str(body.subject, { max: 200, name: 'Subject' })
    if (!partial || body.preheader !== undefined) c.preheader = str(body.preheader, { max: 200, name: 'Preview text' })
    if (!partial || body.blocks !== undefined) { c.blocks = cleanBlocks(body.blocks); c.body = plainText(c.blocks) }
  } else if (!partial || body.body !== undefined) {
    c.body = str(body.body, { max: channel === 'sms' ? 918 : 4000, name: 'Message' }) || ''
  }
  return c
}

export default function (r) {
  // --- email branding ----------------------------------------------------------------
  r.get('/email/settings', async ({ ctx }) => {
    requireCap(ctx, 'messages.manage')
    const p = emailProvider()
    const used = ctx.org.email_usage?.day === new Date().toISOString().slice(0, 10) ? ctx.org.email_usage.count : 0
    return { branding: brandingFor(ctx.org), connected: !!p, fromAddress: p ? fromAddress(ctx.org, brandingFor(ctx.org), p.domain) : null, dailyLimit: dailyLimit(), usedToday: used }
  })

  r.patch('/email/branding', async ({ ctx, body }) => {
    requireCap(ctx, 'org.manage')
    const { db } = await fb()
    if (body.replyTo && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.replyTo)) throw bad('Please enter a valid reply-to email address.', { fields: { replyTo: 'Not a valid email address.' } })
    if (body.website && !/^https?:\/\//i.test(body.website)) body.website = 'https://' + String(body.website).trim()
    const b = cleanBranding({ ...brandingFor(ctx.org), ...body })
    await db.collection('orgs').doc(ctx.org.id).update({ email_branding: b, updated_at: new Date() })
    await audit(ctx, 'email.branding_updated', 'organisation', ctx.org.id)
    return b
  })

  // Images for logos and emails, served from a public URL so email apps can load them.
  r.post('/email/assets', async ({ ctx, body, url }) => {
    requireCap(ctx, 'messages.manage')
    await rateLimit(`asset:${ctx.org.id}`, 60, 3600)
    const img = parseImage(body.dataUrl)
    if (!img) throw bad('Please choose a PNG, JPG, GIF or WebP image.')
    if (img.tooBig) throw bad('That image is too large. Please use one under 600 KB.')
    const { db } = await fb()
    const ref = col(db, ctx.org.id, 'assets').doc()
    await ref.set({ mime: img.mime, data: img.data, size: img.size, kind: body.kind === 'logo' ? 'logo' : 'image', created_at: new Date(), created_by: ctx.user.id })
    return { url: `${siteOrigin(url)}/api/public/asset/${ctx.org.id}/${ref.id}` }
  })

  r.get('/public/asset/:org/:id', { auth: 'public' }, async ({ params }) => {
    if (!isUuid(params.org) || !isUuid(params.id)) throw notFound()
    const { db } = await fb()
    const a = (await col(db, params.org, 'assets').doc(params.id).get()).data()
    if (!a) throw notFound()
    return new Response(Buffer.from(a.data, 'base64'), { status: 200, headers: { 'content-type': a.mime, 'cache-control': 'public, max-age=31536000, immutable' } })
  })

  // --- unsubscribe (link in every email, and one-click from email apps) ---------------
  async function unsubscribe(query) {
    const { o, p, t } = query
    if (!isUuid(o) || !isUuid(p) || !checkUnsubToken(o, p, t)) return null
    const { db } = await fb()
    const ref = col(db, o, 'people').doc(p)
    const snap = await ref.get()
    if (snap.exists) await ref.update({ email_opt_out: true, email_opt_out_at: new Date() })
    const org = (await db.collection('orgs').doc(o).get()).data()
    return org ? brandingFor({ id: o, ...org }).fromName : 'this church'
  }
  r.get('/public/unsubscribe', { auth: 'public' }, async ({ query }) => {
    if (query.test) return htmlPage('Unsubscribe', '<h1 style="font-size:20px">This is a test email</h1><p>The real email will have a working unsubscribe link here.</p>')
    const { o, p, t } = query
    if (!isUuid(o) || !isUuid(p) || !checkUnsubToken(o, p, t)) return htmlPage('Unsubscribe', '<h1 style="font-size:20px">This link isn’t valid</h1><p>It may have been copied incorrectly.</p>')
    const action = `/api/public/unsubscribe?o=${encodeURIComponent(o)}&p=${encodeURIComponent(p)}&t=${encodeURIComponent(t)}`
    return htmlPage('Unsubscribe', `<h1 style="font-size:20px;margin:0 0 12px">Stop receiving these emails?</h1><p style="color:#5B6B7A;margin:0 0 24px">You’ll no longer get email announcements from this church. You can ask them to add you back at any time.</p>
<form method="post" action="${escHtml(action)}"><button type="submit" style="background:#244E43;color:#fff;border:0;border-radius:8px;padding:12px 22px;font-size:15px;font-weight:600;cursor:pointer">Unsubscribe</button></form>`)
  })
  r.post('/public/unsubscribe', { auth: 'public', form: true }, async ({ query }) => {
    const name = await unsubscribe(query)
    if (!name) return htmlPage('Unsubscribe', '<h1 style="font-size:20px">This link isn’t valid</h1>')
    return htmlPage('Unsubscribed', `<h1 style="font-size:20px;margin:0 0 12px">You’ve been unsubscribed</h1><p style="color:#5B6B7A;margin:0">You won’t receive email announcements from ${escHtml(name)} any more.</p>`)
  })

  // --- messages ---------------------------------------------------------------------
  r.get('/messages', async ({ ctx }) => {
    requireCap(ctx, 'messages.manage')
    const { db } = await fb()
    const qs = await col(db, ctx.org.id, 'messages').orderBy('created_at', 'desc').limit(100).get()
    return { rows: qs.docs.map(d => out({ id: d.id, ...plain(d.data()) })), providers: Object.fromEntries(CHANNELS.map(c => [c, !!providerFor(c)])) }
  })

  r.post('/messages/audience', async ({ ctx, body }) => {
    requireCap(ctx, 'messages.manage')
    const people = await audiencePeople(ctx, cleanAudience(body.audience))
    const sorted = [...people].sort((a, b) => String(a.first_name).localeCompare(String(b.first_name)))
    return {
      counts: { total: people.length, with_phone: people.filter(p => p.phone_norm).length, with_email: emailRecipients(people).length, unsubscribed: people.filter(p => p.email && p.email_opt_out).length },
      sample: sorted.slice(0, 8).map(s => [s.first_name, s.last_name ? s.last_name[0] + '.' : ''].join(' ').trim()),
    }
  })

  r.post('/messages', async ({ ctx, body }) => {
    requireCap(ctx, 'messages.manage')
    const { db } = await fb()
    const channel = oneOf(body.channel, CHANNELS, { name: 'Channel', fallback: 'email' })
    const audience = cleanAudience(body.audience)
    const data = { channel, ...readContent(channel, body), audience, recipient_count: 0, status: 'draft',
      scheduled_for: body.scheduledFor ? new Date(date(body.scheduledFor)) : null, created_by: ctx.user.id, created_by_name: ctx.user.name, created_at: new Date(), updated_at: new Date() }
    const ref = await col(db, ctx.org.id, 'messages').add(data)
    await audit(ctx, 'message.drafted', 'message', ref.id, { channel })
    return out({ id: ref.id, ...plain(data) })
  })

  async function loadMessage(db, ctx, id) {
    const m = docOut(await col(db, ctx.org.id, 'messages').doc(uuid(id)).get())
    if (!m) throw notFound()
    return m
  }

  r.get('/messages/:id', async ({ ctx, params }) => {
    requireCap(ctx, 'messages.manage')
    const { db } = await fb()
    return out(await loadMessage(db, ctx, params.id))
  })

  r.patch('/messages/:id', async ({ ctx, params, body }) => {
    requireCap(ctx, 'messages.manage')
    const { db } = await fb()
    const m = await loadMessage(db, ctx, params.id)
    if (m.status !== 'draft') throw bad('Only drafts can be edited.')
    const channel = body.channel !== undefined ? oneOf(body.channel, CHANNELS, { name: 'Channel', fallback: m.channel }) : m.channel
    const patch = { channel, ...readContent(channel, body, { partial: channel === m.channel }), updated_at: new Date() }
    if (body.audience !== undefined) patch.audience = cleanAudience(body.audience)
    await col(db, ctx.org.id, 'messages').doc(m.id).update(patch)
    return out({ ...m, ...plain(patch) })
  })

  r.delete('/messages/:id', async ({ ctx, params }) => {
    requireCap(ctx, 'messages.manage')
    const { db } = await fb()
    const m = await loadMessage(db, ctx, params.id)
    if (m.status !== 'draft') throw bad('Only drafts can be deleted.')
    await col(db, ctx.org.id, 'messages').doc(m.id).delete()
    return { ok: true }
  })

  // Sends the email to the signed-in user, exactly as members will see it.
  r.post('/messages/test', async ({ ctx, body, url }) => {
    requireCap(ctx, 'messages.manage')
    const provider = emailProvider()
    if (!provider) throw bad('Email sending isn’t switched on yet, so a test can’t be sent. The preview shows exactly how it will look.')
    await rateLimit(`emailtest:${ctx.user.id}`, 15, 3600)
    const subject = str(body.subject, { max: 200, required: true, name: 'Subject' })
    const blocks = cleanBlocks(body.blocks)
    if (!blocks.length) throw bad('Add some content before sending a test.')
    const branding = brandingFor(ctx.org)
    const first = String(ctx.user.name || '').split(' ')[0]
    const e = renderEmail({ org: ctx.org, branding, subject: `[Test] ${subject}`, preheader: body.preheader, blocks, person: { first_name: first, last_name: '' }, unsubscribeUrl: `${siteOrigin(url)}/api/public/unsubscribe?test=1` })
    const [res] = await sendEmails(provider, [{ from: fromAddress(ctx.org, branding, provider.domain), to: [ctx.user.email], subject: e.subject, html: e.html, text: e.text, ...(branding.replyTo ? { reply_to: branding.replyTo } : {}) }])
    if (!res.ok) throw bad(`The test couldn’t be sent: ${res.error}`)
    return { ok: true, to: ctx.user.email }
  })

  /**
   * Sends an email message. Works in rounds: each call sends as many as fit in a few seconds
   * and returns progress; the browser calls again until status is "sent". A lock stops two
   * tabs sending at once, and idempotency keys stop a retried round being delivered twice.
   */
  r.post('/messages/:id/send', async ({ ctx, params, url }) => {
    requireCap(ctx, 'messages.manage')
    const { db } = await fb()
    const m = await loadMessage(db, ctx, params.id)
    if (m.channel !== 'email') throw bad(`${LABEL[m.channel]} sending isn’t available yet. Download the recipient list to send it from another tool.`)
    const provider = emailProvider()
    if (!provider) throw bad('Email sending isn’t switched on yet. Nothing was sent.')
    const progress = (d) => ({ status: d.status, total: d.recipient_count || 0, sent: d.sent_count || 0, failed: d.failed_count || 0, error: d.last_error || null })
    if (m.status === 'sent') return progress(m)
    if (m.status === 'draft') {
      if (!m.subject) throw bad('Add a subject before sending.')
      if (!cleanBlocks(m.blocks).length) throw bad('This email is empty. Add some content before sending.')
    }

    const ref = col(db, ctx.org.id, 'messages').doc(m.id)
    const now = Date.now()
    const claim = await db.runTransaction(async (tx) => {
      const d = (await tx.get(ref)).data()
      if (d.status === 'sent') return { done: d }
      if (d.lock_until && toDate(d.lock_until).getTime() > now) return { busy: d }
      tx.update(ref, { lock_until: new Date(now + 25000) })
      return { d }
    })
    if (claim.done) return progress(claim.done)
    if (claim.busy) return { ...progress(claim.busy), busy: true }
    let d = claim.d

    // First round: freeze the recipient list.
    if (d.status === 'draft') {
      const people = emailRecipients(await audiencePeople(ctx, cleanAudience(d.audience)))
      if (!people.length) { await ref.update({ lock_until: null }); throw bad('Nobody in this audience has an email address.') }
      const today = new Date().toISOString().slice(0, 10)
      const orgRef = db.collection('orgs').doc(ctx.org.id)
      const usage = await db.runTransaction(async (tx) => {
        const u = (await tx.get(orgRef)).data().email_usage
        const used = u?.day === today ? u.count : 0
        if (used + people.length > dailyLimit()) return { over: true, left: Math.max(0, dailyLimit() - used) }
        tx.update(orgRef, { email_usage: { day: today, count: used + people.length } })
        return { ok: true }
      })
      if (usage.over) {
        await ref.update({ lock_until: null })
        throw bad(`This would go over your church’s daily email limit (${dailyLimit().toLocaleString()} a day). ${usage.left.toLocaleString()} left today; this email has ${people.length.toLocaleString()} recipients.`)
      }
      const rows = people.map(p => ({ p: p.id, e: String(p.email).trim().toLowerCase(), f: p.first_name || '', l: p.last_name || '' }))
      const chunks = Math.ceil(rows.length / CHUNK)
      for (let i = 0; i < chunks; i++) await ref.collection('queue').doc(String(i)).set({ rows: rows.slice(i * CHUNK, (i + 1) * CHUNK) })
      d = { ...d, status: 'sending', recipient_count: rows.length, sent_count: 0, failed_count: 0, cursor: 0, queue_chunks: chunks, send_id: shortId(8), started_at: new Date(), started_by: ctx.user.id, started_by_name: ctx.user.name }
      await ref.update({ status: d.status, recipient_count: d.recipient_count, sent_count: 0, failed_count: 0, cursor: 0, queue_chunks: chunks, send_id: d.send_id, started_at: d.started_at, started_by: ctx.user.id, started_by_name: ctx.user.name, last_error: null })
      await audit(ctx, 'message.send_started', 'message', m.id, { recipients: rows.length })
    }

    const rows = []
    for (let i = 0; i < d.queue_chunks; i++) rows.push(...((await ref.collection('queue').doc(String(i)).get()).data()?.rows || []))
    const branding = brandingFor(ctx.org)
    const from = fromAddress(ctx.org, branding, provider.domain)
    const origin = siteOrigin(url)
    let { cursor = 0, sent_count: sent = 0, failed_count: failed = 0 } = d
    let lastError = d.last_error || null
    let fatal = false
    const started = Date.now()
    while (cursor < rows.length && Date.now() - started < 7000) {
      const slice = rows.slice(cursor, cursor + BATCH)
      const emails = slice.map(x => {
        const unsub = unsubscribeUrl(origin, ctx.org.id, x.p)
        const e = renderEmail({ org: ctx.org, branding, subject: d.subject, preheader: d.preheader, blocks: d.blocks, person: { first_name: x.f, last_name: x.l }, unsubscribeUrl: unsub })
        return { from, to: [x.e], subject: e.subject, html: e.html, text: e.text, ...(branding.replyTo ? { reply_to: branding.replyTo } : {}),
          headers: { 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } }
      })
      const results = await sendEmails(provider, emails, `${m.id}-${d.send_id}-${cursor}`)
      if (results.some(x => x.fatal)) { fatal = true; lastError = results[0].error; break }
      if (results.some(x => x.retry)) { lastError = results.find(x => x.retry).error; break }
      sent += results.filter(x => x.ok).length
      const rejected = results.filter(x => !x.ok)
      failed += rejected.length
      if (rejected.length) lastError = rejected[0].error
      cursor += slice.length
      await ref.update({ cursor, sent_count: sent, failed_count: failed, last_error: lastError })
    }

    const finished = cursor >= rows.length
    const status = fatal ? 'failed' : finished ? 'sent' : 'sending'
    const patch = { status, lock_until: null, last_error: lastError }
    if (finished) patch.sent_at = new Date()
    await ref.update(patch)
    if (finished) await audit(ctx, 'message.sent', 'message', m.id, { sent, failed })
    return progress({ ...d, ...patch, sent_count: sent, failed_count: failed })
  })

  // Recipient list, for sending through another tool.
  r.get('/messages/:id/recipients', async ({ ctx, params }) => {
    requireCap(ctx, 'messages.manage')
    requireCap(ctx, 'export')
    const { db } = await fb()
    const m = await loadMessage(db, ctx, params.id)
    const all = await audiencePeople(ctx, cleanAudience(m.audience))
    const people = (m.channel === 'email' ? emailRecipients(all) : all.filter(p => p.phone_norm))
      .sort((a, b) => String(a.first_name).localeCompare(String(b.first_name)))
    await audit(ctx, 'message.recipients_exported', 'message', m.id, { count: people.length })
    return csvResponse(toCsv(people, [
      { label: 'First name', value: 'first_name' }, { label: 'Last name', value: 'last_name' },
      m.channel === 'email' ? { label: 'Email', value: 'email' } : { label: 'Phone (international)', value: r => r.phone_norm ? '+' + r.phone_norm : '' },
    ]), `recipients-${m.channel}.csv`)
  })
}
