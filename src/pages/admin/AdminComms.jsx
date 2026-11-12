// GatherHQ team: which provider each channel uses, provider tests, prices and the scheduler.
import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { useLoad, Button, Badge, Notice, Textarea, PageLoader, ErrorState, useToast, useConfirm } from '../../components/ui'
import { fmtDateTime } from '../../lib/format'

const CH = { email: 'Email', whatsapp: 'WhatsApp', sms: 'SMS' }

export default function AdminComms() {
  const toast = useToast()
  const confirm = useConfirm()
  const { data, error, loading, reload } = useLoad(() => api.get('/platform/comms'), [])
  const [rates, setRates] = useState('')
  const [busy, setBusy] = useState('')
  const [tests, setTests] = useState({})
  useEffect(() => { if (data) setRates(JSON.stringify({ rates: data.rates, packs: data.packs || [10, 25, 50] }, null, 2)) }, [data])
  if (error) return <ErrorState error={error} onRetry={reload} />
  if (loading) return <PageLoader />
  const run = async (key, fn, msg) => { setBusy(key); try { const r = await fn(); if (msg) toast(msg); await reload(); return r } catch (e) { toast(e.message, 'error') } finally { setBusy('') } }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Messaging</h1>
        <p className="mt-1 text-sm text-mist-500">Providers for every church on GatherHQ. Environment: <Badge tone={data.environment === 'production' ? 'danger' : 'gold'}>{data.environment}</Badge>{data.updated_by && <> · last changed by {data.updated_by}</>}</p>
      </div>

      {Object.entries(data.channels).map(([ch, c]) => (
        <section key={ch} className="panel">
          <div className="flex items-center justify-between border-b border-mist-200 px-5 py-3.5">
            <h2 className="text-[15px] font-semibold text-ink">{CH[ch]}</h2>
            <span className="text-sm text-mist-500">In use: <strong className="text-ink">{c.providers.find(p => p.id === c.active)?.label || 'None'}</strong></span>
          </div>
          <ul className="divide-y divide-mist-100">
            {c.providers.map(p => (
              <li key={p.id} className="px-5 py-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="flex-1 font-medium text-ink">{p.label}</span>
                  {p.mock && <Badge tone="gold">Test only</Badge>}
                  {p.disabled && <Badge tone="danger">Switched off</Badge>}
                  {c.active === p.id && <Badge tone="success" dot>In use</Badge>}
                  {!p.available && !p.mock && <Badge>Not set up</Badge>}
                </div>
                <p className="mt-1 text-sm text-mist-500">Billing: {p.billing.join(', ')} · Delivery reports: {p.reports ? 'yes' : 'no'}{p.needsTemplates ? ' · Needs approved templates' : ''}</p>
                {p.credentials.length > 0 && <p className="mt-1 text-sm text-mist-500">Credentials: {p.credentials.map(k => `${k.name} ${k.set ? '✓ set' : '✗ not set'}`).join(' · ')}</p>}
                {tests[p.id] && <Notice tone={tests[p.id].ok ? 'success' : 'danger'} className="mt-2">{tests[p.id].message}</Notice>}
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" loading={busy === `t${p.id}`} onClick={async () => { const r = await run(`t${p.id}`, () => api.post('/platform/comms/test', { channel: ch, provider: p.id })); if (r) setTests(t => ({ ...t, [p.id]: r })) }}>Test connection</Button>
                  {c.active !== p.id && p.available && !p.disabled && <Button size="sm" loading={busy === `u${p.id}`} onClick={async () => { if (await confirm({ title: `Switch ${CH[ch]} to ${p.label}?`, message: 'Every church’s new messages on this channel will go through it. Messages already sent are not affected.', confirmLabel: 'Switch' })) run(`u${p.id}`, () => api.post('/platform/comms/provider', { channel: ch, provider: p.id }), 'Switched') }}>Use this</Button>}
                  <Button size="sm" variant={p.disabled ? 'secondary' : 'danger-ghost'} loading={busy === `d${p.id}`} onClick={() => run(`d${p.id}`, () => api.post('/platform/comms/provider', { channel: ch, provider: p.id, disabled: !p.disabled }), p.disabled ? 'Switched back on' : 'Switched off: sends on this provider pause')}>{p.disabled ? 'Switch back on' : 'Switch off'}</Button>
                </div>
              </li>
            ))}
            {c.planned.length > 0 && <li className="px-5 py-3 text-sm text-mist-500">Planned: {c.planned.join(', ')}</li>}
          </ul>
        </section>
      ))}

      <section className="panel px-5 py-4">
        <h2 className="text-[15px] font-semibold text-ink">Prices charged to churches (USD)</h2>
        <p className="mt-0.5 text-sm text-mist-500">WhatsApp per message by country and type; SMS per text segment. Set <code>placeholder</code> to false once prices are final.</p>
        <Textarea className="mt-3 font-mono text-xs" rows={16} value={rates} onChange={e => setRates(e.target.value)} aria-label="Rates JSON" />
        <Button size="sm" loading={busy === 'rates'} onClick={() => { let parsed; try { parsed = JSON.parse(rates) } catch { return toast('That isn’t valid JSON.', 'error') } run('rates', () => api.post('/platform/comms/rates', parsed), 'Prices saved') }}>Save prices</Button>
      </section>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <section className="panel">
          <h2 className="border-b border-mist-200 px-5 py-3.5 text-[15px] font-semibold text-ink">Scheduler runs</h2>
          <ul className="divide-y divide-mist-100 text-sm">{data.runs.map(r => (
            <li key={r.id} className="px-5 py-2.5"><span className="text-mist-500">{fmtDateTime(r.at)}</span> · {r.kind || 'jobs'} · {r.messages ?? 0} messages · {r.enrolments ?? 0} workflow steps · {r.recurring ?? 0} scheduled{r.errors ? <span className="text-red-700"> · {Array.isArray(r.errors) ? r.errors.length : r.errors} errors</span> : ''} · {r.took_ms ?? '?'}ms</li>
          ))}{!data.runs.length && <li className="px-5 py-4 text-mist-500">No runs yet.</li>}</ul>
        </section>
        <section className="panel">
          <h2 className="border-b border-mist-200 px-5 py-3.5 text-[15px] font-semibold text-ink">Queue (next 50)</h2>
          <ul className="divide-y divide-mist-100 text-sm">{data.queue.map(q => (
            <li key={q.id} className="px-5 py-2.5"><span className="text-mist-500">{fmtDateTime(q.due_at)}</span> · {q.kind} · <span className="font-mono text-xs">{q.org_id?.slice(0, 8)}/{q.ref_id?.slice(0, 16)}</span></li>
          ))}{!data.queue.length && <li className="px-5 py-4 text-mist-500">Nothing waiting.</li>}</ul>
        </section>
      </div>
    </div>
  )
}
