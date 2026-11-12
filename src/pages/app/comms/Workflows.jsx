import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { ArrowLeft, Plus, ArrowUp, ArrowDown, Trash2, Pencil, Clock, Send, HelpCircle, ClipboardList, Tag as TagIcon, ArrowRightLeft, Flag, Workflow as WfIcon, Play, Pause, UserMinus, Zap, CalendarClock, FlaskConical, ChevronDown } from 'lucide-react'
import { api } from '../../../lib/api'
import { useSession } from '../../../lib/session'
import { useLoad, Button, Input, Select, Textarea, Notice, PageLoader, ErrorState, EmptyState, Modal, Drawer, Toggle, useToast, useConfirm, Skeleton, Segmented, Checkbox } from '../../../components/ui'
import { useTags } from '../../../components/Tags'
import { AudiencePicker } from '../MessageEditor'
import { WHATSAPP_COMING_SOON, PRESETS, TRIGGERS, STEP_TYPES, CONDITIONS, OUTCOMES, WEEKDAYS, describeTrigger, describeStep, smsInfo, stepId, fmtTime } from '../../../../shared/comms.js'
import { fmtDateTime, relative } from '../../../lib/format'
import { WorkflowStatus, channelLabel, CHANNEL_ICON, BubblePreview, StagingNote, money } from './shared'
import { IS_STAGING } from '../../../components/EnvBanner'

const STEP_ICON = { wait: Clock, send: Send, check: HelpCircle, task: ClipboardList, tag: TagIcon, start_workflow: ArrowRightLeft, end: Flag }

