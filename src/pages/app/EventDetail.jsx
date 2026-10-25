import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Download, Pencil, Trash2, Camera, Check, UserPlus, Users, Undo2, MapPin, Link2 } from 'lucide-react'
import { api, download } from '../../lib/api'
import { useSession } from '../../lib/session'
import { useLoad, useDebounced, PageLoader, ErrorState, Button, Badge, SearchInput, Segmented, Modal, Input, Notice, EmptyState, useToast, useConfirm, IconButton } from '../../components/ui'
import { fmtDateTime, relative } from '../../lib/format'
import QrPanel from '../../components/QrPanel'
import { EventForm, EVENT_STATUS } from './Events'

function Scanner({ onCode, onClose }) {
  const videoRef = useRef(null)
  const cb = useRef(onCode)
  cb.current = onCode
  const [error, setError] = useState('')
  useEffect(() => {
    let stream, timer, stopped = false
    async function start() {
      if (!('BarcodeDetector' in window)) { setError("This browser can't scan codes. Type the ticket code instead."); return }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
        videoRef.current.srcObject = stream
        await videoRef.current.play()
        const detector = new window.BarcodeDetector({ formats: ['qr_code'] })
        const tick = async () => {
          if (stopped) return
          try {
            const codes = await detector.detect(videoRef.current)
            if (codes[0]?.rawValue) { cb.current(codes[0].rawValue); return }
          } catch {}
          timer = setTimeout(tick, 250)
        }
        tick()
      } catch { setError('Camera access was blocked. Allow camera access in your browser settings, or type the code.') }
    }
    start()
    return () => { stopped = true; clearTimeout(timer); stream?.getTracks().forEach(t => t.stop()) }
  }, [])
  return (
    <Modal open onClose={onClose} title="Scan a ticket" size="sm">
      {error ? <Notice tone="warning">{error}</Notice> : <video ref={videoRef} className="aspect-square w-full rounded-lg bg-ink object-cover" muted playsInline />}
      <p className="py-3 text-center text-sm text-mist-500">Hold the ticket's QR code inside the frame.</p>
    </Modal>
  )
}

function WalkIn({ open, eventId, onClose, onDone }) {
  const [f, setF] = useState({ firstName: '', lastName: '', phone: '', email: '' })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (open) { setF({ firstName: '', lastName: '', phone: '', email: '' }); setError('') } }, [open])
  async function save(e) {
    e?.preventDefault(); setBusy(true); setError('')
    try { await api.post(`/events/${eventId}/registrations`, { ...f, checkIn: true }); onDone() } catch (err) { setError(err.message) } finally { setBusy(false) }
  }
  const set = (k) => (e) => setF(x => ({ ...x, [k]: e.target.value }))
  return (
    <Modal open={open} onClose={onClose} title="Add a walk-in" description="They'll be registered and checked in." size="sm"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={save} loading={busy} disabled={!f.firstName.trim()}>Add and check in</Button></>}>
      <form onSubmit={save}>
        {error && <Notice tone="danger" className="mb-4">{error}</Notice>}
        <div className="grid gap-x-3 sm:grid-cols-2">
          <Input label="First name" value={f.firstName} onChange={set('firstName')} required />
          <Input label="Last name" value={f.lastName} onChange={set('lastName')} />
        </div>
        <Input label="Phone" type="tel" value={f.phone} onChange={set('phone')} />
        <Input label="Email" type="email" value={f.email} onChange={set('email')} />
      </form>
    </Modal>
  )
}

