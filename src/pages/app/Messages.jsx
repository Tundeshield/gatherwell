import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { MessageSquare, Plus, Trash2, Mail, Smartphone, MessageCircle, Send, Palette } from 'lucide-react'
import { api } from '../../lib/api'
import { useSession } from '../../lib/session'
import { useLoad, PageHeader, Button, Badge, EmptyState, ErrorState, Skeleton, Notice, useToast, useConfirm } from '../../components/ui'
import { relative } from '../../lib/format'
import { runSend } from '../../lib/sendMessage'

const CHANNELS = { sms: ['SMS', Smartphone], whatsapp: ['WhatsApp', MessageCircle], email: ['Email', Mail] }
const STATUS = { draft: ['Draft', 'neutral'], sending: ['Sending', 'info'], sent: ['Sent', 'success'], failed: ['Stopped', 'danger'], scheduled: ['Scheduled', 'info'] }

export default function Messages() {
  const { can } = useSession()
  const toast = useToast()
  const confirm = useConfirm()
  const navigate = useNavigate()
  const { data, error, loading, reload } = useLoad(() => api.get('/messages'), [])
  const settings = useLoad(() => api.get('/email/settings'), [])
  const [resuming, setResuming] = useState(null)

  async function remove(m) {
    if (!(await confirm({ title: 'Delete this draft?', confirmLabel: 'Delete', danger: true }))) return
    try { await api.del(`/messages/${m.id}`); toast('Draft deleted'); reload() } catch (e) { toast(e.message, 'error') }
  }
  async function resume(m) {
    setResuming(m.id)
    try { const p = await runSend(m.id); toast(p.status === 'sent' ? `Sent to ${p.sent.toLocaleString()} people` : (p.error || 'Sending stopped'), p.status === 'sent' ? 'success' : 'error') }
    catch (e) { toast(e.message, 'error') } finally { setResuming(null); reload() }
  }

  const s = settings.data
  return (
    <div>
      <PageHeader title="Messages" description="Branded emails and announcements for the right people."
        actions={<>
          {can('org.manage') && <Button variant="secondary" icon={Palette} onClick={() => navigate('/app/settings?tab=email')}>Email branding</Button>}
          <Button icon={Plus} onClick={() => navigate('/app/messages/new')}>New message</Button>
        </>} />
      {s && !s.connected && (
        <Notice tone="info" className="mb-6" title="Email sending isn’t switched on yet">
          You can write and preview branded emails and save them as drafts. Sending starts working once your email domain is connected. Nothing is ever marked as sent unless it really was.
        </Notice>
      )}
      <div className="panel overflow-hidden">
        {error ? <ErrorState error={error} onRetry={reload} /> : loading && !data ? <div className="space-y-3 p-4">{[0, 1].map(i => <Skeleton key={i} className="h-14" />)}</div> :
          data.rows.length === 0 ? (
            <EmptyState icon={MessageSquare} title="No messages yet" action={<Button icon={Plus} onClick={() => navigate('/app/messages/new')}>Write your first email</Button>}>
              Send a branded email to a branch, a service unit, last month’s visitors, or members who’ve been away.
            </EmptyState>
          ) : (
            <ul className="divide-y divide-mist-100">
              {data.rows.map(m => {
                const [label, Icon] = CHANNELS[m.channel]
                const [statusLabel, tone] = STATUS[m.status] || STATUS.draft
                const open = m.status === 'draft' ? () => navigate(`/app/messages/${m.id}`) : undefined
                return (
                  <li key={m.id} className={`flex flex-wrap items-start gap-3 px-5 py-4 ${open ? 'cursor-pointer hover:bg-mist-50/60' : ''}`} onClick={open}>
                    <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-mist-100 text-mist-600"><Icon size={16} /></span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium text-ink">{m.subject || label}</span>
                        <Badge tone={tone}>{statusLabel}</Badge>
                      </div>
                      <p className="mt-1 line-clamp-2 text-sm text-mist-600">{m.body || <span className="text-mist-400">No content yet</span>}</p>
                      <p className="mt-1 text-xs text-mist-400">
                        {m.status === 'sent' ? `Sent to ${m.sent_count.toLocaleString()}${m.failed_count ? ` · ${m.failed_count} not delivered` : ''} · ${relative(m.sent_at)}`
                          : m.status === 'sending' || m.status === 'failed' ? `${m.sent_count.toLocaleString()} of ${m.recipient_count.toLocaleString()} sent${m.last_error ? ` · ${m.last_error}` : ''}`
                          : `${m.created_by_name || 'Someone'} · ${relative(m.updated_at || m.created_at)}`}
                      </p>
                    </div>
                    <div className="flex gap-2" onClick={e => e.stopPropagation()}>
                      {(m.status === 'sending' || m.status === 'failed') && <Button size="sm" icon={Send} loading={resuming === m.id} onClick={() => resume(m)}>Continue sending</Button>}
                      {m.status === 'draft' && <Button size="sm" variant="ghost" icon={Trash2} onClick={() => remove(m)} aria-label="Delete draft" />}
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
      </div>
    </div>
  )
}
