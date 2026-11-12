// GatherHQ team: SMS providers, credentials, country routes and prices, sender approvals, health.
import { useEffect, useMemo, useState } from 'react'
import { api } from '../../lib/api'
import { useLoad, Button, Badge, Notice, Input, Select, Checkbox, Toggle, Modal, Skeleton, ErrorState, useToast } from '../../components/ui'
import { fmtDateTime } from '../../lib/format'
import { countryName } from '../../../shared/comms.js'

const SENDER_TYPES = [['alpha', 'Sender name'], ['number', 'Phone number'], ['shortcode', 'Short code'], ['provider', 'Provider-managed']]

export default function AdminSms() {
  const toast = useToast()
  const { data, error, loading, reload } = useLoad(() => api.get('/platform/comms/sms'), [])
  const [cfg, setCfg] = useState(null)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState('')
  const [tests, setTests] = useState({})
  const [creds, setCreds] = useState(null) // { provider, values }
  const [cap, setCap] = useState(null) // { provider, cc, c }
  const [addCc, setAddCc] = useState('')
  useEffect(() => { if (data) { setCfg(structuredClone({ providers: Object.fromEntries(data.providers.map(p => [p.id, { enabled: p.enabled, countries: p.countries }])), routes: data.routes, taxPct: data.taxPct, lowAlerts: data.lowAlerts, resumeWindowHours: data.resumeWindowHours, placeholder: data.placeholder, packs: data.packs })); setDirty(false) } }, [data])
  const countries = useMemo(() => !cfg ? [] : [...new Set(Object.values(cfg.providers).flatMap(p => Object.keys(p.countries || {})).concat(Object.keys(cfg.routes || {})))].sort((a, b) => countryName(a).localeCompare(countryName(b))), [cfg])
  if (error) return <ErrorState error={error} onRetry={reload} />
  if (loading || !cfg) return <Skeleton className="h-64" />
  const change = (fn) => { setCfg(c => { const n = structuredClone(c); fn(n); return n }); setDirty(true) }
  const run = async (key, fn, msg) => { setBusy(key); try { const r = await fn(); if (msg) toast(msg); return r } catch (e) { toast(e.message, 'error') } finally { setBusy('') } }
  const save = () => run('save', async () => { await api.post('/platform/comms/sms', cfg); await reload() }, 'SMS settings saved')
  const label = Object.fromEntries(data.providers.map(p => [p.id, p.label]))

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h2 className="text-xl font-semibold text-ink">SMS</h2><p className="text-sm text-mist-500">Churches just choose “SMS”. These settings decide which provider carries each text.</p></div>
        {dirty && <Button loading={busy === 'save'} onClick={save}>Save SMS settings</Button>}
      </div>

      {/* Providers */}
      <section className="panel">
        <h3 className="border-b border-mist-200 px-5 py-3.5 text-[15px] font-semibold text-ink">Providers</h3>
        <ul className="divide-y divide-mist-100">
          {data.providers.map(p => { const on = cfg.providers[p.id]?.enabled; const verified = Object.entries(cfg.providers[p.id]?.countries || {}).filter(([, c]) => c.verified).map(([cc]) => cc); return (
            <li key={p.id} className="px-5 py-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="flex-1 font-medium text-ink">{p.label}</span>
                {p.mock && <Badge tone="gold">Test only</Badge>}
                {!p.available && !p.mock && <Badge>Credentials missing</Badge>}
                {p.health?.downUntil && new Date(p.health.downUntil) > new Date() && <Badge tone="danger">Paused after failures</Badge>}
                <Toggle checked={!!on} onChange={v => change(n => { n.providers[p.id].enabled = v })} label={on ? 'On' : 'Off'} />
              </div>
              <p className="mt-1 text-sm text-mist-500">Verified countries: {verified.length ? verified.join(', ') : 'none yet'} · Charges for undelivered texts: {p.billsFailed ? 'yes' : 'no'}</p>
              {!p.mock && <p className="mt-1 text-sm text-mist-500">Credentials: {p.credentials.map(k => `${k.name} ${k.set ? `✓ (${k.from === 'netlify' ? 'Netlify' : 'stored, encrypted'})` : k.optional ? '– optional' : '✗'}`).join(' · ')}</p>}
              {p.health && <p className="mt-1 text-sm text-mist-500">Health: {p.health.ok} ok · {p.health.failed} failed{p.health.failures ? ` · ${p.health.failures} failures in a row` : ''}{p.health.lastError ? ` · last error ${fmtDateTime(p.health.lastErrorAt)}: ${p.health.lastError}` : ''}</p>}
              {tests[p.id] && <Notice tone={tests[p.id].ok ? 'success' : 'danger'} className="mt-2">{tests[p.id].ok ? 'Connected.' : tests[p.id].error || 'Couldn’t connect.'}</Notice>}
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" loading={busy === `t${p.id}`} onClick={async () => { const r = await run(`t${p.id}`, () => api.post('/platform/comms/sms/test', { provider: p.id })); if (r) setTests(t => ({ ...t, [p.id]: r })) }}>Test connection</Button>
                {!p.mock && <Button size="sm" variant="ghost" onClick={() => setCreds({ provider: p.id, label: p.label, fields: p.credentials, values: {} })}>Update credentials</Button>}
              </div>
            </li>
          ) })}
        </ul>
      </section>

      {/* Countries and routes */}
      <section className="panel">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-mist-200 px-5 py-3.5">
          <h3 className="text-[15px] font-semibold text-ink">Countries and routing</h3>
          <form className="flex gap-2" onSubmit={e => { e.preventDefault(); const cc = addCc.trim().toUpperCase(); if (/^[A-Z]{2}$/.test(cc)) { setCap({ provider: data.providers[0].id, cc, c: { verified: false, rate: 0.05, surcharge: 0, cost: null, senderTypes: ['alpha'], registration: 'none', twoWay: false, promotional: true } }); setAddCc('') } }}>
            <input value={addCc} onChange={e => setAddCc(e.target.value)} placeholder="Country code, e.g. FR" maxLength={2} className="field w-44" aria-label="Country code to add" />
            <Button size="sm" variant="secondary" type="submit">Add country</Button>
          </form>
        </div>
        <p className="px-5 pt-3 text-sm text-mist-500">A country is only offered to churches when at least one switched-on provider has it marked verified. Prices are what churches pay per text part (USD), before tax of {cfg.taxPct}%.</p>
        <div className="overflow-x-auto"><table className="mt-2 w-full text-sm">
          <thead><tr className="text-left text-xs text-mist-500"><th className="px-5 py-2 font-medium">Country</th><th className="px-2 py-2 font-medium">Providers (price · senders · rules)</th><th className="px-2 py-2 font-medium">Preferred</th><th className="px-5 py-2 font-medium">Fallback</th></tr></thead>
          <tbody className="divide-y divide-mist-100">
            {countries.map(cc => { const offers = Object.entries(cfg.providers).filter(([, p]) => p.countries?.[cc]); const route = cfg.routes?.[cc] || []; const eligible = offers.filter(([, p]) => p.countries[cc].verified).map(([id]) => id); return (
              <tr key={cc} className="align-top">
                <td className="px-5 py-3"><span className="font-medium text-ink">{countryName(cc)}</span> <span className="text-mist-400">{cc}</span></td>
                <td className="px-2 py-3"><ul className="space-y-1">{offers.map(([id, p]) => { const c = p.countries[cc]; return (
                  <li key={id}><button type="button" className="text-left hover:underline" onClick={() => setCap({ provider: id, cc, c: structuredClone(c) })}>
                    <span className={c.verified && p.enabled ? 'text-ink' : 'text-mist-400'}>{label[id]}</span> <span className="text-mist-500">· ${Number(c.rate).toFixed(3)}{c.surcharge ? ` + ${c.surcharge}` : ''} · {c.senderTypes.join('/')}{c.registration === 'required' ? ' · registration' : ''}{c.twoWay ? ' · 2-way' : ''}{c.promotional === false ? ' · updates only' : ''}</span>
                    {!c.verified && <Badge className="ml-1">Not verified</Badge>}
                  </button></li>
                ) })}</ul>
                <button type="button" className="mt-1 text-xs text-brand-700 hover:underline" onClick={() => setCap({ provider: data.providers.find(p => !cfg.providers[p.id]?.countries?.[cc])?.id || data.providers[0].id, cc, c: { verified: false, rate: 0.05, surcharge: 0, cost: null, senderTypes: ['alpha'], registration: 'none', twoWay: false, promotional: true } })}>+ Add a provider for {cc}</button></td>
                <td className="px-2 py-3"><Select aria-label={`Preferred provider for ${cc}`} className="!mb-0" value={route[0] || ''} onChange={e => change(n => { const r = (n.routes[cc] || []).filter(x => x !== e.target.value); n.routes[cc] = e.target.value ? [e.target.value, ...r.slice(e.target.value === route[0] ? 1 : 0)].filter((x, i, a) => a.indexOf(x) === i) : r.slice(1) })}><option value="">Cheapest</option>{eligible.map(id => <option key={id} value={id}>{label[id]}</option>)}</Select></td>
                <td className="px-5 py-3"><Select aria-label={`Fallback provider for ${cc}`} className="!mb-0" value={route[1] || ''} onChange={e => change(n => { const first = (n.routes[cc] || [])[0]; n.routes[cc] = [first, e.target.value].filter(Boolean) })} disabled={!route[0]}><option value="">Any other eligible</option>{eligible.filter(id => id !== route[0]).map(id => <option key={id} value={id}>{label[id]}</option>)}</Select></td>
              </tr>
            ) })}
          </tbody>
        </table></div>
      </section>

      {/* Sender approvals */}
      <section className="panel">
        <h3 className="border-b border-mist-200 px-5 py-3.5 text-[15px] font-semibold text-ink">Sender names waiting for approval</h3>
        {data.senderRequests.length ? (
          <ul className="divide-y divide-mist-100">{data.senderRequests.map(r => <SenderRequest key={r.id} r={r} providers={data.providers.filter(p => cfg.providers[p.id]?.countries?.[r.country])} onDone={reload} />)}</ul>
        ) : <p className="px-5 py-4 text-sm text-mist-500">None waiting.</p>}
      </section>

      {/* Credit and alerts */}
      <section className="panel px-5 py-4">
        <h3 className="text-[15px] font-semibold text-ink">Credit, tax and alerts</h3>
        <div className="mt-3 grid grid-cols-1 gap-x-4 sm:grid-cols-2 lg:grid-cols-4">
          <Input label="Credit packs (USD)" value={(cfg.packs || []).join(', ')} onChange={e => change(n => { n.packs = e.target.value.split(/[,\s]+/).map(Number).filter(x => x > 0) })} hint="Comma separated, e.g. 10, 25, 50" />
          <Input label="Tax added to SMS prices (%)" type="number" min={0} max={50} value={cfg.taxPct} onChange={e => change(n => { n.taxPct = Number(e.target.value) })} />
          <Input label="Low-balance warnings (%)" value={(cfg.lowAlerts || []).join(', ')} onChange={e => change(n => { n.lowAlerts = e.target.value.split(/[,\s]+/).map(Number).filter(x => x > 0 && x < 100) })} hint="Share of the last top-up" />
          <Input label="Skip texts later than (hours)" type="number" min={1} max={168} value={cfg.resumeWindowHours} onChange={e => change(n => { n.resumeWindowHours = Number(e.target.value) })} hint="After credit runs out and is added again" />
        </div>
        <Checkbox checked={cfg.placeholder} onChange={e => change(n => { n.placeholder = e.target.checked })} label="Prices are provisional (churches see an “estimate for testing” note)" />
        {dirty && <Button className="mt-3" loading={busy === 'save'} onClick={save}>Save SMS settings</Button>}
      </section>

      <Modal open={!!creds} onClose={() => setCreds(null)} title={`${creds?.label || ''} credentials`}
        footer={<><Button variant="secondary" onClick={() => setCreds(null)}>Cancel</Button><Button loading={busy === 'creds'} disabled={!data.canStoreSecrets} onClick={async () => { const r = await run('creds', () => api.post('/platform/comms/sms/credentials', { provider: creds.provider, values: creds.values }), 'Credentials saved'); if (r) { setCreds(null); reload() } }}>Save</Button></>}>
        {creds && <>
          {!data.canStoreSecrets && <Notice tone="warning" className="mb-3">Set COMMS_SECRET_KEY as a secret in Netlify first, or add these as Netlify environment variables directly.</Notice>}
          <p className="mb-3 text-sm text-mist-500">Values are encrypted and never shown again. Leave a field empty to keep its current value.</p>
          {creds.fields.map(f => <Input key={f.name} label={`${f.name}${f.optional ? ' (optional)' : ''}`} type="password" autoComplete="off" value={creds.values[f.name] || ''} placeholder={f.set ? 'Saved' : ''} disabled={f.from === 'netlify'} hint={f.from === 'netlify' ? 'Set in Netlify; change it there.' : undefined} onChange={e => setCreds(c => ({ ...c, values: { ...c.values, [f.name]: e.target.value } }))} />)}
        </>}
      </Modal>

      <Modal open={!!cap} onClose={() => setCap(null)} title={cap ? `${countryName(cap.cc)} (${cap.cc})` : ''}
        footer={<>{cap && cfg.providers[cap.provider]?.countries?.[cap.cc] && <Button variant="danger-ghost" onClick={() => { change(n => { delete n.providers[cap.provider].countries[cap.cc]; if (n.routes[cap.cc]) n.routes[cap.cc] = n.routes[cap.cc].filter(x => x !== cap.provider) }); setCap(null) }}>Remove</Button>}<Button onClick={() => { change(n => { n.providers[cap.provider].countries[cap.cc] = { ...cap.c, rate: Number(cap.c.rate), surcharge: Number(cap.c.surcharge || 0), cost: cap.c.cost === '' || cap.c.cost == null ? null : Number(cap.c.cost) } }); setCap(null) }}>Done</Button></>}>
        {cap && <>
          <Select label="Provider" value={cap.provider} onChange={e => setCap(x => ({ ...x, provider: e.target.value, c: structuredClone(cfg.providers[e.target.value]?.countries?.[x.cc] || x.c) }))}>{data.providers.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}</Select>
          {cap.c.note && <Notice className="mb-3">{cap.c.note}</Notice>}
          <div className="grid grid-cols-3 gap-3">
            <Input label="Church price / part" type="number" step="0.001" min={0} value={cap.c.rate} onChange={e => setCap(x => ({ ...x, c: { ...x.c, rate: e.target.value } }))} />
            <Input label="Carrier surcharge" type="number" step="0.001" min={0} value={cap.c.surcharge || 0} onChange={e => setCap(x => ({ ...x, c: { ...x.c, surcharge: e.target.value } }))} />
            <Input label="Our cost (internal)" type="number" step="0.001" min={0} value={cap.c.cost ?? ''} onChange={e => setCap(x => ({ ...x, c: { ...x.c, cost: e.target.value } }))} />
          </div>
          <p className="label">Sender types this route supports</p>
          <div className="mb-3 flex flex-wrap gap-x-4">{SENDER_TYPES.map(([k, l]) => <Checkbox key={k} label={l} checked={cap.c.senderTypes.includes(k)} onChange={e => setCap(x => ({ ...x, c: { ...x.c, senderTypes: e.target.checked ? [...x.c.senderTypes, k] : x.c.senderTypes.filter(t => t !== k) } }))} />)}</div>
          <Select label="Sender registration" value={cap.c.registration} onChange={e => setCap(x => ({ ...x, c: { ...x.c, registration: e.target.value } }))}><option value="none">Not needed</option><option value="required">Required before sending</option></Select>
          <Input label="Default sender (optional)" value={cap.c.from || ''} onChange={e => setCap(x => ({ ...x, c: { ...x.c, from: e.target.value } }))} hint="A number or name GatherHQ sends from when the church has none of its own." />
          <div className="space-y-1">
            <Checkbox label="Two-way (people can reply)" checked={!!cap.c.twoWay} onChange={e => setCap(x => ({ ...x, c: { ...x.c, twoWay: e.target.checked } }))} />
            <Checkbox label="Invitations and news allowed (not only reminders)" checked={cap.c.promotional !== false} onChange={e => setCap(x => ({ ...x, c: { ...x.c, promotional: e.target.checked } }))} />
            <Checkbox label="Uses the Do-Not-Disturb-safe route" checked={cap.c.route === 'dnd'} onChange={e => setCap(x => ({ ...x, c: { ...x.c, route: e.target.checked ? 'dnd' : null } }))} />
            <Checkbox label="Verified: route, price and sender rules checked with a real test send" checked={!!cap.c.verified} onChange={e => setCap(x => ({ ...x, c: { ...x.c, verified: e.target.checked } }))} />
          </div>
          <p className="mt-3 text-xs text-mist-500">Remember to save SMS settings after closing this.</p>
        </>}
      </Modal>
    </div>
  )
}

