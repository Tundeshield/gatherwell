import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, ArrowUp, ArrowDown, Trash2, Heading, Type, MousePointerClick, Image as ImageIcon, Minus, Send, Mail, Smartphone, MessageCircle, Download, Upload, FlaskConical, Settings2 } from 'lucide-react'
import { api, download } from '../../lib/api'
import { useSession, useBranchParam } from '../../lib/session'
import { useLoad, useDebounced, Button, Input, Select, Notice, Checkbox, Modal, PageLoader, ErrorState, useToast } from '../../components/ui'
import { STATUS_LABELS } from '../../lib/format'
import EmailPreview from '../../components/EmailPreview'
import { MERGE_FIELDS, STARTER_BLOCKS } from '../../../shared/email.js'
import { prepareImage } from '../../lib/image'
import { runSend } from '../../lib/sendMessage'

const CHANNELS = { email: ['Email', Mail], sms: ['SMS', Smartphone], whatsapp: ['WhatsApp', MessageCircle] }
const SEGMENTS = { all: 'Everyone matching', recent: 'Seen recently', absent: 'Not seen recently', first_timers_30d: 'First visit in the last 30 days' }
const BLOCKS = {
  heading: ['Heading', Heading, () => ({ type: 'heading', text: '' })],
  text: ['Text', Type, () => ({ type: 'text', text: '' })],
  button: ['Button', MousePointerClick, () => ({ type: 'button', label: 'Learn more', url: '' })],
  image: ['Image', ImageIcon, () => ({ type: 'image', url: '', alt: '', link: '' })],
  divider: ['Divider', Minus, () => ({ type: 'divider' })],
}
let keySeq = 0
const withKeys = (blocks) => blocks.map(b => ({ ...b, _k: ++keySeq }))
const strip = (blocks) => blocks.map(({ _k, ...b }) => b)

function smsInfo(text) {
  const unicode = /[^\x00-\x7F£€¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ¡ÄÖÑÜ§¿äöñüà]/.test(text)
  const single = unicode ? 70 : 160, multi = unicode ? 67 : 153
  return { n: text.length, parts: text.length <= single ? 1 : Math.ceil(text.length / multi), unicode }
}

