// Communications API: send now, schedule, workflows, templates, channels and credits.
import { fb, col, plain, toDate, getMany, F, searchTokens } from '../firebase.js'
import { bad, notFound, forbidden, str, oneOf, uuid, isUuid } from '../http.js'
import { requireCap } from '../access.js'
import { audit, rateLimit } from '../util.js'
import { cleanBlocks, blocksFromBody } from '../../shared/email.js'
import { CHANNEL_KEYS, TRIGGERS, STEP_TYPES, CONDITIONS, OUTCOMES, PURPOSES, STARTER_TEMPLATES, localToUtc, utcToLocal, presetWorkflow, summariseWorkflow, countryOf, smsInfo, stepId } from '../../shared/comms.js'
import { cleanAudience, audiencePeople } from './messages.js'
import { isProduction } from '../env.js'
import { channelStatus, providerOverview, setProvider, activeProvider, adapterFor, platformConfig, clearConfigCache } from '../comms/providers.js'
import { rates, packs, addCredits, ledger, monthUsage, balanceOf, unitPrice, DEFAULT_RATES } from '../comms/credits.js'
import { enqueue, dequeue, processMessage, retryFailed, sortRecipients, estimate, scheduleRecurring, processEnrolment, handleInbound, updateDelivery, runComms } from '../comms/engine.js'

const tz = (ctx) => ctx.org.timezone || 'Africa/Lagos'
const iso = (v) => (v ? toDate(v).toISOString() : null)
const stagingOnly = () => { if (isProduction()) throw forbidden('This is only available on staging.') }

// --- content ---------------------------------------------------------------------------------
function readContent(channel, body) {
  const c = { category: oneOf(body.category, ['marketing', 'utility'], { fallback: 'marketing' }) }
  if (channel === 'email') {
    c.subject = str(body.subject, { max: 200, required: true, name: 'Subject' })
    c.preheader = str(body.preheader, { max: 200 }) || ''
    c.blocks = cleanBlocks(body.blocks?.length ? body.blocks : blocksFromBody(body.body))
    if (!c.blocks.length) throw bad('Write your message before continuing.', { fields: { body: 'Write your message.' } })
    c.body = c.blocks.map(b => b.text || b.label || '').filter(Boolean).join('\n\n').slice(0, 4000)
  } else {
    c.body = str(body.body, { max: channel === 'sms' ? 918 : 1024, required: true, name: 'Message' })
    c.template_id = body.templateId && isUuid(body.templateId) ? body.templateId : null
    c.template_name = str(body.templateName, { max: 120 }) || null
  }
  return c
}

const msgOut = (m, zone) => ({
  id: m.id, channel: m.channel, subject: m.subject || null, preheader: m.preheader || null, body: m.body || '', blocks: cleanBlocks(m.blocks?.length ? m.blocks : blocksFromBody(m.body)),
  category: m.category || 'marketing', template_id: m.template_id || null, template_name: m.template_name || null, audience: m.audience, status: m.status, mode: m.mode || 'now',
  send_at: iso(m.send_at), send_local: m.send_at ? utcToLocal(toDate(m.send_at), zone) : null, sent_at: iso(m.sent_at), created_at: iso(m.created_at),
  recipient_count: m.recipient_count || 0, audience_total: m.audience_total ?? null, excluded: m.excluded || null,
  sent_count: m.sent_count || 0, failed_count: m.failed_count || 0, skipped_count: m.skipped_count || 0, delivered_count: m.delivered_count || 0, read_count: m.read_count || 0,
  cost: m.cost || 0, estimate: m.estimate ?? null, billing: m.billing || null, last_error: m.last_error || null, pause_reason: m.pause_reason || null,
  workflow_id: m.workflow_id || null, workflow_name: m.workflow_name || null, created_by_name: m.created_by_name || null, legacy: !m.mode && m.channel === 'whatsapp',
})

