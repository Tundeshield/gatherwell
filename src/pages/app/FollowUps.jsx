import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { HeartHandshake, Phone, MessageCircle, Users, CheckCircle2, PhoneOff, Home, StickyNote, Send } from 'lucide-react'
import { api, qs } from '../../lib/api'
import { useSession, useBranchParam } from '../../lib/session'
import { useLoad, PageHeader, Button, Badge, Segmented, EmptyState, ErrorState, Skeleton, Drawer, Modal, Input, Select, Textarea, Notice, useToast, Avatar, Checkbox } from '../../components/ui'
import { fmtDay, fmtDateTime, relative, personName, REASON_LABELS, toLocalInput, fromLocalInput } from '../../lib/format'
import { useTeam } from '../../components/NewFollowup'

const NOTE_KINDS = [
  { kind: 'call', label: 'Called', icon: Phone },
  { kind: 'no_answer', label: 'No answer', icon: PhoneOff },
  { kind: 'message', label: 'Messaged', icon: MessageCircle },
  { kind: 'visit', label: 'Visited', icon: Home },
  { kind: 'note', label: 'Note', icon: StickyNote },
]
const NOTE_LABEL = Object.fromEntries(NOTE_KINDS.map(n => [n.kind, n.label]))

function dueTone(f) {
  if (['done', 'cancelled'].includes(f.status)) return 'neutral'
  const due = new Date(f.due_at)
  if (due < new Date(new Date().setHours(0, 0, 0, 0))) return 'danger'
  if (due < new Date(new Date().setHours(24, 0, 0, 0))) return 'warning'
  return 'neutral'
}

