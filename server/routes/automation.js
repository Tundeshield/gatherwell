// Settings for the automations: welcome journey emails, WhatsApp follow-up messages and the
// Monday brief, plus previews and test sends.
import { fb } from '../firebase.js'
import { bad, str } from '../http.js'
import { requireCap, can } from '../access.js'
import { audit, rateLimit } from '../util.js'
import { cleanBlocks } from '../../shared/email.js'
import { JOURNEY_STEPS, journeyFor, whatsappFor, WHATSAPP_KINDS } from '../../shared/automation.js'
import { emailProvider, fromAddress, sendEmails, siteOrigin } from '../email.js'
import { journeyMessage, buildBrief, sendBrief } from '../jobs.js'

export default function (r) {
  r.get('/automation', async ({ ctx }) => {
    if (!can(ctx, 'messages.manage') && !can(ctx, 'org.manage')) requireCap(ctx, 'org.manage')
    return {
      journey: journeyFor(ctx.org), journeyStats: ctx.org.journey_stats || {}, whatsapp: whatsappFor(ctx.org),
      briefEnabled: ctx.org.settings?.briefEnabled !== false, briefSentAt: ctx.org.brief_sent_at || null, connected: !!emailProvider(),
    }
  })

  r.patch('/automation', async ({ ctx, body }) => {
    requireCap(ctx, 'org.manage')
    const { db } = await fb()
    const patch = { updated_at: new Date() }
    if (body.journey) {
      const cur = journeyFor(ctx.org)
      const next = {}
      for (const { key } of JOURNEY_STEPS) {
        const inp = body.journey[key]; const c = cur[key]
        if (!inp) { next[key] = c; continue }
        const blocks = inp.blocks !== undefined ? cleanBlocks(inp.blocks) : c.blocks
        const enabled = inp.enabled !== undefined ? !!inp.enabled : c.enabled
        const subject = inp.subject !== undefined ? str(inp.subject, { max: 200, name: 'Subject' }) : c.subject
        if (enabled && (!subject || !blocks.length)) throw bad('Each email you switch on needs a subject and some content.')
        next[key] = { enabled, subject, blocks, preheader: inp.preheader !== undefined ? str(inp.preheader, { max: 200 }) : c.preheader,
          delayHours: inp.delayHours !== undefined ? Math.min(168, Math.max(0, Number(inp.delayHours) || 0)) : c.delayHours }
      }
      patch.journey = next
    }
    if (body.whatsapp) {
      const cur = whatsappFor(ctx.org)
      patch.whatsapp_templates = Object.fromEntries(WHATSAPP_KINDS.map(([k]) => [k, body.whatsapp[k] !== undefined ? String(body.whatsapp[k]).slice(0, 1000) : cur[k]]))
    }
    if (body.briefEnabled !== undefined) patch.settings = { ...(ctx.org.settings || {}), briefEnabled: !!body.briefEnabled }
    await db.collection('orgs').doc(ctx.org.id).update(patch)
    await audit(ctx, 'automation.updated', 'organisation', ctx.org.id)
    const org = { ...ctx.org, ...patch }
    return { journey: journeyFor(org), whatsapp: whatsappFor(org), briefEnabled: org.settings?.briefEnabled !== false }
  })

  r.post('/automation/journey/test', async ({ ctx, body, url }) => {
    requireCap(ctx, 'org.manage')
    const provider = emailProvider()
    if (!provider) throw bad('Email sending isn’t switched on yet.')
    await rateLimit(`journeytest:${ctx.user.id}`, 15, 3600)
    const step = JOURNEY_STEPS.find(s => s.key === body.step)?.key
    if (!step) throw bad('Choose an email to test.')
    // Test what's on screen, even if it isn't saved yet.
    const org = body.draft ? { ...ctx.org, journey: { ...(ctx.org.journey || {}), [step]: { ...journeyFor(ctx.org)[step], ...body.draft, blocks: cleanBlocks(body.draft.blocks) } } } : ctx.org
    const { branding, email } = journeyMessage({ org, person: { id: 'test', first_name: String(ctx.user.name || '').split(' ')[0] }, step, origin: siteOrigin(url), test: true })
    const [res] = await sendEmails(provider, [{ from: fromAddress(ctx.org, branding, provider.domain), to: [ctx.user.email], subject: email.subject, html: email.html, text: email.text, ...(branding.replyTo ? { reply_to: branding.replyTo } : {}) }])
    if (!res.ok) throw bad(`The test couldn’t be sent: ${res.error}`)
    return { ok: true, to: ctx.user.email }
  })

  r.get('/automation/brief/preview', async ({ ctx }) => {
    if (!can(ctx, 'org.manage') && !can(ctx, 'reports.view')) requireCap(ctx, 'org.manage')
    const { email, data } = await buildBrief(ctx.org, new Date())
    return { subject: email.subject, html: email.html, summary: { total: data.total, sessions: data.sessions, firstTimers: data.firstTimers } }
  })

  r.post('/automation/brief/test', async ({ ctx }) => {
    requireCap(ctx, 'org.manage')
    if (!emailProvider()) throw bad('Email sending isn’t switched on yet.')
    await rateLimit(`brieftest:${ctx.user.id}`, 10, 3600)
    const res = await sendBrief(ctx.org, { to: [{ id: ctx.user.id, email: ctx.user.email, name: ctx.user.name }] })
    if (!res.sent) throw bad(`The brief couldn’t be sent${res.error ? `: ${res.error}` : '.'}`)
    return { ok: true, to: ctx.user.email }
  })

  // Personal email settings.
  r.get('/me/notifications', { auth: 'user' }, async ({ ctx }) => {
    const { db } = await fb()
    const u = (await db.collection('users').doc(ctx.user.id).get()).data() || {}
    return { brief: !u.brief_opt_out, canReceiveBrief: ['owner', 'admin'].includes(ctx.membership?.role) }
  })
  r.patch('/me/notifications', { auth: 'user' }, async ({ ctx, body }) => {
    const { db } = await fb()
    if (body.brief !== undefined) await db.collection('users').doc(ctx.user.id).update({ brief_opt_out: !body.brief })
    return { brief: !!body.brief }
  })
}
