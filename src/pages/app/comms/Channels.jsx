import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { CheckCircle2, CircleDashed, Clock, AlertTriangle, FlaskConical, Mail, Smartphone, MessageCircle, XCircle } from 'lucide-react'
import { api } from '../../../lib/api'
import { useSession } from '../../../lib/session'
import { useLoad, Button, Input, Select, Notice, Skeleton, ErrorState, Badge, Modal, useToast } from '../../../components/ui'
import { fmtDateTime } from '../../../lib/format'
import { money } from './shared'

const LEDGER = { purchase: 'Credit bought', reservation: 'Held for a text', settlement: 'Text sent', release: 'Not sent, returned', refund: 'Not delivered, refunded', test_topup: 'Test credit added', test_reset: 'Balance reset', adjustment: 'Adjustment by GatherHQ' }
const STATE = {
  ready: ['success', CheckCircle2, 'Ready'], pending: ['gold', Clock, 'Sender name waiting for approval'], needs_sender: ['gold', CircleDashed, 'Sender name needed'],
  rejected: ['danger', XCircle, 'Sender name not approved'], issue: ['danger', AlertTriangle, 'Temporary problem'], unsupported: ['neutral', CircleDashed, 'Not available yet'],
}
const DSTATUS = { sent: ['info', 'Sent'], delivered: ['success', 'Delivered'], read: ['success', 'Delivered'], failed: ['danger', 'Not delivered'], unknown: ['gold', 'Checking'], queued: ['neutral', 'Waiting'], sending: ['gold', 'Sending'], skipped: ['neutral', 'Skipped'] }
const hourLabel = (h) => (h === 0 || h === 24 ? 'Midnight' : h === 12 ? '12 noon' : h < 12 ? `${h}am` : `${h - 12}pm`)

function Panel({ title, action, children, className = '' }) {
  return (
    <section className={`panel ${className}`}>
      {title && <div className="flex items-center justify-between gap-3 border-b border-mist-200 px-5 py-3.5"><h2 className="text-[15px] font-semibold text-ink">{title}</h2>{action}</div>}
      {children}
    </section>
  )
}

