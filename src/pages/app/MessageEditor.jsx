import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, ArrowUp, ArrowDown, Trash2, Heading, Type, MousePointerClick, Image as ImageIcon, Minus, Send, Mail, Smartphone, MessageCircle, Download, Upload, FlaskConical, Settings2, Search, Check, Plus, X, Users, UserCheck } from 'lucide-react'
import { api, download } from '../../lib/api'
import { useSession, useBranchParam } from '../../lib/session'
import { useLoad, useDebounced, Button, Input, Select, Notice, Checkbox, Modal, PageLoader, ErrorState, useToast, Segmented } from '../../components/ui'
import { STATUS_LABELS, personName } from '../../lib/format'
import { TagChip, TagPicker, useTags } from '../../components/Tags'
import EmailPreview from '../../components/EmailPreview'
import EmailBlocksEditor, { withKeys, stripKeys } from '../../components/EmailBlocksEditor'
import { MERGE_FIELDS, STARTER_BLOCKS } from '../../../shared/email.js'
import { prepareImage } from '../../lib/image'
import { runSend } from '../../lib/sendMessage'

const CHANNELS = { email: ['Email', Mail], sms: ['SMS', Smartphone], whatsapp: ['WhatsApp', MessageCircle] }
const SEGMENTS = { all: 'Everyone matching', recent: 'Seen recently', absent: 'Not seen recently', first_timers_30d: 'First visit in the last 30 days' }
function smsInfo(text) {
  const unicode = /[^\x00-\x7F£€¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ¡ÄÖÑÜ§¿äöñüà]/.test(text)
  const single = unicode ? 70 : 160, multi = unicode ? 67 : 153
  return { n: text.length, parts: text.length <= single ? 1 : Math.ceil(text.length / multi), unicode }
}