function AudiencePicker({ audience, setAudience, channel, preview }) {
  const { activeBranches, multiBranch } = useSession()
  const units = useLoad(() => api.get('/units'), [])
  const toggle = (s) => setAudience(a => ({ ...a, statuses: a.statuses.includes(s) ? a.statuses.filter(x => x !== s) : [...a.statuses, s] }))
  const reachable = preview ? (channel === 'email' ? preview.counts.with_email : preview.counts.with_phone) : null
  return (
    <section className="panel px-5 py-4">
      <h2 className="mb-3 text-[15px] font-semibold text-ink">Who receives it</h2>
      <div className="grid gap-x-4 sm:grid-cols-2">
        {multiBranch && (
          <Select label="Branch" value={audience.branch || ''} onChange={e => setAudience(a => ({ ...a, branch: e.target.value }))}>
            <option value="">All my branches</option>{activeBranches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
          </Select>
        )}
        <Select label="Attendance" value={audience.segment} onChange={e => setAudience(a => ({ ...a, segment: e.target.value }))}>
          {Object.entries(SEGMENTS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
        {units.data?.length > 0 && (
          <Select label="Service unit" value={audience.unit || ''} onChange={e => setAudience(a => ({ ...a, unit: e.target.value }))}>
            <option value="">Any unit</option>{units.data.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
          </Select>
        )}
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-2">
        {['member', 'visitor', 'inactive'].map(s => <Checkbox key={s} label={STATUS_LABELS[s] + 's'} checked={audience.statuses.includes(s)} onChange={() => toggle(s)} />)}
      </div>
      {preview && (
        <p className="mt-3 rounded-lg bg-mist-50 px-3 py-2 text-sm text-mist-600">
          <span className="font-semibold text-ink">{reachable.toLocaleString()}</span> of {preview.counts.total.toLocaleString()} people can be reached by {CHANNELS[channel][0].toLowerCase()}
          {channel === 'email' && preview.counts.unsubscribed > 0 && <>, not counting {preview.counts.unsubscribed} who unsubscribed</>}.
          {preview.sample.length > 0 && <span className="block text-xs text-mist-400">Including {preview.sample.join(', ')}{preview.counts.total > preview.sample.length ? '…' : ''}</span>}
        </p>
      )}
    </section>
  )
}

function BlockCard({ block, index, count, onChange, onMove, onRemove, onFocusField }) {
  const [label, Icon] = BLOCKS[block.type]
  const toast = useToast()
  const [uploading, setUploading] = useState(false)
  const fileRef = useRef(null)
  const set = (k) => (e) => onChange({ ...block, [k]: e.target.value })
  const focus = (field) => (e) => onFocusField({ index, field, el: e.target })

  async function upload(file) {
    if (!file) return
    setUploading(true)
    try {
      const dataUrl = await prepareImage(file, { maxWidth: 1200 })
      const { url } = await api.post('/email/assets', { dataUrl })
      onChange({ ...block, url, alt: block.alt || file.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ') })
    } catch (e) { toast(e.message, 'error') } finally { setUploading(false); if (fileRef.current) fileRef.current.value = '' }
  }

  return (
    <div className="panel px-4 py-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-md bg-mist-100 text-mist-600"><Icon size={15} /></span>
        <span className="flex-1 text-sm font-medium text-ink">{label}</span>
        <Button size="sm" variant="ghost" icon={ArrowUp} aria-label="Move up" disabled={index === 0} onClick={() => onMove(-1)} />
        <Button size="sm" variant="ghost" icon={ArrowDown} aria-label="Move down" disabled={index === count - 1} onClick={() => onMove(1)} />
        <Button size="sm" variant="ghost" icon={Trash2} aria-label="Remove" onClick={onRemove} />
      </div>
      {block.type === 'heading' && <Input className="mb-0" aria-label="Heading" value={block.text} onChange={set('text')} onFocus={focus('text')} placeholder="e.g. You’re invited, {first_name}" />}
      {block.type === 'text' && (
        <textarea aria-label="Text" value={block.text} onChange={set('text')} onFocus={focus('text')} rows={Math.min(14, Math.max(4, block.text.split('\n').length + 1))}
          className="field" placeholder="Write your message. Leave an empty line between paragraphs. Links like https://… become clickable." />
      )}
      {block.type === 'button' && (
        <div className="grid gap-x-3 sm:grid-cols-2">
          <Input className="mb-0" label="Button text" value={block.label} onChange={set('label')} onFocus={focus('label')} />
          <Input className="mb-0" label="Link" value={block.url} onChange={set('url')} placeholder="https://" error={block.url && !/^https?:\/\//.test(block.url) ? 'Start with https://' : undefined} />
        </div>
      )}
      {block.type === 'image' && (
        <div className="space-y-3">
          {block.url && <img src={block.url} alt={block.alt} className="max-h-48 rounded-lg border border-mist-200 object-contain" />}
          <div className="flex flex-wrap items-center gap-2">
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" className="hidden" onChange={e => upload(e.target.files[0])} />
            <Button size="sm" variant="secondary" icon={Upload} loading={uploading} onClick={() => fileRef.current?.click()}>{block.url ? 'Replace image' : 'Upload image'}</Button>
            <span className="text-xs text-mist-400">or paste an image link below</span>
          </div>
          <div className="grid gap-x-3 sm:grid-cols-2">
            <Input className="mb-0" label="Image link" value={block.url} onChange={set('url')} placeholder="https://" />
            <Input className="mb-0" label="Describe the image" hint="Shown if the image doesn’t load." value={block.alt} onChange={set('alt')} />
          </div>
          <Input className="mb-0" label="Open this link when tapped (optional)" value={block.link} onChange={set('link')} placeholder="https://" />
        </div>
      )}
      {block.type === 'divider' && <hr className="my-2 border-mist-200" />}
    </div>
  )
}

function SendDialog({ open, onClose, message, settings, reachable, onSent }) {
  const toast = useToast()
  const [progress, setProgress] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (open) { setProgress(null); setError('') } }, [open])
  async function send() {
    setBusy(true); setError('')
    try {
      const p = await runSend(message.id, setProgress)
      if (p.status === 'sent') { toast(`Sent to ${p.sent.toLocaleString()} ${p.sent === 1 ? 'person' : 'people'}`); onSent() }
      else setError(p.error || 'Sending stopped. Please try again.')
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  const pct = progress?.total ? Math.round(((progress.sent + progress.failed) / progress.total) * 100) : 0
  const b = settings?.branding || {}
  return (
    <Modal open={open} onClose={busy ? undefined : onClose} title={busy ? 'Sending…' : 'Ready to send?'}
      footer={!busy && <><Button variant="secondary" onClick={onClose}>Not yet</Button>
        <Button icon={Send} onClick={send} disabled={!settings?.connected || !reachable}>Send to {reachable.toLocaleString()} {reachable === 1 ? 'person' : 'people'}</Button></>}>
      {busy || progress ? (
        <div className="py-2">
          <div className="h-2 overflow-hidden rounded-full bg-mist-100"><div className="h-full bg-brand-600 transition-all" style={{ width: `${pct}%` }} /></div>
          <p className="mt-3 text-sm text-mist-600">{(progress?.sent || 0).toLocaleString()} of {(progress?.total || reachable).toLocaleString()} sent{progress?.failed ? ` · ${progress.failed} couldn’t be delivered` : ''}. Please keep this page open.</p>
          {error && <Notice tone="danger" className="mt-4">{error}</Notice>}
        </div>
      ) : (
        <div className="space-y-4">
          {!settings?.connected && <Notice tone="warning" title="Email sending isn’t switched on yet">Your draft is saved. Once sending is connected, you can send it from here.</Notice>}
          {error && <Notice tone="danger">{error}</Notice>}
          <dl className="divide-y divide-mist-100 rounded-lg border border-mist-200 text-sm">
            {[['To', `${reachable.toLocaleString()} ${reachable === 1 ? 'person' : 'people'}`], ['From', settings?.fromAddress || b.fromName], ['Replies go to', b.replyTo || 'Not set (add one in Settings › Email)'], ['Subject', message.subject]].map(([k, v]) => (
              <div key={k} className="flex gap-4 px-4 py-2.5"><dt className="w-28 shrink-0 text-mist-500">{k}</dt><dd className="min-w-0 break-words text-ink">{v}</dd></div>
            ))}
          </dl>
          <p className="text-xs text-mist-500">Each person gets their own copy with their name filled in and an unsubscribe link. Once sent, this can’t be undone.</p>
        </div>
      )}
    </Modal>
  )
}

export default function MessageEditor() {
  const { id: routeId } = useParams()
  const isNew = !routeId || routeId === 'new'
  const navigate = useNavigate()
  const toast = useToast()
  const { me, can } = useSession()
  const branchParam = useBranchParam()
  const settings = useLoad(() => api.get('/email/settings'), [])
  const existing = useLoad(() => (isNew ? Promise.resolve(null) : api.get(`/messages/${routeId}`)), [routeId])

  const [id, setId] = useState(isNew ? null : routeId)
  const [channel, setChannel] = useState('email')
  const [audience, setAudience] = useState({ branch: branchParam || '', statuses: ['member'], unit: '', segment: 'all' })
  const [subject, setSubject] = useState('')
  const [preheader, setPreheader] = useState('')
  const [blocks, setBlocks] = useState(() => withKeys(STARTER_BLOCKS))
  const [body, setBody] = useState('')
  const [loaded, setLoaded] = useState(isNew)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [preview, setPreview] = useState(null)
  const lastField = useRef(null)

  useEffect(() => {
    const m = existing.data
    if (!m) return
    if (m.status !== 'draft') { navigate('/app/messages', { replace: true }); return }
    setId(m.id); setChannel(m.channel); setAudience({ branch: '', unit: '', segment: 'all', statuses: [], ...m.audience, branch: m.audience?.branch || '', unit: m.audience?.unit || '' })
    setSubject(m.subject || ''); setPreheader(m.preheader || ''); setBody(m.body || '')
    setBlocks(withKeys(m.blocks?.length ? m.blocks : STARTER_BLOCKS)); setLoaded(true)
  }, [existing.data]) // eslint-disable-line

  const debouncedAudience = useDebounced(audience, 300)
  useEffect(() => { api.post('/messages/audience', { audience: debouncedAudience }).then(setPreview).catch(() => {}) }, [debouncedAudience])

  const cleanBlocks = useMemo(() => strip(blocks), [blocks])
  const samplePerson = useMemo(() => ({ first_name: (preview?.sample?.[0] || 'Ada').split(' ')[0], last_name: '' }), [preview])
  const reachable = preview ? (channel === 'email' ? preview.counts.with_email : preview.counts.with_phone) : 0

  const update = (i, b) => setBlocks(bs => bs.map((x, j) => (j === i ? { ...b, _k: x._k } : x)))
  const move = (i, d) => setBlocks(bs => { const a = [...bs]; const [x] = a.splice(i, 1); a.splice(i + d, 0, x); return a })
  const remove = (i) => setBlocks(bs => bs.filter((_, j) => j !== i))
  const add = (type) => setBlocks(bs => [...bs, ...withKeys([BLOCKS[type][2]()])])
  function insertField(tag) {
    const f = lastField.current
    if (!f || !blocks[f.index]) { toast('Click into a heading or text box first'); return }
    const el = f.el
    const cur = String(blocks[f.index][f.field] || '')
    const pos = el && typeof el.selectionStart === 'number' ? el.selectionStart : cur.length
    update(f.index, { ...blocks[f.index], [f.field]: cur.slice(0, pos) + tag + cur.slice(pos) })
    setTimeout(() => { try { el.focus(); el.setSelectionRange(pos + tag.length, pos + tag.length) } catch { /* ignore */ } }, 0)
  }

  async function save({ quiet = false } = {}) {
    setSaving(true); setError('')
    const payload = { channel, audience, ...(channel === 'email' ? { subject, preheader, blocks: cleanBlocks } : { body }) }
    try {
      let m
      if (id) m = await api.patch(`/messages/${id}`, payload)
      else { m = await api.post('/messages', payload); setId(m.id); navigate(`/app/messages/${m.id}`, { replace: true }) }
      if (!quiet) toast('Draft saved')
      return m
    } catch (e) { setError(e.message); return null } finally { setSaving(false) }
  }
  async function sendTest() {
    setTesting(true); setError('')
    try { const r = await api.post('/messages/test', { subject, preheader, blocks: cleanBlocks }); toast(`Test sent to ${r.to}`) }
    catch (e) { setError(e.message) } finally { setTesting(false) }
  }
  async function review() {
    if (!subject.trim()) { setError('Add a subject before sending.'); return }
    if (!cleanBlocks.some(b => b.type !== 'divider' && (b.text || b.label || b.url))) { setError('Add some content before sending.'); return }
    const m = await save({ quiet: true })
    if (m) setSending(true)
  }

  if (existing.error) return <ErrorState error={existing.error} onRetry={existing.reload} />
  if (!loaded || !settings.data) return <PageLoader />
  const s = settings.data
  const sms = smsInfo(body)

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <Link to="/app/messages" className="inline-flex items-center gap-1.5 text-sm text-mist-500 hover:text-ink"><ArrowLeft size={16} /> Messages</Link>
        <h1 className="flex-1 text-xl font-semibold text-ink">{id ? 'Edit message' : 'New message'}</h1>
        <Button variant="secondary" onClick={() => save()} loading={saving}>Save draft</Button>
        {channel === 'email' && <Button variant="secondary" icon={FlaskConical} onClick={sendTest} loading={testing} disabled={!s.connected}
          title={s.connected ? `Send a test to ${me.user?.email || 'you'}` : 'Available once email sending is switched on'}>Send test to me</Button>}
        {channel === 'email' && <Button icon={Send} onClick={review}>Review and send</Button>}
      </div>

      {error && <Notice tone="danger" className="mb-4">{error}</Notice>}
      {channel === 'email' && !s.connected && (
        <Notice tone="info" className="mb-4" title="Email sending isn’t switched on yet">
          You can write, preview and save emails now. Sending and test emails start working once your email domain is connected.
        </Notice>
      )}

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,560px)]">
        <div className="space-y-4">
          <div className="flex gap-2">
            {Object.entries(CHANNELS).map(([k, [label, Icon]]) => (
              <button key={k} type="button" onClick={() => setChannel(k)} aria-pressed={channel === k}
                className={`flex flex-1 items-center justify-center gap-2 rounded-lg border px-3 py-2.5 text-sm font-medium ${channel === k ? 'border-brand-300 bg-brand-50 text-brand-700' : 'border-mist-200 bg-white text-mist-600 hover:border-mist-300'}`}>
                <Icon size={16} />{label}
              </button>
            ))}
          </div>

          <AudiencePicker audience={audience} setAudience={setAudience} channel={channel} preview={preview} />

          {channel === 'email' ? (
            <>
              <section className="panel px-5 py-4">
                <Input label="Subject" value={subject} onChange={e => setSubject(e.target.value)} placeholder="e.g. This Sunday: Family Service at 9am" maxLength={200} />
                <Input className="mb-0" label="Preview text" hint="The short line people see next to the subject in their inbox." value={preheader} onChange={e => setPreheader(e.target.value)} maxLength={200} />
              </section>

              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-mist-500">Personalise:</span>
                {MERGE_FIELDS.map(([tag, label]) => (
                  <button key={tag} type="button" onMouseDown={e => e.preventDefault()} onClick={() => insertField(tag)}
                    className="rounded-full border border-mist-200 bg-white px-2.5 py-1 text-xs font-medium text-mist-600 hover:border-brand-300 hover:text-brand-700">+ {label}</button>
                ))}
              </div>

              {blocks.map((b, i) => (
                <BlockCard key={b._k} block={b} index={i} count={blocks.length} onChange={(nb) => update(i, nb)} onMove={(d) => move(i, d)} onRemove={() => remove(i)}
                  onFocusField={(f) => { lastField.current = f }} />
              ))}

              <div className="rounded-xl border border-dashed border-mist-300 bg-white/60 p-3">
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-mist-500">Add to email</p>
                <div className="flex flex-wrap gap-2">
                  {Object.entries(BLOCKS).map(([k, [label, Icon]]) => <Button key={k} size="sm" variant="secondary" icon={Icon} onClick={() => add(k)}>{label}</Button>)}
                </div>
              </div>
            </>
          ) : (
            <section className="panel px-5 py-4">
              <label htmlFor="msg-body" className="label">Message</label>
              <textarea id="msg-body" value={body} onChange={e => setBody(e.target.value)} rows={6} className="field" placeholder="e.g. Hi! Join us this Sunday at 9am for our family service." />
              {channel === 'sms' && <p className="hint">{sms.n} characters · {sms.parts} SMS {sms.parts === 1 ? 'part' : 'parts'} per person{sms.unicode ? ' (emoji or special characters use shorter parts)' : ''}</p>}
              <Notice tone="info" className="mt-4">{CHANNELS[channel][0]} sending is coming soon. Save this as a draft, or download the recipient list to send it from another tool.</Notice>
              {id && can('export') && <Button className="mt-3" size="sm" variant="secondary" icon={Download} onClick={() => download(`/messages/${id}/recipients`).catch(e => toast(e.message, 'error'))}>Download recipients</Button>}
            </section>
          )}
        </div>

        {channel === 'email' && (
          <div className="xl:sticky xl:top-6">
            <EmailPreview org={me.org} branding={s.branding} subject={subject} preheader={preheader} blocks={cleanBlocks} person={samplePerson} fromAddress={s.fromAddress} />
            <p className="mt-3 text-center text-xs text-mist-500">
              Showing {samplePerson.first_name}’s copy. Logo, colour and footer come from{' '}
              {can('org.manage') ? <Link to="/app/settings?tab=email" className="font-medium text-brand-700 hover:underline"><Settings2 size={12} className="mr-0.5 inline" />Settings › Email</Link> : 'Settings › Email'}.
            </p>
          </div>
        )}
      </div>

      {id && <SendDialog open={sending} onClose={() => setSending(false)} message={{ id, subject }} settings={s} reachable={reachable} onSent={() => navigate('/app/messages')} />}
    </div>
  )
}