export default function Channels() {
  const { can } = useSession()
  const toast = useToast()
  const [params, setParams] = useSearchParams()
  const { data, error, loading, reload } = useLoad(() => api.get('/comms/channels'), [])
  const usage = useLoad(() => api.get('/comms/usage'), [])
  const [quiet, setQuiet] = useState(null)
  const [busy, setBusy] = useState('')
  const [sender, setSender] = useState(null) // { country, name, value }
  useEffect(() => { if (data) setQuiet(data.quiet) }, [data])
  useEffect(() => {
    const c = params.get('credit')
    if (!c) return
    toast(c === 'paid' ? 'Payment received. Your credit appears as soon as the payment is confirmed, usually within a minute.' : 'Payment cancelled. Nothing was charged.', c === 'paid' ? undefined : 'error')
    setParams({}, { replace: true })
    if (c === 'paid') { const t = setTimeout(reload, 4000); return () => clearTimeout(t) }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  if (error) return <ErrorState error={error} onRetry={reload} />
  if (loading || !quiet) return <Skeleton className="h-72" />
  const admin = can('org.manage')
  const run = async (key, fn, msg) => { setBusy(key); try { const r = await fn(); if (msg) toast(msg); await reload(); usage.reload(); return r } catch (e) { toast(e.message, 'error') } finally { setBusy('') } }
  const c = data.credits
  const setup = data.sms.setup
  const failures = (usage.data?.rows || []).filter(x => x.status === 'failed').slice(0, 8)

  async function buy(amount) {
    setBusy(`buy${amount}`)
    try { const r = await api.post('/comms/credits/checkout', { amount }); window.location.assign(r.url) } catch (e) { toast(e.message, 'error'); setBusy('') }
  }

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_360px]">
      <div className="min-w-0 space-y-6">
        {/* Channels in plain words */}
        <Panel title="Channels">
          <ul className="divide-y divide-mist-100">
            <li className="flex items-start gap-3 px-5 py-4">
              <Mail size={18} className="mt-0.5 text-mist-500" aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2"><span className="text-[16px] font-medium text-ink">Email</span>{data.channels.email.ready ? <Badge tone="success">Ready</Badge> : <Badge>Not connected</Badge>}</div>
                <p className="mt-1 text-sm text-mist-600">Included in your plan: no credit needed, up to {data.emailLimit.toLocaleString()} emails a day. Emails keep going even when your messaging credit runs out.</p>
              </div>
            </li>
            <li className="flex items-start gap-3 px-5 py-4">
              <Smartphone size={18} className="mt-0.5 text-mist-500" aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2"><span className="text-[16px] font-medium text-ink">SMS (text messages)</span>{data.channels.sms.ready ? <Badge tone="success">{data.channels.sms.simulated ? 'Ready (test mode)' : 'Ready'}</Badge> : <Badge>Not available yet</Badge>}</div>
                <p className="mt-1 text-sm text-mist-600">Paid from your messaging credit, per text. Long texts are sent in parts and each part is charged. GatherHQ chooses the best route for each country.{data.channels.sms.simulated ? ' On staging nothing is really sent: deliveries, failures and replies are simulated.' : ''}</p>
              </div>
            </li>
            <li className="flex items-start gap-3 px-5 py-4">
              <MessageCircle size={18} className="mt-0.5 text-mist-400" aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2"><span className="text-[16px] font-medium text-ink">WhatsApp automation</span><Badge>Coming soon</Badge></div>
                <p className="mt-1 text-sm text-mist-600">Connect your church’s own WhatsApp number when this integration becomes available. Until then, you can message people one by one from your own WhatsApp with the one-tap option when sending.</p>
              </div>
            </li>
          </ul>
        </Panel>

        {/* SMS setup by country */}
        <Panel title="Text message setup">
          <p className="px-5 pt-4 text-sm text-mist-600">Each country has its own rules for who a text can come from. Some need your church’s sender name approved before texts can go out.</p>
          {setup.length ? (
            <ul className="mt-2 divide-y divide-mist-100">
              {setup.map(s => { const [tone, Icon, label] = s.state === 'ready' && s.sender?.status === 'pending' ? ['success', CheckCircle2, 'Ready · own name pending'] : (STATE[s.state] || STATE.unsupported); return (
                <li key={s.country} className="px-5 py-4">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="min-w-0 flex-1 text-[15px] font-medium text-ink">{s.name}</span>
                    <span className="text-sm text-mist-500">{s.people} {s.people === 1 ? 'person' : 'people'} · {s.consented} agreed to texts</span>
                    <Badge tone={tone}><Icon size={13} className="mr-1 inline" />{label}</Badge>
                  </div>
                  <ul className="mt-2 space-y-1 text-sm text-mist-600">
                    {s.state === 'unsupported' && <li>GatherHQ can’t send texts to {s.name} yet. People there can still get emails.</li>}
                    {s.state !== 'unsupported' && s.price != null && <li>About <strong className="text-ink">{money(s.price)}</strong> per text part.</li>}
                    {s.state !== 'unsupported' && s.shared && <li>Texts come from “{s.from}”, and start with your church’s name so people know who it’s from (for example “{data.churchName || 'Your church'}: Hi Ada, …”). The name counts towards the text’s length.</li>}
                    {s.state !== 'unsupported' && !s.shared && <li>{s.needsRegistration ? 'Needs a registered sender name.' : s.senderType === 'alpha' ? `Texts show “${s.from || data.sms.senderName}” as the sender.` : 'Texts come from a GatherHQ phone number.'}{s.twoWay ? ' People can reply.' : ' Replies can’t be received in this country, except STOP.'}</li>}
                    {s.sender && <li>Sender name: <strong className="text-ink">{s.sender.value}</strong>{s.sender.status === 'pending' ? ' · sent for approval' + (s.sender.submitted_at ? ` on ${fmtDateTime(s.sender.submitted_at)}` : '') + '. This usually takes 1–5 working days.' : s.sender.status === 'rejected' ? ` · not approved${s.sender.note ? `: ${s.sender.note}` : ''}` : ' · approved'}</li>}
                  </ul>
                  {admin && s.state === 'ready' && s.senderType === 'alpha' && !s.needsRegistration && <Button size="sm" variant="ghost" className="mt-2" onClick={() => setSender({ country: s.country, name: s.name, value: s.sender?.value || s.from || data.sms.senderName })}>Change sender name</Button>}
                  {admin && s.shared && s.canRegister && !s.sender && <Button size="sm" variant="ghost" className="mt-2" onClick={() => setSender({ country: s.country, name: s.name, value: data.sms.senderName })}>Use your own sender name instead</Button>}
                  {admin && ['needs_sender', 'rejected'].includes(s.state) && <Button size="sm" variant="secondary" className="mt-3" onClick={() => setSender({ country: s.country, name: s.name, value: s.sender?.value || data.sms.senderName })}>{s.state === 'rejected' ? 'Try another sender name' : 'Register a sender name'}</Button>}
                  {data.staging && s.sender?.status === 'pending' && <Button size="sm" variant="ghost" icon={FlaskConical} className="mt-3" loading={busy === `ap${s.country}`} onClick={() => run(`ap${s.country}`, () => api.post(`/comms/simulate/sender/${s.country}`, { status: 'approved' }), 'Approved (staging)')}>Approve now (staging)</Button>}
                </li>
              ) })}
            </ul>
          ) : <p className="px-5 py-4 text-sm text-mist-500">Add phone numbers to your people and their countries will appear here.</p>}
        </Panel>

        {/* Usage */}
        <Panel title="Text messages this month">
          <div className="grid grid-cols-3 gap-4 px-5 py-4">
            <div><p className="text-sm text-mist-500">Texts sent</p><p className="tabular text-[22px] font-semibold text-ink">{data.usage.month.count}</p></div>
            <div><p className="text-sm text-mist-500">Parts charged</p><p className="tabular text-[22px] font-semibold text-ink">{data.usage.month.segments}</p></div>
            <div><p className="text-sm text-mist-500">Spent</p><p className="tabular text-[22px] font-semibold text-ink">{money(data.usage.month.cost)}</p></div>
          </div>
          {data.usage.byCountry.length > 0 && (
            <div className="overflow-x-auto border-t border-mist-100"><table className="w-full text-sm">
              <thead><tr className="text-left text-xs text-mist-500"><th className="px-5 py-2 font-medium">Country</th><th className="px-2 py-2 text-right font-medium">Texts</th><th className="px-2 py-2 text-right font-medium">Parts</th><th className="px-2 py-2 text-right font-medium">Per part</th><th className="px-5 py-2 text-right font-medium">Spent</th></tr></thead>
              <tbody className="divide-y divide-mist-100">{data.usage.byCountry.map(r => (
                <tr key={r.country}><td className="px-5 py-2 text-ink">{r.name}</td><td className="tabular px-2 py-2 text-right">{r.count}</td><td className="tabular px-2 py-2 text-right">{r.segments}</td><td className="tabular px-2 py-2 text-right">{r.segments ? money(r.cost / r.segments) : '—'}</td><td className="tabular px-5 py-2 text-right">{money(r.cost)}</td></tr>
              ))}</tbody>
            </table></div>
          )}
        </Panel>

        <Panel title="Recent texts">
          {usage.loading ? <Skeleton className="m-5 h-24" /> : usage.data?.rows?.length ? (
            <ul className="divide-y divide-mist-100">
              {usage.data.rows.slice(0, 12).map(x => { const [tone, label] = DSTATUS[x.status] || ['neutral', x.status]; return (
                <li key={x.id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-5 py-2.5 text-sm">
                  <span className="min-w-0 flex-1 truncate text-ink">{x.name}<span className="text-mist-500"> · {x.countryName}{x.segments ? ` · ${x.segments} ${x.segments === 1 ? 'part' : 'parts'}` : ''}{x.workflow ? ' · workflow' : ''}</span></span>
                  <span className="tabular text-mist-600">{x.cost ? money(x.cost) : '—'}</span>
                  <Badge tone={tone}>{label}</Badge>
                  {x.error && x.status !== 'sent' && <span className="w-full text-xs text-mist-500">{x.error}</span>}
                </li>
              ) })}
            </ul>
          ) : <p className="px-5 py-6 text-sm text-mist-500">No texts sent yet.</p>}
        </Panel>

        {failures.length > 0 && (
          <Panel title="Texts that weren’t delivered">
            <ul className="divide-y divide-mist-100 text-sm">{failures.map(x => <li key={x.id} className="px-5 py-2.5"><span className="font-medium text-ink">{x.name}</span> <span className="text-mist-500">({x.countryName}, {fmtDateTime(x.at)})</span><span className="block text-mist-600">{x.error || 'It couldn’t be delivered.'} Not charged.</span></li>)}</ul>
          </Panel>
        )}

        <Panel title="Sending hours">
          <div className="px-5 py-4">
            <p className="text-sm text-mist-500">Automatic messages that would arrive outside these hours wait until the next morning. Times are in {data.timezone}.</p>
            <div className="mt-3 grid max-w-md grid-cols-2 gap-3">
              <Select label="From" disabled={!admin} value={quiet.start} onChange={e => setQuiet(q => ({ ...q, start: Number(e.target.value) }))}>{Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hourLabel(h)}</option>)}</Select>
              <Select label="Until" disabled={!admin} value={quiet.end} onChange={e => setQuiet(q => ({ ...q, end: Number(e.target.value) }))}>{Array.from({ length: 24 }, (_, i) => i + 1).map(h => <option key={h} value={h}>{hourLabel(h)}</option>)}</Select>
            </div>
            {admin && (quiet.start !== data.quiet.start || quiet.end !== data.quiet.end) && <Button size="sm" loading={busy === 'quiet'} onClick={() => run('quiet', () => api.patch('/comms/settings', { quietStart: quiet.start, quietEnd: quiet.end }), 'Sending hours saved')}>Save sending hours</Button>}
          </div>
        </Panel>
      </div>

      <aside className="space-y-6">
        <Panel>
          <div className="px-5 py-5">
            <p className="text-sm text-mist-500">Messaging credit</p>
            <p className={`tabular mt-1 text-[32px] font-semibold tracking-tight ${c.balance <= 0 ? 'text-red-700' : c.level > 0 ? 'text-amber-800' : 'text-ink'}`}>{money(c.balance)}</p>
            <p className="mt-1 text-sm text-mist-500">{c.capacity != null ? `Enough for about ${c.capacity.toLocaleString()} more texts at your usual rate.` : 'Used for text messages. Email doesn’t use credit.'}</p>
            {c.balance <= 0 && <Notice tone="danger" className="mt-3">Texts are paused until you add credit. Emails keep going.</Notice>}
            {c.balance > 0 && c.level > 0 && <Notice tone="warning" className="mt-3">Your credit is running low.</Notice>}
            <div className="mt-4 border-t border-mist-100 pt-4">
              <p className="text-sm font-medium text-ink">Add credit</p>
              <div className="mt-2 flex flex-wrap gap-2">{c.packs.map(p => <Button key={p} size="sm" variant="secondary" disabled={!admin || !c.purchases} loading={busy === `buy${p}`} onClick={() => buy(p)}>{money(p)}</Button>)}</div>
              <p className="mt-2 text-xs text-mist-500">{!c.purchases ? 'Buying credit isn’t switched on yet.' : !admin ? 'Ask an admin to add credit.' : `Paid by card through Stripe, separately from your plan.${data.staging ? ' Staging uses Stripe test mode: use card 4242 4242 4242 4242.' : ''}`}</p>
            </div>
            {data.staging && (
              <div className="mt-4 rounded-xl border border-mist-200 bg-mist-50 p-3">
                <p className="flex items-center gap-1.5 text-[13px] font-medium text-mist-700"><FlaskConical size={14} />Staging only</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" loading={busy === 't5'} onClick={() => run('t5', () => api.post('/comms/credits/test', { amount: 5 }), 'Added $5 test credit')}>Add $5 test credit</Button>
                  <Button size="sm" variant="ghost" loading={busy === 'reset'} onClick={() => run('reset', () => api.post('/comms/credits/test-reset'), 'Balance set to zero')}>Set to zero</Button>
                </div>
              </div>
            )}
          </div>
        </Panel>

        {(data.resume.journeys.length > 0 || data.resume.messages.length > 0) && (
          <Panel title="Waiting for credit">
            <div className="px-5 py-4 text-sm text-mist-600">
              <p>These will continue when you add credit. Anything that would now arrive more than {Math.round(c.resumeWindowHours / 24)} days late is skipped, so nobody gets old messages in a burst.</p>
              <ul className="mt-2 space-y-1">
                {data.resume.messages.map(m => <li key={m.id}>• <Link to={`/app/communications/messages/${m.id}`} className="link">{m.title || 'Text message'}</Link>: {m.remaining} still to send</li>)}
                {data.resume.journeys.slice(0, 8).map(j => <li key={j.id}>• {j.person} in “{j.workflow}”</li>)}
                {data.resume.journeys.length > 8 && <li>…and {data.resume.journeys.length - 8} more in workflows</li>}
              </ul>
            </div>
          </Panel>
        )}

        <Panel title="Credit history">
          {data.ledger.filter(e => !['reservation', 'release'].includes(e.type)).length ? (
            <ul className="divide-y divide-mist-100 text-sm">
              {data.ledger.filter(e => !['reservation', 'release'].includes(e.type)).slice(0, 15).map(e => (
                <li key={e.id} className="flex items-start gap-3 px-5 py-2.5">
                  <span className="min-w-0 flex-1"><span className="block text-ink">{LEDGER[e.type] || e.type}{e.test && <Badge tone="gold" className="ml-2">Test</Badge>}</span><span className="text-xs text-mist-500">{fmtDateTime(e.created_at)}{e.country ? ` · ${e.country}` : ''}</span></span>
                  {(() => { const a = e.type === 'settlement' ? -(e.actual_cost || 0) : e.amount; return <span className={`tabular ${a < 0 ? 'text-ink' : 'text-green-800'}`}>{a < 0 ? '−' : '+'}{money(Math.abs(a))}</span> })()}
                </li>
              ))}
            </ul>
          ) : <p className="px-5 py-5 text-sm text-mist-500">No credit added or used yet.</p>}
          <p className="border-t border-mist-100 px-5 py-3 text-xs text-mist-500">When a text is sent, its estimated cost is held first, then settled at the actual price. Texts that aren’t sent are never charged.</p>
        </Panel>
        {c.placeholder && <Notice tone="warning">Text prices on staging are estimates for testing, not final GatherHQ prices.</Notice>}
      </aside>

      <Modal open={!!sender} onClose={() => setSender(null)} title={`Sender name for ${sender?.name || ''}`}
        footer={<><Button variant="secondary" onClick={() => setSender(null)}>Cancel</Button><Button loading={busy === 'sender'} onClick={async () => { const r = await run('sender', () => api.post('/comms/sms/senders', sender), null); if (r) { toast(r.status === 'approved' ? 'Sender name saved' : 'Sent for approval'); setSender(null) } }}>Submit</Button></>}>
        {sender && <>
          <Input label="Sender name" value={sender.value} maxLength={11} onChange={e => setSender(s => ({ ...s, value: e.target.value.replace(/[^A-Za-z0-9 ]/g, '') }))} hint="3 to 11 letters or numbers, for example GRACECHURCH. This is what people see instead of a phone number." />
          {setup.find(x => x.country === sender.country)?.needsRegistration ? <><p className="text-sm font-medium text-ink">What happens next</p>
          <ol className="mt-1 list-decimal space-y-1 pl-5 text-sm text-mist-600">
            <li>GatherHQ submits the name to the mobile networks in {sender.name} for you.</li>
            <li>They may ask for proof that your church uses this name (for example a registration certificate or letterhead). We’ll email you if so.</li>
            <li>Approval usually takes 1 to 5 working days. Texts to {sender.name} start automatically once it’s approved.</li>
          </ol></> : <p className="text-sm text-mist-600">{sender.name} doesn’t need sender names registered, so the new name is used straight away.</p>}
        </>}
      </Modal>
    </div>
  )
}
