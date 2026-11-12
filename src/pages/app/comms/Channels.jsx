import { useEffect, useState } from 'react'
import { CheckCircle2, CircleDashed, FlaskConical } from 'lucide-react'
import { api } from '../../../lib/api'
import { useSession } from '../../../lib/session'
import { useLoad, Button, Select, Notice, Skeleton, ErrorState, Badge, Segmented, useToast } from '../../../components/ui'
import { fmtDateTime } from '../../../lib/format'
import { CHANNEL_ICON, channelLabel, money } from './shared'

const LEDGER = { usage: 'Messages sent', church_billed: 'Paid on your own account', test_topup: 'Test credit added', test_reset: 'Balance reset', topup: 'Credit added', refund: 'Refund', adjustment: 'Adjustment' }
const countryName = (c) => { try { return new Intl.DisplayNames(['en'], { type: 'region' }).of(c) } catch { return c } }
const hours = Array.from({ length: 25 }, (_, h) => h)
const hourLabel = (h) => h === 0 || h === 24 ? 'Midnight' : h === 12 ? '12 noon' : h < 12 ? `${h}am` : `${h - 12}pm`

export default function Channels() {
  const { can } = useSession()
  const toast = useToast()
  const { data, error, loading, reload } = useLoad(() => api.get('/comms/channels'), [])
  const [quiet, setQuiet] = useState(null)
  const [busy, setBusy] = useState('')
  useEffect(() => { if (data) setQuiet(data.quiet) }, [data])
  if (error) return <ErrorState error={error} onRetry={reload} />
  if (loading || !quiet) return <Skeleton className="h-72" />
  const admin = can('org.manage')
  const run = async (key, fn, msg) => { setBusy(key); try { await fn(); toast(msg); await reload() } catch (e) { toast(e.message, 'error') } finally { setBusy('') } }

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_360px]">
      <div className="space-y-6">
        <section className="panel">
          <h2 className="border-b border-mist-200 px-5 py-3.5 text-[15px] font-semibold text-ink">Channels</h2>
          <ul className="divide-y divide-mist-100">
            {Object.entries(data.channels).map(([ch, s]) => { const Icon = CHANNEL_ICON[ch]; return (
              <li key={ch} className="px-5 py-4">
                <div className="flex flex-wrap items-center gap-3">
                  <Icon size={18} className="text-mist-500" aria-hidden />
                  <span className="flex-1 text-[16px] font-medium text-ink">{channelLabel(ch)}</span>
                  {s.ready ? <span className="flex items-center gap-1.5 text-sm text-green-800"><CheckCircle2 size={15} />{s.simulated ? 'Ready (test mode)' : 'Ready'}</span> : <span className="flex items-center gap-1.5 text-sm text-mist-500"><CircleDashed size={15} />Not connected</span>}
                </div>
                <p className="mt-1.5 pl-[30px] text-sm text-mist-600">
                  {ch === 'email' && s.ready ? 'Included in your plan, up to your daily email limit.'
                    : !s.ready ? 'GatherHQ is still connecting this channel. You can prepare messages, but they can’t be sent yet.'
                    : s.billing === 'church' ? 'Sent through your own account. Your provider bills you directly; GatherHQ doesn’t charge for these.'
                    : `Paid from your messaging credit. About ${money(ch === 'sms' ? data.prices.sms : data.prices.whatsapp.marketing)} per ${ch === 'sms' ? 'text' : 'message'} in ${countryName(data.prices.country)}.`}
                  {s.simulated && ' Nothing is really sent: deliveries, replies and opt-outs are simulated.'}
                </p>
                {ch !== 'email' && s.ready && admin && (
                  <div className="mt-3 pl-[30px]">
                    <Segmented size="sm" value={s.billing} onChange={(billing) => run(ch, () => api.patch(`/comms/channels/${ch}`, { billing }), 'Saved')}
                      options={[{ value: 'platform', label: 'Pay with GatherHQ credit' }, { value: 'church', label: 'Use our own account', disabled: !s.canChurchBill }]} />
                    {!s.canChurchBill && <p className="mt-1.5 text-xs text-mist-500">Connecting your own {channelLabel(ch)} account will be available later.</p>}
                  </div>
                )}
              </li>
            ) })}
          </ul>
        </section>

        <section className="panel px-5 py-4">
          <h2 className="text-[15px] font-semibold text-ink">Sending hours</h2>
          <p className="mt-0.5 text-sm text-mist-500">Automatic messages that would arrive outside these hours wait until the next morning. Times are in {data.timezone}.</p>
          <div className="mt-3 grid max-w-md grid-cols-2 gap-3">
            <Select label="From" disabled={!admin} value={quiet.start} onChange={e => setQuiet(q => ({ ...q, start: Number(e.target.value) }))}>{hours.slice(0, 24).map(h => <option key={h} value={h}>{hourLabel(h)}</option>)}</Select>
            <Select label="Until" disabled={!admin} value={quiet.end} onChange={e => setQuiet(q => ({ ...q, end: Number(e.target.value) }))}>{hours.slice(1).map(h => <option key={h} value={h}>{hourLabel(h)}</option>)}</Select>
          </div>
          {admin && (quiet.start !== data.quiet.start || quiet.end !== data.quiet.end) && <Button size="sm" loading={busy === 'quiet'} onClick={() => run('quiet', () => api.patch('/comms/settings', { quietStart: quiet.start, quietEnd: quiet.end }), 'Sending hours saved')}>Save sending hours</Button>}
        </section>

        <section className="panel">
          <h2 className="border-b border-mist-200 px-5 py-3.5 text-[15px] font-semibold text-ink">Credit history</h2>
          {data.ledger.length ? (
            <div className="overflow-x-auto"><table className="w-full text-sm">
              <thead><tr className="text-left text-xs text-mist-500"><th className="px-5 py-2 font-medium">When</th><th className="px-2 py-2 font-medium">What</th><th className="px-2 py-2 text-right font-medium">Amount</th><th className="px-5 py-2 text-right font-medium">Balance</th></tr></thead>
              <tbody className="divide-y divide-mist-100">{data.ledger.map(e => (
                <tr key={e.id}><td className="whitespace-nowrap px-5 py-2.5 text-mist-500">{fmtDateTime(e.created_at)}</td>
                  <td className="px-2 py-2.5 text-ink">{LEDGER[e.type] || e.type}{e.count ? ` · ${e.count} ${channelLabel(e.channel)}` : ''}{e.test && <Badge tone="gold" className="ml-2">Test</Badge>}</td>
                  <td className={`tabular px-2 py-2.5 text-right ${e.amount < 0 ? 'text-ink' : 'text-green-800'}`}>{e.type === 'church_billed' ? '—' : `${e.amount < 0 ? '−' : '+'}${money(Math.abs(e.amount))}`}</td>
                  <td className="tabular px-5 py-2.5 text-right text-mist-600">{e.balance_after != null ? money(e.balance_after) : ''}</td></tr>
              ))}</tbody>
            </table></div>
          ) : <p className="px-5 py-6 text-sm text-mist-500">No credit used yet.</p>}
        </section>
      </div>

      <aside className="space-y-6">
        <section className="panel px-5 py-5">
          <p className="text-sm text-mist-500">Messaging credit</p>
          <p className="tabular mt-1 text-[32px] font-semibold tracking-tight text-ink">{money(data.credits.balance)}</p>
          <p className="mt-1 text-sm text-mist-500">Used for WhatsApp and SMS sent through GatherHQ. Email doesn’t use credit.</p>
          <dl className="mt-4 space-y-1.5 border-t border-mist-100 pt-4 text-sm">
            <div className="flex justify-between"><dt className="text-mist-600">WhatsApp this month</dt><dd className="tabular text-ink">{data.usage.whatsapp.count} · {money(data.usage.whatsapp.cost)}</dd></div>
            <div className="flex justify-between"><dt className="text-mist-600">SMS this month</dt><dd className="tabular text-ink">{data.usage.sms.count} · {money(data.usage.sms.cost)}</dd></div>
            {data.usage.church_billed.count > 0 && <div className="flex justify-between"><dt className="text-mist-600">On your own account</dt><dd className="tabular text-ink">{data.usage.church_billed.count}</dd></div>}
          </dl>
          <div className="mt-4 border-t border-mist-100 pt-4">
            <p className="text-sm font-medium text-ink">Add credit</p>
            <div className="mt-2 flex flex-wrap gap-2">{data.credits.packs.map(p => <Button key={p} size="sm" variant="secondary" disabled>{money(p)}</Button>)}</div>
            <p className="mt-2 text-xs text-mist-500">Buying credit isn’t switched on yet.</p>
          </div>
          {data.staging && (
            <div className="mt-4 rounded-xl border border-gold-200 bg-gold-50 p-3">
              <p className="flex items-center gap-1.5 text-[13px] font-medium text-gold-700"><FlaskConical size={14} />Staging only</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {[10, 50].map(n => <Button key={n} size="sm" variant="secondary" loading={busy === `t${n}`} onClick={() => run(`t${n}`, () => api.post('/comms/credits/test', { amount: n }), `Added ${money(n)} test credit`)}>Add {money(n)} test credit</Button>)}
                <Button size="sm" variant="ghost" loading={busy === 'reset'} onClick={() => run('reset', () => api.post('/comms/credits/test-reset'), 'Balance set to zero')}>Set to zero</Button>
              </div>
            </div>
          )}
        </section>
        {data.credits.placeholderRates && <Notice tone="warning">Prices shown are estimates for testing, not final GatherHQ prices.</Notice>}
      </aside>
    </div>
  )
}