// --- workflows ---------------------------------------------------------------------------------
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/
const time = (v, f = '10:00') => (HHMM.test(String(v || '')) ? String(v) : f)
const num = (v, min, max, f) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : f }
function cleanTrigger(t = {}) {
  const type = oneOf(t.type, Object.keys(TRIGGERS), { name: 'Start', fallback: 'first_visit' })
  const out = { type }
  if (type === 'event_registered') out.eventId = t.eventId && isUuid(t.eventId) ? t.eventId : null
  if (type === 'absent') out.weeks = num(t.weeks, 1, 26, 3)
  if (type === 'tag_added') { if (!t.tagId || !isUuid(t.tagId)) throw bad('Choose the tag that starts this workflow.'); out.tagId = t.tagId }
  if (type === 'schedule') {
    const s = t.schedule || {}
    const frequency = oneOf(s.frequency, ['weekly', 'daily', 'once'], { fallback: 'weekly' })
    out.schedule = { frequency, time: time(s.time), weekdays: frequency === 'weekly' ? [...new Set((s.weekdays || [1]).map(Number).filter(d => d >= 0 && d <= 6))].sort() : [], date: frequency === 'once' ? String(s.date || '').slice(0, 10) : null }
    if (frequency === 'weekly' && !out.schedule.weekdays.length) out.schedule.weekdays = [1]
    out.audience = cleanAudience(t.audience || {})
  }
  return out
}
function cleanStep(s = {}) {
  const type = oneOf(s.type, Object.keys(STEP_TYPES), { name: 'Step', fallback: 'end' })
  const id = /^[a-z0-9]{2,24}$/i.test(s.id || '') ? s.id : stepId()
  if (type === 'wait') {
    const w = s.wait || {}
    const kind = oneOf(w.kind, ['for', 'until_day', 'until_time', 'before_event'], { fallback: 'for' })
    const wait = { kind }
    if (kind === 'for') { wait.unit = oneOf(w.unit, ['minutes', 'hours', 'days'], { fallback: 'days' }); wait.amount = num(w.amount, 1, wait.unit === 'minutes' ? 1440 : wait.unit === 'hours' ? 720 : 90, 2) }
    if (kind === 'until_day') { wait.weekday = num(w.weekday, 0, 6, 1); wait.time = time(w.time) }
    if (kind === 'until_time') wait.time = time(w.time)
    if (kind === 'before_event') { wait.days = num(w.days, 0, 30, 1); wait.time = time(w.time) }
    return { id, type, wait }
  }
  if (type === 'send') {
    const channel = oneOf(s.channel, CHANNEL_KEYS, { fallback: 'email' })
    const step = { id, type, channel, title: str(s.title, { max: 80 }) || '', purpose: s.purpose && PURPOSES[s.purpose] ? s.purpose : 'general', category: oneOf(s.category, ['marketing', 'utility'], { fallback: 'marketing' }) }
    step.body = str(s.body, { max: channel === 'sms' ? 918 : channel === 'whatsapp' ? 1024 : 4000 }) || ''
    if (channel === 'email') { step.subject = str(s.subject, { max: 200 }) || step.title; step.preheader = str(s.preheader, { max: 200 }) || ''; step.blocks = s.blocks?.length ? cleanBlocks(s.blocks) : [] }
    else { step.templateId = s.templateId && isUuid(s.templateId) ? s.templateId : null; step.templateName = str(s.templateName, { max: 120 }) || null }
    return step
  }
  if (type === 'check') {
    const condition = oneOf(s.condition, Object.keys(CONDITIONS), { fallback: 'attended' })
    return { id, type, condition, tagId: s.tagId && isUuid(s.tagId) ? s.tagId : null, channel: s.channel && CHANNEL_KEYS.includes(s.channel) ? s.channel : null,
      ifYes: oneOf(s.ifYes, Object.keys(OUTCOMES), { fallback: 'continue' }), ifNo: oneOf(s.ifNo, Object.keys(OUTCOMES), { fallback: 'continue' }), taskTitle: str(s.taskTitle, { max: 200 }) || null,
      assigneeId: s.assigneeId && isUuid(s.assigneeId) ? s.assigneeId : null, assigneeName: str(s.assigneeName, { max: 120 }) || null }
  }
  if (type === 'task') return { id, type, title: str(s.title, { max: 200 }) || 'Follow up with {first_name}', dueHours: num(s.dueHours, 1, 720, 48), assigneeId: s.assigneeId && isUuid(s.assigneeId) ? s.assigneeId : null, assigneeName: str(s.assigneeName, { max: 120 }) || null }
  if (type === 'tag') return { id, type, tagId: s.tagId && isUuid(s.tagId) ? s.tagId : null }
  if (type === 'start_workflow') return { id, type, workflowId: s.workflowId && isUuid(s.workflowId) ? s.workflowId : null }
  return { id, type: 'end' }
}
const wfOut = (w) => ({
  id: w.id, name: w.name, status: w.status, trigger: w.trigger, steps: w.steps || [], pause_on_reply: w.pause_on_reply !== false, summary: summariseWorkflow(w),
  enrolled_count: w.enrolled_count || 0, active_count: Math.max(0, w.active_count || 0), completed_count: w.completed_count || 0, runs: w.runs || 0,
  next_run_at: iso(w.next_run_at), last_run_at: iso(w.last_run_at), created_at: iso(w.created_at), updated_at: iso(w.updated_at), preset: w.preset || null,
})

// What has to be true before a workflow can be switched on. Returns a list of plain problems.
async function activationProblems(ctx, w) {
  const out = []
  const sends = (w.steps || []).filter(s => s.type === 'send')
  if (!(w.steps || []).length) out.push('Add at least one step.')
  if (w.trigger.type === 'schedule') {
    if (sends.length !== 1 || w.steps.length > 1) out.push('A regular schedule sends one message each time. Keep a single “Send a message” step.')
    if (w.trigger.schedule.frequency === 'once' && !localToUtc(w.trigger.schedule.date, w.trigger.schedule.time, tz(ctx))) out.push('Choose the date to send on.')
  }
  const status = await channelStatus(ctx.org)
  for (const s of sends) {
    if (!status[s.channel].ready) out.push(`${s.channel === 'sms' ? 'SMS' : s.channel === 'whatsapp' ? 'WhatsApp' : 'Email'} isn’t connected yet, so “${s.title || 'a message'}” can’t be sent.`)
    if (s.channel === 'email' && !s.subject) out.push(`Give the email “${s.title || 'message'}” a subject.`)
    if (!s.body && !(s.blocks || []).length) out.push(`Write the message for “${s.title || 'a send step'}”.`)
  }
  for (const s of w.steps || []) if (s.type === 'wait' && s.wait.kind === 'before_event' && w.trigger.type !== 'event_registered') out.push('“Before the event” waits only work in workflows that start when someone registers for an event.')
  return [...new Set(out)]
}

