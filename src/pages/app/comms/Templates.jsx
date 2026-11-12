import { useState } from 'react'
import { Plus, Copy, Pencil, Trash2, Send } from 'lucide-react'
import { api } from '../../../lib/api'
import { useLoad, Button, Input, Select, Textarea, Badge, Modal, Notice, Skeleton, ErrorState, EmptyState, useToast, useConfirm } from '../../../components/ui'
import { smsInfo, WHATSAPP_AUTOMATION } from '../../../../shared/comms.js'
import { BubblePreview } from './shared'
import { useSession } from '../../../lib/session'

const WA = { not_submitted: ['neutral', 'Not sent for WhatsApp approval'], pending: ['gold', 'Waiting for WhatsApp approval'], approved: ['success', 'Approved for WhatsApp'], rejected: ['danger', 'Rejected by WhatsApp'] }
const EMPTY = { name: '', purpose: 'general', subject: '', body: '', category: 'marketing' }

export default function Templates() {
  const { me } = useSession()
  const toast = useToast()
  const confirm = useConfirm()
  const { data, error, loading, reload } = useLoad(() => api.get('/comms/templates'), [])
  const [edit, setEdit] = useState(null) // {id?, ...fields, starterKey?}
  const [busy, setBusy] = useState('')
  if (error) return <ErrorState error={error} onRetry={reload} />
  if (loading) return <Skeleton className="h-64" />
  const purposes = data.purposes || {}

  async function save() {
    setBusy('save')
    try {
      if (edit.id) await api.patch(`/comms/templates/${edit.id}`, edit)
      else await api.post('/comms/templates', edit)
      toast('Template saved'); setEdit(null); reload()
    } catch (e) { toast(e.message, 'error') } finally { setBusy('') }
  }
  async function submit(t) {
    setBusy(t.id)
    try { const r = await api.post(`/comms/templates/${t.id}/submit`); toast(r.whatsapp.status === 'approved' ? (r.whatsapp.simulated ? 'Approved (test mode: no real review)' : 'Approved') : 'Sent for approval. This usually takes minutes, sometimes a day.'); reload() }
    catch (e) { toast(e.message, 'error') } finally { setBusy('') }
  }
  const info = smsInfo(edit?.body || '')
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-mist-600">Save the emails and texts you send often, then reuse them in messages and journeys.</p>
        <Button icon={Plus} onClick={() => setEdit({ ...EMPTY })}>New template</Button>
      </div>
      {data.own.length ? (
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {data.own.map(t => { const [tone, label] = WA[t.whatsapp.status] || WA.not_submitted; return (
            <li key={t.id} className="flex flex-col rounded-2xl border border-mist-200 bg-white p-5">
              <div className="flex items-start justify-between gap-2"><h3 className="text-[16px] font-semibold text-ink">{t.name}</h3><span className="text-xs text-mist-500">{purposes[t.purpose] || ''}</span></div>
              <p className="mt-2 line-clamp-3 whitespace-pre-line text-sm text-mist-600">{t.body}</p>
              <div className="mt-3 flex flex-wrap items-center gap-2">{WHATSAPP_AUTOMATION && <Badge tone={tone}>{label}</Badge>}{WHATSAPP_AUTOMATION && t.whatsapp.simulated && <Badge tone="gold">Test approval</Badge>}<span className="text-xs text-mist-500">{t.sms.segments} SMS {t.sms.segments === 1 ? 'text' : 'texts'}</span></div>
              {WHATSAPP_AUTOMATION && t.whatsapp.note && <p className="mt-2 text-xs text-amber-800">{t.whatsapp.note}</p>}
              <div className="mt-auto flex flex-wrap gap-1 pt-4">
                <Button size="sm" variant="ghost" icon={Pencil} onClick={() => setEdit({ ...t })}>Edit</Button>
                {WHATSAPP_AUTOMATION && t.whatsapp.status !== 'approved' && t.whatsapp.status !== 'pending' && <Button size="sm" variant="ghost" icon={Send} loading={busy === t.id} onClick={() => submit(t)}>Get WhatsApp approval</Button>}
                <Button size="sm" variant="danger-ghost" icon={Trash2} onClick={async () => { if (await confirm({ title: `Delete “${t.name}”?`, message: 'Workflows using it will need a new template before they can send on WhatsApp.', confirmLabel: 'Delete', danger: true })) { await api.del(`/comms/templates/${t.id}`); reload() } }}>Delete</Button>
              </div>
            </li>
          ) })}
        </ul>
      ) : <EmptyState title="No templates yet">Start from one of the examples below, or write your own.</EmptyState>}

      {data.starters.length > 0 && (
        <section>
          <h2 className="mb-3 text-[15px] font-semibold text-ink">Examples to start from</h2>
          <ul className="grid grid-cols-1 gap-3 md:grid-cols-3">
            {data.starters.map(s => (
              <li key={s.key} className="flex flex-col rounded-2xl border border-dashed border-mist-300 bg-mist-50/50 p-4">
                <h3 className="font-semibold text-ink">{s.name}</h3>
                <p className="mt-1 line-clamp-3 text-sm text-mist-600">{s.body}</p>
                <div className="mt-auto pt-3"><Button size="sm" variant="secondary" icon={Copy} onClick={() => setEdit({ name: s.name, purpose: s.purpose, subject: s.subject || '', body: s.body, category: s.category || 'marketing', starterKey: s.key })}>Use this</Button></div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? 'Edit template' : 'New template'} size="lg"
        footer={<><Button variant="secondary" onClick={() => setEdit(null)}>Cancel</Button><Button loading={busy === 'save'} onClick={save}>Save template</Button></>}>
        {edit && (
          <div className="grid grid-cols-1 gap-x-6 md:grid-cols-2">
            <div>
              <Input label="Name" value={edit.name} onChange={e => setEdit({ ...edit, name: e.target.value })} maxLength={100} />
              <Select label="Used for" value={edit.purpose} onChange={e => setEdit({ ...edit, purpose: e.target.value })}>{Object.entries(purposes).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
              <Input label="Email subject (optional)" value={edit.subject} onChange={e => setEdit({ ...edit, subject: e.target.value })} maxLength={200} />
              <Textarea label="Message" rows={7} maxLength={1024} value={edit.body} onChange={e => setEdit({ ...edit, body: e.target.value })} hint="Use {first_name}, {church_name}, {event_name} or {event_date}." />
              <p className="-mt-2 mb-3 text-xs text-mist-500">{info.length} characters · {info.segments} SMS {info.segments === 1 ? 'text' : 'texts'}{info.unicode ? ' (special characters use more texts)' : ''}</p>
              <Select label="Message type" value={edit.category} onChange={e => setEdit({ ...edit, category: e.target.value })} hint="Some countries only allow reminders and updates by text, not invitations or news.">
                <option value="marketing">Invitations, welcomes and news</option><option value="utility">Reminders and updates for something they signed up for</option>
              </Select>
              {WHATSAPP_AUTOMATION && edit.id && edit.whatsapp?.status === 'approved' && <Notice tone="warning">Changing the words means WhatsApp has to approve it again.</Notice>}
            </div>
            <div><p className="label">Preview</p><BubblePreview channel="sms" text={edit.body} churchName={me.org.name} /></div>
          </div>
        )}
      </Modal>
    </div>
  )
}
