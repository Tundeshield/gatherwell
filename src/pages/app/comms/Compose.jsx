import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { ArrowLeft, Check, CheckCircle2, CircleDashed, Users, UserCheck, UserPlus, Clock, Tag, Sparkles, Smartphone, AlertTriangle } from 'lucide-react'
import { api } from '../../../lib/api'
import { useSession } from '../../../lib/session'
import { useLoad, Button, Input, Select, Textarea, Notice, PageLoader, ErrorState, useToast, Spinner } from '../../../components/ui'
import { AudiencePicker } from '../MessageEditor'
import EmailPreview from '../../../components/EmailPreview'
import EmailBlocksEditor, { withKeys, stripKeys } from '../../../components/EmailBlocksEditor'
import { FIELDS, smsInfo, CHANNELS, localToUtc, withinSendingHours, utcToLocal, nextWeekdayAt } from '../../../../shared/comms.js'
import { blocksFromBody } from '../../../../shared/email.js'
import { fmtDateTime } from '../../../lib/format'
import { CHANNEL_ICON, channelLabel, Exclusions, BubblePreview, money, audienceText, StagingNote } from './shared'

const QUICK = [
  ['everyone', 'Everyone', Users, { mode: 'filters', statuses: [], segment: 'all', tags: [], people: [] }],
  ['members', 'Members', UserCheck, { mode: 'filters', statuses: ['member'], segment: 'all', tags: [], people: [] }],
  ['visitors', 'Visitors', UserPlus, { mode: 'filters', statuses: ['visitor'], segment: 'all', tags: [], people: [] }],
  ['first', 'First-time visitors (30 days)', Sparkles, { mode: 'filters', statuses: ['visitor'], segment: 'first_timers_30d', tags: [], people: [] }],
  ['absent', 'Not seen recently', Clock, { mode: 'filters', statuses: [], segment: 'absent', tags: [], people: [] }],
]
const sameAudience = (a, b) => JSON.stringify({ ...a, branch: a.branch || null, unit: a.unit || null }) === JSON.stringify({ ...b, branch: b.branch || null, unit: b.unit || null })

function Steps({ steps, at, onGo }) {
  return (
    <ol className="mb-6 flex flex-wrap items-center gap-2 text-sm" aria-label="Steps">
      {steps.map((s, i) => (
        <li key={s.key} className="flex items-center gap-2">
          <button type="button" disabled={i > at} onClick={() => onGo(i)} aria-current={i === at ? 'step' : undefined}
            className={`flex items-center gap-2 rounded-full px-3 py-1.5 font-medium ${i === at ? 'bg-brand-700 text-white' : i < at ? 'bg-brand-50 text-brand-800 hover:bg-brand-100' : 'bg-mist-100 text-mist-500'}`}>
            <span className={`flex h-5 w-5 items-center justify-center rounded-full text-[11px] ${i === at ? 'bg-white/20' : 'bg-white'}`}>{i < at ? <Check size={12} /> : i + 1}</span>{s.label}
          </button>
          {i < steps.length - 1 && <span aria-hidden className="h-px w-4 bg-mist-300" />}
        </li>
      ))}
    </ol>
  )
}

function Card({ title, hint, children }) {
  return (
    <section className="panel px-5 py-5 sm:px-6">
      <h2 className="text-[19px] font-semibold text-ink">{title}</h2>
      {hint && <p className="mt-1 text-sm text-mist-500">{hint}</p>}
      <div className="mt-5">{children}</div>
    </section>
  )
}

