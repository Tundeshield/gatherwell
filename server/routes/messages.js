import { fb, col, docOut, plain, getMany } from '../firebase.js'
import { bad, notFound, str, oneOf, uuid, date, isUuid } from '../http.js'
import { requireCap, branchFilter } from '../access.js'
import { audit } from '../util.js'
import { findPeople, STATUSES } from './people.js'
import { toCsv, csvResponse } from '../domain.js'

const CHANNELS = ['sms', 'email', 'whatsapp']

// Delivery providers are not connected yet. When one is added, set e.g. SMS_PROVIDER and implement sending.
export function providerFor(channel) {
  return { sms: process.env.SMS_PROVIDER, email: process.env.EMAIL_PROVIDER, whatsapp: process.env.WHATSAPP_PROVIDER }[channel] || null
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

export default function (r) {
  r.get('/messages', async ({ ctx }) => {
    requireCap(ctx, 'messages.manage')
    const { db } = await fb()
    const qs = await col(db, ctx.org.id, 'messages').orderBy('created_at', 'desc').limit(100).get()
    return { rows: qs.docs.map(d => ({ id: d.id, ...plain(d.data()) })), providers: Object.fromEntries(CHANNELS.map(c => [c, !!providerFor(c)])) }
  })

  r.post('/messages/audience', async ({ ctx, body }) => {
    requireCap(ctx, 'messages.manage')
    const people = await audiencePeople(ctx, cleanAudience(body.audience))
    const sorted = [...people].sort((a, b) => String(a.first_name).localeCompare(String(b.first_name)))
    return {
      counts: { total: people.length, with_phone: people.filter(p => p.phone_norm).length, with_email: people.filter(p => p.email).length },
      sample: sorted.slice(0, 8).map(s => [s.first_name, s.last_name ? s.last_name[0] + '.' : ''].join(' ').trim()),
    }
  })

  r.post('/messages', async ({ ctx, body }) => {
    requireCap(ctx, 'messages.manage')
    const { db } = await fb()
    const channel = oneOf(body.channel, CHANNELS, { name: 'Channel', fallback: 'sms' })
    const audience = cleanAudience(body.audience)
    const people = await audiencePeople(ctx, audience)
    const reachable = people.filter(p => (channel === 'email' ? p.email : p.phone_norm)).length
    const text = str(body.body, { required: true, max: channel === 'sms' ? 918 : 10000, name: 'Message' })
    const data = { channel, subject: str(body.subject, { max: 200 }), body: text, audience, recipient_count: reachable, status: 'draft',
      scheduled_for: body.scheduledFor ? new Date(date(body.scheduledFor)) : null, created_by: ctx.user.id, created_by_name: ctx.user.name, created_at: new Date(), updated_at: new Date() }
    const ref = await col(db, ctx.org.id, 'messages').add(data)
    await audit(ctx, 'message.drafted', 'message', ref.id, { channel, recipients: reachable })
    return { id: ref.id, ...plain(data) }
  })

  async function loadMessage(db, ctx, id) {
    const m = docOut(await col(db, ctx.org.id, 'messages').doc(uuid(id)).get())
    if (!m) throw notFound()
    return m
  }

  r.patch('/messages/:id', async ({ ctx, params, body }) => {
    requireCap(ctx, 'messages.manage')
    const { db } = await fb()
    const m = await loadMessage(db, ctx, params.id)
    if (m.status !== 'draft') throw bad('Only drafts can be edited.')
    const patch = { updated_at: new Date() }
    if (body.subject !== undefined) patch.subject = str(body.subject, { max: 200 })
    if (body.body) patch.body = str(body.body, { max: 10000 })
    await col(db, ctx.org.id, 'messages').doc(m.id).update(patch)
    return { ...m, ...plain(patch) }
  })

  r.delete('/messages/:id', async ({ ctx, params }) => {
    requireCap(ctx, 'messages.manage')
    const { db } = await fb()
    const m = await loadMessage(db, ctx, params.id)
    if (m.status !== 'draft') throw notFound('Only drafts can be deleted.')
    await col(db, ctx.org.id, 'messages').doc(m.id).delete()
    return { ok: true }
  })

  r.post('/messages/:id/send', async ({ ctx, params }) => {
    requireCap(ctx, 'messages.manage')
    const { db } = await fb()
    const m = await loadMessage(db, ctx, params.id)
    if (!providerFor(m.channel)) throw bad(`No ${m.channel.toUpperCase()} provider is connected yet, so nothing was sent. Download the recipient list to send it from another tool, or connect a provider in Settings.`)
    throw bad('Sending is not available yet.')
  })

  // Recipient list for sending through another tool while no provider is connected.
  r.get('/messages/:id/recipients', async ({ ctx, params }) => {
    requireCap(ctx, 'messages.manage')
    requireCap(ctx, 'export')
    const { db } = await fb()
    const m = await loadMessage(db, ctx, params.id)
    const people = (await audiencePeople(ctx, cleanAudience(m.audience))).filter(p => (m.channel === 'email' ? p.email : p.phone_norm))
      .sort((a, b) => String(a.first_name).localeCompare(String(b.first_name)))
    await audit(ctx, 'message.recipients_exported', 'message', m.id, { count: people.length })
    return csvResponse(toCsv(people, [
      { label: 'First name', value: 'first_name' }, { label: 'Last name', value: 'last_name' },
      m.channel === 'email' ? { label: 'Email', value: 'email' } : { label: 'Phone (international)', value: r => r.phone_norm ? '+' + r.phone_norm : '' },
    ]), `recipients-${m.channel}.csv`)
  })
}