export default function (r) {
  // --- overview ------------------------------------------------------------------------------
  r.get('/comms/overview', async ({ ctx }) => {
    requireCap(ctx, 'messages.manage')
    const { db } = await fb()
    const [msgs, wfs, channels] = await Promise.all([
      col(db, ctx.org.id, 'messages').orderBy('created_at', 'desc').limit(200).get(),
      col(db, ctx.org.id, 'workflows').get(),
      channelStatus(ctx.org),
    ])
    const all = msgs.docs.map(d => msgOut({ id: d.id, ...plain(d.data()) }, tz(ctx)))
    const workflows = wfs.docs.map(d => wfOut({ id: d.id, ...plain(d.data()) })).filter(w => w.status !== 'archived')
    return {
      channels, timezone: tz(ctx),
      credits: { balance: balanceOf(ctx.org), low: balanceOf(ctx.org) < 2, staging: !isProduction() },
      scheduled: all.filter(m => m.status === 'scheduled').sort((a, b) => a.send_at.localeCompare(b.send_at)).slice(0, 5),
      recent: all.filter(m => ['sent', 'sending'].includes(m.status)).slice(0, 5),
      attention: all.filter(m => m.status === 'failed' || m.status === 'paused' || (m.status === 'sent' && m.failed_count > 0)).slice(0, 5),
      workflows: workflows.filter(w => w.status === 'active').slice(0, 6),
      counts: { workflowsActive: workflows.filter(w => w.status === 'active').length, scheduled: all.filter(m => m.status === 'scheduled').length, drafts: all.filter(m => m.status === 'draft').length },
    }
  })

  // Who will receive it, who won't and why, and what it will cost.
  r.post('/comms/preview', async ({ ctx, body }) => {
    requireCap(ctx, 'messages.manage')
    const channel = oneOf(body.channel, CHANNEL_KEYS, { fallback: 'email' })
    const audience = cleanAudience(body.audience)
    const people = await audiencePeople(ctx, audience)
    const { eligible, excluded } = sortRecipients(channel, people)
    const est = await estimate(ctx.org, channel, eligible, { body: body.body || '', category: body.category || 'marketing' })
    const sorted = [...people].sort((a, b) => String(a.first_name).localeCompare(String(b.first_name)))
    return {
      total: people.length, eligible: eligible.length, excluded, estimate: est,
      sample: sorted.slice(0, 6).map(s => [s.first_name, s.last_name ? s.last_name[0] + '.' : ''].join(' ').trim()),
      picked: audience.mode === 'people' ? sorted.map(p => ({ id: p.id, name: [p.first_name, p.last_name].filter(Boolean).join(' '), email: !!p.email && !p.email_opt_out, phone: !!p.phone_norm })) : undefined,
      sms: channel === 'sms' ? smsInfo(body.body || '') : null,
    }
  })

  // --- messages ------------------------------------------------------------------------------
  r.get('/comms/messages', async ({ ctx }) => {
    requireCap(ctx, 'messages.manage')
    const { db } = await fb()
    const qs = await col(db, ctx.org.id, 'messages').orderBy('created_at', 'desc').limit(300).get()
    return { rows: qs.docs.map(d => msgOut({ id: d.id, ...plain(d.data()) }, tz(ctx))), timezone: tz(ctx) }
  })

  async function loadMsg(db, ctx, id) {
    const s = await col(db, ctx.org.id, 'messages').doc(uuid(id, { required: true })).get()
    if (!s.exists) throw notFound('Message not found.')
    return { id: s.id, ...s.data() }
  }

  async function prepareSend(ctx, body, existing = null) {
    const channel = oneOf(body.channel ?? existing?.channel, CHANNEL_KEYS, { fallback: 'email' })
    const content = readContent(channel, body)
    const audience = cleanAudience(body.audience ?? existing?.audience)
    const when = oneOf(body.when, ['now', 'later', 'draft'], { fallback: 'draft' })
    let sendAt = null
    if (when === 'later') {
      sendAt = localToUtc(body.sendDate, body.sendTime, tz(ctx))
      if (!sendAt) throw bad('Choose a date and time.', { fields: { sendDate: 'Choose a date.' } })
      if (sendAt < new Date(Date.now() + 60e3)) throw bad('Choose a time in the future.', { fields: { sendTime: 'This time has already passed.' } })
      if (sendAt > new Date(Date.now() + 366 * 86400e3)) throw bad('You can schedule up to a year ahead.')
    }
    if (when !== 'draft') {
      const st = (await channelStatus(ctx.org))[channel]
      if (!st.ready) throw bad(`${channel === 'sms' ? 'SMS' : channel === 'whatsapp' ? 'WhatsApp' : 'Email'} isn’t connected yet, so this can’t be sent.`)
      if (channel === 'whatsapp' && st.needsTemplates && !content.template_id) throw bad('WhatsApp messages must use an approved template. Choose one, or save your message as a template first.')
      if (content.template_id) {
        const { db } = await fb()
        const t = (await col(db, ctx.org.id, 'templates').doc(content.template_id).get()).data()
        if (channel === 'whatsapp' && st.needsTemplates && t?.whatsapp?.status !== 'approved') throw bad('That WhatsApp template isn’t approved yet.')
        if (t) { content.template_name = t.name; if (channel === 'whatsapp') content.category = t.category || content.category }
      }
    }
    return { channel, content, audience, when, sendAt }
  }

  r.post('/comms/messages', async ({ ctx, body }) => {
    requireCap(ctx, 'messages.manage')
    await rateLimit(`comms:${ctx.org.id}`, 120, 3600)
    const { db } = await fb()
    const { channel, content, audience, when, sendAt } = await prepareSend(ctx, body)
    const status = when === 'draft' ? 'draft' : 'scheduled'
    const data = { channel, ...content, audience, status, mode: when === 'later' ? 'scheduled' : 'now', send_at: when === 'draft' ? null : (sendAt || new Date()), scope: ctx.branchScope || null,
      recipient_count: 0, created_by: ctx.user.id, created_by_name: ctx.user.name, created_at: new Date(), updated_at: new Date() }
    const ref = await col(db, ctx.org.id, 'messages').add(data)
    if (status === 'scheduled') await enqueue(ctx.org.id, 'message', ref.id, data.send_at)
    await audit(ctx, when === 'later' ? 'message.scheduled' : when === 'now' ? 'message.send_started' : 'message.drafted', 'message', ref.id, { channel })
    let progress = null
    if (when === 'now') progress = await processMessage(ctx.org.id, ref.id, { budgetMs: 6000 })
    const m = { id: ref.id, ...plain((await ref.get()).data()) }
    return { message: msgOut(m, tz(ctx)), progress }
  })

  r.get('/comms/messages/:id', async ({ ctx, params }) => {
    requireCap(ctx, 'messages.manage')
    const { db } = await fb()
    const m = await loadMsg(db, ctx, params.id)
    const ds = await col(db, ctx.org.id, 'deliveries').where('message_id', '==', m.id).get()
    const deliveries = ds.docs.map(d => ({ id: d.id, ...plain(d.data()) })).sort((a, b) => String(a.name).localeCompare(String(b.name))).slice(0, 1000)
      .map(d => ({ id: d.id, name: d.name, person_id: d.person_id, to: d.channel === 'email' ? d.to : `+${String(d.to).slice(0, -4).replace(/\d/g, '•')}${String(d.to).slice(-4)}`, status: d.status, error: d.error || null, cost: d.cost || 0, test: !!d.test }))
    return { message: msgOut(m, tz(ctx)), deliveries, timezone: tz(ctx), staging: !isProduction() }
  })

  r.patch('/comms/messages/:id', async ({ ctx, params, body }) => {
    requireCap(ctx, 'messages.manage')
    const { db } = await fb()
    const m = await loadMsg(db, ctx, params.id)
    if (!['draft', 'scheduled', 'paused'].includes(m.status) || (m.status === 'paused' && m.recipient_count)) throw bad('This message has already started sending, so it can’t be changed.')
    const { channel, content, audience, when, sendAt } = await prepareSend(ctx, body, m)
    const status = when === 'draft' ? 'draft' : 'scheduled'
    const patch = { channel, ...content, audience, status, mode: when === 'later' ? 'scheduled' : 'now', send_at: when === 'draft' ? null : (sendAt || new Date()), last_error: null, pause_reason: null, updated_at: new Date() }
    await col(db, ctx.org.id, 'messages').doc(m.id).update(patch)
    if (status === 'scheduled') await enqueue(ctx.org.id, 'message', m.id, patch.send_at); else await dequeue(ctx.org.id, 'message', m.id)
    let progress = null
    if (when === 'now') progress = await processMessage(ctx.org.id, m.id, { budgetMs: 6000 })
    await audit(ctx, 'message.updated', 'message', m.id, { status })
    return { message: msgOut({ ...m, ...patch }, tz(ctx)), progress }
  })

  // Continue sending (the browser calls this until it's done; the scheduler also continues).
  r.post('/comms/messages/:id/send', async ({ ctx, params }) => {
    requireCap(ctx, 'messages.manage')
    const { db } = await fb()
    const m = await loadMsg(db, ctx, params.id)
    const p = await processMessage(ctx.org.id, m.id, { budgetMs: 6000 })
    if (p.nextAt) await enqueue(ctx.org.id, 'message', m.id, p.nextAt)
    return p
  })

  r.post('/comms/messages/:id/cancel', async ({ ctx, params }) => {
    requireCap(ctx, 'messages.manage')
    const { db } = await fb()
    const ref = col(db, ctx.org.id, 'messages').doc(uuid(params.id, { required: true }))
    const ok = await db.runTransaction(async (tx) => {
      const s = await tx.get(ref)
      if (!s.exists) throw notFound('Message not found.')
      const m = s.data()
      if (m.status === 'scheduled' || (m.status === 'paused' && !m.recipient_count)) { tx.update(ref, { status: 'cancelled', cancelled_at: new Date(), cancelled_by_name: ctx.user.name, updated_at: new Date() }); return 'cancelled' }
      if (m.status === 'sending' || m.status === 'paused') { tx.update(ref, { status: 'cancelled', cancelled_at: new Date(), cancelled_by_name: ctx.user.name, updated_at: new Date(), last_error: 'Stopped before everyone received it.' }); return 'stopped' }
      throw bad('Only scheduled messages, or ones still sending, can be cancelled.')
    })
    await dequeue(ctx.org.id, 'message', params.id)
    await audit(ctx, 'message.cancelled', 'message', params.id)
    return { ok: true, result: ok }
  })

  r.post('/comms/messages/:id/resume', async ({ ctx, params }) => {
    requireCap(ctx, 'messages.manage')
    const { db } = await fb()
    const m = await loadMsg(db, ctx, params.id)
    if (m.status !== 'paused') throw bad('Only paused messages can be resumed.')
    const status = m.recipient_count ? 'sending' : 'scheduled'
    await col(db, ctx.org.id, 'messages').doc(m.id).update({ status, pause_reason: null, last_error: null, send_at: status === 'scheduled' ? new Date() : m.send_at, updated_at: new Date() })
    const p = await processMessage(ctx.org.id, m.id, { budgetMs: 6000 })
    if (p.nextAt) await enqueue(ctx.org.id, 'message', m.id, p.nextAt)
    return p
  })

  r.post('/comms/messages/:id/duplicate', async ({ ctx, params }) => {
    requireCap(ctx, 'messages.manage')
    const { db } = await fb()
    const m = await loadMsg(db, ctx, params.id)
    const data = { channel: m.channel, subject: m.subject || null, preheader: m.preheader || null, blocks: m.blocks || [], body: m.body || '', category: m.category || 'marketing',
      template_id: m.template_id || null, template_name: m.template_name || null, audience: m.audience, status: 'draft', mode: 'now', send_at: null, scope: ctx.branchScope || null,
      recipient_count: 0, created_by: ctx.user.id, created_by_name: ctx.user.name, created_at: new Date(), updated_at: new Date() }
    const ref = await col(db, ctx.org.id, 'messages').add(data)
    return { id: ref.id }
  })

  r.post('/comms/messages/:id/retry', async ({ ctx, params }) => {
    requireCap(ctx, 'messages.manage')
    await rateLimit(`retry:${ctx.org.id}`, 20, 3600)
    const r2 = await retryFailed(ctx.org.id, uuid(params.id, { required: true }))
    if (r2.error) throw bad(r2.error)
    await audit(ctx, 'message.retried', 'message', params.id, r2)
    return r2
  })

  r.delete('/comms/messages/:id', async ({ ctx, params }) => {
    requireCap(ctx, 'messages.manage')
    const { db } = await fb()
    const m = await loadMsg(db, ctx, params.id)
    if (!['draft', 'cancelled'].includes(m.status)) throw bad('Only drafts and cancelled messages can be deleted.')
    await col(db, ctx.org.id, 'messages').doc(m.id).delete()
    await dequeue(ctx.org.id, 'message', m.id)
    return { ok: true }
  })

  // Everything waiting to happen: scheduled messages and the next step of each workflow.
  r.get('/comms/upcoming', async ({ ctx }) => {
    requireCap(ctx, 'messages.manage')
    const { db } = await fb()
    const [msgs, enr] = await Promise.all([
      col(db, ctx.org.id, 'messages').where('status', '==', 'scheduled').get(),
      col(db, ctx.org.id, 'enrolments').where('status', '==', 'active').get(),
    ])
    const items = [
      ...msgs.docs.map(d => ({ kind: 'message', id: d.id, at: iso(d.data().send_at), title: d.data().subject || d.data().template_name || (d.data().body || '').slice(0, 60), channel: d.data().channel, workflow: d.data().workflow_name || null })),
      ...enr.docs.map(d => ({ kind: 'step', id: d.id, at: iso(d.data().next_at), title: d.data().person_name, workflow: d.data().workflow_name, workflow_id: d.data().workflow_id, blocked: d.data().blocked || null })),
    ].filter(x => x.at).sort((a, b) => a.at.localeCompare(b.at)).slice(0, 200)
    return { items, timezone: tz(ctx) }
  })

  // --- workflows -------------------------------------------------------------------------------
  r.get('/comms/workflows', async ({ ctx }) => {
    requireCap(ctx, 'messages.manage')
    const { db } = await fb()
    const qs = await col(db, ctx.org.id, 'workflows').get()
    const rows = qs.docs.map(d => wfOut({ id: d.id, ...plain(d.data()) })).filter(w => w.status !== 'archived').sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
    return { rows, classicJourney: Object.values(ctx.org.journey || {}).some(j => j?.enabled) }
  })

  r.post('/comms/workflows', async ({ ctx, body }) => {
    requireCap(ctx, 'messages.manage')
    const { db } = await fb()
    const status = await channelStatus(ctx.org)
    const channel = CHANNEL_KEYS.includes(body.channel) && status[body.channel]?.ready ? body.channel : 'email'
    const preset = presetWorkflow(String(body.preset || 'scratch'), channel)
    const data = { name: preset.name, trigger: cleanTrigger(preset.trigger), steps: preset.steps.map(cleanStep), status: 'draft', preset: body.preset || 'scratch', pause_on_reply: true,
      owner_id: ctx.user.id, scope: ctx.branchScope || null, enrolled_count: 0, active_count: 0, completed_count: 0, created_by: ctx.user.id, created_at: new Date(), updated_at: new Date() }
    const ref = await col(db, ctx.org.id, 'workflows').add(data)
    await audit(ctx, 'workflow.created', 'workflow', ref.id, { preset: data.preset })
    return wfOut({ id: ref.id, ...plain(data) })
  })

  async function loadWf(db, ctx, id) {
    const s = await col(db, ctx.org.id, 'workflows').doc(uuid(id, { required: true })).get()
    if (!s.exists || s.data().status === 'archived') throw notFound('Workflow not found.')
    return { id: s.id, ...s.data() }
  }

  r.get('/comms/workflows/:id', async ({ ctx, params }) => {
    requireCap(ctx, 'messages.manage')
    const { db } = await fb()
    const w = await loadWf(db, ctx, params.id)
    return { workflow: wfOut(plain(w)), problems: await activationProblems(ctx, w), channels: await channelStatus(ctx.org), timezone: tz(ctx) }
  })

  r.patch('/comms/workflows/:id', async ({ ctx, params, body }) => {
    requireCap(ctx, 'messages.manage')
    const { db } = await fb()
    const w = await loadWf(db, ctx, params.id)
    const patch = { updated_at: new Date() }
    if (body.name !== undefined) patch.name = str(body.name, { max: 100, required: true, name: 'Name' })
    if (body.trigger !== undefined) patch.trigger = cleanTrigger(body.trigger)
    if (body.steps !== undefined) {
      if (!Array.isArray(body.steps) || body.steps.length > 30) throw bad('A workflow can have up to 30 steps.')
      patch.steps = body.steps.map(cleanStep)
    }
    if (body.pause_on_reply !== undefined) patch.pause_on_reply = !!body.pause_on_reply
    if (w.status === 'active' && patch.trigger && patch.trigger.type !== w.trigger.type) throw bad('Pause the workflow before changing how it starts.')
    const next = { ...w, ...patch }
    if (w.status === 'active') {
      const problems = await activationProblems(ctx, next)
      if (problems.length) throw bad(problems[0])
    }
    await col(db, ctx.org.id, 'workflows').doc(w.id).update(patch)
    if (w.status === 'active' && next.trigger.type === 'schedule') await scheduleRecurring(ctx.org, next)
    await audit(ctx, 'workflow.updated', 'workflow', w.id)
    return { workflow: wfOut(plain(next)), problems: await activationProblems(ctx, next) }
  })

  r.post('/comms/workflows/:id/status', async ({ ctx, params, body }) => {
    requireCap(ctx, 'messages.manage')
    const { db } = await fb()
    const w = await loadWf(db, ctx, params.id)
    const status = oneOf(body.status, ['active', 'paused'], { name: 'Status' })
    if (status === 'active') {
      const problems = await activationProblems(ctx, w)
      if (problems.length) throw bad(problems[0], { problems })
    }
    await col(db, ctx.org.id, 'workflows').doc(w.id).update({ status, updated_at: new Date(), ...(status === 'active' ? { activated_at: new Date() } : { paused_at: new Date() }) })
    const trig = db.collection('commsTriggers').doc(`${ctx.org.id}_${w.id}`)
    if (status === 'active') {
      await trig.set({ org_id: ctx.org.id, workflow_id: w.id, type: w.trigger.type })
      if (w.trigger.type === 'schedule') await scheduleRecurring(ctx.org, { ...w, status })
    } else {
      await trig.delete().catch(() => {})
      if (w.trigger.type === 'schedule') await dequeue(ctx.org.id, 'recurring', w.id)
    }
    await audit(ctx, status === 'active' ? 'workflow.activated' : 'workflow.paused', 'workflow', w.id)
    const fresh = { id: w.id, ...plain((await col(db, ctx.org.id, 'workflows').doc(w.id).get()).data()) }
    return { workflow: wfOut(fresh) }
  })

  r.delete('/comms/workflows/:id', async ({ ctx, params }) => {
    requireCap(ctx, 'messages.manage')
    const { db } = await fb()
    const w = await loadWf(db, ctx, params.id)
    await col(db, ctx.org.id, 'workflows').doc(w.id).update({ status: 'archived', updated_at: new Date() })
    await db.collection('commsTriggers').doc(`${ctx.org.id}_${w.id}`).delete().catch(() => {})
    await dequeue(ctx.org.id, 'recurring', w.id)
    await audit(ctx, 'workflow.deleted', 'workflow', w.id)
    return { ok: true }
  })

  r.get('/comms/workflows/:id/people', async ({ ctx, params }) => {
    requireCap(ctx, 'messages.manage')
    const { db } = await fb()
    const w = await loadWf(db, ctx, params.id)
    const qs = await col(db, ctx.org.id, 'enrolments').where('workflow_id', '==', w.id).get()
    const rows = qs.docs.map(d => ({ id: d.id, ...plain(d.data()) })).sort((a, b) => String(b.started_at).localeCompare(String(a.started_at))).slice(0, 300)
      .map(e => ({ id: e.id, person_id: e.person_id, name: e.person_name, status: e.status, step_id: e.step_id, step_index: e.step_index, next_at: e.next_at || null, started_at: e.started_at, replied_at: e.replied_at || null, blocked: e.blocked || null, history: (e.history || []).slice(-12) }))
    return { rows }
  })

  r.post('/comms/enrolments/:id/remove', async ({ ctx, params }) => {
    requireCap(ctx, 'messages.manage')
    const { db } = await fb()
    const ref = col(db, ctx.org.id, 'enrolments').doc(String(params.id).slice(0, 200))
    const e = (await ref.get()).data()
    if (!e) throw notFound()
    if (!['active', 'paused_reply'].includes(e.status)) throw bad('This person has already finished the workflow.')
    await ref.update({ status: 'removed', removed_at: new Date(), history: [...(e.history || []), { at: new Date(), type: 'end', text: `Removed by ${ctx.user.name}` }] })
    if (e.status === 'active') await col(db, ctx.org.id, 'workflows').doc(e.workflow_id).update({ active_count: F.inc(-1) }).catch(() => {})
    await dequeue(ctx.org.id, 'enrolment', ref.id)
    return { ok: true }
  })

  r.post('/comms/enrolments/:id/resume', async ({ ctx, params }) => {
    requireCap(ctx, 'messages.manage')
    const { db } = await fb()
    const ref = col(db, ctx.org.id, 'enrolments').doc(String(params.id).slice(0, 200))
    const e = (await ref.get()).data()
    if (!e || e.status !== 'paused_reply') throw bad('Only workflows paused by a reply can be resumed.')
    await ref.update({ status: 'active', next_at: new Date(), history: [...(e.history || []), { at: new Date(), type: 'start', text: `Resumed by ${ctx.user.name}` }] })
    await col(db, ctx.org.id, 'workflows').doc(e.workflow_id).update({ active_count: F.inc(1) }).catch(() => {})
    await enqueue(ctx.org.id, 'enrolment', ref.id, new Date())
    return { ok: true }
  })

  // --- templates -------------------------------------------------------------------------------
  const tplOut = (t) => ({ id: t.id, name: t.name, purpose: t.purpose, subject: t.subject || '', body: t.body || '', category: t.category || 'marketing',
    whatsapp: t.whatsapp || { status: 'not_submitted' }, starter: !!t.starter, updated_at: iso(t.updated_at), sms: smsInfo(t.body || '') })
  r.get('/comms/templates', async ({ ctx }) => {
    requireCap(ctx, 'messages.manage')
    const { db } = await fb()
    const qs = await col(db, ctx.org.id, 'templates').get()
    const own = qs.docs.map(d => tplOut({ id: d.id, ...plain(d.data()) })).sort((a, b) => a.name.localeCompare(b.name))
    const starters = STARTER_TEMPLATES.filter(s => !own.some(o => o.starter_key === s.key)).map(s => ({ ...s, id: `starter:${s.key}`, starter: true, whatsapp: { status: 'not_submitted' }, sms: smsInfo(s.body) }))
    return { own, starters, purposes: PURPOSES }
  })
  function readTemplate(body) {
    return {
      name: str(body.name, { max: 100, required: true, name: 'Name' }), purpose: PURPOSES[body.purpose] ? body.purpose : 'general',
      subject: str(body.subject, { max: 200 }) || '', body: str(body.body, { max: 1024, required: true, name: 'Message' }),
      category: oneOf(body.category, ['marketing', 'utility'], { fallback: 'marketing' }),
    }
  }
  r.post('/comms/templates', async ({ ctx, body }) => {
    requireCap(ctx, 'messages.manage')
    const { db } = await fb()
    const data = { ...readTemplate(body), starter_key: body.starterKey ? String(body.starterKey).slice(0, 30) : null, whatsapp: { status: 'not_submitted' }, created_by: ctx.user.id, created_at: new Date(), updated_at: new Date() }
    const ref = await col(db, ctx.org.id, 'templates').add(data)
    return tplOut({ id: ref.id, ...plain(data) })
  })
  r.patch('/comms/templates/:id', async ({ ctx, params, body }) => {
    requireCap(ctx, 'messages.manage')
    const { db } = await fb()
    const ref = col(db, ctx.org.id, 'templates').doc(uuid(params.id, { required: true }))
    const cur = (await ref.get()).data()
    if (!cur) throw notFound()
    const data = readTemplate(body)
    // Changing the words of an approved WhatsApp template needs a new approval.
    const changed = data.body !== cur.body || data.category !== cur.category
    const patch = { ...data, updated_at: new Date(), ...(changed && cur.whatsapp?.status !== 'not_submitted' ? { whatsapp: { status: 'not_submitted', note: 'Edited since approval: submit again.' } } : {}) }
    await ref.update(patch)
    return tplOut({ id: ref.id, ...plain({ ...cur, ...patch }) })
  })
  r.delete('/comms/templates/:id', async ({ ctx, params }) => {
    requireCap(ctx, 'messages.manage')
    const { db } = await fb()
    await col(db, ctx.org.id, 'templates').doc(uuid(params.id, { required: true })).delete()
    return { ok: true }
  })
  // Submit for WhatsApp approval through the active provider. Only the test provider exists so far,
  // and it approves straight away, marked as simulated.
  r.post('/comms/templates/:id/submit', async ({ ctx, params }) => {
    requireCap(ctx, 'messages.manage')
    const { db } = await fb()
    const ref = col(db, ctx.org.id, 'templates').doc(uuid(params.id, { required: true }))
    const t = (await ref.get()).data()
    if (!t) throw notFound()
    const { adapter } = await activeProvider('whatsapp')
    if (!adapter) throw bad('WhatsApp isn’t connected yet, so templates can’t be submitted for approval.')
    const wa = adapter.mock ? { status: 'approved', simulated: true, category: t.category, provider: adapter.id, at: new Date() } : { status: 'pending', provider: adapter.id, at: new Date() }
    await ref.update({ whatsapp: wa, updated_at: new Date() })
    return tplOut({ id: ref.id, ...plain({ ...t, whatsapp: wa }) })
  })

  // --- channels, usage and credits ------------------------------------------------------------------
  r.get('/comms/channels', async ({ ctx }) => {
    requireCap(ctx, 'messages.manage')
    const R = await rates()
    const country = countryOf(String(ctx.org.settings?.defaultCountryCode || '234'))
    const [entries, usage, packList] = await Promise.all([ledger(ctx.org.id, 30), monthUsage(ctx.org.id), packs()])
    return {
      channels: await channelStatus(ctx.org), timezone: tz(ctx), staging: !isProduction(),
      quiet: { start: Number(ctx.org.settings?.quietStart ?? 8), end: Number(ctx.org.settings?.quietEnd ?? 21) },
      credits: { balance: balanceOf(ctx.org), packs: packList, placeholderRates: !!R.placeholder },
      prices: { country, whatsapp: { marketing: unitPrice(R, 'whatsapp', { phoneNorm: String(ctx.org.settings?.defaultCountryCode || '234'), category: 'marketing' }), utility: unitPrice(R, 'whatsapp', { phoneNorm: String(ctx.org.settings?.defaultCountryCode || '234'), category: 'utility' }) }, sms: unitPrice(R, 'sms', { phoneNorm: String(ctx.org.settings?.defaultCountryCode || '234'), body: 'x' }) },
      usage, ledger: entries.map(e => ({ id: e.id, type: e.type, amount: e.amount, balance_after: e.balance_after, channel: e.channel, count: e.count, note: e.note, created_at: e.created_at, test: !!e.test, message_id: e.message_id || null })),
    }
  })
  r.patch('/comms/channels/:channel', async ({ ctx, params, body }) => {
    requireCap(ctx, 'org.manage')
    const channel = oneOf(params.channel, ['whatsapp', 'sms'], { name: 'Channel' })
    const billing = oneOf(body.billing, ['platform', 'church'], { name: 'Who pays' })
    const st = (await channelStatus(ctx.org))[channel]
    if (billing === 'church' && !st.canChurchBill) throw bad('Connecting your own account isn’t available for this channel yet.')
    const { db } = await fb()
    await db.collection('orgs').doc(ctx.org.id).update({ [`comms.channels.${channel}.billing`]: billing, updated_at: new Date() })
    await audit(ctx, 'comms.billing_changed', 'organisation', ctx.org.id, { channel, billing })
    return { ok: true }
  })
  r.patch('/comms/settings', async ({ ctx, body }) => {
    requireCap(ctx, 'org.manage')
    const start = num(body.quietStart, 0, 23, 8), end = num(body.quietEnd, 1, 24, 21)
    if (end <= start) throw bad('The end of sending hours must be after the start.')
    const { db } = await fb()
    await db.collection('orgs').doc(ctx.org.id).update({ 'settings.quietStart': start, 'settings.quietEnd': end, updated_at: new Date() })
    return { quiet: { start, end } }
  })
  // Staging only: add pretend credit to test paid channels. Live purchases aren't built yet.
  r.post('/comms/credits/test', async ({ ctx, body }) => {
    stagingOnly(); requireCap(ctx, 'messages.manage')
    const amount = num(body.amount, 1, 500, 10)
    const balance = await addCredits(ctx.org.id, { amount, type: 'test_topup', note: 'Test credit (staging)', user: ctx.user })
    return { balance }
  })
  r.post('/comms/credits/test-reset', async ({ ctx }) => {
    stagingOnly(); requireCap(ctx, 'messages.manage')
    const balance = await addCredits(ctx.org.id, { amount: -balanceOf(ctx.org), type: 'test_reset', note: 'Balance set to zero (staging)', user: ctx.user })
    return { balance }
  })

  // --- consent ---------------------------------------------------------------------------------------
  r.patch('/people/:id/consent', async ({ ctx, params, body }) => {
    requireCap(ctx, 'people.edit')
    const channel = oneOf(body.channel, ['whatsapp', 'sms', 'email'], { name: 'Channel' })
    const status = oneOf(body.status, ['granted', 'withdrawn'], { name: 'Status' })
    const { db } = await fb()
    const ref = col(db, ctx.org.id, 'people').doc(uuid(params.id, { required: true }))
    const p = (await ref.get()).data()
    if (!p || (ctx.branchScope && !ctx.branchScope.includes(p.branch_id))) throw notFound()
    const record = { status, at: new Date(), source: oneOf(body.source, ['in_person', 'form', 'verbal', 'written', 'reply', 'import'], { fallback: 'in_person' }), wording: str(body.wording, { max: 300 }) || null, by: ctx.user.name }
    const patch = { [`consent.${channel}`]: record, updated_at: new Date() }
    if (channel === 'email') Object.assign(patch, status === 'withdrawn' ? { email_opt_out: true, email_opt_out_at: new Date() } : { email_opt_out: false, email_opt_out_at: null, email_resubscribed_at: new Date() })
    await ref.update(patch)
    await audit(ctx, `person.consent_${status}`, 'person', ref.id, { channel })
    return { consent: { ...(p.consent || {}), [channel]: { ...record, at: record.at.toISOString() } } }
  })

  // --- staging simulations ----------------------------------------------------------------------------
  r.post('/comms/simulate/delivery/:id', async ({ ctx, params, body }) => {
    stagingOnly(); requireCap(ctx, 'messages.manage')
    const status = oneOf(body.status, ['delivered', 'read', 'failed'], { name: 'Status' })
    return { ok: await updateDelivery(ctx.org.id, String(params.id).slice(0, 200), status, status === 'failed' ? 'Not delivered (simulated).' : null) }
  })
  r.post('/comms/simulate/message/:id', async ({ ctx, params, body }) => {
    stagingOnly(); requireCap(ctx, 'messages.manage')
    const status = oneOf(body.status, ['delivered', 'read'], { name: 'Status' })
    const { db } = await fb()
    const ds = await col(db, ctx.org.id, 'deliveries').where('message_id', '==', uuid(params.id, { required: true })).get()
    let n = 0
    for (const d of ds.docs) if (['sent', 'delivered'].includes(d.data().status) && await updateDelivery(ctx.org.id, d.id, status)) n++
    return { updated: n }
  })
  r.post('/comms/simulate/reply', async ({ ctx, body }) => {
    stagingOnly(); requireCap(ctx, 'messages.manage')
    const res = await handleInbound(ctx.org.id, { channel: oneOf(body.channel, CHANNEL_KEYS, { fallback: 'whatsapp' }), personId: uuid(body.personId, { required: true }), text: str(body.text, { max: 500, required: true, name: 'Reply' }) })
    return res
  })
  r.post('/comms/simulate/run', async ({ ctx }) => {
    stagingOnly(); requireCap(ctx, 'messages.manage')
    return runComms({ deadline: Date.now() + 8000 })
  })
  r.post('/comms/simulate/advance/:id', async ({ ctx, params }) => {
    stagingOnly(); requireCap(ctx, 'messages.manage')
    const { db } = await fb()
    const ref = col(db, ctx.org.id, 'enrolments').doc(String(params.id).slice(0, 200))
    const e = (await ref.get()).data()
    if (!e || e.status !== 'active') throw bad('This person isn’t waiting in the workflow.')
    await ref.update({ wait_until: e.wait_until ? new Date(Date.now() - 1000) : null, next_at: new Date() })
    const r2 = await processEnrolment(ctx.org.id, ref.id)
    if (r2.nextAt) await enqueue(ctx.org.id, 'enrolment', ref.id, r2.nextAt); else await dequeue(ctx.org.id, 'enrolment', ref.id)
    return r2
  })
  // Synthetic people for testing, clearly marked, with consent recorded.
  r.post('/comms/simulate/seed', async ({ ctx }) => {
    stagingOnly(); requireCap(ctx, 'people.edit')
    const { db } = await fb()
    const branchId = (await db.collection('orgs').doc(ctx.org.id).collection('branches').limit(1).get()).docs[0]?.id || null
    const FIRST = ['Ada', 'Bayo', 'Chika', 'Dami', 'Efe', 'Femi', 'Grace', 'Halima', 'Ike', 'Joy', 'Kemi', 'Lanre', 'Musa', 'Ngozi', 'Ola', 'Peace', 'Remi', 'Segun', 'Tobi', 'Uche']
    const tagRef = await col(db, ctx.org.id, 'tags').add({ name: 'Test data', color: 'gray', created_at: new Date(), created_by: ctx.user.id })
    const cc = String(ctx.org.settings?.defaultCountryCode || '234')
    const b = db.batch()
    FIRST.forEach((f, i) => {
      const ref = col(db, ctx.org.id, 'people').doc()
      // The last test person's number ends in 99, which the test providers treat as undeliverable.
      const phoneNorm = i === FIRST.length - 1 ? `${cc}8000000099` : `${cc}80000${String(10000 + i).slice(-5)}`
      const consent = { at: new Date(), source: 'form', wording: 'Test consent (staging)', by: ctx.user.name }
      b.set(ref, { first_name: f, last_name: 'Test', email: i % 5 === 4 ? null : `test+${f.toLowerCase()}@example.test`, phone: '+' + phoneNorm, phone_norm: phoneNorm, status: i < 12 ? 'member' : 'visitor',
        branch_id: branchId, tags: [tagRef.id], visit_count: i < 12 ? 6 : 1, first_visit_at: new Date(Date.now() - (i < 12 ? 200 : 6) * 86400e3), last_seen_at: new Date(Date.now() - (i < 12 ? (i < 4 ? 30 : 6) : 6) * 86400e3),
        consent: i % 4 === 3 ? {} : { whatsapp: { status: 'granted', ...consent }, sms: { status: 'granted', ...consent } }, test: true, open_followups: 0, open_reasons: [], created_at: new Date(), updated_at: new Date(),
        search: searchTokens({ first_name: f, last_name: 'Test', email: i % 5 === 4 ? null : `test+${f.toLowerCase()}@example.test`, phone_norm: phoneNorm }) })
      b.set(col(db, ctx.org.id, 'phones').doc(phoneNorm), { person_id: ref.id })
    })
    await b.commit()
    return { created: FIRST.length, tag: 'Test data' }
  })

  // --- GatherHQ team: providers, rates and the scheduler ----------------------------------------------
  r.get('/platform/comms', { auth: 'platform' }, async () => {
    const { db } = await fb()
    const [overview, cfg, runs, queue] = await Promise.all([
      providerOverview(), platformConfig({ fresh: true }),
      db.collection('schedulerRuns').orderBy('at', 'desc').limit(15).get(),
      db.collection('commsQueue').orderBy('due_at', 'asc').limit(50).get(),
    ])
    return { ...overview, rates: cfg.rates || DEFAULT_RATES, packs: cfg.packs || null, environment: isProduction() ? 'production' : 'staging',
      runs: runs.docs.map(d => ({ id: d.id, ...plain(d.data()) })), queue: queue.docs.map(d => ({ id: d.id, ...plain(d.data()) })) }
  })
  r.post('/platform/comms/provider', { auth: 'platform' }, async ({ ctx, body }) => {
    const channel = oneOf(body.channel, CHANNEL_KEYS, { name: 'Channel' })
    const provider = body.provider === null ? null : String(body.provider || '')
    if (provider && !adapterFor(channel, provider)) throw bad('That provider isn’t available for this channel.')
    const out = await setProvider({ channel, provider, disabled: body.disabled, user: ctx.user })
    await audit(ctx, 'platform.comms_provider', 'platform', 'comms', { channel, provider, disabled: body.disabled ?? null })
    return out
  })
  r.post('/platform/comms/test', { auth: 'platform' }, async ({ body }) => {
    const a = adapterFor(oneOf(body.channel, CHANNEL_KEYS, { name: 'Channel' }), String(body.provider || ''))
    if (!a) throw bad('Unknown provider.')
    return a.test()
  })
  r.post('/platform/comms/rates', { auth: 'platform' }, async ({ ctx, body }) => {
    const R = body.rates
    const okNum = (v) => typeof v === 'number' && v >= 0 && v < 5
    if (!R || typeof R !== 'object' || !R.whatsapp || !R.sms) throw bad('Rates need whatsapp and sms sections.')
    for (const [c, v] of Object.entries(R.whatsapp)) if (!/^([A-Z]{2}|OTHER)$/.test(c) || !okNum(v?.marketing) || !okNum(v?.utility)) throw bad(`Check the WhatsApp rate for ${c}.`)
    for (const [c, v] of Object.entries(R.sms)) if (!/^([A-Z]{2}|OTHER)$/.test(c) || !okNum(v)) throw bad(`Check the SMS rate for ${c}.`)
    const packList = Array.isArray(body.packs) ? body.packs.map(Number).filter(n => n > 0 && n <= 1000).slice(0, 6) : null
    const { db } = await fb()
    await db.collection('platform').doc('comms').set({ rates: { currency: 'USD', placeholder: !!R.placeholder, whatsapp: R.whatsapp, sms: R.sms }, ...(packList ? { packs: packList } : {}), updated_at: new Date(), updated_by: ctx.user.email }, { merge: true })
    clearConfigCache()
    await audit(ctx, 'platform.comms_rates', 'platform', 'comms')
    return { ok: true }
  })
}