function FollowupDrawer({ id, onClose, onChanged }) {
  const { can, tz, me } = useSession()
  const toast = useToast()
  const team = useTeam()
  const { data, error, loading, reload } = useLoad(() => (id ? api.get(`/followups/${id}`) : Promise.resolve(null)), [id])
  const [kind, setKind] = useState('call')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState('')
  const [closing, setClosing] = useState(false)
  const [outcome, setOutcome] = useState('')
  useEffect(() => { setText(''); setKind('call'); setClosing(false); setOutcome('') }, [id])

  if (!id) return null
  const f = data?.followup
  const p = data?.person
  const open = f && ['pending', 'in_progress'].includes(f.status)
  const digits = (p?.phone || '').replace(/\D/g, '')
  const intl = digits.startsWith('0') ? (me.org.settings?.defaultCountryCode || '234') + digits.slice(1) : digits

  async function act(label, fn, msg) {
    setBusy(label)
    try { await fn(); if (msg) toast(msg); await reload(); onChanged() } catch (e) { toast(e.message, 'error') } finally { setBusy('') }
  }
  const patch = (body, msg) => act('patch', () => api.patch(`/followups/${id}`, body), msg)

  return (
    <Drawer open={!!id} onClose={onClose} title={f ? (f.title || REASON_LABELS[f.reason]) : 'Follow-up'}>
      {error ? <ErrorState error={error} /> : !f ? <Skeleton className="h-40" /> : (
        <div className="space-y-6">
          <div className="flex items-center gap-3">
            <Avatar person={p} size={44} />
            <div className="min-w-0 flex-1">
              <Link to={`/app/people/${p.id}`} className="block truncate text-[16px] font-semibold text-ink hover:text-brand-700">{personName(p)}</Link>
              <div className="text-sm text-mist-500">{p.visit_count} visit{p.visit_count === 1 ? '' : 's'} · last seen {relative(p.last_seen_at)}</div>
            </div>
          </div>
          {p.phone && (
            <div className="flex gap-2">
              <a href={`tel:${p.phone}`} className="inline-flex h-10 flex-1 items-center justify-center gap-2 rounded-lg border border-mist-200 text-sm font-medium text-ink hover:bg-mist-50"><Phone size={16} />Call</a>
              <a href={`https://wa.me/${intl}`} target="_blank" rel="noreferrer" className="inline-flex h-10 flex-1 items-center justify-center gap-2 rounded-lg border border-mist-200 text-sm font-medium text-ink hover:bg-mist-50"><MessageCircle size={16} />WhatsApp</a>
              <a href={`sms:${p.phone}`} className="inline-flex h-10 flex-1 items-center justify-center gap-2 rounded-lg border border-mist-200 text-sm font-medium text-ink hover:bg-mist-50"><Send size={16} />Text</a>
            </div>
          )}

          <dl className="grid grid-cols-2 gap-4 rounded-lg bg-mist-50 px-4 py-3 text-sm">
            <div><dt className="text-xs text-mist-500">Why</dt><dd className="text-ink">{REASON_LABELS[f.reason]}</dd></div>
            <div><dt className="text-xs text-mist-500">Status</dt><dd className="text-ink">{{ pending: 'Not started', in_progress: 'In progress', done: 'Done', cancelled: 'Cancelled' }[f.status]}</dd></div>
            <div><dt className="text-xs text-mist-500">Due</dt><dd className={dueTone(f) === 'danger' ? 'font-medium text-red-700' : 'text-ink'}>{fmtDateTime(f.due_at, tz)}</dd></div>
            <div><dt className="text-xs text-mist-500">Assigned to</dt><dd className="text-ink">{f.assignee_name || 'No one'}</dd></div>
            {f.outcome && <div className="col-span-2"><dt className="text-xs text-mist-500">Outcome</dt><dd className="text-ink">{f.outcome}</dd></div>}
          </dl>

          {can('followups.manage') && open && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Select label="Assign to" className="mb-0" value={f.assignee_user_id || ''} onChange={e => patch({ assigneeUserId: e.target.value || null }, 'Reassigned')}>
                <option value="">No one</option>
                {(team.data || []).map(m => <option key={m.user_id} value={m.user_id}>{m.user_id === me.user.id ? `${m.name} (me)` : m.name}</option>)}
              </Select>
              <Input label="Due" type="datetime-local" className="mb-0" defaultValue={toLocalInput(f.due_at)} onBlur={e => e.target.value && fromLocalInput(e.target.value) !== new Date(f.due_at).toISOString() && patch({ dueAt: fromLocalInput(e.target.value) }, 'Rescheduled')} />
            </div>
          )}

          {can('followups.manage') && open && (
            <section>
              <h3 className="mb-2 text-sm font-medium text-ink">Log a contact attempt</h3>
              <div className="mb-2 flex flex-wrap gap-1.5">
                {NOTE_KINDS.map(n => (
                  <button key={n.kind} type="button" onClick={() => setKind(n.kind)} aria-pressed={kind === n.kind}
                    className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[13px] ${kind === n.kind ? 'border-brand-300 bg-brand-50 text-brand-700' : 'border-mist-200 text-mist-600 hover:border-mist-300'}`}>
                    <n.icon size={13} />{n.label}
                  </button>
                ))}
              </div>
              <textarea value={text} onChange={e => setText(e.target.value)} rows={2} className="field" placeholder="What happened? (optional for calls)" aria-label="Note" />
              <div className="mt-2 flex justify-end">
                <Button size="sm" loading={busy === 'note'} disabled={kind === 'note' && !text.trim()} onClick={() => act('note', () => api.post(`/followups/${id}/notes`, { kind, body: text }), 'Logged').then(() => setText(''))}>Save to history</Button>
              </div>
            </section>
          )}

          {can('followups.manage') && (open ? (
            closing ? (
              <div className="rounded-lg border border-mist-200 p-4">
                <Textarea label="Outcome" value={outcome} onChange={e => setOutcome(e.target.value)} rows={2} placeholder="e.g. Spoke with her — joining the welcome class on Sunday" />
                <div className="flex justify-end gap-2"><Button variant="ghost" size="sm" onClick={() => setClosing(false)}>Back</Button>
                  <Button size="sm" variant="secondary" loading={busy === 'patch'} onClick={() => patch({ status: 'cancelled', outcome: outcome || undefined }, 'Follow-up cancelled')}>Cancel follow-up</Button>
                  <Button size="sm" icon={CheckCircle2} loading={busy === 'patch'} onClick={() => patch({ status: 'done', outcome: outcome || undefined }, 'Marked done')}>Mark done</Button></div>
              </div>
            ) : <Button className="w-full" variant="secondary" icon={CheckCircle2} onClick={() => setClosing(true)}>Close this follow-up</Button>
          ) : <Button className="w-full" variant="secondary" onClick={() => patch({ status: 'pending' }, 'Reopened')}>Reopen</Button>)}

          <section>
            <h3 className="mb-3 text-sm font-medium text-ink">History</h3>
            <ol className="space-y-3 border-l border-mist-200 pl-4">
              {data.notes.map(n => (
                <li key={n.id} className="relative text-sm">
                  <span className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-brand-500" />
                  <div className="text-ink"><span className="font-medium">{NOTE_LABEL[n.kind]}</span>{n.body && <> — {n.body}</>}</div>
                  <div className="text-xs text-mist-500">{n.user_name || 'Someone'} · {relative(n.created_at)}</div>
                </li>
              ))}
              <li className="relative text-sm">
                <span className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-mist-300" />
                <div className="text-ink">Follow-up created</div>
                <div className="text-xs text-mist-500">{f.created_by ? '' : 'Automatically · '}{relative(f.created_at)}</div>
              </li>
            </ol>
          </section>
        </div>
      )}
    </Drawer>
  )
}

function AbsenceReview({ open, onClose, onDone }) {
  const { me, tz } = useSession()
  const branch = useBranchParam()
  const team = useTeam()
  const { data, loading, error } = useLoad(() => (open ? api.get(`/followups/absence/candidates${qs({ branch })}`) : Promise.resolve(null)), [open, branch])
  const [selected, setSelected] = useState(new Set())
  const [assignee, setAssignee] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  useEffect(() => { if (data) setSelected(new Set(data.rows.map(r => r.id))) }, [data])

  async function create() {
    setBusy(true); setErr('')
    try { const r = await api.post('/followups/absence', { personIds: [...selected], assigneeUserId: assignee || null }); onDone(r.created) }
    catch (e) { setErr(e.message) } finally { setBusy(false) }
  }
  return (
    <Modal open={open} onClose={onClose} size="lg" title="Members not seen recently"
      description={data ? `Members not checked in for ${data.weeks}+ weeks who don't already have an open check-in. People may simply be travelling or attending elsewhere — this is a prompt to care, not a judgement.` : ''}
      footer={<><Button variant="secondary" onClick={onClose}>Not now</Button><Button onClick={create} loading={busy} disabled={!selected.size}>Create {selected.size} follow-up{selected.size === 1 ? '' : 's'}</Button></>}>
      {err && <Notice tone="danger" className="mb-4">{err}</Notice>}
      {error ? <Notice tone="danger">{error.message}</Notice> : loading || !data ? <Skeleton className="h-40" /> : data.rows.length === 0 ? (
        <EmptyState icon={Users} title="No one to review">Everyone who's been away already has a follow-up, or all members have attended recently.</EmptyState>
      ) : (
        <>
          <Select label="Assign them to" value={assignee} onChange={e => setAssignee(e.target.value)}>
            <option value="">No one yet — assign later</option>
            {(team.data || []).map(m => <option key={m.user_id} value={m.user_id}>{m.user_id === me.user.id ? `${m.name} (me)` : m.name}</option>)}
          </Select>
          <div className="mb-2 flex items-center justify-between text-sm">
            <Checkbox label={`Select all (${data.rows.length})`} checked={selected.size === data.rows.length} onChange={(v) => setSelected(v ? new Set(data.rows.map(r => r.id)) : new Set())} />
          </div>
          <ul className="max-h-72 divide-y divide-mist-100 overflow-auto rounded-lg border border-mist-200">
            {data.rows.map(p => (
              <li key={p.id} className="flex items-center gap-3 px-3 py-2">
                <input type="checkbox" aria-label={`Select ${personName(p)}`} checked={selected.has(p.id)} onChange={e => setSelected(s => { const n = new Set(s); e.target.checked ? n.add(p.id) : n.delete(p.id); return n })} className="h-4 w-4 accent-brand-700" />
                <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium text-ink">{personName(p)}</span><span className="text-xs text-mist-500">{p.branch_name}</span></span>
                <span className="text-xs text-mist-500">last seen {fmtDay(p.last_seen_at, tz)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Modal>
  )
}

export default function FollowUps() {
  const { can, tz, multiBranch } = useSession()
  const branch = useBranchParam()
  const toast = useToast()
  const [params, setParams] = useSearchParams()
  const bucket = params.get('bucket') || 'today'
  const assignee = params.get('assignee') || ''
  const reason = params.get('reason') || ''
  const openId = params.get('open')
  const [review, setReview] = useState(params.get('review') === 'absence')
  const setParam = (k, v) => { const p = new URLSearchParams(params); v ? p.set(k, v) : p.delete(k); setParams(p, { replace: true }) }
  const { data, error, loading, reload } = useLoad(() => api.get(`/followups${qs({ bucket, assignee, reason, branch })}`), [bucket, assignee, reason, branch])

  const c = data?.counts
  return (
    <div>
      <PageHeader title="Follow-ups" description="Welcoming visitors and checking in on people who've been away."
        actions={can('followups.manage') && <Button variant="secondary" icon={Users} onClick={() => setReview(true)}>Review absences</Button>} />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Segmented value={bucket} onChange={(v) => setParam('bucket', v)} options={[
          { value: 'overdue', label: 'Overdue', count: c?.overdue, alert: true }, { value: 'today', label: 'Due today', count: c?.today },
          { value: 'upcoming', label: 'Upcoming', count: c?.upcoming }, { value: 'done', label: 'Done', count: c?.done_30d }]} />
        <select aria-label="Assigned to" value={assignee} onChange={e => setParam('assignee', e.target.value)} className="field h-10 w-auto">
          <option value="">Anyone</option><option value="me">Assigned to me</option><option value="unassigned">Unassigned</option>
        </select>
        <select aria-label="Reason" value={reason} onChange={e => setParam('reason', e.target.value)} className="field h-10 w-auto">
          <option value="">All reasons</option>{Object.entries(REASON_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>
      <div className="panel overflow-hidden">
        {error ? <ErrorState error={error} onRetry={reload} /> : loading && !data ? (
          <div className="space-y-3 p-4">{[0, 1, 2, 3].map(i => <Skeleton key={i} className="h-12" />)}</div>
        ) : data.rows.length === 0 ? (
          <EmptyState icon={HeartHandshake} title={{ overdue: 'Nothing overdue', today: 'Nothing due today', upcoming: 'Nothing coming up', done: 'Nothing completed in the last 30 days' }[bucket]}>
            {bucket === 'today' && c?.overdue > 0 ? <>But there {c.overdue === 1 ? 'is 1 overdue follow-up' : `are ${c.overdue} overdue follow-ups`}. <button className="link" onClick={() => setParam('bucket', 'overdue')}>See overdue</button></> :
              bucket !== 'done' && 'First-time visitors get a welcome follow-up automatically when they check in.'}
          </EmptyState>
        ) : (
          <ul className="divide-y divide-mist-100">
            {data.rows.map(f => (
              <li key={f.id}>
                <button type="button" onClick={() => setParam('open', f.id)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-mist-50/70 focus-visible:bg-mist-50 focus-visible:outline-none">
                  <Avatar person={{ id: f.person_id, first_name: f.first_name, last_name: f.last_name }} size={36} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-ink">{personName(f)}</span>
                    <span className="block truncate text-xs text-mist-500">{f.title || REASON_LABELS[f.reason]}{multiBranch && f.branch_name ? ` · ${f.branch_name}` : ''}{f.attempts ? ` · ${f.attempts} attempt${f.attempts === 1 ? '' : 's'}` : ''}</span>
                  </span>
                  <span className="hidden text-xs text-mist-500 sm:block">{f.assignee_name || <span className="text-mist-400">Unassigned</span>}</span>
                  {bucket === 'done' ? <Badge tone={f.status === 'done' ? 'success' : 'neutral'}>{f.status === 'done' ? 'Done' : 'Cancelled'}</Badge>
                    : <Badge tone={dueTone(f)}>{fmtDay(f.due_at, tz)}</Badge>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <FollowupDrawer id={openId} onClose={() => setParam('open', '')} onChanged={reload} />
      <AbsenceReview open={review} onClose={() => { setReview(false); if (params.get('review')) setParam('review', '') }}
        onDone={(n) => { setReview(false); setParam('review', ''); toast(`${n} follow-up${n === 1 ? '' : 's'} created`); reload() }} />
    </div>
  )
}