export default function Compose() {
  const { me, tz } = useSession()
  const { id } = useParams()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const toast = useToast()
  const later = id ? null : params.get('mode') === 'later'
  const existing = useLoad(() => (id ? api.get(`/comms/messages/${id}`) : Promise.resolve(null)), [id])
  const channels = useLoad(() => api.get('/comms/channels'), [])
  const settings = useLoad(() => api.get('/email/settings'), [])
  const templates = useLoad(() => api.get('/comms/templates'), [])
  const tagNames = {}

  const [scheduled, setScheduled] = useState(!!later)
  const [at, setAt] = useState(0)
  const [audience, setAudience] = useState(QUICK[1][3])
  const [picked, setPicked] = useState([])
  const [channel, setChannel] = useState(null)
  const [subject, setSubject] = useState('')
  const [preheader, setPreheader] = useState('')
  const [blocks, setBlocks] = useState(() => withKeys(blocksFromBody('Hi {first_name},\n\n')))
  const [body, setBody] = useState('')
  const [templateId, setTemplateId] = useState('')
  const [category, setCategory] = useState('marketing')
  const [sendDate, setSendDate] = useState('')
  const [sendTime, setSendTime] = useState('19:00')
  const [counts, setCounts] = useState({})
  const [review, setReview] = useState(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(null)
  const [error, setError] = useState('')

  // Editing a draft or scheduled message.
  useEffect(() => {
    const m = existing.data?.message
    if (!m) return
    setAudience(m.audience); setChannel(m.channel); setSubject(m.subject || ''); setPreheader(m.preheader || ''); setBlocks(withKeys(m.blocks || []))
    setBody(m.body || ''); setTemplateId(m.template_id || ''); setCategory(m.category || 'marketing')
    if (m.send_local && m.status === 'scheduled' && m.mode === 'scheduled') { setScheduled(true); setSendDate(m.send_local.date); setSendTime(m.send_local.time) }
  }, [existing.data])

  const steps = [{ key: 'who', label: 'Who' }, { key: 'how', label: 'How' }, { key: 'what', label: 'What' }, ...(scheduled ? [{ key: 'when', label: 'When' }] : []), { key: 'review', label: 'Review' }]
  const step = steps[at]?.key

  // How many people each channel can reach, for the "How" step.
  useEffect(() => {
    if (step !== 'how') return
    let off = false
    Promise.all(['email', 'whatsapp', 'sms'].map(c => api.post('/comms/preview', { channel: c, audience, body: 'x' }).then(r => [c, r]).catch(() => [c, null])))
      .then(rs => { if (!off) setCounts(Object.fromEntries(rs)) })
    return () => { off = true }
  }, [step, audience])

  const isOneTap = channel === 'onetap'
  const ch = isOneTap ? 'whatsapp' : channel
  const st = channels.data?.channels || {}
  const approved = (templates.data?.own || []).filter(t => t.whatsapp?.status === 'approved')
  const content = () => ch === 'email' ? { subject, preheader, blocks: stripKeys(blocks) } : { body, templateId: templateId || null, category }

  useEffect(() => {
    if (step !== 'review') return
    setReview(null)
    api.post('/comms/preview', { channel: ch, audience, body, category }).then(setReview).catch(e => setError(e.message))
  }, [step])

  const sendAt = scheduled && sendDate && sendTime ? localToUtc(sendDate, sendTime, tz) : null
  const quiet = channels.data?.quiet
  const canNext = () => {
    if (step === 'who') return audience.mode === 'filters' || (audience.people || []).length > 0
    if (step === 'how') return !!channel
    if (step === 'what') return ch === 'email' ? !!subject.trim() && stripKeys(blocks).some(b => (b.text || '').trim() || b.type === 'image') : ch === 'whatsapp' && !isOneTap && st.whatsapp?.needsTemplates ? !!templateId : !!body.trim()
    if (step === 'when') return !!sendAt && sendAt > new Date(Date.now() + 60e3)
    return true
  }

  async function submit(when) {
    setBusy(true); setError('')
    try {
      if (isOneTap) {
        const m = await api.post('/messages', { channel: 'whatsapp', audience, body })
        navigate(`/app/messages/${m.id}/whatsapp`); return
      }
      const payload = { channel: ch, audience, when, ...content(), ...(when === 'later' ? { sendDate, sendTime } : {}) }
      const r = id ? await api.patch(`/comms/messages/${id}`, payload) : await api.post('/comms/messages', payload)
      let p = r.progress
      if (when === 'now') {
        setProgress(p)
        for (let i = 0; p && p.status === 'sending' && i < 300; i++) { p = await api.post(`/comms/messages/${r.message.id}/send`); setProgress(p) }
        if (p?.status === 'sent') toast(`Sent to ${p.sent.toLocaleString()} ${p.sent === 1 ? 'person' : 'people'}`)
        else if (p?.status === 'paused') toast('Paused: see the message for what to do next')
      } else if (when === 'later') toast(`Scheduled for ${fmtDateTime(r.message.send_at, tz)}`)
      else toast('Saved as a draft')
      navigate(`/app/communications/messages/${r.message.id}`)
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }

  if (existing.loading || channels.loading) return <PageLoader />
  if (existing.error) return <ErrorState error={existing.error} />
  if (channels.error) return <ErrorState error={channels.error} onRetry={channels.reload} />

  const quickKey = QUICK.find(q => sameAudience(q[3], audience))?.[0]
  const samplePerson = { first_name: 'Ada', last_name: '' }
  const smsMeta = smsInfo(body)

  return (
    <div className="mx-auto max-w-3xl">
      <Link to="/app/communications" className="mb-3 inline-flex items-center gap-1.5 text-sm text-mist-500 hover:text-ink"><ArrowLeft size={15} />Communications</Link>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-[26px] font-semibold tracking-tight text-ink">{id ? 'Edit message' : scheduled ? 'Schedule a message' : 'Send a message'}</h1>
        {!id && <button type="button" className="text-sm font-medium text-brand-700 hover:underline" onClick={() => { setScheduled(s => !s); setAt(a => Math.min(a, 2)) }}>{scheduled ? 'Send now instead' : 'Schedule for later instead'}</button>}
      </div>
      <Steps steps={steps} at={at} onGo={setAt} />

      {step === 'who' && (
        <Card title="Who would you like to reach?" hint="Choose a group, or pick people one by one.">
          <div className="mb-5 flex flex-wrap gap-2">
            {QUICK.map(([k, label, Icon, a]) => (
              <button key={k} type="button" onClick={() => setAudience(a)} aria-pressed={quickKey === k}
                className={`flex items-center gap-2 rounded-full border px-3.5 py-2 text-sm font-medium ${quickKey === k ? 'border-brand-600 bg-brand-50 text-brand-800' : 'border-mist-200 bg-white text-ink hover:border-mist-300'}`}>
                <Icon size={15} />{label}
              </button>
            ))}
          </div>
          <AudiencePicker audience={audience} setAudience={setAudience} channel={'email'} preview={null} picked={picked} setPicked={setPicked} />
          <p className="mt-4 text-sm text-mist-500"><Tag size={14} className="mr-1 inline" />To reach a department or group, use a tag (for example “Choir”). Tag people on the People page.</p>
        </Card>
      )}

      {step === 'how' && (
        <Card title="How would you like to send it?" hint={`To: ${audienceText(audience, tagNames)}`}>
          <div className="space-y-3">
            {['email', 'whatsapp', 'sms'].map(c => {
              const s = st[c] || {}
              const Icon = CHANNEL_ICON[c]
              const n = counts[c]
              return (
                <button key={c} type="button" disabled={!s.ready} onClick={() => setChannel(c)} aria-pressed={channel === c}
                  className={`flex w-full items-start gap-4 rounded-xl border p-4 text-left transition-colors ${channel === c ? 'border-brand-600 bg-brand-50 ring-1 ring-brand-600' : s.ready ? 'border-mist-200 bg-white hover:border-mist-300' : 'cursor-not-allowed border-mist-200 bg-mist-50 opacity-70'}`}>
                  <Icon size={22} className={s.ready ? 'mt-0.5 text-brand-700' : 'mt-0.5 text-mist-400'} />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2 text-[16px] font-semibold text-ink">{CHANNELS[c].label}
                      {s.ready ? <span className="flex items-center gap-1 text-xs font-medium text-green-800"><CheckCircle2 size={13} />{s.simulated ? 'Ready (test mode)' : 'Ready'}</span> : <span className="flex items-center gap-1 text-xs font-medium text-mist-500"><CircleDashed size={13} />Not connected yet</span>}
                    </span>
                    <span className="mt-0.5 block text-sm text-mist-500">{CHANNELS[c].blurb}{CHANNELS[c].paid && s.ready ? (s.billing === 'church' ? ' Paid by your church directly.' : ' Uses messaging credit.') : ''}{c === 'email' ? ' Included in your plan.' : ''}</span>
                    {s.ready && n && <span className="mt-1.5 block text-sm text-ink"><span className="font-semibold">{n.eligible.toLocaleString()}</span> of {n.total.toLocaleString()} can receive it{n.total > n.eligible ? <span className="text-mist-500"> · {Object.entries(n.excluded).filter(([, v]) => v).map(([k, v]) => `${v} ${{ no_contact: c === 'email' ? 'no email' : 'no phone', no_consent: 'no permission yet', opted_out: 'opted out', duplicate: 'duplicates' }[k]}`).join(', ')}</span> : null}</span>}
                  </span>
                </button>
              )
            })}
            {!st.whatsapp?.ready && (
              <button type="button" onClick={() => setChannel('onetap')} aria-pressed={isOneTap}
                className={`flex w-full items-start gap-4 rounded-xl border border-dashed p-4 text-left ${isOneTap ? 'border-brand-600 bg-brand-50' : 'border-mist-300 bg-white hover:border-mist-400'}`}>
                <Smartphone size={22} className="mt-0.5 text-brand-700" />
                <span><span className="block text-[16px] font-semibold text-ink">WhatsApp, one by one from your phone</span><span className="text-sm text-mist-500">GatherHQ opens each chat with your message ready. You tap send.</span></span>
              </button>
            )}
          </div>
        </Card>
      )}

      {step === 'what' && ch === 'email' && (
        <Card title="What would you like to say?" hint="Use {first_name} to greet each person by name.">
          <TemplatePick templates={templates.data} onPick={(t) => { setSubject(t.subject || t.name); setBlocks(withKeys(blocksFromBody(t.body))) }} />
          <Input label="Subject" value={subject} onChange={e => setSubject(e.target.value)} maxLength={200} required />
          <Input label="Preview text" hint="The short line shown after the subject in most inboxes." value={preheader} onChange={e => setPreheader(e.target.value)} maxLength={200} />
          <EmailBlocksEditor blocks={blocks} setBlocks={setBlocks} />
          {settings.data && <div className="mt-5"><p className="label">Preview</p><EmailPreview compact org={me.org} branding={settings.data.branding} subject={subject} preheader={preheader} blocks={stripKeys(blocks)} person={samplePerson} fromAddress={settings.data.fromAddress} /></div>}
        </Card>
      )}

      {step === 'what' && ch === 'whatsapp' && !isOneTap && (
        <WhatsAppContent templates={templates} approved={approved} templateId={templateId} setTemplateId={setTemplateId} setBody={setBody} setCategory={setCategory} body={body} category={category} churchName={me.org.name} />
      )}

      {step === 'what' && (ch === 'sms' || isOneTap) && (
        <Card title="What would you like to say?" hint="Keep it short and friendly. Use {first_name} to greet each person by name.">
          <TemplatePick templates={templates.data} onPick={(t) => setBody(t.body)} />
          <Textarea label="Message" rows={5} value={body} onChange={e => setBody(e.target.value)} maxLength={ch === 'sms' ? 918 : 1024} />
          <p className="-mt-2 mb-4 flex flex-wrap gap-x-3 text-xs text-mist-500">{FIELDS.slice(0, 3).map(([k, l]) => <button key={k} type="button" className="hover:text-ink" onClick={() => setBody(b => b + k)}>+ {l}</button>)}</p>
          {ch === 'sms' && <p className={`mb-4 text-sm ${smsMeta.segments > 2 ? 'text-amber-800' : 'text-mist-600'}`}>{smsMeta.length} characters · {smsMeta.segments} {smsMeta.segments === 1 ? 'text' : 'texts'} per person{smsMeta.unicode ? ' (emoji or special letters make each text shorter)' : ''}{smsMeta.segments > 1 ? '. Longer messages cost more.' : ''}</p>}
          <BubblePreview channel={ch} text={body} churchName={me.org.name} />
        </Card>
      )}

      {step === 'when' && (
        <Card title="When should it go out?" hint={`Times are in your church’s time zone (${tz}).`}>
          <div className="mb-4 flex flex-wrap gap-2">
            {[['This Friday, 7pm', 5, '19:00'], ['Saturday, 9am', 6, '09:00'], ['Sunday, 8am', 0, '08:00'], ['Monday, 10am', 1, '10:00']].map(([label, d, t]) => {
              const at2 = nextWeekdayAt(new Date(), tz, [d], t); const l = utcToLocal(at2, tz)
              return <button key={label} type="button" onClick={() => { setSendDate(l.date); setSendTime(l.time) }} className="rounded-full border border-mist-200 bg-white px-3.5 py-2 text-sm font-medium text-ink hover:border-mist-300">{label}</button>
            })}
          </div>
          <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
            <Input label="Date" type="date" value={sendDate} onChange={e => setSendDate(e.target.value)} min={utcToLocal(new Date(), tz).date} required />
            <Input label="Time" type="time" value={sendTime} onChange={e => setSendTime(e.target.value)} required />
          </div>
          {sendAt && (sendAt <= new Date() ? <Notice tone="warning">That time has already passed. Choose a time in the future.</Notice>
            : <p className="rounded-lg bg-brand-50 px-4 py-3 text-[15px] text-brand-900">It will go out on <strong>{fmtDateTime(sendAt, tz)}</strong>.{quiet && !withinSendingHours(sendAt, tz, quiet) ? ' That’s outside your usual sending hours, but it will go at the time you chose.' : ''}</p>)}
        </Card>
      )}

      {step === 'review' && (
        <Card title="Check and send" hint="Here’s exactly what will happen.">
          {!review ? <div className="flex items-center gap-2 text-sm text-mist-500"><Spinner />Checking who can receive it…</div> : (
            <dl className="divide-y divide-mist-100 text-[15px]">
              <Row label="To"><p className="text-ink">{audienceText(audience, tagNames)}</p>
                <p className="mt-1"><span className="font-semibold text-ink">{review.eligible.toLocaleString()}</span> <span className="text-mist-600">{review.eligible === 1 ? 'person' : 'people'} will receive it{review.total > review.eligible ? `, out of ${review.total.toLocaleString()}` : ''}.</span></p>
                {review.total > review.eligible && <><p className="mt-2 text-sm font-medium text-ink">Why some people aren’t included</p><Exclusions channel={ch} excluded={review.excluded} /></>}
                {scheduled && audience.mode === 'filters' && <p className="mt-2 text-sm text-mist-500">The final number can change: GatherHQ checks who is in this group at the moment it sends.</p>}
              </Row>
              <Row label="By">{isOneTap ? 'WhatsApp, one by one from your phone' : channelLabel(ch)}</Row>
              <Row label="Message">{ch === 'email' && settings.data ? <><p className="mb-2 font-medium text-ink">{subject}</p><EmailPreview compact org={me.org} branding={settings.data.branding} subject={subject} preheader={preheader} blocks={stripKeys(blocks)} person={samplePerson} fromAddress={settings.data.fromAddress} /></> : <BubblePreview channel={ch} text={body} churchName={me.org.name} />}</Row>
              <Row label="When">{scheduled ? fmtDateTime(sendAt, tz) : 'Straight away'}</Row>
              {review.estimate?.billing === 'platform' && (
                <Row label="Cost">
                  <p className="text-ink">Estimated cost: <strong>{money(review.estimate.cost)}</strong> · Your balance: {money(review.estimate.balance)}</p>
                  {!review.estimate.enough && <Notice tone="warning" className="mt-2" title="Not enough messaging credit">{scheduled ? 'You can still schedule it. If there isn’t enough credit when it’s due, it will wait until you add more.' : 'It will be paused until you add credit. Email isn’t affected.'} <Link to="/app/communications/channels" className="link">Add credit</Link></Notice>}
                  {review.estimate.placeholderRates && <p className="mt-1 text-xs text-mist-500">Prices are provisional while providers are being chosen.</p>}
                </Row>
              )}
              {review.estimate?.billing === 'church' && <Row label="Cost">Your church pays the provider directly. GatherHQ doesn’t charge for these messages.</Row>}
            </dl>
          )}
          <StagingNote>Staging: messages go to the test provider and nobody is contacted. Emails only reach approved test addresses.</StagingNote>
          {progress && progress.status === 'sending' && <p className="mt-3 flex items-center gap-2 text-sm text-mist-600"><Spinner />Sending… {progress.sent.toLocaleString()} of {progress.total.toLocaleString()}</p>}
        </Card>
      )}

      {error && <Notice tone="danger" className="mt-4"><AlertTriangle size={16} className="mr-1 inline" />{error}</Notice>}

      <div className="sticky bottom-0 mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-mist-200 bg-ivory/95 py-4 backdrop-blur">
        <Button variant="secondary" onClick={() => (at === 0 ? navigate('/app/communications') : setAt(at - 1))}>{at === 0 ? 'Cancel' : 'Back'}</Button>
        <div className="flex flex-wrap gap-2">
          {step === 'review' && !isOneTap && <Button variant="ghost" loading={busy} onClick={() => submit('draft')}>Save as draft</Button>}
          {step !== 'review' ? <Button onClick={() => { setError(''); setAt(at + 1) }} disabled={!canNext()}>Continue</Button>
            : <Button loading={busy} disabled={!review || (!isOneTap && review.eligible === 0)} onClick={() => submit(scheduled ? 'later' : 'now')}>
              {isOneTap ? 'Start sending on WhatsApp' : scheduled ? `Schedule for ${fmtDateTime(sendAt, tz)}` : `Send now to ${review?.eligible?.toLocaleString() ?? ''} ${review?.eligible === 1 ? 'person' : 'people'}`}
            </Button>}
        </div>
      </div>
    </div>
  )
}

function Row({ label, children }) {
  return <div className="grid grid-cols-1 gap-1 py-3.5 sm:grid-cols-[110px_minmax(0,1fr)] sm:gap-4"><dt className="text-sm font-medium text-mist-500">{label}</dt><dd className="min-w-0">{children}</dd></div>
}

function TemplatePick({ templates, onPick }) {
  const all = [...(templates?.own || []), ...(templates?.starters || [])]
  if (!all.length) return null
  return (
    <Select label="Start from a template (optional)" value="" onChange={e => { const t = all.find(x => x.id === e.target.value); if (t) onPick(t) }}>
      <option value="">Write from scratch</option>
      {(templates.own || []).length > 0 && <optgroup label="Your templates">{templates.own.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</optgroup>}
      <optgroup label="Starter templates">{templates.starters.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</optgroup>
    </Select>
  )
}

// WhatsApp needs an approved template for messages a person didn't ask for.
function WhatsAppContent({ templates, approved, templateId, setTemplateId, setBody, setCategory, body, category, churchName }) {
  const toast = useToast()
  const [creating, setCreating] = useState(approved.length === 0)
  const [name, setName] = useState('')
  const [text, setText] = useState('Hi {first_name}, ')
  const [cat, setCat] = useState('marketing')
  const [busy, setBusy] = useState(false)
  const pick = (t) => { setTemplateId(t.id); setBody(t.body); setCategory(t.category) }
  async function create() {
    setBusy(true)
    try {
      const t = await api.post('/comms/templates', { name, purpose: 'general', body: text, category: cat })
      const s = await api.post(`/comms/templates/${t.id}/submit`, {})
      await templates.reload()
      if (s.whatsapp.status === 'approved') { pick(s); setCreating(false); toast(s.whatsapp.simulated ? 'Template approved (simulated on staging)' : 'Template approved') }
      else toast('Sent to WhatsApp for approval. You can send it once it’s approved.')
    } catch (e) { toast(e.message, 'error') } finally { setBusy(false) }
  }
  return (
    <Card title="What would you like to say?" hint="WhatsApp asks businesses to use an approved message template for messages people didn’t request. Choose one, or write a new one.">
      {!creating ? (
        <>
          <div className="space-y-2">
            {approved.map(t => (
              <button key={t.id} type="button" onClick={() => pick(t)} aria-pressed={templateId === t.id}
                className={`block w-full rounded-xl border p-4 text-left ${templateId === t.id ? 'border-brand-600 bg-brand-50 ring-1 ring-brand-600' : 'border-mist-200 bg-white hover:border-mist-300'}`}>
                <span className="flex flex-wrap items-center gap-2 font-semibold text-ink">{t.name}<span className="text-xs font-medium text-green-800">Approved{t.whatsapp?.simulated ? ' (simulated)' : ''} · {t.category === 'utility' ? 'Utility' : 'Marketing'}</span></span>
                <span className="mt-1 block text-sm text-mist-600">{t.body}</span>
              </button>
            ))}
          </div>
          <button type="button" className="mt-3 text-sm font-medium text-brand-700 hover:underline" onClick={() => setCreating(true)}>Write a new WhatsApp template</button>
          {templateId && <div className="mt-5"><p className="label">Preview</p><BubblePreview channel="whatsapp" text={body} churchName={churchName} /><p className="mt-2 text-xs text-mist-500">WhatsApp charges marketing messages more than utility ones (such as reminders for something someone signed up for). This one is {category === 'utility' ? 'utility' : 'marketing'}.</p></div>}
        </>
      ) : (
        <>
          <Input label="Template name" hint="Only your team sees this." value={name} onChange={e => setName(e.target.value)} maxLength={100} />
          <Textarea label="Message" rows={5} value={text} onChange={e => setText(e.target.value)} maxLength={1024} />
          <Select label="What kind of message is it?" value={cat} onChange={e => setCat(e.target.value)} hint="WhatsApp decides the final category when it reviews the template.">
            <option value="marketing">Marketing: welcomes, invitations, news</option>
            <option value="utility">Utility: reminders or updates about something they signed up for</option>
          </Select>
          <BubblePreview channel="whatsapp" text={text} churchName={churchName} />
          <div className="mt-4 flex flex-wrap gap-2">
            <Button loading={busy} disabled={!name.trim() || text.trim().length < 5} onClick={create}>Save and submit for approval</Button>
            {approved.length > 0 && <Button variant="ghost" onClick={() => setCreating(false)}>Use an existing template</Button>}
          </div>
        </>
      )}
    </Card>
  )
}
