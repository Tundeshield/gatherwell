import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Plus, CalendarCheck, QrCode } from 'lucide-react'
import { api, qs } from '../../lib/api'
import { useSession, useBranchParam } from '../../lib/session'
import { useLoad, PageHeader, Button, Badge, SESSION_TONE, Segmented, Table, Th, Td, Pagination, EmptyState, ErrorState, Skeleton, Modal, Input, Select, Notice, useToast } from '../../components/ui'
import { fmtDay, fmtTime, KIND_LABELS, toLocalInput, fromLocalInput } from '../../lib/format'
import FormBuilder, { DEFAULT_FORM } from '../../components/FormBuilder'

const LIMIT = 30
const STATUS_LABEL = { open: 'Open', scheduled: 'Scheduled', closed: 'Closed', draft: 'Draft', archived: 'Archived' }

function nextSunday9() {
  const d = new Date(); d.setHours(9, 0, 0, 0)
  const add = (7 - d.getDay()) % 7
  d.setDate(d.getDate() + (add === 0 && new Date().getHours() >= 12 ? 7 : add))
  return d
}

export function NewSessionModal({ open, onClose, onCreated }) {
  const { activeBranches, can } = useSession()
  const branchParam = useBranchParam()
  const templates = useLoad(() => (open ? api.get('/templates') : Promise.resolve([])), [open])
  const [f, setF] = useState(null)
  const [saveTemplate, setSaveTemplate] = useState(false)
  const [templateName, setTemplateName] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (open) {
      setF({ name: 'Sunday Service', kind: 'service', branchId: branchParam || activeBranches[0]?.id, startsAt: toLocalInput(nextSunday9()), endsAt: '', status: 'open', form: DEFAULT_FORM })
      setError(''); setSaveTemplate(false); setTemplateName('')
    }
  }, [open]) // eslint-disable-line

  if (!f) return null
  const set = (k) => (e) => setF(x => ({ ...x, [k]: e.target.value }))
  function applyTemplate(id) {
    const t = templates.data?.find(x => x.id === id)
    if (t) setF(x => ({ ...x, name: t.name, kind: t.kind, form: t.form }))
  }

  async function submit(e) {
    e.preventDefault()
    setBusy(true); setError('')
    try {
      if (saveTemplate && templateName.trim()) await api.post('/templates', { name: templateName, kind: f.kind, form: f.form })
      const g = await api.post('/gatherings', { ...f, startsAt: fromLocalInput(f.startsAt), endsAt: fromLocalInput(f.endsAt) })
      onCreated(g)
    } catch (err) { setError(err.message) } finally { setBusy(false) }
  }

  return (
    <Modal open={open} onClose={onClose} title="New attendance session" size="lg"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={submit} loading={busy}>Create session</Button></>}>
      <form onSubmit={submit}>
        {error && <Notice tone="danger" className="mb-4">{error}</Notice>}
        {templates.data?.length > 0 && (
          <Select label="Start from a template" defaultValue="" onChange={e => applyTemplate(e.target.value)}>
            <option value="">Blank session</option>
            {templates.data.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </Select>
        )}
        <div className="grid gap-x-4 sm:grid-cols-2">
          <Input label="Name" value={f.name} onChange={set('name')} required className="sm:col-span-2" />
          <Select label="Type" value={f.kind} onChange={set('kind')}>
            {Object.entries(KIND_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
          <Select label="Branch" value={f.branchId} onChange={set('branchId')}>
            {activeBranches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
          </Select>
          <Input label="Starts" type="datetime-local" value={f.startsAt} onChange={set('startsAt')} required />
          <Input label="Ends (optional)" type="datetime-local" value={f.endsAt} onChange={set('endsAt')} />
          <Select label="Check-in" value={f.status} onChange={set('status')} hint="You can open or close check-in at any time." className="sm:col-span-2">
            <option value="open">Open now — people can check in straight away</option>
            <option value="scheduled">Scheduled — open it when the session starts</option>
          </Select>
        </div>
        <div className="mb-2 text-sm font-medium text-ink">Check-in form</div>
        <p className="mb-3 text-xs text-mist-500">Name and phone are always asked so people can be recognised next time. Returning people only enter their phone and first name.</p>
        <FormBuilder value={f.form} onChange={(form) => setF(x => ({ ...x, form }))} />
        {can('attendance.manage') && (
          <div className="mt-4 rounded-lg border border-mist-200 px-4 py-3">
            <label className="flex items-center gap-2 text-sm text-ink"><input type="checkbox" checked={saveTemplate} onChange={e => { setSaveTemplate(e.target.checked); if (!templateName) setTemplateName(f.name) }} className="h-4 w-4 accent-brand-700" />Save as a template for next time</label>
            {saveTemplate && <Input className="mb-0 mt-3" label="Template name" value={templateName} onChange={e => setTemplateName(e.target.value)} />}
          </div>
        )}
      </form>
    </Modal>
  )
}

export default function Attendance() {
  const { can, tz, multiBranch } = useSession()
  const branch = useBranchParam()
  const navigate = useNavigate()
  const toast = useToast()
  const [params, setParams] = useSearchParams()
  const [status, setStatus] = useState('')
  const [offset, setOffset] = useState(0)
  const [creating, setCreating] = useState(params.get('new') === '1')
  const { data, error, loading, reload } = useLoad(() => api.get(`/gatherings${qs({ branch, status, offset, limit: LIMIT })}`), [branch, status, offset])

  return (
    <div>
      <PageHeader title="Attendance" description="Sessions, QR check-in and who was there."
        actions={can('attendance.manage') && <Button icon={Plus} onClick={() => setCreating(true)}>New session</Button>} />
      <div className="mb-4">
        <Segmented value={status} onChange={(v) => { setStatus(v); setOffset(0) }} options={[{ value: '', label: 'All' }, { value: 'open', label: 'Open' }, { value: 'scheduled', label: 'Scheduled' }, { value: 'closed', label: 'Closed' }, { value: 'archived', label: 'Archived' }]} />
      </div>
      <div className="panel overflow-hidden">
        {error ? <ErrorState error={error} onRetry={reload} /> : loading && !data ? (
          <div className="space-y-3 p-4">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-10" />)}</div>
        ) : data.rows.length === 0 ? (
          <EmptyState icon={CalendarCheck} title={status ? `No ${STATUS_LABEL[status].toLowerCase()} sessions` : 'No sessions yet'}
            action={can('attendance.manage') && !status && <Button icon={Plus} onClick={() => setCreating(true)}>Create your first session</Button>}>
            {!status && 'Create a session for each service or meeting. GatherHQ gives you a QR code people scan to check in.'}
          </EmptyState>
        ) : (
          <>
            <Table>
              <thead><tr><Th>Session</Th><Th>Date</Th>{multiBranch && <Th>Branch</Th>}<Th>Check-in</Th><Th className="text-right">Attendance</Th><Th className="text-right">First-time</Th></tr></thead>
              <tbody className={loading ? 'opacity-60' : ''}>
                {data.rows.map(g => (
                  <tr key={g.id} className="cursor-pointer hover:bg-mist-50/70" onClick={() => navigate(`/app/attendance/${g.id}`)}>
                    <Td><Link to={`/app/attendance/${g.id}`} className="font-medium text-ink hover:text-brand-700" onClick={e => e.stopPropagation()}>{g.name}</Link><div className="text-xs text-mist-500">{KIND_LABELS[g.kind] || g.kind}</div></Td>
                    <Td className="whitespace-nowrap text-mist-600">{fmtDay(g.starts_at, tz)}<div className="text-xs text-mist-400">{fmtTime(g.starts_at, tz)}</div></Td>
                    {multiBranch && <Td className="text-mist-600">{g.branch_name}</Td>}
                    <Td><Badge tone={SESSION_TONE[g.status]} dot={g.status === 'open'}>{STATUS_LABEL[g.status]}</Badge></Td>
                    <Td className="tabular text-right font-medium text-ink">{g.attendance.toLocaleString()}</Td>
                    <Td className="tabular text-right text-mist-600">{g.first_timers}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <Pagination total={data.total} limit={LIMIT} offset={offset} onChange={setOffset} />
          </>
        )}
      </div>
      <NewSessionModal open={creating} onClose={() => { setCreating(false); if (params.get('new')) setParams({}, { replace: true }) }}
        onCreated={(g) => { setCreating(false); toast('Session created'); navigate(`/app/attendance/${g.id}`) }} />
    </div>
  )
}