export default function EventDetail() {
  const { id } = useParams()
  const { can, tz, me, multiBranch } = useSession()
  const navigate = useNavigate()
  const toast = useToast()
  const confirm = useConfirm()
  const { data, error, loading, reload } = useLoad(() => api.get(`/events/${id}`), [id])
  const [search, setSearch] = useState('')
  const q = useDebounced(search, 250)
  const [filter, setFilter] = useState('')
  const regs = useLoad(() => api.get(`/events/${id}/registrations?${new URLSearchParams({ ...(q && { q }), ...(filter && { status: filter }) })}`), [id, q, filter])
  const [code, setCode] = useState('')
  const [codeBusy, setCodeBusy] = useState(false)
  const [lastResult, setLastResult] = useState(null)
  const [scanning, setScanning] = useState(false)
  const [editing, setEditing] = useState(false)
  const [walkIn, setWalkIn] = useState(false)

  if (loading && !data) return <PageLoader />
  if (error) return <ErrorState error={error.status === 404 ? { message: "This event doesn't exist, or belongs to a branch you can't access." } : error} onRetry={reload} />
  const { event: e, stats } = data
  const [tone, label] = EVENT_STATUS[e.status]
  const url = `${window.location.origin}/e/${e.public_token}`
  const refresh = () => { reload(); regs.reload() }

  async function checkIn(body) {
    setCodeBusy(true)
    try {
      const r = await api.post(`/events/${e.id}/checkin`, body)
      setLastResult({ ok: true, name: r.registration.name, already: r.already, waitlisted: r.wasWaitlisted, undo: body.undo })
      setCode(''); refresh()
    } catch (err) { setLastResult({ ok: false, message: err.message }) } finally { setCodeBusy(false) }
  }
  async function setStatus(status, msg) {
    const ok = await confirm({ title: msg.title, message: msg.body, confirmLabel: msg.label, danger: status === 'cancelled' })
    if (!ok) return
    try { await api.patch(`/events/${e.id}`, { status }); toast(`Event ${status}`); reload() } catch (err) { toast(err.message, 'error') }
  }
  async function remove() {
    const n = stats.registered + stats.waitlist
    const ok = await confirm({ title: 'Delete this event?', message: n ? `${n} registrations will be deleted. Cancelling keeps the record instead.` : 'This cannot be undone.', confirmLabel: 'Delete event', danger: true })
    if (!ok) return
    try { await api.del(`/events/${e.id}?confirm=delete`); toast('Event deleted'); navigate('/app/events') } catch (err) { toast(err.message, 'error') }
  }
  async function cancelReg(r) {
    const ok = await confirm({ title: `Cancel ${r.name}'s registration?`, message: e.capacity ? 'The next person on the waitlist will get their place.' : 'They can register again later.', confirmLabel: 'Cancel registration', danger: true })
    if (!ok) return
    try { await api.patch(`/events/${e.id}/registrations/${r.id}`, { status: 'cancelled' }); toast('Registration cancelled'); refresh() } catch (err) { toast(err.message, 'error') }
  }

  const rows = regs.data?.rows || []
  return (
    <div>
      <Link to="/app/events" className="mb-4 inline-flex items-center gap-1.5 text-sm text-mist-500 hover:text-ink"><ArrowLeft size={15} />Events</Link>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-3"><h1 className="text-[26px] font-semibold leading-tight text-ink">{e.name}</h1><Badge tone={tone}>{label}</Badge></div>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 text-sm text-mist-500">
            <span>{fmtDateTime(e.starts_at, tz)}</span>{e.location && <><span aria-hidden>·</span><span className="inline-flex items-center gap-1"><MapPin size={13} />{e.location}</span></>}
            {multiBranch && <><span aria-hidden>·</span><span>{e.branch_name || 'Whole church'}</span></>}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {can('export') && <Button variant="secondary" icon={Download} onClick={() => download(`/events/${e.id}/export`).catch(err => toast(err.message, 'error'))}>Export</Button>}
          {can('events.manage') && <Button variant="secondary" icon={Pencil} onClick={() => setEditing(true)}>Edit</Button>}
          {can('events.manage') && e.status === 'published' && <Button variant="secondary" onClick={() => setStatus('postponed', { title: 'Postpone this event?', body: 'Registration pauses and the page shows it has been postponed. You can set a new date and publish again.', label: 'Postpone' })}>Postpone</Button>}
          {can('events.manage') && !['cancelled', 'completed'].includes(e.status) && <Button variant="danger-ghost" onClick={() => setStatus('cancelled', { title: 'Cancel this event?', body: 'The registration page will show that the event is cancelled. Registrations are kept.', label: 'Cancel event' })}>Cancel event</Button>}
          {can('events.manage') && <IconButton icon={Trash2} label="Delete event" onClick={remove} className="border border-mist-200 bg-white hover:text-red-700" size={40} />}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_300px]">
        <div className="space-y-6">
          <section className="panel grid grid-cols-3 divide-x divide-mist-100">
            <div className="px-5 py-4"><div className="tabular text-3xl font-semibold text-ink">{stats.registered}{e.capacity && <span className="text-lg font-normal text-mist-400">/{e.capacity}</span>}</div><div className="text-sm text-mist-500">registered</div></div>
            <div className="px-5 py-4"><div className="tabular text-3xl font-semibold text-ink">{stats.checked_in}</div><div className="text-sm text-mist-500">checked in</div></div>
            <div className="px-5 py-4"><div className="tabular text-3xl font-semibold text-ink">{stats.waitlist}</div><div className="text-sm text-mist-500">on waitlist</div></div>
          </section>

          {can('events.checkin') && e.status !== 'cancelled' && (
            <section className="panel px-5 py-5">
              <h2 className="text-[15px] font-semibold text-ink">Door check-in</h2>
              <form className="mt-3 flex gap-2" onSubmit={ev => { ev.preventDefault(); code.trim() && checkIn({ code }) }}>
                <input value={code} onChange={ev => setCode(ev.target.value.toUpperCase())} placeholder="Ticket code" aria-label="Ticket code" autoComplete="off"
                  className="field h-11 flex-1 font-semibold uppercase tracking-[0.2em] placeholder:font-normal placeholder:normal-case placeholder:tracking-normal" maxLength={10} />
                <Button type="submit" size="lg" loading={codeBusy} disabled={!code.trim()} className="h-11">Check in</Button>
                <Button variant="secondary" size="lg" icon={Camera} className="h-11" onClick={() => setScanning(true)} aria-label="Scan ticket"><span className="hidden sm:inline">Scan</span></Button>
              </form>
              {lastResult && (
                <Notice tone={lastResult.ok ? (lastResult.already ? 'warning' : 'success') : 'danger'} className="mt-3">
                  {lastResult.ok ? (lastResult.undo ? `${lastResult.name} unmarked.` : lastResult.already ? `${lastResult.name} was already checked in.` : `${lastResult.name} checked in${lastResult.waitlisted ? ' (was on the waitlist)' : ''}.`) : lastResult.message}
                </Notice>
              )}
            </section>
          )}

          <section className="panel overflow-hidden">
            <div className="flex flex-wrap items-center gap-3 border-b border-mist-100 px-4 py-3">
              <SearchInput value={search} onChange={setSearch} placeholder="Search name, phone or code" className="w-full sm:w-64" />
              <Segmented size="sm" value={filter} onChange={setFilter} options={[{ value: '', label: 'All' }, { value: 'registered', label: 'Registered' }, { value: 'checked_in', label: 'Checked in' }, { value: 'waitlist', label: 'Waitlist' }, { value: 'cancelled', label: 'Cancelled' }]} />
              {can('events.checkin') && e.status !== 'cancelled' && <Button size="sm" variant="ghost" icon={UserPlus} className="ml-auto" onClick={() => setWalkIn(true)}>Walk-in</Button>}
            </div>
            {rows.length === 0 ? (
              <EmptyState icon={Users} title={q || filter ? 'No registrations match' : 'No registrations yet'}>{!q && !filter && 'Share the registration link or QR code to start taking sign-ups.'}</EmptyState>
            ) : (
              <ul className="divide-y divide-mist-100">
                {rows.map(r => (
                  <li key={r.id} className="flex items-center gap-3 px-4 py-2.5">
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-ink">{r.name}</span>
                        {r.person_id && <Link to={`/app/people/${r.person_id}`} className="shrink-0 text-xs text-brand-700 hover:underline" title="Matched to a person by phone number">Profile</Link>}
                      </span>
                      <span className="block truncate text-xs text-mist-500"><span className="tabular font-medium tracking-wider">{r.code}</span> · {r.phone || r.email || 'no contact'} · registered {relative(r.created_at)}</span>
                    </span>
                    {r.status === 'waitlist' && <Badge tone="warning">Waitlist</Badge>}
                    {r.status === 'cancelled' && <Badge>Cancelled</Badge>}
                    {r.status !== 'cancelled' && can('events.checkin') && (r.checked_in_at
                      ? <button type="button" onClick={() => checkIn({ registrationId: r.id, undo: true })} className="group inline-flex items-center gap-1 rounded-md bg-green-50 px-2 py-1 text-xs font-medium text-green-800 hover:bg-mist-100 hover:text-mist-600" title="Undo check-in">
                          <Check size={13} className="group-hover:hidden" /><Undo2 size={13} className="hidden group-hover:block" />Checked in</button>
                      : <Button size="sm" variant="subtle" onClick={() => checkIn({ registrationId: r.id })}>Check in</Button>)}
                    {r.status !== 'cancelled' && can('events.manage') && !r.checked_in_at && <button type="button" onClick={() => cancelReg(r)} className="text-xs text-mist-400 hover:text-red-700">Cancel</button>}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
        <aside className="space-y-6">
          <QrPanel url={url} title={e.name} subtitle={fmtDateTime(e.starts_at, tz)} orgName={me.org.name} cta="Scan to register"
            disabledReason={['cancelled', 'postponed', 'completed', 'draft'].includes(e.status) ? 'Registration is closed for this event.' : null} />
          {e.description && <section className="panel px-5 py-5"><h2 className="text-[15px] font-semibold text-ink">About</h2><p className="mt-2 whitespace-pre-line text-sm text-mist-600">{e.description}</p></section>}
        </aside>
      </div>
      {scanning && <Scanner onClose={() => setScanning(false)} onCode={(c) => { setScanning(false); checkIn({ code: c }) }} />}
      <EventForm open={editing} event={e} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); toast('Event updated'); reload() }} />
      <WalkIn open={walkIn} eventId={e.id} onClose={() => setWalkIn(false)} onDone={() => { setWalkIn(false); toast('Walk-in added and checked in'); refresh() }} />
    </div>
  )
}
