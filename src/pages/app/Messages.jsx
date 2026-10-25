import { useEffect, useState } from 'react'
import { MessageSquare, Plus, Download, Trash2, Mail, Smartphone, MessageCircle } from 'lucide-react'
import { api, download } from '../../lib/api'
import { useSession, useBranchParam } from '../../lib/session'
import { useLoad, useDebounced, PageHeader, Button, Badge, EmptyState, ErrorState, Skeleton, Modal, Input, Select, Notice, useToast, useConfirm, Checkbox } from '../../components/ui'
import { relative, STATUS_LABELS } from '../../lib/format'

const CHANNELS = { sms: ['SMS', Smartphone], whatsapp: ['WhatsApp', MessageCircle], email: ['Email', Mail] }
const SEGMENTS = { all: 'Everyone matching', recent: 'Seen recently', absent: 'Not seen recently', first_timers_30d: 'First visit in the last 30 days' }

function smsInfo(text) {
  const unicode = /[^\x00-\x7F£€¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ¡ÄÖÑÜ§¿äöñüà]/.test(text)
  const single = unicode ? 70 : 160, multi = unicode ? 67 : 153
  const n = text.length
  return { n, parts: n <= single ? 1 : Math.ceil(n / multi), unicode }
}

function Compose({ open, onClose, onSaved }) {
  const { activeBranches, multiBranch } = useSession()
  const branchParam = useBranchParam()
  const units = useLoad(() => (open ? api.get('/units') : Promise.resolve([])), [open])
  const [channel, setChannel] = useState('sms')
  const [audience, setAudience] = useState({ branch: '', statuses: ['member'], unit: '', segment: 'all' })
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [preview, setPreview] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const debouncedAudience = useDebounced(audience, 300)
  useEffect(() => { if (open) { setAudience(a => ({ ...a, branch: branchParam || '' })); setBody(''); setSubject(''); setError('') } }, [open]) // eslint-disable-line
  useEffect(() => {
    if (!open) return
    api.post('/messages/audience', { audience: debouncedAudience }).then(setPreview).catch(e => setError(e.message))
  }, [debouncedAudience, open])

  const toggleStatus = (s) => setAudience(a => ({ ...a, statuses: a.statuses.includes(s) ? a.statuses.filter(x => x !== s) : [...a.statuses, s] }))
  const reachable = preview ? (channel === 'email' ? preview.counts.with_email : preview.counts.with_phone) : 0
  const sms = smsInfo(body)

  async function save() {
    setBusy(true); setError('')
    try { await api.post('/messages', { channel, subject, body, audience }); onSaved() } catch (e) { setError(e.message) } finally { setBusy(false) }
  }

  return (
    <Modal open={open} onClose={onClose} title="New message" size="lg"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={save} loading={busy} disabled={!body.trim()}>Save draft</Button></>}>
      {error && <Notice tone="danger" className="mb-4">{error}</Notice>}
      <div className="mb-4 flex gap-2">
        {Object.entries(CHANNELS).map(([k, [label, Icon]]) => (
          <button key={k} type="button" onClick={() => setChannel(k)} aria-pressed={channel === k}
            className={`flex flex-1 items-center justify-center gap-2 rounded-lg border px-3 py-2.5 text-sm font-medium ${channel === k ? 'border-brand-300 bg-brand-50 text-brand-700' : 'border-mist-200 text-mist-600 hover:border-mist-300'}`}>
            <Icon size={16} />{label}
          </button>
        ))}
      </div>
      <fieldset className="mb-4 rounded-lg border border-mist-200 px-4 py-3">
        <legend className="px-1 text-sm font-medium text-ink">Who should receive it</legend>
        <div className="grid gap-x-4 sm:grid-cols-2">
          {multiBranch && (
            <Select label="Branch" value={audience.branch} onChange={e => setAudience(a => ({ ...a, branch: e.target.value }))}>
              <option value="">All my branches</option>{activeBranches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </Select>
          )}
          <Select label="Attendance" value={audience.segment} onChange={e => setAudience(a => ({ ...a, segment: e.target.value }))}>
            {Object.entries(SEGMENTS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
          {units.data?.length > 0 && (
            <Select label="Service unit" value={audience.unit} onChange={e => setAudience(a => ({ ...a, unit: e.target.value }))}>
              <option value="">Any unit</option>{units.data.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
            </Select>
          )}
        </div>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {['member', 'visitor', 'inactive'].map(s => <Checkbox key={s} label={STATUS_LABELS[s] + 's'} checked={audience.statuses.includes(s)} onChange={() => toggleStatus(s)} />)}
        </div>
        {preview && (
          <p className="mt-3 text-sm text-mist-600">
            <span className="font-semibold text-ink">{reachable.toLocaleString()}</span> of {preview.counts.total.toLocaleString()} people can be reached by {CHANNELS[channel][0]}
            {preview.sample.length > 0 && <span className="block text-xs text-mist-400">Including {preview.sample.join(', ')}{preview.counts.total > preview.sample.length ? '…' : ''}</span>}
          </p>
        )}
      </fieldset>
      {channel === 'email' && <Input label="Subject" value={subject} onChange={e => setSubject(e.target.value)} />}
      <label htmlFor="msg-body" className="label">Message</label>
      <textarea id="msg-body" value={body} onChange={e => setBody(e.target.value)} rows={5} className="field" placeholder="e.g. Hi! Join us this Sunday at 9am for our family service." />
      {channel === 'sms' && <p className="hint">{sms.n} characters · {sms.parts} SMS {sms.parts === 1 ? 'part' : 'parts'} per person{sms.unicode ? ' (emoji or special characters use shorter parts)' : ''}</p>}
    </Modal>
  )
}

export default function Messages() {
  const { can } = useSession()
  const toast = useToast()
  const confirm = useConfirm()
  const { data, error, loading, reload } = useLoad(() => api.get('/messages'), [])
  const [composing, setComposing] = useState(false)
  const providers = data?.providers || {}
  const anyProvider = Object.values(providers).some(Boolean)

  async function send(m) {
    try { await api.post(`/messages/${m.id}/send`) ; toast('Sent'); reload() } catch (e) { toast(e.message, 'error') }
  }
  async function remove(m) {
    if (!(await confirm({ title: 'Delete this draft?', confirmLabel: 'Delete', danger: true }))) return
    try { await api.del(`/messages/${m.id}`); toast('Draft deleted'); reload() } catch (e) { toast(e.message, 'error') }
  }

  return (
    <div>
      <PageHeader title="Messages" description="Prepare announcements and reminders for the right people." actions={<Button icon={Plus} onClick={() => setComposing(true)}>New message</Button>} />
      {data && !anyProvider && (
        <Notice tone="info" className="mb-6" title="Sending isn't connected yet">
          You can write messages and choose audiences now. Until an SMS, WhatsApp Business or email provider is connected, download the recipient list and send from the tool you already use. Nothing is ever marked as sent unless it really was.
        </Notice>
      )}
      <div className="panel overflow-hidden">
        {error ? <ErrorState error={error} onRetry={reload} /> : loading && !data ? <div className="space-y-3 p-4">{[0, 1].map(i => <Skeleton key={i} className="h-14" />)}</div> :
          data.rows.length === 0 ? (
            <EmptyState icon={MessageSquare} title="No messages yet" action={<Button icon={Plus} onClick={() => setComposing(true)}>Write your first message</Button>}>
              Pick an audience — a branch, a service unit, visitors from the last month, or members who've been away.
            </EmptyState>
          ) : (
            <ul className="divide-y divide-mist-100">
              {data.rows.map(m => {
                const [label, Icon] = CHANNELS[m.channel]
                return (
                  <li key={m.id} className="flex flex-wrap items-start gap-3 px-5 py-4">
                    <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-mist-100 text-mist-600"><Icon size={16} /></span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium text-ink">{m.subject || label}</span>
                        <Badge tone={m.status === 'sent' ? 'success' : m.status === 'failed' ? 'danger' : 'neutral'}>{{ draft: 'Draft', scheduled: 'Scheduled', sent: 'Sent', failed: 'Failed' }[m.status]}</Badge>
                      </div>
                      <p className="mt-1 line-clamp-2 text-sm text-mist-600">{m.body}</p>
                      <p className="mt-1 text-xs text-mist-400">{m.recipient_count.toLocaleString()} recipients · {m.created_by_name || 'Someone'} · {relative(m.created_at)}</p>
                    </div>
                    {m.status === 'draft' && (
                      <div className="flex gap-2">
                        {can('export') && <Button size="sm" variant="secondary" icon={Download} onClick={() => download(`/messages/${m.id}/recipients`).catch(e => toast(e.message, 'error'))}>Recipients</Button>}
                        {providers[m.channel] && <Button size="sm" onClick={() => send(m)}>Send</Button>}
                        <Button size="sm" variant="ghost" icon={Trash2} onClick={() => remove(m)} aria-label="Delete draft" />
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
      </div>
      <Compose open={composing} onClose={() => setComposing(false)} onSaved={() => { setComposing(false); toast('Draft saved'); reload() }} />
    </div>
  )
}
