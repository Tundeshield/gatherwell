import { Link } from 'react-router-dom'
import { AlertTriangle, ChevronRight, CheckCircle2, CircleDashed, Wallet } from 'lucide-react'
import { api } from '../../../lib/api'
import { useSession } from '../../../lib/session'
import { useLoad, Skeleton, ErrorState, EmptyState } from '../../../components/ui'
import { fmtDateTime } from '../../../lib/format'
import { ACTIONS, CHANNEL_ICON, channelLabel, MessageStatus, money, WorkflowStatus } from './shared'

function Section({ title, link, children }) {
  return (
    <section className="panel">
      <div className="flex items-center justify-between border-b border-mist-200 px-5 py-3.5">
        <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
        {link && <Link to={link[0]} className="text-sm font-medium text-brand-700 hover:underline">{link[1]}</Link>}
      </div>
      {children}
    </section>
  )
}
const msgTitle = (m) => m.subject || m.template_name || m.body?.slice(0, 60) || 'Message'

export default function CommsOverview() {
  const { tz } = useSession()
  const { data, error, loading, reload } = useLoad(() => api.get('/comms/overview'), [])
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {ACTIONS.map(a => (
          <Link key={a.title} to={a.to} className="group flex items-start gap-4 rounded-2xl border border-mist-200 bg-white p-5 transition-colors hover:border-brand-300 hover:bg-brand-50/40">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand-700 text-white"><a.icon size={20} /></span>
            <span className="min-w-0">
              <span className="block text-[16px] font-semibold text-ink">{a.title}</span>
              <span className="mt-0.5 block text-sm text-mist-500">{a.body}</span>
            </span>
          </Link>
        ))}
      </div>

      {error ? <ErrorState error={error} onRetry={reload} /> : loading ? <div className="grid gap-4 lg:grid-cols-2">{[0, 1, 2, 3].map(i => <Skeleton key={i} className="h-40" />)}</div> : (
        <>
          {data.attention.length > 0 && (
            <section className="rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4">
              <h2 className="flex items-center gap-2 text-[15px] font-semibold text-amber-900"><AlertTriangle size={17} />Needs your attention</h2>
              <ul className="mt-2 divide-y divide-amber-200/70">
                {data.attention.map(m => (
                  <li key={m.id}><Link to={`/app/communications/messages/${m.id}`} className="flex items-center justify-between gap-3 py-2 text-sm hover:underline">
                    <span className="min-w-0 truncate text-amber-900">{msgTitle(m)}: {m.status === 'paused' ? (m.pause_reason === 'credits' ? 'paused, not enough messaging credit' : m.pause_reason === 'channel' ? 'paused, channel not connected' : 'paused') : m.failed_count ? `${m.failed_count} couldn’t be delivered` : 'didn’t send'}</span>
                    <ChevronRight size={16} className="shrink-0 text-amber-700" />
                  </Link></li>
                ))}
              </ul>
            </section>
          )}

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <Section title="Coming up" link={['/app/communications/messages?tab=scheduled', 'All scheduled']}>
              {data.scheduled.length ? (
                <ul className="divide-y divide-mist-100">
                  {data.scheduled.map(m => { const Icon = CHANNEL_ICON[m.channel]; return (
                    <li key={m.id}><Link to={`/app/communications/messages/${m.id}`} className="flex items-center gap-3 px-5 py-3 hover:bg-mist-50">
                      <Icon size={17} className="shrink-0 text-mist-400" aria-label={channelLabel(m.channel)} />
                      <span className="min-w-0 flex-1"><span className="block truncate text-[15px] font-medium text-ink">{msgTitle(m)}</span><span className="text-sm text-mist-500">{fmtDateTime(m.send_at, tz)}{m.workflow_name ? ` · ${m.workflow_name}` : ''}</span></span>
                    </Link></li>
                  ) })}
                </ul>
              ) : <p className="px-5 py-6 text-sm text-mist-500">Nothing scheduled. <Link to="/app/communications/send?mode=later" className="link">Schedule a message</Link></p>}
            </Section>

            <Section title="Recently sent" link={['/app/communications/messages', 'All messages']}>
              {data.recent.length ? (
                <ul className="divide-y divide-mist-100">
                  {data.recent.map(m => { const Icon = CHANNEL_ICON[m.channel]; return (
                    <li key={m.id}><Link to={`/app/communications/messages/${m.id}`} className="flex items-center gap-3 px-5 py-3 hover:bg-mist-50">
                      <Icon size={17} className="shrink-0 text-mist-400" aria-label={channelLabel(m.channel)} />
                      <span className="min-w-0 flex-1"><span className="block truncate text-[15px] font-medium text-ink">{msgTitle(m)}</span><span className="text-sm text-mist-500">{m.sent_count.toLocaleString()} sent{m.delivered_count ? ` · ${m.delivered_count} delivered` : ''} · {fmtDateTime(m.sent_at || m.created_at, tz)}</span></span>
                      <MessageStatus status={m.status} />
                    </Link></li>
                  ) })}
                </ul>
              ) : <p className="px-5 py-6 text-sm text-mist-500">No messages sent yet.</p>}
            </Section>

            <Section title="Automatic workflows" link={['/app/communications/workflows', 'All workflows']}>
              {data.workflows.length ? (
                <ul className="divide-y divide-mist-100">
                  {data.workflows.map(w => (
                    <li key={w.id}><Link to={`/app/communications/workflows/${w.id}`} className="flex items-center gap-3 px-5 py-3 hover:bg-mist-50">
                      <span className="min-w-0 flex-1"><span className="block truncate text-[15px] font-medium text-ink">{w.name}</span><span className="text-sm text-mist-500">{w.active_count} {w.active_count === 1 ? 'person' : 'people'} in it now · {w.summary}</span></span>
                      <WorkflowStatus status={w.status} />
                    </Link></li>
                  ))}
                </ul>
              ) : <EmptyState title="No workflows switched on" className="py-6">Welcome every first-time visitor automatically. <Link to="/app/communications/workflows?new=1" className="link">Set one up</Link></EmptyState>}
            </Section>

            <Section title="Channels" link={['/app/communications/channels', 'Channels & usage']}>
              <ul className="divide-y divide-mist-100">
                {Object.entries(data.channels).map(([ch, s]) => { const Icon = CHANNEL_ICON[ch]; return (
                  <li key={ch} className="flex items-center gap-3 px-5 py-3">
                    <Icon size={17} className="text-mist-400" aria-hidden />
                    <span className="flex-1 text-[15px] text-ink">{channelLabel(ch)}</span>
                    {s.ready ? <span className="flex items-center gap-1.5 text-sm text-green-800"><CheckCircle2 size={15} />{s.simulated ? 'Ready (test mode)' : 'Ready'}</span>
                      : <span className="flex items-center gap-1.5 text-sm text-mist-500"><CircleDashed size={15} />Not connected</span>}
                  </li>
                ) })}
                <li className="flex items-center gap-3 px-5 py-3">
                  <Wallet size={17} className="text-mist-400" aria-hidden />
                  <span className="flex-1 text-[15px] text-ink">Messaging credit</span>
                  <span className={`text-sm font-medium ${data.credits.low ? 'text-amber-800' : 'text-ink'}`}>{money(data.credits.balance)}{data.credits.low ? ' · low' : ''}</span>
                </li>
              </ul>
            </Section>
          </div>
        </>
      )}
    </div>
  )
}
