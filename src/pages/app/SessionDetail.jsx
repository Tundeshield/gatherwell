import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Download, Pencil, Trash2, Archive, UserPlus, Search, Check, X, Users, ArrowUpRight, ArrowDownRight } from 'lucide-react'
import { api, download } from '../../lib/api'
import { useSession } from '../../lib/session'
import { useLoad, useDebounced, PageLoader, ErrorState, Button, Badge, SESSION_TONE, PERSON_TONE, Avatar, SearchInput, Modal, Input, Select, Notice, EmptyState, useToast, useConfirm, IconButton } from '../../components/ui'
import { fmtDateTime, fmtTime, relative, personName, KIND_LABELS, STATUS_LABELS, toLocalInput, fromLocalInput, pctChange } from '../../lib/format'
import QrPanel from '../../components/QrPanel'
import FormBuilder from '../../components/FormBuilder'

function ManualCheckin({ gatheringId, onDone }) {
  const toast = useToast()
  const [term, setTerm] = useState('')
  const q = useDebounced(term, 250)
  const [results, setResults] = useState([])
  const [busy, setBusy] = useState(null)
  const [adding, setAdding] = useState(false)
  const [nf, setNf] = useState({ firstName: '', lastName: '', phone: '' })
  const [error, setError] = useState('')

  useEffect(() => {
    if (q.trim().length < 2) { setResults([]); return }
    api.get(`/gatherings/${gatheringId}/lookup?q=${encodeURIComponent(q)}`).then(r => setResults(r.rows)).catch(() => setResults([]))
  }, [q, gatheringId])

  async function checkIn(body, label) {
    setBusy(label); setError('')
    try {
      const r = await api.post(`/gatherings/${gatheringId}/checkins`, body)
      toast(`${label} checked in${r.firstTime ? ' — first visit' : ''}`)
      setTerm(''); setResults([]); setAdding(false); setNf({ firstName: '', lastName: '', phone: '' })
      onDone()
    } catch (e) { setError(e.message) } finally { setBusy(null) }
  }

  return (
    <div className="border-b border-mist-100 p-4">
      <div className="flex gap-2">
        <SearchInput value={term} onChange={setTerm} placeholder="Check someone in — search name or phone" className="flex-1" />
        <Button variant="secondary" icon={UserPlus} onClick={() => { setAdding(a => !a); setNf(x => ({ ...x, firstName: /\d/.test(term) ? '' : term, phone: /\d/.test(term) ? term : '' })) }}>New</Button>
      </div>
      {error && <Notice tone="danger" className="mt-3">{error}</Notice>}
      {results.length > 0 && !adding && (
        <ul className="mt-2 divide-y divide-mist-100 rounded-lg border border-mist-200">
          {results.map(p => (
            <li key={p.id} className="flex items-center gap-3 px-3 py-2">
              <Avatar person={p} size={28} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-ink">{personName(p)}</span>
                <span className="block truncate text-xs text-mist-500">{[p.phone, p.branch_name].filter(Boolean).join(' · ')}</span>
              </span>
              {p.checked_in ? <Badge tone="success"><Check size={12} />Checked in</Badge> :
                <Button size="sm" loading={busy === personName(p)} onClick={() => checkIn({ personId: p.id }, personName(p))}>Check in</Button>}
            </li>
          ))}
        </ul>
      )}
      {q.trim().length >= 2 && results.length === 0 && !adding && <p className="mt-2 text-sm text-mist-500">No one found. <button className="link" onClick={() => setAdding(true)}>Add them as a new person</button></p>}
      {adding && (
        <form className="mt-3 rounded-lg border border-mist-200 p-3" onSubmit={e => { e.preventDefault(); checkIn(nf, nf.firstName) }}>
          <div className="grid gap-x-3 sm:grid-cols-3">
            <Input label="First name" value={nf.firstName} onChange={e => setNf(x => ({ ...x, firstName: e.target.value }))} required className="mb-3" />
            <Input label="Last name" value={nf.lastName} onChange={e => setNf(x => ({ ...x, lastName: e.target.value }))} className="mb-3" />
            <Input label="Phone" type="tel" value={nf.phone} onChange={e => setNf(x => ({ ...x, phone: e.target.value }))} className="mb-3" />
          </div>
          <div className="flex justify-end gap-2"><Button size="sm" variant="ghost" onClick={() => setAdding(false)}>Cancel</Button><Button size="sm" type="submit" loading={busy === nf.firstName} disabled={!nf.firstName.trim()}>Add and check in</Button></div>
        </form>
      )}
    </div>
  )
}

