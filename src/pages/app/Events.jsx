import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Plus, CalendarDays, MapPin } from 'lucide-react'
import { api, qs } from '../../lib/api'
import { useSession, useBranchParam } from '../../lib/session'
import { useLoad, PageHeader, Button, Badge, Segmented, EmptyState, ErrorState, Skeleton, Modal, Input, Select, Textarea, Notice, useToast } from '../../components/ui'
import { fmtDateTime, toLocalInput, fromLocalInput } from '../../lib/format'
import FormBuilder, { DEFAULT_FORM } from '../../components/FormBuilder'

export const EVENT_STATUS = { draft: ['neutral', 'Draft'], published: ['success', 'Published'], postponed: ['warning', 'Postponed'], cancelled: ['danger', 'Cancelled'], completed: ['neutral', 'Completed'] }

export function EventForm({ open, event, onClose, onSaved }) {
  const { activeBranches, me } = useSession()
  const scoped = !!me.membership?.branchIds
  const branchParam = useBranchParam()
  const [f, setF] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!open) return
    setError('')
    const start = new Date(Date.now() + 14 * 86400000); start.setHours(10, 0, 0, 0)
    setF(event ? {
      name: event.name, description: event.description || '', location: event.location || '', branchId: event.branch_id || '',
      startsAt: toLocalInput(event.starts_at), endsAt: toLocalInput(event.ends_at), registrationOpensAt: toLocalInput(event.registration_opens_at),
      registrationClosesAt: toLocalInput(event.registration_closes_at), capacity: event.capacity || '', status: event.status, form: event.form,
    } : { name: '', description: '', location: '', branchId: scoped ? (branchParam || activeBranches[0]?.id) : (branchParam || ''), startsAt: toLocalInput(start), endsAt: '', registrationOpensAt: '', registrationClosesAt: '', capacity: '', status: 'published', form: DEFAULT_FORM })
  }, [open, event]) // eslint-disable-line
  if (!f) return null
  const set = (k) => (e) => setF(x => ({ ...x, [k]: e.target.value }))

  async function save(e) {
    e?.preventDefault()
    setBusy(true); setError('')
    const body = { ...f, branchId: f.branchId || null, capacity: f.capacity === '' ? null : Number(f.capacity), startsAt: fromLocalInput(f.startsAt), endsAt: fromLocalInput(f.endsAt),
      registrationOpensAt: fromLocalInput(f.registrationOpensAt), registrationClosesAt: fromLocalInput(f.registrationClosesAt) }
    try { const saved = event ? await api.patch(`/events/${event.id}`, body) : await api.post('/events', body); onSaved(saved) }
    catch (err) { setError(err.message) } finally { setBusy(false) }
  }

  return (
    <Modal open={open} onClose={onClose} title={event ? 'Edit event' : 'New event'} size="lg"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={save} loading={busy}>{event ? 'Save changes' : 'Create event'}</Button></>}>
      <form onSubmit={save}>
        {error && <Notice tone="danger" className="mb-4">{error}</Notice>}
        <Input label="Event name" value={f.name} onChange={set('name')} required placeholder="e.g. Youth Camp 2026" />
        <Textarea label="Description" value={f.description} onChange={set('description')} rows={3} hint="Shown on the registration page." />
        <div className="grid gap-x-4 sm:grid-cols-2">
          <Input label="Location" value={f.location} onChange={set('location')} />
          <Select label="Who it's for" value={f.branchId} onChange={set('branchId')}>
            {!scoped && <option value="">Whole church (all branches)</option>}
            {activeBranches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
          </Select>
          <Input label="Starts" type="datetime-local" value={f.startsAt} onChange={set('startsAt')} required />
          <Input label="Ends" type="datetime-local" value={f.endsAt} onChange={set('endsAt')} />
          <Input label="Registration opens" type="datetime-local" value={f.registrationOpensAt} onChange={set('registrationOpensAt')} hint="Leave empty to open now." />
          <Input label="Registration closes" type="datetime-local" value={f.registrationClosesAt} onChange={set('registrationClosesAt')} hint="Leave empty to close when the event starts." />
          <Input label="Capacity" type="number" min="1" value={f.capacity} onChange={set('capacity')} hint="Extra sign-ups join a waitlist. Leave empty for no limit." />
          <Select label="Status" value={f.status} onChange={set('status')}>
            {Object.entries(EVENT_STATUS).map(([k, [, l]]) => <option key={k} value={k}>{l}</option>)}
          </Select>
        </div>
        <div className="mb-2 text-sm font-medium text-ink">Registration form</div>
        <FormBuilder value={f.form} onChange={(form) => setF(x => ({ ...x, form }))} />
      </form>
    </Modal>
  )
}

