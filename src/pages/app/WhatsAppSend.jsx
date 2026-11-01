import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Check, MessageCircle, Search, Undo2 } from 'lucide-react'
import { api } from '../../lib/api'
import { useSession } from '../../lib/session'
import { useLoad, PageLoader, ErrorState, Button, Notice, useToast, useConfirm } from '../../components/ui'
import { whatsappLink } from '../../../shared/automation.js'

// One-tap WhatsApp sending: each person's chat opens with their own copy of the message ready.
export default function WhatsAppSend() {
  const { id } = useParams()
  const navigate = useNavigate()
  const toast = useToast()
  const confirm = useConfirm()
  const { me } = useSession()
  const { data, error, reload } = useLoad(() => api.get(`/messages/${id}/whatsapp`), [id])
  const [done, setDone] = useState([])
  const [q, setQ] = useState('')
  const [finishing, setFinishing] = useState(false)
  useEffect(() => { if (data) setDone(data.done) }, [data])

  const rows = useMemo(() => (data?.recipients || []).filter(p => !q || `${p.first_name} ${p.last_name || ''} ${p.phone || ''}`.toLowerCase().includes(q.toLowerCase())), [data, q])
  if (error) return <ErrorState error={error} onRetry={reload} />
  if (!data) return <PageLoader />
  const m = data.message
  const total = data.recipients.length
  const doneSet = new Set(done)
  const next = data.recipients.find(p => !doneSet.has(p.id))
  const finished = m.status === 'sent'

  async function mark(p, value = true) {
    setDone(d => (value ? [...new Set([...d, p.id])] : d.filter(x => x !== p.id)))
    try { const r = await api.post(`/messages/${id}/whatsapp/done`, { personId: p.id, done: value }); setDone(r.done) }
    catch (e) { toast(e.message, 'error'); reload() }
  }
  function open(p) {
    const link = whatsappLink({ template: m.body, phoneNorm: p.phone_norm, person: p, churchName: me.org.name, myName: me.user.name })
    window.open(link, '_blank', 'noopener')
    mark(p, true)
  }
  async function finish() {
    if (done.length < total && !(await confirm({ title: 'Finish sending?', message: `${total - done.length} ${total - done.length === 1 ? 'person hasn’t' : 'people haven’t'} been sent the message yet. You can’t continue after finishing.`, confirmLabel: 'Finish' }))) return
    setFinishing(true)
    try { const r = await api.post(`/messages/${id}/whatsapp/finish`); toast(`Done: sent to ${r.sent} of ${r.total}`); navigate('/app/messages') }
    catch (e) { toast(e.message, 'error') } finally { setFinishing(false) }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <Link to="/app/messages" className="mb-4 inline-flex items-center gap-1.5 text-sm text-mist-500 hover:text-ink"><ArrowLeft size={15} />Messages</Link>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-ink">Send on WhatsApp</h1>
          <p className="mt-1 text-sm text-mist-500">{done.length} of {total} sent. Tap WhatsApp, press Send in WhatsApp, then come back for the next person.</p>
        </div>
        {!finished && <Button variant="secondary" onClick={finish} loading={finishing}>{done.length >= total && total > 0 ? 'Finish' : 'Finish for now'}</Button>}
      </div>
      <div className="mb-5 h-2 overflow-hidden rounded-full bg-mist-100"><div className="h-full bg-[#25D366] transition-all" style={{ width: `${total ? (done.length / total) * 100 : 0}%` }} /></div>

      {finished && <Notice tone="success" className="mb-4">This message is finished. It was sent to {m.sent_count} of {m.recipient_count}.</Notice>}
      {total === 0 && <Notice tone="warning">Nobody in this audience has a phone number. Go back and choose different people.</Notice>}

      <div className="panel mb-4 whitespace-pre-wrap px-5 py-4 text-sm text-ink-soft">{m.body}</div>

      {!finished && next && (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-[#25D366]/40 bg-[#E7F7EE] px-4 py-3">
          <span className="flex-1 text-sm text-[#0B6B3A]">Next: <b>{next.first_name} {next.last_name || ''}</b></span>
          <Button onClick={() => open(next)} icon={MessageCircle} className="!border-[#1DA851] !bg-[#25D366] !text-white hover:!bg-[#1DA851]">Open WhatsApp</Button>
        </div>
      )}

      {total > 8 && (
        <div className="relative mb-3">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-mist-400" />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Find someone" className="field h-10 pl-9" />
        </div>
      )}
      <ul className="panel divide-y divide-mist-100 overflow-hidden">
        {rows.map(p => {
          const sent = doneSet.has(p.id)
          return (
            <li key={p.id} className={`flex items-center gap-3 px-4 py-3 ${sent ? 'bg-mist-50/60' : ''}`}>
              <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${sent ? 'bg-[#25D366] text-white' : 'border border-mist-300'}`}>{sent && <Check size={14} />}</span>
              <span className="min-w-0 flex-1">
                <span className={`block truncate text-sm font-medium ${sent ? 'text-mist-500' : 'text-ink'}`}>{p.first_name} {p.last_name || ''}</span>
                <span className="block text-xs text-mist-500">{p.phone}</span>
              </span>
              {!finished && (sent
                ? <Button size="sm" variant="ghost" icon={Undo2} onClick={() => mark(p, false)}>Not sent</Button>
                : <Button size="sm" variant="secondary" icon={MessageCircle} onClick={() => open(p)}>WhatsApp</Button>)}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