function PeoplePicker({ picked, onAdd, onRemove, channel }) {
  const reachableBy = (p) => (channel === 'email' ? p.email : p.phone)
  const missing = channel === 'email' ? 'no email' : 'no phone'
  const [term, setTerm] = useState('')
  const q = useDebounced(term, 250)
  const [results, setResults] = useState([])
  useEffect(() => {
    if (q.trim().length < 2) { setResults([]); return }
    api.get(`/people?q=${encodeURIComponent(q.trim())}&limit=8`).then(r => setResults(r.rows)).catch(() => setResults([]))
  }, [q])
  const chosen = new Set(picked.map(p => p.id))
  return (
    <div>
      <div className="relative">
        <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-mist-400" />
        <input value={term} onChange={e => setTerm(e.target.value)} placeholder="Search by name, phone or email" className="field h-10 pl-9" aria-label="Find people" />
        {results.length > 0 && (
          <ul className="absolute z-20 mt-1 max-h-72 w-full overflow-y-auto rounded-xl border border-mist-200 bg-white p-1 shadow-pop">
            {results.map(p => (
              <li key={p.id}>
                <button type="button" disabled={chosen.has(p.id)} onClick={() => { onAdd({ id: p.id, name: personName(p), email: !!p.email && !p.email_opt_out, phone: !!p.phone_norm }); setTerm('') }}
                  className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm hover:bg-mist-50 disabled:opacity-40">
                  <span className="min-w-0 flex-1"><span className="block truncate font-medium text-ink">{personName(p)}</span>
                    <span className="block truncate text-xs text-mist-500">{(channel === 'email' ? p.email : p.phone) || (channel === 'email' ? 'No email address' : 'No phone number')}</span></span>
                  {chosen.has(p.id) ? <Check size={15} className="text-brand-700" /> : <Plus size={15} className="text-mist-400" />}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {picked.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {picked.map(p => (
            <span key={p.id} className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium ${reachableBy(p) ? 'border-mist-200 bg-white text-ink' : 'border-amber-200 bg-amber-50 text-amber-800'}`}
              title={reachableBy(p) ? undefined : `${missing}, so they won’t receive it`}>
              {p.name}{!reachableBy(p) && ` (${missing})`}
              <button type="button" onClick={() => onRemove(p.id)} aria-label={`Remove ${p.name}`} className="opacity-60 hover:opacity-100"><X size={12} /></button>
            </span>
          ))}
        </div>
      ) : <p className="mt-2 text-xs text-mist-500">Search and add the exact people who should get this message.</p>}
    </div>
  )
}

function AudiencePicker({ audience, setAudience, channel, preview, picked, setPicked }) {
  const { activeBranches, multiBranch } = useSession()
  const units = useLoad(() => api.get('/units'), [])
  const { tags, byId } = useTags()
  const toggle = (s) => setAudience(a => ({ ...a, statuses: a.statuses.includes(s) ? a.statuses.filter(x => x !== s) : [...a.statuses, s] }))
  const reachable = preview ? (channel === 'email' ? preview.counts.with_email : preview.counts.with_phone) : null
  const mode = audience.mode === 'people' ? 'people' : 'filters'
  const setMode = (m) => setAudience(a => ({ ...a, mode: m }))
  const toggleTag = (t, on) => setAudience(a => ({ ...a, tags: on ? [...new Set([...(a.tags || []), t.id])] : (a.tags || []).filter(x => x !== t.id) }))
  return (
    <section className="panel px-5 py-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[15px] font-semibold text-ink">Who receives it</h2>
        <Segmented size="sm" value={mode} onChange={setMode} options={[{ value: 'filters', label: <><Users size={14} /> A group</> }, { value: 'people', label: <><UserCheck size={14} /> Pick people</> }]} />
      </div>
      {mode === 'people' ? (
        <PeoplePicker channel={channel} picked={picked} onAdd={(p) => { setPicked(x => [...x, p]); setAudience(a => ({ ...a, people: [...(a.people || []), p.id] })) }}
          onRemove={(id) => { setPicked(x => x.filter(p => p.id !== id)); setAudience(a => ({ ...a, people: (a.people || []).filter(x => x !== id) })) }} />
      ) : (
        <>
          <div className="mb-4">
            <p className="label">Tags</p>
            <div className="flex flex-wrap items-center gap-1.5">
              {(audience.tags || []).map(id => <TagChip key={id} tag={byId.get(id)} onRemove={() => toggleTag(byId.get(id), false)} />)}
              <TagPicker selected={audience.tags || []} onToggle={toggleTag} allowCreate={false} label={(audience.tags || []).length ? 'Add another' : 'Only people with a tag…'} />
            </div>
            <p className="hint">{(audience.tags || []).length > 1 ? 'People with any of these tags.' : tags.length ? 'Leave empty to include everyone.' : 'Tag people on the People page to group them, like “Choir” or “Youth”.'}</p>
          </div>
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
        </>
      )}
      {preview && (mode === 'filters' || picked.length > 0) && (
        <p className="mt-3 rounded-lg bg-mist-50 px-3 py-2 text-sm text-mist-600">
          <span className="font-semibold text-ink">{reachable.toLocaleString()}</span> of {preview.counts.total.toLocaleString()} {preview.counts.total === 1 ? 'person' : 'people'} can be reached by {channel === 'whatsapp' ? 'WhatsApp' : CHANNELS[channel][0].toLowerCase()}
          {channel === 'email' && preview.counts.unsubscribed > 0 && <>, not counting {preview.counts.unsubscribed} who unsubscribed</>}.
          {mode === 'filters' && preview.sample.length > 0 && <span className="block text-xs text-mist-400">Including {preview.sample.join(', ')}{preview.counts.total > preview.sample.length ? '…' : ''}</span>}
        </p>
      )}
    </section>
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
  const [audience, setAudience] = useState({ mode: 'filters', branch: branchParam || '', statuses: ['member'], unit: '', segment: 'all', tags: [], people: [] })
  const [picked, setPicked] = useState([])
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

  useEffect(() => {
    const m = existing.data
    if (!m) return
    if (m.status !== 'draft') { navigate('/app/messages', { replace: true }); return }
    setId(m.id); setChannel(m.channel); setAudience({ mode: 'filters', branch: '', unit: '', segment: 'all', statuses: [], tags: [], people: [], ...m.audience, branch: m.audience?.branch || '', unit: m.audience?.unit || '' })
    setSubject(m.subject || ''); setPreheader(m.preheader || ''); setBody(m.body || '')
    setBlocks(withKeys(m.blocks?.length ? m.blocks : STARTER_BLOCKS)); setLoaded(true)
  }, [existing.data]) // eslint-disable-line

  const debouncedAudience = useDebounced(audience, 300)
  useEffect(() => {
    api.post('/messages/audience', { audience: debouncedAudience }).then(r => {
      setPreview(r)
      // Fill in names for hand-picked people when reopening a draft.
      if (r.picked) setPicked(cur => (cur.length === r.picked.length ? cur : r.picked))
    }).catch(() => {})
  }, [debouncedAudience])

  const cleanBlocks = useMemo(() => stripKeys(blocks), [blocks])
  const samplePerson = useMemo(() => ({ first_name: (preview?.sample?.[0] || 'Ada').split(' ')[0], last_name: '' }), [preview])
  const reachable = preview ? (channel === 'email' ? preview.counts.with_email : preview.counts.with_phone) : 0


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
  const waRef = useRef(null)
  function insertWa(tag) {
    const el = waRef.current
    const pos = el && typeof el.selectionStart === 'number' ? el.selectionStart : body.length
    setBody(b => b.slice(0, pos) + tag + b.slice(pos))
    setTimeout(() => { try { el.focus(); el.setSelectionRange(pos + tag.length, pos + tag.length) } catch { /* ignore */ } }, 0)
  }
  async function startWhatsapp() {
    const m = await save({ quiet: true })
    if (m) navigate(`/app/messages/${m.id}/whatsapp`)
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
  const waPreview = body.trim() ? body.replace(/\{first_name\}/g, samplePerson.first_name).replace(/\{last_name\}/g, '').replace(/\{church_name\}/g, me.org.name).replace(/\{my_name\}/g, String(me.user.name || '').split(' ')[0]) : ''

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <Link to="/app/messages" className="inline-flex items-center gap-1.5 text-sm text-mist-500 hover:text-ink"><ArrowLeft size={16} /> Messages</Link>
        <h1 className="flex-1 text-xl font-semibold text-ink">{id ? 'Edit message' : 'New message'}</h1>
        <Button variant="secondary" onClick={() => save()} loading={saving}>Save draft</Button>
        {channel === 'email' && <Button variant="secondary" icon={FlaskConical} onClick={sendTest} loading={testing} disabled={!s.connected}
          title={s.connected ? `Send a test to ${me.user?.email || 'you'}` : 'Available once email sending is switched on'}>Send test to me</Button>}
        {channel === 'email' && <Button icon={Send} onClick={review}>Review and send</Button>}
        {channel === 'whatsapp' && <Button icon={Send} onClick={startWhatsapp} disabled={!body.trim()}>Start sending</Button>}
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
            {Object.entries(CHANNELS).map(([k, [label, Icon]]) => {
              const soon = k === 'sms'
              return (
                <button key={k} type="button" onClick={() => !soon && setChannel(k)} aria-pressed={channel === k} disabled={soon && channel !== k}
                  title={soon ? `${label} is coming soon` : undefined}
                  className={`flex flex-1 items-center justify-center gap-2 rounded-lg border px-3 py-2.5 text-sm font-medium ${channel === k ? 'border-brand-300 bg-brand-50 text-brand-700' : soon ? 'cursor-not-allowed border-mist-200 bg-mist-50 text-mist-400' : 'border-mist-200 bg-white text-mist-600 hover:border-mist-300'}`}>
                  <Icon size={16} />{label}
                  {soon && <span className="rounded-full bg-gold-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-gold-700">Soon</span>}
                </button>
              )
            })}
          </div>

          <AudiencePicker audience={audience} setAudience={setAudience} channel={channel} preview={preview} picked={picked} setPicked={setPicked} />

          {channel === 'email' ? (
            <>
              <section className="panel px-5 py-4">
                <Input label="Subject" value={subject} onChange={e => setSubject(e.target.value)} placeholder="e.g. This Sunday: Family Service at 9am" maxLength={200} />
                <Input className="mb-0" label="Preview text" hint="The short line people see next to the subject in their inbox." value={preheader} onChange={e => setPreheader(e.target.value)} maxLength={200} />
              </section>

              <EmailBlocksEditor blocks={blocks} setBlocks={setBlocks} />
            </>
          ) : channel === 'whatsapp' ? (
            <section className="panel px-5 py-4">
              <label htmlFor="wa-body" className="label">Message</label>
              <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
                <span className="text-mist-500">Personalise:</span>
                {[['{first_name}', 'First name'], ['{church_name}', 'Church name'], ['{my_name}', 'Your name']].map(([tag, label]) => (
                  <button key={tag} type="button" onMouseDown={e => e.preventDefault()} onClick={() => insertWa(tag)}
                    className="rounded-full border border-mist-200 bg-white px-2.5 py-1 text-xs font-medium text-mist-600 hover:border-brand-300 hover:text-brand-700">+ {label}</button>
                ))}
              </div>
              <textarea id="wa-body" ref={waRef} value={body} onChange={e => setBody(e.target.value)} rows={7} className="field" maxLength={4000}
                placeholder="e.g. Hi {first_name}! Choir rehearsal moves to 5pm this Saturday. See you there 🎶" />
              <p className="hint">You’ll send it one person at a time: GatherHQ opens each chat in WhatsApp with their own copy ready, you tap Send, then come back for the next. WhatsApp doesn’t allow sending to everyone at once from a normal account.</p>
            </section>
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

        {channel === 'whatsapp' && (
          <div className="xl:sticky xl:top-6">
            <p className="mb-3 text-sm font-medium text-ink">Preview</p>
            <div className="rounded-2xl bg-[#EFE7DD] p-5">
              <div className="ml-auto max-w-[85%] whitespace-pre-wrap break-words rounded-xl rounded-tr-sm bg-[#D9FDD3] px-3.5 py-2.5 text-[15px] leading-snug text-[#111B21] shadow-sm">
                {waPreview || <span className="text-[#667781]">Your message will appear here.</span>}
                <span className="mt-1 block text-right text-[11px] text-[#667781]">now ✓✓</span>
              </div>
            </div>
            <p className="mt-3 text-center text-xs text-mist-500">Showing {samplePerson.first_name}’s copy.</p>
          </div>
        )}
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
