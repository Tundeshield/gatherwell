import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Pencil, HeartHandshake, Trash2, Phone, Mail, Building2, Users, CalendarCheck } from 'lucide-react'
import { api } from '../../lib/api'
import { useSession } from '../../lib/session'
import { useLoad, PageLoader, ErrorState, Button, Badge, PERSON_TONE, Avatar, Modal, useToast, useConfirm, EmptyState } from '../../components/ui'
import { fmtDate, fmtDay, relative, personName, STATUS_LABELS, REASON_LABELS } from '../../lib/format'
import PersonForm from '../../components/PersonForm'
import NewFollowup from '../../components/NewFollowup'

export default function PersonDetail() {
  const { id } = useParams()
  const { can, tz, multiBranch } = useSession()
  const navigate = useNavigate()
  const toast = useToast()
  const confirm = useConfirm()
  const { data, error, loading, reload } = useLoad(() => api.get(`/people/${id}`), [id])
  const [editing, setEditing] = useState(false)
  const [followup, setFollowup] = useState(false)

  if (loading && !data) return <PageLoader />
  if (error) return <ErrorState error={error.status === 404 ? { message: "This person doesn't exist, or isn't in a branch you can access." } : error} onRetry={error.status === 404 ? null : reload} />
  const { person: p, attendance, followups, registrations } = data

  async function remove() {
    const ok = await confirm({ title: `Delete ${personName(p)}?`, message: 'Their profile, attendance history and follow-ups will be permanently removed. To keep their history, change their status to Archived instead.', confirmLabel: 'Delete permanently', danger: true })
    if (!ok) return
    try { await api.del(`/people/${p.id}`); toast(`${personName(p)} deleted`); navigate('/app/people') }
    catch (e) { toast(e.message, 'error') }
  }

  const Info = ({ icon: Icon, children }) => <li className="flex items-start gap-3 text-sm"><Icon size={16} className="mt-0.5 shrink-0 text-mist-400" /><span className="min-w-0 break-words text-ink">{children}</span></li>

  return (
    <div>
      <Link to="/app/people" className="mb-4 inline-flex items-center gap-1.5 text-sm text-mist-500 hover:text-ink"><ArrowLeft size={15} />People</Link>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-4">
          <Avatar person={p} size={56} />
          <div>
            <h1 className="text-[26px] font-semibold leading-tight text-ink">{personName(p)}</h1>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-mist-500">
              <Badge tone={PERSON_TONE[p.status]}>{STATUS_LABELS[p.status]}</Badge>
              {p.unit_name && <span>{p.unit_name}</span>}
              {p.owner_name && <span>Cared for by {p.owner_name}</span>}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {can('followups.manage') && <Button variant="secondary" icon={HeartHandshake} onClick={() => setFollowup(true)}>Follow up</Button>}
          {can('people.edit') && <Button variant="secondary" icon={Pencil} onClick={() => setEditing(true)}>Edit</Button>}
          {can('people.delete') && <Button variant="danger-ghost" icon={Trash2} onClick={remove} aria-label="Delete">Delete</Button>}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
        <div className="space-y-6">
          <section className="panel px-5 py-5">
            <ul className="space-y-3">
              <Info icon={Phone}>{p.phone ? <a href={`tel:${p.phone}`} className="link">{p.phone}</a> : <span className="text-mist-400">No phone</span>}</Info>
              <Info icon={Mail}>{p.email ? <a href={`mailto:${p.email}`} className="link">{p.email}</a> : <span className="text-mist-400">No email</span>}</Info>
              {multiBranch && <Info icon={Building2}>{p.branch_name || 'No branch'}</Info>}
            </ul>
            <dl className="mt-5 grid grid-cols-2 gap-4 border-t border-mist-100 pt-5 text-sm">
              <div><dt className="text-xs text-mist-500">Visits</dt><dd className="tabular mt-0.5 text-lg font-semibold text-ink">{p.visit_count}</dd></div>
              <div><dt className="text-xs text-mist-500">Last attended</dt><dd className="mt-0.5 text-ink">{p.last_seen_at ? relative(p.last_seen_at) : 'Never'}</dd></div>
              <div><dt className="text-xs text-mist-500">First visit</dt><dd className="mt-0.5 text-ink">{fmtDate(p.first_visit_at, tz)}</dd></div>
              <div><dt className="text-xs text-mist-500">Date joined</dt><dd className="mt-0.5 text-ink">{p.joined_at ? fmtDate(p.joined_at, 'UTC') : '—'}</dd></div>
              {p.birthday && <div><dt className="text-xs text-mist-500">Birthday</dt><dd className="mt-0.5 text-ink">{new Date(p.birthday).toLocaleDateString(undefined, { day: 'numeric', month: 'long', timeZone: 'UTC' })}</dd></div>}
              {p.gender && <div><dt className="text-xs text-mist-500">Gender</dt><dd className="mt-0.5 capitalize text-ink">{p.gender}</dd></div>}
            </dl>
            {p.notes && <div className="mt-5 border-t border-mist-100 pt-4"><div className="text-xs text-mist-500">Notes</div><p className="mt-1 whitespace-pre-line text-sm text-ink">{p.notes}</p></div>}
            <p className="mt-5 text-xs text-mist-400">Added {fmtDate(p.created_at, tz)}{p.source === 'checkin' ? ' at QR check-in' : p.source === 'import' ? ' by import' : ''}</p>
          </section>

          {can('followups.view') && (
            <section className="panel overflow-hidden">
              <h2 className="border-b border-mist-100 px-5 py-4 text-[15px] font-semibold text-ink">Follow-ups</h2>
              {followups.length === 0 ? <p className="px-5 py-5 text-sm text-mist-500">No follow-ups yet.</p> : (
                <ul className="divide-y divide-mist-100">
                  {followups.map(f => (
                    <li key={f.id}>
                      <Link to={`/app/follow-ups?open=${f.id}`} className="block px-5 py-3 hover:bg-mist-50">
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-sm font-medium text-ink">{f.title || REASON_LABELS[f.reason]}</span>
                          <Badge tone={f.status === 'done' ? 'success' : f.status === 'cancelled' ? 'neutral' : new Date(f.due_at) < new Date() ? 'danger' : 'warning'}>
                            {f.status === 'done' ? 'Done' : f.status === 'cancelled' ? 'Cancelled' : `Due ${fmtDay(f.due_at, tz)}`}
                          </Badge>
                        </div>
                        <div className="mt-0.5 truncate text-xs text-mist-500">{f.outcome || (f.assignee_name ? `Assigned to ${f.assignee_name}` : 'Unassigned')}</div>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </div>

        <div className="space-y-6">
          <section className="panel overflow-hidden">
            <h2 className="border-b border-mist-100 px-5 py-4 text-[15px] font-semibold text-ink">Attendance</h2>
            {attendance.length === 0 ? <EmptyState icon={CalendarCheck} title="No attendance yet">Their check-ins will show here.</EmptyState> : (
              <ul className="divide-y divide-mist-100">
                {attendance.map(a => (
                  <li key={a.id}>
                    <Link to={`/app/attendance/${a.gathering_id}`} className="flex items-center gap-3 px-5 py-3 hover:bg-mist-50">
                      <span className="w-28 shrink-0 text-sm text-mist-500">{fmtDay(a.starts_at, tz)}</span>
                      <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{a.name}</span>
                      {multiBranch && <span className="hidden truncate text-xs text-mist-500 sm:block">{a.branch_name}</span>}
                      {a.first_time && <Badge tone="gold">First visit</Badge>}
                      {a.method === 'manual' && <Badge>Added by usher</Badge>}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {registrations.length > 0 && (
            <section className="panel overflow-hidden">
              <h2 className="border-b border-mist-100 px-5 py-4 text-[15px] font-semibold text-ink">Events</h2>
              <ul className="divide-y divide-mist-100">
                {registrations.map(r => (
                  <li key={r.id}>
                    <Link to={`/app/events/${r.event_id}`} className="flex items-center gap-3 px-5 py-3 hover:bg-mist-50">
                      <span className="w-28 shrink-0 text-sm text-mist-500">{fmtDay(r.starts_at, tz)}</span>
                      <span className="flex-1 truncate text-sm font-medium text-ink">{r.name}</span>
                      <Badge tone={r.checked_in_at ? 'success' : r.status === 'cancelled' ? 'neutral' : 'brand'}>{r.checked_in_at ? 'Attended' : r.status === 'waitlist' ? 'Waitlist' : r.status === 'cancelled' ? 'Cancelled' : 'Registered'}</Badge>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>

      <Modal open={editing} onClose={() => setEditing(false)} title={`Edit ${personName(p)}`} size="lg">
        <PersonForm person={p} onCancel={() => setEditing(false)} onSaved={() => { setEditing(false); toast('Changes saved'); reload() }} />
      </Modal>
      <NewFollowup open={followup} person={p} onClose={() => setFollowup(false)} onCreated={() => { setFollowup(false); toast('Follow-up created'); reload() }} />
    </div>
  )
}
