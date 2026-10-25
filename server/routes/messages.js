import { q, one, builder } from '../db.js'
import { bad, notFound, str, oneOf, uuid, date, isUuid } from '../http.js'
import { requireCap, branchFilter } from '../access.js'
import { audit } from '../util.js'
import { peopleWhere, STATUSES } from './people.js'
import { toCsv, csvResponse } from '../domain.js'

const CHANNELS = ['sms', 'email', 'whatsapp']

// Delivery providers are not connected yet. When one is added, set e.g. SMS_PROVIDER and implement send().
export function providerFor(channel) {
  const env = { sms: process.env.SMS_PROVIDER, email: process.env.EMAIL_PROVIDER, whatsapp: process.env.WHATSAPP_PROVIDER }[channel]
  return env || null
}

function cleanAudience(a = {}) {
  return {
    branch: a.branch && isUuid(a.branch) ? a.branch : null,
    statuses: (Array.isArray(a.statuses) ? a.statuses : []).filter(s => STATUSES.includes(s) && s !== 'archived'),
    unit: a.unit && isUuid(a.unit) ? a.unit : null,
    segment: oneOf(a.segment, ['all', 'first_timers_30d', 'absent', 'recent'], { name: 'Segment', fallback: 'all' }),
  }
}

async function audienceQuery(ctx, audience) {
  const f = { branch: audience.branch || undefined, unit: audience.unit || undefined, status: audience.statuses.length ? audience.statuses.join(',') : undefined }
  if (audience.segment === 'absent') f.attendance = 'absent'
  if (audience.segment === 'recent') f.attendance = 'recent'
  if (audience.segment === 'first_timers_30d') f.firstVisitSince = new Date(Date.now() - 30 * 86400000).toISOString()
  return peopleWhere(ctx, f)
}

export default function (r) {
  r.get('/messages', async ({ ctx }) => {
    requireCap(ctx, 'messages.manage')
    const rows = await q(`SELECT m.*, u.name AS created_by_name FROM messages m LEFT JOIN users u ON u.id = m.created_by
                           WHERE m.org_id = $1 ORDER BY m.created_at DESC LIMIT 100`, [ctx.org.id])
    return { rows, providers: Object.fromEntries(CHANNELS.map(c => [c, !!providerFor(c)])) }
  })

  r.post('/messages/audience', async ({ ctx, body }) => {
    requireCap(ctx, 'messages.manage')
    const audience = cleanAudience(body.audience)
    await branchFilter(ctx, audience.branch)
    const b = await audienceQuery(ctx, audience)
    const where = b.sql()
    const counts = await one(`SELECT COUNT(*)::int AS total, COUNT(p.phone_norm)::int AS with_phone, COUNT(p.email)::int AS with_email FROM people p ${where}`, b.params)
    const sample = await q(`SELECT p.first_name, p.last_name FROM people p ${where} ORDER BY p.first_name LIMIT 8`, b.params)
    return { counts, sample: sample.map(s => [s.first_name, s.last_name ? s.last_name[0] + '.' : ''].join(' ').trim()) }
  })

  r.post('/messages', async ({ ctx, body }) => {
    requireCap(ctx, 'messages.manage')
    const channel = oneOf(body.channel, CHANNELS, { name: 'Channel', fallback: 'sms' })
    const audience = cleanAudience(body.audience)
    await branchFilter(ctx, audience.branch)
    const b = await audienceQuery(ctx, audience)
    const col = channel === 'email' ? 'p.email' : 'p.phone_norm'
    const n = await one(`SELECT COUNT(${col})::int AS n FROM people p ${b.sql()}`, b.params)
    const text = str(body.body, { required: true, max: channel === 'sms' ? 918 : 10000, name: 'Message' })
    const m = await one(`INSERT INTO messages (org_id, channel, subject, body, audience, recipient_count, status, scheduled_for, created_by)
                         VALUES ($1,$2,$3,$4,$5,$6,'draft',$7,$8) RETURNING *`,
      [ctx.org.id, channel, str(body.subject, { max: 200 }), text, audience, n.n, date(body.scheduledFor), ctx.user.id])
    await audit(ctx, 'message.drafted', 'message', m.id, { channel, recipients: n.n })
    return m
  })

  r.patch('/messages/:id', async ({ ctx, params, body }) => {
    requireCap(ctx, 'messages.manage')
    const m = await one(`SELECT * FROM messages WHERE id = $1 AND org_id = $2`, [uuid(params.id), ctx.org.id])
    if (!m) throw notFound()
    if (m.status !== 'draft') throw bad('Only drafts can be edited.')
    return one(`UPDATE messages SET subject = COALESCE($3, subject), body = COALESCE($4, body), updated_at = NOW() WHERE id = $1 AND org_id = $2 RETURNING *`,
      [m.id, ctx.org.id, str(body.subject, { max: 200 }), str(body.body, { max: 10000 })])
  })

  r.delete('/messages/:id', async ({ ctx, params }) => {
    requireCap(ctx, 'messages.manage')
    const m = await one(`DELETE FROM messages WHERE id = $1 AND org_id = $2 AND status = 'draft' RETURNING id`, [uuid(params.id), ctx.org.id])
    if (!m) throw notFound('Only drafts can be deleted.')
    return { ok: true }
  })

  r.post('/messages/:id/send', async ({ ctx, params }) => {
    requireCap(ctx, 'messages.manage')
    const m = await one(`SELECT * FROM messages WHERE id = $1 AND org_id = $2`, [uuid(params.id), ctx.org.id])
    if (!m) throw notFound()
    if (!providerFor(m.channel)) {
      throw bad(`No ${m.channel.toUpperCase()} provider is connected yet, so nothing was sent. Download the recipient list to send it from another tool, or connect a provider in Settings.`)
    }
    throw bad('Sending is not available yet.')
  })

  // Recipient list for sending through another tool while no provider is connected.
  r.get('/messages/:id/recipients', async ({ ctx, params }) => {
    requireCap(ctx, 'messages.manage')
    requireCap(ctx, 'export')
    const m = await one(`SELECT * FROM messages WHERE id = $1 AND org_id = $2`, [uuid(params.id), ctx.org.id])
    if (!m) throw notFound()
    const audience = cleanAudience(m.audience)
    const b = await audienceQuery(ctx, audience)
    const col = m.channel === 'email' ? 'p.email' : 'p.phone_norm'
    const rows = await q(`SELECT p.first_name, p.last_name, p.phone, p.phone_norm, p.email FROM people p ${b.sql()} AND ${col} IS NOT NULL ORDER BY p.first_name LIMIT 20000`, b.params)
    await audit(ctx, 'message.recipients_exported', 'message', m.id, { count: rows.length })
    return csvResponse(toCsv(rows, [
      { label: 'First name', value: 'first_name' }, { label: 'Last name', value: 'last_name' },
      m.channel === 'email' ? { label: 'Email', value: 'email' } : { label: 'Phone (international)', value: r => r.phone_norm ? '+' + r.phone_norm : '' },
    ]), `recipients-${m.channel}.csv`)
  })
}