// --- list --------------------------------------------------------------------------------------
export function WorkflowsList() {
  const [params, setParams] = useSearchParams()
  const [tab, setTab] = useState('all')
  const { data, error, loading, reload } = useLoad(() => api.get('/comms/workflows'), [])
  const rows = (data?.rows || []).filter(w => tab === 'all' || w.status === tab)
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Segmented size="sm" value={tab} onChange={setTab} options={[['all', 'All'], ['active', 'On'], ['paused', 'Paused'], ['draft', 'Drafts']].map(([value, label]) => ({ value, label }))} />
        <Button icon={Plus} onClick={() => setParams({ new: '1' })}>New workflow</Button>
      </div>
      {data?.classicJourney && <Notice className="mb-4" title="Your visit welcome emails are still on">They’re set in <Link to="/app/settings?tab=automation" className="link">Settings › Automation</Link>. If you also switch on a welcome workflow here, visitors may get two welcomes.</Notice>}
      {error ? <ErrorState error={error} onRetry={reload} /> : loading ? <Skeleton className="h-48" /> : !rows.length ? (
        <EmptyState icon={WfIcon} title={tab === 'all' ? 'No workflows yet' : 'Nothing here'} action={tab === 'all' && <Button icon={Plus} onClick={() => setParams({ new: '1' })}>Create your first workflow</Button>}>
          Workflows send messages and create follow-up tasks for you, every time something happens.
        </EmptyState>
      ) : (
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {rows.map(w => (
            <li key={w.id}>
              <Link to={`/app/communications/workflows/${w.id}`} className="block h-full rounded-2xl border border-mist-200 bg-white p-5 hover:border-brand-300">
                <div className="flex items-start justify-between gap-3"><h3 className="text-[16px] font-semibold text-ink">{w.name}</h3><WorkflowStatus status={w.status} /></div>
                <p className="mt-1.5 text-sm text-mist-600">{describeTrigger(w.trigger)}: {w.summary}.</p>
                <p className="mt-3 text-sm text-mist-500">{w.trigger.type === 'schedule' ? (w.next_run_at && w.status === 'active' ? `Next: ${fmtDateTime(w.next_run_at)}` : `${w.runs} sent so far`) : `${w.active_count} in it now · ${w.enrolled_count} so far`}</p>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <NewWorkflow open={!!params.get('new')} onClose={() => setParams({})} />
    </div>
  )
}

function NewWorkflow({ open, onClose }) {
  const navigate = useNavigate()
  const toast = useToast()
  const ch = useLoad(() => (open ? api.get('/comms/overview') : Promise.resolve(null)), [open])
  const [busy, setBusy] = useState('')
  const preferred = ch.data?.channels?.sms?.ready ? 'sms' : 'email'
  async function create(preset) {
    setBusy(preset)
    try { const w = await api.post('/comms/workflows', { preset, channel: preferred }); navigate(`/app/communications/workflows/${w.id}`) } catch (e) { toast(e.message, 'error') } finally { setBusy('') }
  }
  return (
    <Modal open={open} onClose={onClose} title="What would you like GatherHQ to do automatically?" description="Pick a starting point. You can change every step before switching it on." size="lg">
      <ul className="grid grid-cols-1 gap-2 pb-2 sm:grid-cols-2">
        {PRESETS.map(([key, title, body]) => (
          <li key={key}>
            <button type="button" onClick={() => create(key)} disabled={!!busy} className="h-full w-full rounded-xl border border-mist-200 bg-white p-4 text-left hover:border-brand-300 hover:bg-brand-50/40 disabled:opacity-60">
              <span className="block text-[15px] font-semibold text-ink">{busy === key ? 'Setting up…' : title}</span>
              <span className="mt-1 block text-sm text-mist-500">{body}</span>
            </button>
          </li>
        ))}
      </ul>
    </Modal>
  )
}

// --- builder -----------------------------------------------------------------------------------
export function WorkflowBuilder() {
  const { id } = useParams()
  const { tz } = useSession()
  const toast = useToast()
  const confirm = useConfirm()
  const navigate = useNavigate()
  const { data, error, loading, reload } = useLoad(() => api.get(`/comms/workflows/${id}`), [id])
  const templates = useLoad(() => api.get('/comms/templates'), [])
  const events = useLoad(() => api.get('/events').catch(() => ({ rows: [] })), [])
  const others = useLoad(() => api.get('/comms/workflows'), [])
  const assignees = useLoad(() => api.get('/team/assignees').catch(() => []), [])
  const { tags, byId } = useTags()
  const [wf, setWf] = useState(null)
  const [dirty, setDirty] = useState(false)
  const [editing, setEditing] = useState(null) // step index, or 'trigger'
  const [adding, setAdding] = useState(null) // insert position
  const [tab, setTab] = useState('steps')
  const [busy, setBusy] = useState('')
  const [problems, setProblems] = useState([])
  const [estimate, setEstimate] = useState(null)
  useEffect(() => { if (data) { setWf(data.workflow); setProblems(data.problems); setEstimate(data.estimate); setDirty(false) } }, [data])
  if (loading || !wf) return error ? <ErrorState error={error} onRetry={reload} /> : <PageLoader />
  const names = { tag: byId.get(wf.trigger.tagId)?.name, event: (events.data?.rows || []).find(e => e.id === wf.trigger.eventId)?.name, tags: Object.fromEntries(tags.map(t => [t.id, t.name])), workflows: Object.fromEntries((others.data?.rows || []).map(w => [w.id, w.name])) }
  const update = (patch) => { setWf(w => ({ ...w, ...patch })); setDirty(true) }
  const setSteps = (steps) => update({ steps })
  const scheduled = wf.trigger.type === 'schedule'

  async function save() {
    setBusy('save')
    try { const r = await api.patch(`/comms/workflows/${id}`, { name: wf.name, trigger: wf.trigger, steps: wf.steps, pause_on_reply: wf.pause_on_reply, exit_on_return: wf.exit_on_return }); setWf(r.workflow); setProblems(r.problems); setEstimate(r.estimate); setDirty(false); toast('Saved') }
    catch (e) { toast(e.message, 'error') } finally { setBusy('') }
  }
  async function setStatus(status) {
    setBusy('status')
    try {
      if (dirty) { const r = await api.patch(`/comms/workflows/${id}`, { name: wf.name, trigger: wf.trigger, steps: wf.steps, pause_on_reply: wf.pause_on_reply, exit_on_return: wf.exit_on_return }); setProblems(r.problems); setEstimate(r.estimate); setDirty(false) }
      const r = await api.post(`/comms/workflows/${id}/status`, { status })
      setWf(r.workflow); toast(status === 'active' ? 'Switched on' : 'Paused. Nobody will get new steps until you switch it back on.')
    } catch (e) { setProblems(e.details?.problems || [e.message]); toast(e.message, 'error') } finally { setBusy('') }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <Link to="/app/communications/workflows" className="mb-3 inline-flex items-center gap-1.5 text-sm text-mist-500 hover:text-ink"><ArrowLeft size={15} />Journeys</Link>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <input value={wf.name} onChange={e => update({ name: e.target.value })} aria-label="Workflow name" maxLength={100}
            className="w-full rounded-lg border border-transparent bg-transparent px-1 py-0.5 text-[24px] font-semibold tracking-tight text-ink hover:border-mist-200 focus:border-brand-400 focus:outline-none" />
          <div className="mt-1 flex items-center gap-2 px-1"><WorkflowStatus status={wf.status} /><span className="text-sm text-mist-500">{wf.summary}</span></div>
        </div>
        <div className="flex flex-wrap gap-2">
          {dirty && <Button variant="secondary" loading={busy === 'save'} onClick={save}>Save changes</Button>}
          {wf.status === 'active' ? <Button variant="secondary" icon={Pause} loading={busy === 'status'} onClick={() => setStatus('paused')}>Pause</Button>
            : <Button icon={Play} loading={busy === 'status'} onClick={() => setStatus('active')}>{wf.status === 'paused' ? 'Resume' : 'Switch on'}</Button>}
        </div>
      </div>
      {problems.length > 0 && wf.status !== 'active' && <Notice tone="warning" className="mb-4" title="Before you switch it on"><ul className="list-disc pl-5">{problems.map(p => <li key={p}>{p}</li>)}</ul></Notice>}
      {wf.status === 'active' && <Notice tone="success" className="mb-4">It’s on. {scheduled ? (wf.next_run_at ? `Next message: ${fmtDateTime(wf.next_run_at, tz)}.` : '') : 'Changes you save apply to the steps people haven’t reached yet.'}</Notice>}

      <div className="mb-4"><Segmented size="sm" value={tab} onChange={setTab} options={[{ value: 'steps', label: 'Steps' }, ...(!scheduled ? [{ value: 'people', label: `People in it (${wf.active_count})` }] : [])]} /></div>

      {tab === 'steps' ? (
        <>
          <button type="button" onClick={() => setEditing('trigger')} className="flex w-full items-center gap-4 rounded-2xl border-2 border-brand-200 bg-brand-50 p-4 text-left hover:border-brand-300">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-700 text-white">{scheduled ? <CalendarClock size={18} /> : <Zap size={18} />}</span>
            <span className="min-w-0 flex-1"><span className="block text-xs font-semibold uppercase tracking-wide text-brand-700">Starts</span><span className="block text-[16px] font-semibold text-ink">{describeTrigger(wf.trigger, names)}</span>{scheduled && <span className="text-sm text-mist-600">To: {wf.trigger.audience?.statuses?.length ? wf.trigger.audience.statuses.join(' and ') : 'everyone'}{wf.trigger.audience?.tags?.length ? ' with selected tags' : ''}</span>}</span>
            <Pencil size={16} className="text-mist-400" />
          </button>
          <ol className="relative mt-1">
            {wf.steps.map((s, i) => { const Icon = STEP_ICON[s.type] || Flag; return (
              <li key={s.id}>
                <AddHere onClick={() => setAdding(i)} disabled={scheduled} />
                <div className="flex items-start gap-3 rounded-2xl border border-mist-200 bg-white p-4">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-mist-100 text-mist-600"><Icon size={17} /></span>
                  <button type="button" onClick={() => setEditing(i)} className="min-w-0 flex-1 text-left">
                    <span className="block text-[15px] font-semibold text-ink">{i + 1}. {describeStep(s, names)}</span>
                    <StepDetail s={s} />
                  </button>
                  <span className="flex shrink-0 gap-0.5">
                    <IconBtn label="Move up" icon={ArrowUp} disabled={i === 0} onClick={() => { const a = [...wf.steps]; [a[i - 1], a[i]] = [a[i], a[i - 1]]; setSteps(a) }} />
                    <IconBtn label="Move down" icon={ArrowDown} disabled={i === wf.steps.length - 1} onClick={() => { const a = [...wf.steps]; [a[i + 1], a[i]] = [a[i], a[i + 1]]; setSteps(a) }} />
                    <IconBtn label="Edit step" icon={Pencil} onClick={() => setEditing(i)} />
                    <IconBtn label="Remove step" icon={Trash2} onClick={() => setSteps(wf.steps.filter((_, j) => j !== i))} />
                  </span>
                </div>
              </li>
            ) })}
            <AddHere onClick={() => setAdding(wf.steps.length)} disabled={scheduled && wf.steps.length >= 1} last />
          </ol>
          <div className="mt-1 flex items-center gap-3 rounded-2xl border border-dashed border-mist-300 p-4 text-sm text-mist-500"><Flag size={16} />{scheduled ? 'Then it waits for the next time and sends again.' : 'The workflow ends for this person.'}</div>
          {wf.steps.some(x => x.type === 'send' && x.channel === 'sms') && <SmsCost estimate={estimate} dirty={dirty} />}
          {!scheduled && <div className="panel mt-5 divide-y divide-mist-100 px-5">
            <div className="py-4"><Toggle checked={wf.pause_on_reply} onChange={v => update({ pause_on_reply: v })} label="Pause and tell someone when a person replies" hint="Their follow-up waits, and a follow-up task is created so a person can respond. Replying “STOP” always opts them out." /></div>
            {['first_visit', 'second_visit', 'absent'].includes(wf.trigger.type) && <div className="py-4"><Toggle checked={!!wf.exit_on_return} onChange={v => update({ exit_on_return: v })} label="Stop when they come back" hint="If they attend again before a message is due, the rest of the journey is cancelled, so nobody is invited back after they’ve already returned." /></div>}
            <div className="py-4 text-sm text-mist-600"><p className="font-medium text-ink">If a message can’t be delivered</p><p className="mt-0.5">It’s marked as not delivered and the journey carries on. Texts that couldn’t be sent aren’t charged. If messaging credit runs out, texts wait (emails keep going) and are skipped if they’d go out more than two days late.</p></div>
          </div>}
          <div className="mt-6 flex flex-wrap justify-between gap-3">
            <Button variant="danger-ghost" icon={Trash2} onClick={async () => { if (await confirm({ title: 'Delete this workflow?', message: 'It stops for everyone in it. Messages it already sent stay in your history.', confirmLabel: 'Delete', danger: true })) { await api.del(`/comms/workflows/${id}`); toast('Deleted'); navigate('/app/communications/workflows') } }}>Delete workflow</Button>
            {dirty && <Button loading={busy === 'save'} onClick={save}>Save changes</Button>}
          </div>
        </>
      ) : <EnrolledPeople wf={wf} names={names} />}

      <StepPicker open={adding !== null} scheduled={scheduled} onClose={() => setAdding(null)} onPick={(type) => {
        const s = type === 'wait' ? { id: stepId(), type, wait: { kind: 'for', amount: 2, unit: 'days' } } : type === 'send' ? { id: stepId(), type, channel: 'email', title: 'New message', subject: '', body: 'Hi {first_name}, ', category: 'marketing' }
          : type === 'check' ? { id: stepId(), type, condition: 'attended', ifYes: 'end', ifNo: 'continue' } : type === 'task' ? { id: stepId(), type, title: 'Follow up with {first_name}', dueHours: 48 } : { id: stepId(), type }
        const a = [...wf.steps]; a.splice(adding, 0, s); setSteps(a); setEditing(adding); setAdding(null)
      }} />
      <Drawer open={editing !== null} onClose={() => setEditing(null)} title={editing === 'trigger' ? 'How does it start?' : editing !== null && wf.steps[editing] ? STEP_TYPES[wf.steps[editing].type] : ''}
        footer={<Button onClick={() => setEditing(null)}>Done</Button>}>
        {editing === 'trigger' ? <TriggerEditor trigger={wf.trigger} onChange={t => update({ trigger: t })} locked={wf.status === 'active'} tags={tags} events={events.data?.rows || []} />
          : editing !== null && wf.steps[editing] ? <StepEditor step={wf.steps[editing]} trigger={wf.trigger} onChange={s => setSteps(wf.steps.map((x, j) => (j === editing ? s : x)))} channels={data.channels} templates={templates.data} tags={tags} assignees={assignees.data || []} workflows={(others.data?.rows || []).filter(w => w.id !== wf.id)} /> : null}
      </Drawer>
    </div>
  )
}

function SmsCost({ estimate: e, dirty }) {
  if (!e) return null
  const rows = Object.entries(e.byCountry || {})
  return (
    <section className="panel mt-5 px-5 py-4" aria-label="Text message cost">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-[15px] font-semibold text-ink">Text message cost</h3>
        <span className="text-sm text-mist-500">Balance: <span className={e.balance < e.perPerson ? 'font-medium text-amber-800' : 'text-ink'}>{money(e.balance)}</span> · <Link to="/app/communications/channels" className="link">Add credit</Link></span>
      </div>
      <p className="mt-1 text-sm text-mist-600">This journey sends {e.smsSteps === 1 ? 'one text' : `${e.smsSteps} texts`} per person ({e.segments} {e.segments === 1 ? 'part' : 'parts'} in total).{e.perPerson > 0 ? <> At today’s rates that’s about <strong className="text-ink">{money(e.perPerson)}</strong> per person, so 100 people would cost about <strong className="text-ink">{money(e.per100)}</strong>.</> : ''}</p>
      {rows.length > 1 && <table className="mt-3 w-full max-w-lg text-sm"><thead><tr className="text-left text-xs text-mist-500"><th className="py-1 font-medium">Where your people are</th><th className="py-1 text-right font-medium">People</th><th className="py-1 text-right font-medium">Per person</th><th className="py-1 text-right font-medium">Per 100</th></tr></thead>
        <tbody className="divide-y divide-mist-100">{rows.map(([cc, c]) => <tr key={cc}><td className="py-1.5">{c.name}</td><td className="tabular py-1.5 text-right">{c.people}</td><td className="tabular py-1.5 text-right">{money(c.perPerson)}</td><td className="tabular py-1.5 text-right">{money(c.per100)}</td></tr>)}</tbody></table>}
      {e.blocked?.length > 0 && <ul className="mt-3 space-y-1 text-sm text-amber-800">{e.blocked.map(b => <li key={b.reason}>• {b.text}</li>)}</ul>}
      <p className="mt-2 text-xs text-mist-500">An estimate based on the people in your list now. Long texts are sent in parts and each part is charged; networks can occasionally split a text differently.{dirty ? ' Save to update.' : ''}</p>
    </section>
  )
}

const IconBtn = ({ label, icon: Icon, ...p }) => <button type="button" aria-label={label} title={label} className="rounded-md p-1.5 text-mist-400 hover:bg-mist-100 hover:text-ink disabled:opacity-30" {...p}><Icon size={15} /></button>
function AddHere({ onClick, disabled, last }) {
  if (disabled) return <div className="ml-[34px] h-5 w-px bg-mist-200" />
  return (
    <div className="flex items-center py-1.5 pl-[18px]">
      <span className="h-4 w-px bg-mist-200" />
      <button type="button" onClick={onClick} className="ml-3 inline-flex items-center gap-1 rounded-full border border-dashed border-mist-300 px-2.5 py-0.5 text-xs font-medium text-mist-500 hover:border-brand-400 hover:text-brand-700"><Plus size={12} />{last ? 'Add a step' : 'Add a step here'}</button>
    </div>
  )
}
function StepDetail({ s }) {
  if (s.type === 'send') return <span className="mt-0.5 block truncate text-sm text-mist-500">{s.channel === 'email' ? s.subject : s.body}</span>
  if (s.type === 'check') return <span className="mt-0.5 block text-sm text-mist-500">If yes: {OUTCOMES[s.ifYes]?.toLowerCase()} · If no: {OUTCOMES[s.ifNo]?.toLowerCase()}</span>
  if (s.type === 'task') return <span className="mt-0.5 block truncate text-sm text-mist-500">Due within {s.dueHours} hours{s.assigneeName ? `, for ${s.assigneeName}` : ''}</span>
  return null
}

function StepPicker({ open, onClose, onPick, scheduled }) {
  const items = scheduled ? [['send', 'Send a message', 'Email, WhatsApp or SMS.']] : [
    ['wait', 'Wait', 'For a few days, or until a day and time.'], ['send', 'Send a message', 'Email, WhatsApp or SMS.'],
    ['check', 'Check something', 'Did they come back? Did they reply?'], ['task', 'Create a follow-up task', 'Ask someone on your team to call.'],
    ['tag', 'Add a tag', 'Group them, for example “Newcomers”.'], ['start_workflow', 'Move to another workflow', 'Hand over to another journey.'], ['end', 'End', 'Stop the workflow here.'],
  ]
  return (
    <Modal open={open} onClose={onClose} title="Add a step">
      <ul className="space-y-1.5 pb-2">{items.map(([t, l, h]) => { const Icon = STEP_ICON[t]; return (
        <li key={t}><button type="button" onClick={() => onPick(t)} className="flex w-full items-center gap-3 rounded-xl border border-mist-200 px-4 py-3 text-left hover:border-brand-300 hover:bg-brand-50/40"><Icon size={18} className="text-brand-700" /><span><span className="block font-semibold text-ink">{l}</span><span className="text-sm text-mist-500">{h}</span></span></button></li>
      ) })}</ul>
    </Modal>
  )
}

function TriggerEditor({ trigger, onChange, locked, tags, events }) {
  const t = trigger
  const set = (p) => onChange({ ...t, ...p })
  const s = t.schedule || { frequency: 'weekly', weekdays: [1], time: '10:00' }
  const [picked, setPicked] = useState([])
  return (
    <div>
      {locked && <Notice className="mb-4">Pause the workflow to change how it starts.</Notice>}
      <fieldset disabled={locked}>
        <Select label="It starts when…" value={t.type} onChange={e => onChange(e.target.value === 'schedule' ? { type: 'schedule', schedule: { frequency: 'weekly', weekdays: [1], time: '10:00' }, audience: { mode: 'filters', statuses: ['member'], segment: 'all', tags: [], people: [] } } : { type: e.target.value, weeks: 3 })}>
          <optgroup label="Something happens">{Object.entries(TRIGGERS).filter(([, v]) => v.group === 'event').map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</optgroup>
          <optgroup label="On a schedule"><option value="schedule">{TRIGGERS.schedule.label}</option></optgroup>
        </Select>
        {t.type === 'absent' && <Select label="Not attended for" value={t.weeks || 3} onChange={e => set({ weeks: Number(e.target.value) })}>{[2, 3, 4, 6, 8].map(n => <option key={n} value={n}>{n} weeks</option>)}</Select>}
        {t.type === 'tag_added' && <Select label="Tag" value={t.tagId || ''} onChange={e => set({ tagId: e.target.value })}><option value="">Choose a tag</option>{tags.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>}
        {t.type === 'event_registered' && <Select label="Event" hint="Only registrations matched to someone in your people list can be messaged." value={t.eventId || ''} onChange={e => set({ eventId: e.target.value || null })}><option value="">Any event</option>{events.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>}
        {(t.type === 'first_visit' || t.type === 'second_visit') && <p className="text-sm text-mist-500">Counted from check-ins. Members’ first check-ins don’t count as a first visit.</p>}
        {t.type === 'schedule' && (
          <>
            <Select label="How often" value={s.frequency} onChange={e => set({ schedule: { ...s, frequency: e.target.value } })}><option value="weekly">Every week</option><option value="daily">Every day</option><option value="once">Once, on a date</option></Select>
            {s.frequency === 'weekly' && <div className="mb-4"><p className="label">On</p><div className="flex flex-wrap gap-1.5">{WEEKDAYS.map((d, i) => { const on = (s.weekdays || []).includes(i); return <button key={d} type="button" aria-pressed={on} onClick={() => set({ schedule: { ...s, weekdays: on ? s.weekdays.filter(x => x !== i) : [...(s.weekdays || []), i] } })} className={`rounded-full border px-3 py-1.5 text-sm ${on ? 'border-brand-600 bg-brand-50 font-medium text-brand-800' : 'border-mist-200 text-ink'}`}>{d.slice(0, 3)}</button> })}</div></div>}
            {s.frequency === 'once' && <Input label="Date" type="date" value={s.date || ''} onChange={e => set({ schedule: { ...s, date: e.target.value } })} />}
            <Input label="Time" type="time" value={s.time || '10:00'} onChange={e => set({ schedule: { ...s, time: e.target.value } })} hint="In your church’s time zone." />
            <p className="label mt-2">Who receives it</p>
            <AudiencePicker audience={t.audience || { mode: 'filters', statuses: [], segment: 'all', tags: [], people: [] }} setAudience={(fn) => set({ audience: typeof fn === 'function' ? fn(t.audience || {}) : fn })} channel="email" preview={null} picked={picked} setPicked={setPicked} />
            <p className="mt-2 text-sm text-mist-500">Each time, GatherHQ sends to whoever is in this group at that moment.</p>
          </>
        )}
      </fieldset>
    </div>
  )
}

function StepEditor({ step: s, trigger, onChange, channels, templates, tags, assignees, workflows }) {
  const churchName = useSession().me?.org?.name || 'Your church'
  const set = (p) => onChange({ ...s, ...p })
  if (s.type === 'wait') {
    const w = s.wait || {}
    const setW = (p) => set({ wait: { ...w, ...p } })
    return (
      <div>
        <Select label="Wait" value={w.kind} onChange={e => setW({ kind: e.target.value, ...(e.target.value === 'for' ? { amount: 2, unit: 'days' } : e.target.value === 'until_day' ? { weekday: 1, time: '10:00' } : { time: '10:00', days: 1 }) })}>
          <option value="for">For a set time</option><option value="until_day">Until a day of the week</option><option value="until_time">Until a time of day</option>
          {trigger.type === 'event_registered' && <option value="before_event">Until a number of days before the event</option>}
        </Select>
        {w.kind === 'for' && <div className="grid grid-cols-2 gap-3"><Input label="How long" type="number" min={1} value={w.amount ?? 2} onChange={e => setW({ amount: Number(e.target.value) })} /><Select label="&nbsp;" value={w.unit || 'days'} onChange={e => setW({ unit: e.target.value })}><option value="minutes">minutes</option><option value="hours">hours</option><option value="days">days</option></Select></div>}
        {w.kind === 'until_day' && <div className="grid grid-cols-2 gap-3"><Select label="Day" value={w.weekday ?? 1} onChange={e => setW({ weekday: Number(e.target.value) })}>{WEEKDAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}</Select><Input label="Time" type="time" value={w.time || '10:00'} onChange={e => setW({ time: e.target.value })} /></div>}
        {w.kind === 'until_time' && <Input label="Time" type="time" value={w.time || '10:00'} onChange={e => setW({ time: e.target.value })} />}
        {w.kind === 'before_event' && <div className="grid grid-cols-2 gap-3"><Input label="Days before" type="number" min={0} max={30} value={w.days ?? 1} onChange={e => setW({ days: Number(e.target.value) })} /><Input label="At" type="time" value={w.time || '10:00'} onChange={e => setW({ time: e.target.value })} /></div>}
        <p className="text-sm text-mist-500">Times are in your church’s time zone. Messages that would arrive outside your sending hours wait until the morning.</p>
      </div>
    )
  }
  if (s.type === 'send') {
    const approved = (templates?.own || []).filter(t => t.whatsapp?.status === 'approved')
    const info = smsInfo(s.body)
    return (
      <div>
        <p className="label">Send by</p>
        <div className="mb-4 grid grid-cols-3 gap-2">
          {['email', 'sms', 'whatsapp'].map(c => { const Icon = CHANNEL_ICON[c]; const ok = channels[c]?.ready; const soon = channels[c]?.comingSoon; return (
            <button key={c} type="button" disabled={soon} onClick={() => set({ channel: c, ...(c === 'whatsapp' ? { templateId: null } : {}) })} aria-pressed={s.channel === c} title={soon ? WHATSAPP_COMING_SOON : undefined}
              className={`flex flex-col items-center gap-1 rounded-xl border px-2 py-3 text-sm ${s.channel === c ? 'border-brand-600 bg-brand-50 font-semibold text-brand-800' : soon ? 'cursor-not-allowed border-mist-200 bg-mist-50 text-mist-400' : 'border-mist-200 text-ink'}`}>
              <Icon size={18} />{channelLabel(c)}<span className={`text-[11px] ${ok ? 'text-green-800' : 'text-mist-400'}`}>{soon ? 'Coming soon' : ok ? (channels[c].simulated ? 'Test mode' : c === 'sms' ? 'Uses credit' : 'Included') : 'Not connected'}</span>
            </button>
          ) })}
        </div>
        {channels.whatsapp?.comingSoon && <p className="-mt-2 mb-4 text-xs text-mist-500">{WHATSAPP_COMING_SOON}</p>}
        {s.channel === 'whatsapp' && channels.whatsapp?.comingSoon && <Notice tone="warning" className="mb-4">This step uses WhatsApp, which can’t be automated yet. Choose SMS or email so the journey can be switched on.</Notice>}
        {s.channel !== 'email' && !channels[s.channel]?.ready && !channels[s.channel]?.comingSoon && <Notice tone="warning" className="mb-4">{channelLabel(s.channel)} isn’t connected yet. You can prepare the step, but the workflow can’t be switched on until it is.</Notice>}
        <Input label="Step name" hint="Only your team sees this." value={s.title || ''} onChange={e => set({ title: e.target.value })} maxLength={80} />
        {s.channel === 'email' && <>
          <Input label="Subject" value={s.subject || ''} onChange={e => set({ subject: e.target.value })} maxLength={200} />
          <Textarea label="Message" rows={8} value={s.body || ''} onChange={e => set({ body: e.target.value, blocks: [] })} hint="Use {first_name} to greet them by name." />
        </>}
        {s.channel === 'whatsapp' && <>
          <Select label="Approved WhatsApp template" value={s.templateId || ''} onChange={e => { const t = approved.find(x => x.id === e.target.value); set(t ? { templateId: t.id, templateName: t.name, body: t.body, category: t.category } : { templateId: null }) }}
            hint={approved.length ? 'WhatsApp needs an approved template for messages people didn’t ask for.' : undefined}>
            <option value="">Choose a template</option>{approved.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </Select>
          {!approved.length && <Notice className="mb-4">You don’t have an approved WhatsApp template yet. <Link to="/app/communications/templates" className="link">Create one in Templates</Link>.</Notice>}
          {s.body && <BubblePreview channel="whatsapp" text={s.body} churchName={churchName} />}
        </>}
        {s.channel === 'sms' && <>
          <Textarea label="Message" rows={5} value={s.body || ''} onChange={e => set({ body: e.target.value })} maxLength={918} />
          <p className="-mt-2 mb-3 text-sm text-mist-500">{info.length} characters · {info.segments} {info.segments === 1 ? 'text' : 'texts'} per person</p>
          <BubblePreview channel="sms" text={s.body} churchName={churchName} />
        </>}
      </div>
    )
  }
  if (s.type === 'check') {
    return (
      <div>
        <Select label="Check" value={s.condition} onChange={e => set({ condition: e.target.value })}>
          {Object.entries(CONDITIONS).filter(([k]) => k !== 'registered' || trigger.type === 'event_registered').map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
        {s.condition === 'attended' && <p className="-mt-2 mb-4 text-sm text-mist-500">Yes if they’ve checked in since the workflow started.</p>}
        {s.condition === 'has_tag' && <Select label="Tag" value={s.tagId || ''} onChange={e => set({ tagId: e.target.value })}><option value="">Choose a tag</option>{tags.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</Select>}
        {s.condition === 'opted_out' && <Select label="Of" value={s.channel || 'whatsapp'} onChange={e => set({ channel: e.target.value })}>{['whatsapp', 'sms', 'email'].map(c => <option key={c} value={c}>{channelLabel(c)}</option>)}</Select>}
        <div className="grid grid-cols-1 gap-x-3 sm:grid-cols-2">
          <Select label="If yes" value={s.ifYes} onChange={e => set({ ifYes: e.target.value })}>{Object.entries(OUTCOMES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
          <Select label="If no" value={s.ifNo} onChange={e => set({ ifNo: e.target.value })}>{Object.entries(OUTCOMES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
        </div>
        {(s.ifYes === 'task' || s.ifNo === 'task') && <>
          <Input label="Task" value={s.taskTitle || ''} onChange={e => set({ taskTitle: e.target.value })} placeholder="Call {first_name}" />
          <Select label="For" value={s.assigneeId || ''} onChange={e => { const a = assignees.find(x => x.user_id === e.target.value); set({ assigneeId: a?.user_id || null, assigneeName: a?.name || null }) }}><option value="">Anyone on the follow-up team</option>{assignees.map(a => <option key={a.user_id} value={a.user_id}>{a.name}</option>)}</Select>
        </>}
      </div>
    )
  }
  if (s.type === 'task') {
    return (
      <div>
        <Input label="Task" value={s.title || ''} onChange={e => set({ title: e.target.value })} hint="It appears in Follow-ups. Use {first_name} for their name." />
        <Select label="Due within" value={s.dueHours || 48} onChange={e => set({ dueHours: Number(e.target.value) })}>{[[24, '1 day'], [48, '2 days'], [72, '3 days'], [168, '1 week']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
        <Select label="For" value={s.assigneeId || ''} onChange={e => { const a = assignees.find(x => x.user_id === e.target.value); set({ assigneeId: a?.user_id || null, assigneeName: a?.name || null }) }}><option value="">Anyone on the follow-up team</option>{assignees.map(a => <option key={a.user_id} value={a.user_id}>{a.name}</option>)}</Select>
      </div>
    )
  }
  if (s.type === 'tag') return <Select label="Tag to add" value={s.tagId || ''} onChange={e => set({ tagId: e.target.value })}><option value="">Choose a tag</option>{tags.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</Select>
  if (s.type === 'start_workflow') return <Select label="Move them to" hint="Only works if that workflow is switched on." value={s.workflowId || ''} onChange={e => set({ workflowId: e.target.value })}><option value="">Choose a workflow</option>{workflows.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}</Select>
  return <p className="text-sm text-mist-500">The workflow ends here for this person.</p>
}

const ENR_STATUS = { active: 'In progress', paused_reply: 'Paused: they replied', completed: 'Finished', exited: 'Left', removed: 'Removed' }
function EnrolledPeople({ wf, names }) {
  const toast = useToast()
  const { tz } = useSession()
  const { data, error, loading, reload } = useLoad(() => api.get(`/comms/workflows/${wf.id}/people`), [wf.id])
  const [open, setOpen] = useState(null)
  const act = async (fn, msg) => { try { await fn(); await reload(); toast(msg) } catch (e) { toast(e.message, 'error') } }
  if (error) return <ErrorState error={error} onRetry={reload} />
  if (loading) return <Skeleton className="h-40" />
  if (!data.rows.length) return <EmptyState title="Nobody yet">{wf.status === 'active' ? 'People join automatically when it starts for them.' : 'Switch the workflow on and people will join automatically.'}</EmptyState>
  return (
    <ul className="panel divide-y divide-mist-100">
      {data.rows.map(e => { const step = wf.steps.find(s => s.id === e.step_id); return (
        <li key={e.id} className="px-5 py-3">
          <div className="flex flex-wrap items-center gap-3">
            <span className="min-w-0 flex-1"><Link to={`/app/people/${e.person_id}`} className="font-medium text-ink hover:underline">{e.name}</Link>
              <span className="block text-sm text-mist-500">{ENR_STATUS[e.status] || e.status}{e.status === 'active' && step ? ` · next: ${describeStep(step, names).toLowerCase()}${e.next_at ? `, ${fmtDateTime(e.next_at, tz)}` : ''}` : ''}{e.blocked === 'credits' ? ' · waiting for messaging credit' : ''}</span></span>
            <button type="button" className="text-sm text-mist-500 hover:text-ink" onClick={() => setOpen(open === e.id ? null : e.id)} aria-expanded={open === e.id}>History <ChevronDown size={14} className="inline" /></button>
            {e.status === 'paused_reply' && <Button size="sm" variant="secondary" onClick={() => act(() => api.post(`/comms/enrolments/${e.id}/resume`), 'Resumed')}>Resume</Button>}
            {['active', 'paused_reply'].includes(e.status) && <Button size="sm" variant="ghost" icon={UserMinus} onClick={() => act(() => api.post(`/comms/enrolments/${e.id}/remove`), 'Removed from this workflow')}>Remove</Button>}
            {IS_STAGING && e.status === 'active' && <Button size="sm" variant="ghost" icon={FlaskConical} onClick={() => act(() => api.post(`/comms/simulate/advance/${e.id}`), 'Ran the next step (staging)')}>Run next step now</Button>}
          </div>
          {open === e.id && (
            <ol className="mt-2 space-y-1 border-l border-mist-200 pl-4 text-sm">
              {e.history.map((h, i) => <li key={i} className={h.result === 'failed' ? 'text-red-700' : 'text-mist-600'}><span className="text-mist-400">{fmtDateTime(h.at, tz)}</span> · {h.text.replace(/Waiting until (\S+)/, (_, d) => `Waiting until ${fmtDateTime(d, tz)}`)}</li>)}
            </ol>
          )}
        </li>
      ) })}
    </ul>
  )
}
