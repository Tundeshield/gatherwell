// Per-channel permission to message someone, with who recorded it, when and how.
import { useState } from 'react'
import { Mail, MessageCircle, Smartphone } from 'lucide-react'
import { api } from '../lib/api'
import { Button, Modal, Select, Textarea, Badge, useToast } from './ui'
import { fmtDate } from '../lib/format'

const CH = [['email', 'Email', Mail], ['whatsapp', 'WhatsApp', MessageCircle], ['sms', 'SMS', Smartphone]]
const SOURCES = { in_person: 'Told us in person', form: 'Ticked a box on a form', verbal: 'Said yes on the phone', written: 'Gave written permission', reply: 'By replying to a message', import: 'Imported with their details' }

export default function ConsentPanel({ person: p, canEdit, onChange }) {
  const toast = useToast()
  const [edit, setEdit] = useState(null)
  const [form, setForm] = useState({ source: 'in_person', wording: '' })
  const [busy, setBusy] = useState(false)
  const state = (ch) => {
    const c = p.consent?.[ch]
    if (ch === 'email') return p.email_opt_out ? 'withdrawn' : 'granted'
    return c?.status || 'none'
  }
  async function save(status) {
    setBusy(true)
    try { await api.patch(`/people/${p.id}/consent`, { channel: edit, status, ...form }); toast(status === 'granted' ? 'Permission recorded' : 'Recorded that they don’t want these messages'); setEdit(null); onChange?.() }
    catch (e) { toast(e.message, 'error') } finally { setBusy(false) }
  }
  const has = { email: !!p.email, whatsapp: !!p.phone, sms: !!p.phone }
  return (
    <section className="panel px-5 py-4">
      <h2 className="text-[15px] font-semibold text-ink">Messaging permission</h2>
      <p className="mt-0.5 text-sm text-mist-500">WhatsApp and SMS need a clear yes from the person first.</p>
      <ul className="mt-3 divide-y divide-mist-100">
        {CH.map(([ch, label, Icon]) => { const s = state(ch); const c = p.consent?.[ch]; return (
          <li key={ch} className="flex items-center gap-3 py-2.5">
            <Icon size={16} className="text-mist-400" aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block text-[15px] text-ink">{label}</span>
              <span className="block text-xs text-mist-500">{!has[ch] ? `No ${ch === 'email' ? 'email address' : 'phone number'}` : c?.at ? `${SOURCES[c.source] || 'Recorded'} · ${fmtDate(c.at)}${c.by ? ` · by ${c.by}` : ''}` : ch === 'email' ? 'Receives church emails unless they unsubscribe' : 'Not asked yet'}</span>
            </span>
            <Badge tone={s === 'granted' ? 'success' : s === 'withdrawn' ? 'danger' : 'neutral'}>{s === 'granted' ? 'Yes' : s === 'withdrawn' ? 'No' : 'Not asked'}</Badge>
            {canEdit && has[ch] && <Button size="sm" variant="ghost" onClick={() => { setForm({ source: 'in_person', wording: '' }); setEdit(ch) }}>Change</Button>}
          </li>
        ) })}
      </ul>
      <Modal open={!!edit} onClose={() => setEdit(null)} title={`${CH.find(c => c[0] === edit)?.[1] || ''} messages for ${p.first_name}`}
        footer={<><Button variant="secondary" loading={busy} onClick={() => save('withdrawn')}>They said no</Button><Button loading={busy} onClick={() => save('granted')}>They said yes</Button></>}>
        <Select label="How did they tell you?" value={form.source} onChange={e => setForm(f => ({ ...f, source: e.target.value }))}>{Object.entries(SOURCES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
        <Textarea label="What were they asked? (optional)" rows={2} maxLength={300} value={form.wording} onChange={e => setForm(f => ({ ...f, wording: e.target.value }))} placeholder="For example: “Can we send you WhatsApp updates about church events?”" hint="Kept as a record in case anyone asks later." />
        <p className="text-sm text-mist-500">Children’s records are never messaged.</p>
      </Modal>
    </section>
  )
}