function SenderRequest({ r, providers, onDone }) {
  const toast = useToast()
  const [picked, setPicked] = useState(providers.map(p => p.id))
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState('')
  const decide = async (status) => { setBusy(status); try { await api.post('/platform/comms/sms/sender', { id: r.id, status, providers: picked, note }); toast(status === 'approved' ? 'Approved' : 'Rejected'); onDone() } catch (e) { toast(e.message, 'error') } finally { setBusy('') } }
  return (
    <li className="px-5 py-4">
      <p className="text-ink"><strong>{r.value}</strong> for {r.org_name} in {countryName(r.country)}</p>
      <p className="text-sm text-mist-500">Requested {fmtDateTime(r.submitted_at)}{r.contact ? ` · contact ${r.contact}` : ''}</p>
      <div className="mt-2 flex flex-wrap gap-x-4">{providers.map(p => <Checkbox key={p.id} label={`Approved with ${p.label}`} checked={picked.includes(p.id)} onChange={e => setPicked(x => e.target.checked ? [...x, p.id] : x.filter(i => i !== p.id))} />)}</div>
      <Input label="Note to the church (optional)" value={note} onChange={e => setNote(e.target.value)} maxLength={300} />
      <div className="flex gap-2"><Button size="sm" loading={busy === 'approved'} disabled={!picked.length} onClick={() => decide('approved')}>Approve</Button><Button size="sm" variant="danger-ghost" loading={busy === 'rejected'} onClick={() => decide('rejected')}>Reject</Button></div>
    </li>
  )
}