function EditSession({ open, g, onClose, onSaved }) {
  const [f, setF] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (open) { setF({ name: g.name, kind: g.kind, startsAt: toLocalInput(g.starts_at), endsAt: toLocalInput(g.ends_at), description: g.description || '', form: g.form }); setError('') } }, [open, g])
  if (!f) return null
  const set = (k) => (e) => setF(x => ({ ...x, [k]: e.target.value }))
  async function save() {
    setBusy(true); setError('')
    try { await api.patch(`/gatherings/${g.id}`, { ...f, startsAt: fromLocalInput(f.startsAt), endsAt: f.endsAt ? fromLocalInput(f.endsAt) : null }); onSaved() }
    catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  return (
    <Modal open={open} onClose={onClose} title="Edit session" size="lg" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={save} loading={busy}>Save changes</Button></>}>
      {error && <Notice tone="danger" className="mb-4">{error}</Notice>}
      <div className="grid gap-x-4 sm:grid-cols-2">
        <Input label="Name" value={f.name} onChange={set('name')} className="sm:col-span-2" />
        <Select label="Type" value={f.kind} onChange={set('kind')} className="sm:col-span-2">{Object.entries(KIND_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
        <Input label="Starts" type="datetime-local" value={f.startsAt} onChange={set('startsAt')} />
        <Input label="Ends" type="datetime-local" value={f.endsAt} onChange={set('endsAt')} />
      </div>
      <div className="mb-2 text-sm font-medium text-ink">Check-in form</div>
      <FormBuilder value={f.form} onChange={(form) => setF(x => ({ ...x, form }))} />
    </Modal>
  )
}

export default function SessionDetail() {
  const { id } = useParams()
  const { can, tz, me, multiBranch } = useSession()
  const navigate = useNavigate()
  const toast = useToast()
  const confirm = useConfirm()
  const { data, error, loading, reload } = useLoad(() => api.get(`/gatherings/${id}`), [id])
  const [search, setSearch] = useState('')
  const q = useDebounced(search, 250)
  const attendees = useLoad(() => api.get(`/gatherings/${id}/attendees${q ? `?q=${encodeURIComponent(q)}` : ''}`), [id, q])
  const [editing, setEditing] = useState(false)
  const [statusBusy, setStatusBusy] = useState(false)

  const isOpen = data?.gathering.status === 'open'
  useEffect(() => {
    if (!isOpen) return
    const t = setInterval(() => { attendees.reload(); reload() }, 15000)
    return () => clearInterval(t)
  }, [isOpen]) // eslint-disable-line

  if (loading && !data) return <PageLoader />
  if (error) return <ErrorState error={error.status === 404 ? { message: "This session doesn't exist, or belongs to a branch you can't access." } : error} onRetry={reload} />
  const { gathering: g, stats, previous } = data
  const url = `${window.location.origin}/c/${g.public_token}`
  const refresh = () => { reload(); attendees.reload() }

  async function setStatus(status) {
    setStatusBusy(true)
    try { await api.patch(`/gatherings/${g.id}`, { status }); toast(status === 'open' ? 'Check-in is open' : status === 'closed' ? 'Check-in closed' : 'Session archived'); reload() }
    catch (e) { toast(e.message, 'error') } finally { setStatusBusy(false) }
  }
  async function remove() {
    const ok = await confirm({ title: 'Delete this session?', message: stats.attendance ? `This removes ${stats.attendance} check-ins and updates everyone's attendance history. Archiving keeps the record instead.` : 'This session has no check-ins.', confirmLabel: 'Delete session', danger: true })
    if (!ok) return
    try { await api.del(`/gatherings/${g.id}?confirm=delete`); toast('Session deleted'); navigate('/app/attendance') } catch (e) { toast(e.message, 'error') }
  }
  async function removeCheckin(c) {
    const ok = await confirm({ title: `Remove ${personName(c)}'s check-in?`, message: 'Use this to correct a mistake. The change is recorded in the activity log.', confirmLabel: 'Remove check-in', danger: true })
    if (!ok) return
    try { await api.del(`/gatherings/${g.id}/checkins/${c.id}`); toast('Check-in removed'); refresh() } catch (e) { toast(e.message, 'error') }
  }

  const change = previous ? pctChange(stats.attendance, previous.attendance) : null
  const rows = attendees.data?.rows || []

  return (
    <div>
      <Link to="/app/attendance" className="mb-4 inline-flex items-center gap-1.5 text-sm text-mist-500 hover:text-ink"><ArrowLeft size={15} />Attendance</Link>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-[26px] font-semibold leading-tight text-ink">{g.name}</h1>
            <Badge tone={SESSION_TONE[g.status]} dot={isOpen}>{isOpen ? 'Check-in open' : { closed: 'Closed', scheduled: 'Scheduled', archived: 'Archived', draft: 'Draft' }[g.status]}</Badge>
          </div>
          <p className="mt-1 text-sm text-mist-500">{fmtDateTime(g.starts_at, tz)}{g.ends_at ? ` – ${fmtTime(g.ends_at, tz)}` : ''} · {KIND_LABELS[g.kind] || g.kind}{multiBranch ? ` · ${g.branch_name}` : ''}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {can('attendance.manage') && (isOpen
            ? <Button variant="secondary" loading={statusBusy} onClick={() => setStatus('closed')}>Close check-in</Button>
            : g.status !== 'archived' && <Button loading={statusBusy} onClick={() => setStatus('open')}>Open check-in</Button>)}
          {can('export') && <Button variant="secondary" icon={Download} onClick={() => download(`/gatherings/${g.id}/export`).catch(e => toast(e.message, 'error'))}>Export</Button>}
          {can('attendance.manage') && <IconButton icon={Pencil} label="Edit session" onClick={() => setEditing(true)} className="border border-mist-200 bg-white" size={40} />}
          {can('attendance.manage') && g.status !== 'archived' && <IconButton icon={Archive} label="Archive session" onClick={() => setStatus('archived')} className="border border-mist-200 bg-white" size={40} />}
          {can('attendance.manage') && <IconButton icon={Trash2} label="Delete session" onClick={remove} className="border border-mist-200 bg-white hover:text-red-700" size={40} />}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_300px]">
        <div className="space-y-6">
          <section className="panel grid grid-cols-3 divide-x divide-mist-100">
            <div className="px-5 py-4"><div className="tabular text-3xl font-semibold text-ink">{stats.attendance}</div><div className="text-sm text-mist-500">checked in</div></div>
            <div className="px-5 py-4"><div className="tabular text-3xl font-semibold text-ink">{stats.first_timers}</div><div className="text-sm text-mist-500">first-time</div></div>
            <div className="px-5 py-4">
              {previous ? <>
                <div className={`flex items-center gap-1 text-2xl font-semibold ${change >= 0 ? 'text-green-800' : 'text-red-700'}`}>{change >= 0 ? <ArrowUpRight size={20} /> : <ArrowDownRight size={20} />}{change === null ? '—' : `${Math.abs(change)}%`}</div>
                <div className="text-sm text-mist-500" title={`${previous.name}: ${previous.attendance}`}>vs last {KIND_LABELS[g.kind]?.toLowerCase() || 'session'} ({previous.attendance})</div>
              </> : <><div className="text-2xl font-semibold text-mist-300">—</div><div className="text-sm text-mist-500">no earlier session to compare</div></>}
            </div>
          </section>

          <section className="panel overflow-hidden">
            {can('attendance.record') && g.status !== 'archived' && <ManualCheckin gatheringId={g.id} onDone={refresh} />}
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <h2 className="text-[15px] font-semibold text-ink">Who's here <span className="tabular font-normal text-mist-500">({stats.attendance})</span></h2>
              {stats.attendance > 8 && <SearchInput value={search} onChange={setSearch} placeholder="Filter this list" className="w-full sm:w-56" />}
            </div>
            {rows.length === 0 ? (
              <EmptyState icon={Users} title={q ? 'No one matches' : 'No one has checked in yet'}>{!q && (isOpen ? 'Share the QR code — check-ins appear here automatically.' : 'Open check-in to start recording attendance.')}</EmptyState>
            ) : (
              <ul className="divide-y divide-mist-100 border-t border-mist-100">
                {rows.map(c => (
                  <li key={c.id} className="group flex items-center gap-3 px-4 py-2.5">
                    <Avatar person={{ id: c.person_id, first_name: c.first_name, last_name: c.last_name }} size={32} />
                    <Link to={can('people.view') ? `/app/people/${c.person_id}` : '#'} className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-ink">{personName(c)}</span>
                      <span className="block truncate text-xs text-mist-500">{relative(c.created_at)}{c.method === 'manual' ? ` · added by ${c.recorded_by || 'usher'}` : ''}</span>
                    </Link>
                    {c.first_time && <Badge tone="gold">First visit</Badge>}
                    <Badge tone={PERSON_TONE[c.status]} className="hidden sm:inline-flex">{STATUS_LABELS[c.status]}</Badge>
                    {can('attendance.manage') && <IconButton icon={X} label={`Remove ${personName(c)}`} size={28} onClick={() => removeCheckin(c)} className="opacity-0 focus:opacity-100 group-hover:opacity-100" />}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <aside className="space-y-6">
          <QrPanel url={url} title={g.name} subtitle={fmtDateTime(g.starts_at, tz)} orgName={me.org.name}
            disabledReason={isOpen ? null : g.status === 'scheduled' ? 'Check-in opens when you choose "Open check-in".' : 'Check-in is closed — scanning shows a closed message.'} />
        </aside>
      </div>
      <EditSession open={editing} g={g} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); toast('Session updated'); reload() }} />
    </div>
  )
}
