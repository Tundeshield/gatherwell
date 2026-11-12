import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { ArrowLeft, Copy, Pencil, XCircle, RotateCw, Play, Inbox, FlaskConical } from 'lucide-react'
import { api } from '../../../lib/api'
import { useSession } from '../../../lib/session'
import { useLoad, Button, Notice, PageLoader, ErrorState, EmptyState, Segmented, useToast, useConfirm, Skeleton, Select, Input } from '../../../components/ui'
import { fmtDateTime } from '../../../lib/format'
import { CHANNEL_ICON, channelLabel, MessageStatus, DeliveryStatus, Exclusions, BubblePreview, money, audienceText, StagingNote } from './shared'
import { IS_STAGING } from '../../../components/EnvBanner'

const TABS = [['all', 'All'], ['scheduled', 'Scheduled'], ['sent', 'Sent'], ['draft', 'Drafts'], ['problems', 'Needs attention']]
const title = (m) => m.subject || m.template_name || m.body?.slice(0, 70) || 'Message'

export function MessagesList() {
  const { tz } = useSession()
  const [params, setParams] = useSearchParams()
  const tab = params.get('tab') || 'all'
  const { data, error, loading, reload } = useLoad(() => api.get('/comms/messages'), [])
  const rows = useMemo(() => (data?.rows || []).filter(m => tab === 'all' ? true : tab === 'problems' ? (m.status === 'failed' || m.status === 'paused' || m.failed_count > 0) : tab === 'sent' ? ['sent', 'sending'].includes(m.status) : m.status === tab)
    .sort((a, b) => tab === 'scheduled' ? String(a.send_at).localeCompare(String(b.send_at)) : 0), [data, tab])
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="overflow-x-auto"><Segmented size="sm" value={tab} onChange={(t) => setParams(t === 'all' ? {} : { tab: t })} options={TABS.map(([value, label]) => ({ value, label }))} /></div>
        <div className="flex gap-2">
          <Link to="/app/communications/send?mode=later"><Button variant="secondary">Schedule</Button></Link>
          <Link to="/app/communications/send?mode=now"><Button>Send a message</Button></Link>
        </div>
      </div>
      {error ? <ErrorState error={error} onRetry={reload} /> : loading ? <Skeleton className="h-64" /> : !rows.length ? (
        <EmptyState icon={Inbox} title={tab === 'all' ? 'No messages yet' : 'Nothing here'}>{tab === 'all' ? 'Messages you send or schedule will appear here, with who received them.' : 'Try another tab.'}</EmptyState>
      ) : (
        <ul className="panel divide-y divide-mist-100">
          {rows.map(m => { const Icon = CHANNEL_ICON[m.channel]; return (
            <li key={m.id}>
              <Link to={m.legacy && m.status !== 'sent' ? `/app/messages/${m.id}/whatsapp` : `/app/communications/messages/${m.id}`} className="flex items-center gap-3 px-4 py-3.5 hover:bg-mist-50 sm:px-5">
                <Icon size={18} className="shrink-0 text-mist-400" aria-label={channelLabel(m.channel)} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] font-medium text-ink">{title(m)}</span>
                  <span className="block truncate text-sm text-mist-500">
                    {m.status === 'scheduled' ? `Goes out ${fmtDateTime(m.send_at, tz)}` : m.status === 'draft' ? `Draft · ${fmtDateTime(m.created_at, tz)}` : `${m.sent_count.toLocaleString()} sent${m.failed_count ? `, ${m.failed_count} failed` : ''} · ${fmtDateTime(m.sent_at || m.created_at, tz)}`}
                    {m.workflow_name ? ` · ${m.workflow_name}` : ''}
                  </span>
                </span>
                <MessageStatus status={m.status} />
              </Link>
            </li>
          ) })}
        </ul>
      )}
    </div>
  )
}