export default function Events() {
  const { can, tz, multiBranch } = useSession()
  const branch = useBranchParam()
  const navigate = useNavigate()
  const toast = useToast()
  const [when, setWhen] = useState('upcoming')
  const [creating, setCreating] = useState(false)
  const { data, error, loading, reload } = useLoad(() => api.get(`/events${qs({ branch, when })}`), [branch, when])

  return (
    <div>
      <PageHeader title="Events" description="Conferences, camps, classes and anything people register for."
        actions={can('events.manage') && <Button icon={Plus} onClick={() => setCreating(true)}>New event</Button>} />
      <div className="mb-4"><Segmented value={when} onChange={setWhen} options={[{ value: 'upcoming', label: 'Upcoming' }, { value: 'past', label: 'Past' }, { value: '', label: 'All' }]} /></div>
      {error ? <div className="panel"><ErrorState error={error} onRetry={reload} /></div> : loading && !data ? (
        <div className="grid gap-4 sm:grid-cols-2">{[0, 1].map(i => <Skeleton key={i} className="h-36" />)}</div>
      ) : data.rows.length === 0 ? (
        <div className="panel"><EmptyState icon={CalendarDays} title={when === 'past' ? 'No past events' : 'No upcoming events'}
          action={can('events.manage') && when !== 'past' && <Button icon={Plus} onClick={() => setCreating(true)}>Create an event</Button>}>
          {when !== 'past' && 'Each event gets a registration link, tickets with QR codes and a door check-in list.'}
        </EmptyState></div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {data.rows.map(e => {
            const [tone, label] = EVENT_STATUS[e.status]
            const pct = e.capacity ? Math.min(100, (e.registered / e.capacity) * 100) : null
            return (
              <Link key={e.id} to={`/app/events/${e.id}`} className="panel group block px-5 py-5 transition-colors hover:border-brand-300">
                <div className="flex items-start justify-between gap-3">
                  <h2 className="text-[16px] font-semibold text-ink group-hover:text-brand-700">{e.name}</h2>
                  {e.status !== 'published' && <Badge tone={tone}>{label}</Badge>}
                </div>
                <p className="mt-1 text-sm text-mist-600">{fmtDateTime(e.starts_at, tz)}</p>
                <p className="mt-0.5 flex items-center gap-1 truncate text-sm text-mist-500">{e.location && <><MapPin size={13} />{e.location}</>}{multiBranch && <span className="ml-auto shrink-0 text-xs">{e.branch_name || 'Whole church'}</span>}</p>
                <div className="mt-4">
                  <div className="flex justify-between text-sm"><span className="text-mist-500">Registered</span><span className="tabular font-medium text-ink">{e.registered}{e.capacity ? ` / ${e.capacity}` : ''}</span></div>
                  {pct !== null && <div className="mt-1.5 h-1.5 rounded-full bg-mist-100"><div className="h-1.5 rounded-full bg-brand-600" style={{ width: `${pct}%` }} /></div>}
                  {e.checked_in > 0 && <div className="mt-1.5 text-xs text-mist-500">{e.checked_in} checked in</div>}
                </div>
              </Link>
            )
          })}
        </div>
      )}
      <EventForm open={creating} onClose={() => setCreating(false)} onSaved={(e) => { setCreating(false); toast('Event created'); navigate(`/app/events/${e.id}`) }} />
    </div>
  )
}