export function MessageDetail() {
  const { id } = useParams()
  const { me, tz } = useSession()
  const navigate = useNavigate()
  const toast = useToast()
  const confirm = useConfirm()
  const { data, error, loading, reload } = useLoad(() => api.get(`/comms/messages/${id}`), [id])
  const [busy, setBusy] = useState('')
  const [filter, setFilter] = useState('all')
  const run = async (key, fn, done) => { setBusy(key); try { const r = await fn(); await reload(); if (done) toast(typeof done === 'function' ? done(r) : done) } catch (e) { toast(e.message, 'error') } finally { setBusy('') } }
  if (loading) return <PageLoader />
  if (error) return <ErrorState error={error} onRetry={reload} />
  const m = data.message
  const d = data.deliveries
  const Icon = CHANNEL_ICON[m.channel]
  const shown = d.filter(x => filter === 'all' || x.status === filter)
  const canEdit = m.status === 'draft' || m.status === 'scheduled' || (m.status === 'paused' && !m.recipient_count)
  return (
    <div className="mx-auto max-w-4xl">
      <Link to="/app/communications/messages" className="mb-3 inline-flex items-center gap-1.5 text-sm text-mist-500 hover:text-ink"><ArrowLeft size={15} />Messages</Link>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2"><MessageStatus status={m.status} /><span className="inline-flex items-center gap-1.5 text-sm text-mist-500"><Icon size={15} />{channelLabel(m.channel)}</span>{m.workflow_name && <span className="text-sm text-mist-500">· from “{m.workflow_name}”</span>}</div>
          <h1 className="mt-2 text-[24px] font-semibold tracking-tight text-ink">{title(m)}</h1>
          <p className="mt-1 text-sm text-mist-500">
            {m.status === 'scheduled' ? `Goes out ${fmtDateTime(m.send_at, tz)} (church time)` : m.sent_at ? `Sent ${fmtDateTime(m.sent_at, tz)}` : m.status === 'draft' ? 'Draft, not sent' : m.send_at ? `Due ${fmtDateTime(m.send_at, tz)}` : ''}
            {m.created_by_name ? ` · by ${m.created_by_name}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canEdit && <Button variant="secondary" icon={Pencil} onClick={() => navigate(`/app/communications/messages/${m.id}/edit`)}>Edit</Button>}
          {m.status === 'paused' && <Button icon={Play} loading={busy === 'resume'} onClick={() => run('resume', () => api.post(`/comms/messages/${m.id}/resume`), (r) => r.status === 'sent' ? 'Sent' : r.status === 'paused' ? 'Still paused: check the reason below' : 'Sending')}>Try again</Button>}
          {(m.status === 'scheduled' || m.status === 'sending' || m.status === 'paused') && <Button variant="danger-ghost" icon={XCircle} loading={busy === 'cancel'}
            onClick={async () => { if (await confirm({ title: m.status === 'scheduled' ? 'Cancel this scheduled message?' : 'Stop sending?', message: m.status === 'scheduled' ? 'It won’t be sent. You can duplicate it later if you change your mind.' : 'People who already received it keep it. Nobody else will.', confirmLabel: m.status === 'scheduled' ? 'Cancel message' : 'Stop sending', danger: true })) run('cancel', () => api.post(`/comms/messages/${m.id}/cancel`), 'Cancelled') }}>{m.status === 'scheduled' ? 'Cancel' : 'Stop'}</Button>}
          {m.failed_count > 0 && ['sent', 'failed'].includes(m.status) && <Button variant="secondary" icon={RotateCw} loading={busy === 'retry'} onClick={() => run('retry', () => api.post(`/comms/messages/${m.id}/retry`), (r) => `Retried ${r.retried}: ${r.sent} sent${r.failed ? `, ${r.failed} still failed` : ''}`)}>Retry failed</Button>}
          <Button variant="ghost" icon={Copy} loading={busy === 'dup'} onClick={async () => { setBusy('dup'); try { const r = await api.post(`/comms/messages/${m.id}/duplicate`); navigate(`/app/communications/messages/${r.id}/edit`) } catch (e) { toast(e.message, 'error') } finally { setBusy('') } }}>Duplicate</Button>
        </div>
      </div>

      {m.status === 'paused' && <Notice tone="warning" className="mb-5" title={m.pause_reason === 'credits' ? 'Paused: not enough messaging credit' : m.pause_reason === 'channel' ? 'Paused: this channel isn’t connected' : m.pause_reason === 'limit' ? 'Paused: daily email limit reached' : 'Paused'}>
        {m.last_error} {m.pause_reason === 'credits' && <><Link to="/app/communications/channels" className="link">Add credit</Link>, then press Try again. Email is not affected.</>}
      </Notice>}
      {m.status === 'failed' && <Notice tone="danger" className="mb-5" title="Not sent">{m.last_error}</Notice>}

      {m.status !== 'draft' && m.status !== 'scheduled' && (
        <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[['Sent', m.sent_count], ['Delivered', m.channel === 'email' && !m.delivered_count ? '—' : m.delivered_count], ['Read', m.channel === 'whatsapp' ? m.read_count : '—'], ['Failed', m.failed_count]].map(([l, v]) => (
            <div key={l} className="panel px-4 py-3"><p className="text-sm text-mist-500">{l}</p><p className="text-[22px] font-semibold text-ink">{typeof v === 'number' ? v.toLocaleString() : v}</p></div>
          ))}
        </div>
      )}
      {m.channel === 'email' && m.status === 'sent' && !m.delivered_count && <p className="-mt-2 mb-5 text-xs text-mist-500">Email delivery and opens aren’t tracked yet, so only “sent” is shown.</p>}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <section className="panel px-5 py-4">
          <h2 className="mb-2 text-[15px] font-semibold text-ink">Audience</h2>
          <p className="text-[15px] text-ink">{audienceText(m.audience)}</p>
          {m.recipient_count > 0 && <p className="mt-1 text-sm text-mist-600">{m.recipient_count.toLocaleString()} could receive it{m.audience_total > m.recipient_count ? ` out of ${m.audience_total.toLocaleString()}` : ''}.</p>}
          {m.excluded && <Exclusions channel={m.channel} excluded={m.excluded} />}
          {m.status === 'scheduled' && m.audience?.mode === 'filters' && <p className="mt-2 text-sm text-mist-500">Who receives it is worked out when it sends, so new members of this group are included.</p>}
          {m.billing === 'platform' && <p className="mt-3 text-sm text-mist-600">Messaging credit used: <strong>{money(m.cost)}</strong></p>}
          {m.billing === 'church' && <p className="mt-3 text-sm text-mist-600">Paid by your church directly to the provider.</p>}
        </section>
        <section className="panel px-5 py-4">
          <h2 className="mb-2 text-[15px] font-semibold text-ink">Message</h2>
          {m.channel === 'email' ? <><p className="font-medium text-ink">{m.subject}</p><p className="mt-2 whitespace-pre-wrap text-sm text-mist-600">{m.body}</p></> : <BubblePreview channel={m.channel} text={m.body} churchName={me.org.name} />}
        </section>
      </div>

      {d.length > 0 && (
        <section className="panel mt-5">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-mist-200 px-5 py-3">
            <h2 className="text-[15px] font-semibold text-ink">Recipients</h2>
            <Select className="!mb-0 w-44" value={filter} onChange={e => setFilter(e.target.value)} aria-label="Filter recipients">
              <option value="all">Everyone ({d.length})</option>
              {['sent', 'delivered', 'read', 'failed', 'skipped', 'unknown'].filter(s => d.some(x => x.status === s)).map(s => <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)} ({d.filter(x => x.status === s).length})</option>)}
            </Select>
          </div>
          <ul className="max-h-[480px] divide-y divide-mist-100 overflow-y-auto">
            {shown.map(x => (
              <li key={x.id} className="flex flex-wrap items-center gap-3 px-5 py-2.5 text-sm">
                <span className="min-w-0 flex-1"><Link to={`/app/people/${x.person_id}`} className="font-medium text-ink hover:underline">{x.name}</Link><span className="ml-2 text-mist-500">{x.to}</span>{x.error && <span className="block text-xs text-red-700">{x.error}</span>}</span>
                <DeliveryStatus status={x.status} />
                {IS_STAGING && data.staging && x.status !== 'failed' && x.status !== 'skipped' && (
                  <span className="flex gap-1">{['delivered', 'read', 'failed'].map(s => <button key={s} type="button" className="rounded border border-mist-200 px-1.5 py-0.5 text-[11px] text-mist-500 hover:bg-mist-50" onClick={() => run('sim', () => api.post(`/comms/simulate/delivery/${x.id}`, { status: s }))}>{s}</button>)}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {IS_STAGING && data.staging && m.status === 'sent' && m.channel !== 'email' && <SimulatePanel m={m} deliveries={d} run={run} />}
    </div>
  )
}

function SimulatePanel({ m, deliveries, run }) {
  const [who, setWho] = useState(deliveries[0]?.person_id || '')
  const [text, setText] = useState('Thank you! Can someone call me?')
  return (
    <section className="mt-5 rounded-2xl border border-gold-200 bg-gold-50 px-5 py-4">
      <h2 className="flex items-center gap-2 text-[15px] font-semibold text-gold-700"><FlaskConical size={16} />Staging: simulate what happens next</h2>
      <p className="mt-1 text-sm text-gold-700">Nothing here reaches a real person.</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" onClick={() => run('sim', () => api.post(`/comms/simulate/message/${m.id}`, { status: 'delivered' }), 'Marked as delivered')}>Mark all delivered</Button>
        <Button size="sm" variant="secondary" onClick={() => run('sim', () => api.post(`/comms/simulate/message/${m.id}`, { status: 'read' }), 'Marked as read')}>Mark all read</Button>
      </div>
      <div className="mt-4 grid grid-cols-1 gap-x-3 sm:grid-cols-[180px_minmax(0,1fr)_auto] sm:items-end">
        <Select label="Reply from" value={who} onChange={e => setWho(e.target.value)}>{deliveries.map(x => <option key={x.id} value={x.person_id}>{x.name}</option>)}</Select>
        <Input label="Reply text" hint="Type STOP to test opting out." value={text} onChange={e => setText(e.target.value)} />
        <Button className="mb-4" onClick={() => run('sim', () => api.post('/comms/simulate/reply', { personId: who, channel: m.channel, text }), (r) => r.optedOut ? 'Opted out of this channel' : r.paused ? `Reply received: ${r.paused} workflow paused and a follow-up created` : 'Reply received')}>Simulate reply</Button>
      </div>
    </section>
  )
}
