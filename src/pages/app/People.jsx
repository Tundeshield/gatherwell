import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Plus, Upload, Download, Users, X } from 'lucide-react'
import { api, qs, download } from '../../lib/api'
import { useSession, useBranchParam } from '../../lib/session'
import { useLoad, useDebounced, PageHeader, Button, SearchInput, Badge, PERSON_TONE, Avatar, Table, Th, Td, Pagination, EmptyState, ErrorState, Skeleton, useToast, Modal, Select } from '../../components/ui'
import { fmtDate, relative, personName, STATUS_LABELS } from '../../lib/format'
import PersonForm from '../../components/PersonForm'
import ImportPeople from '../../components/ImportPeople'

const LIMIT = 50

export default function People() {
  const { can, tz, multiBranch, me } = useSession()
  const branch = useBranchParam()
  const toast = useToast()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const [search, setSearch] = useState(params.get('q') || '')
  const q = useDebounced(search)
  const status = params.get('status') || ''
  const attendance = params.get('attendance') || ''
  const unit = params.get('unit') || ''
  const followup = params.get('followup') || ''
  const firstVisit = params.get('firstVisit') || ''
  const sort = params.get('sort') || 'name'
  const offset = Number(params.get('offset') || 0)
  const [selected, setSelected] = useState(new Set())
  const [adding, setAdding] = useState(false)
  const [importing, setImporting] = useState(params.get('import') === '1')
  const [bulk, setBulk] = useState(false)

  const setParam = (k, v) => { const p = new URLSearchParams(params); v ? p.set(k, v) : p.delete(k); if (k !== 'offset') p.delete('offset'); setParams(p, { replace: true }) }
  useEffect(() => { if ((params.get('q') || '') !== q) setParam('q', q) }, [q]) // eslint-disable-line

  const filters = useMemo(() => ({
    q, status, attendance, unit, followup, sort, offset, limit: LIMIT, branch,
    firstVisitSince: firstVisit ? new Date(Date.now() - Number(firstVisit) * 86400000).toISOString() : undefined,
  }), [q, status, attendance, unit, followup, sort, offset, branch, firstVisit])
  const { data, error, loading, reload } = useLoad(() => api.get(`/people${qs(filters)}`), [JSON.stringify(filters)])
  const units = useLoad(() => api.get('/units'), [])
  useEffect(() => setSelected(new Set()), [JSON.stringify(filters)]) // eslint-disable-line

  const activeFilters = [status && STATUS_LABELS[status], attendance && { recent: 'Seen recently', absent: 'Not seen recently', never: 'Never checked in' }[attendance],
    firstVisit && `First visit in last ${firstVisit} days`, followup && 'Open follow-up', unit && units.data?.find(u => u.id === unit)?.name].filter(Boolean)
  const clearFilters = () => setParams(new URLSearchParams(q ? { q } : {}), { replace: true })
  const weeks = me.org.settings?.absenceWeeks || 3

  async function exportCsv() {
    try { await download(`/people/export${qs({ ...filters, limit: undefined, offset: undefined })}`); toast('Export downloaded') }
    catch (e) { toast(e.message, 'error') }
  }

  const rows = data?.rows || []
  const allSelected = rows.length > 0 && rows.every(r => selected.has(r.id))

  return (
    <div>
      <PageHeader title="People" description={data ? `${data.total.toLocaleString()} ${activeFilters.length || q ? 'matching' : 'people'}` : ' '}
        actions={<>
          {can('export') && <Button variant="secondary" icon={Download} onClick={exportCsv}>Export</Button>}
          {can('people.edit') && <Button variant="secondary" icon={Upload} onClick={() => setImporting(true)}>Import</Button>}
          {can('people.edit') && <Button icon={Plus} onClick={() => setAdding(true)}>Add person</Button>}
        </>} />

      <div className="panel overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-mist-100 p-3">
          <SearchInput value={search} onChange={setSearch} placeholder="Search name, phone or email" className="w-full sm:w-72" />
          <select aria-label="Status" value={status} onChange={e => setParam('status', e.target.value)} className="field h-10 w-auto">
            <option value="">All statuses</option>
            {Object.entries(STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <select aria-label="Attendance" value={attendance} onChange={e => setParam('attendance', e.target.value)} className="field h-10 w-auto">
            <option value="">Any attendance</option>
            <option value="recent">Seen in last {weeks} weeks</option>
            <option value="absent">Not seen for {weeks}+ weeks</option>
            <option value="never">Never checked in</option>
          </select>
          {units.data?.length > 0 && (
            <select aria-label="Service unit" value={unit} onChange={e => setParam('unit', e.target.value)} className="field h-10 w-auto">
              <option value="">All units</option>
              {units.data.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          )}
          <select aria-label="Sort" value={sort} onChange={e => setParam('sort', e.target.value)} className="field h-10 w-auto sm:ml-auto">
            <option value="name">Sort: Name</option>
            <option value="last_seen">Sort: Last attended</option>
            <option value="first_visit">Sort: First visit</option>
            <option value="recent">Sort: Recently added</option>
          </select>
        </div>
        {(activeFilters.length > 0) && (
          <div className="flex flex-wrap items-center gap-2 border-b border-mist-100 bg-mist-50/50 px-4 py-2 text-sm">
            <span className="text-mist-500">Filtered by</span>
            {activeFilters.map(f => <Badge key={f} tone="brand">{f}</Badge>)}
            <button onClick={clearFilters} className="ml-1 inline-flex items-center gap-1 text-mist-500 hover:text-ink"><X size={14} />Clear</button>
          </div>
        )}
        {selected.size > 0 && (
          <div className="flex items-center gap-3 border-b border-brand-100 bg-brand-50 px-4 py-2 text-sm">
            <span className="font-medium text-brand-800">{selected.size} selected</span>
            <Button size="sm" variant="secondary" onClick={() => setBulk(true)}>Change status or unit</Button>
            <button className="text-brand-700 hover:underline" onClick={() => setSelected(new Set())}>Clear</button>
          </div>
        )}

        {error ? <ErrorState error={error} onRetry={reload} /> : loading && !data ? (
          <div className="space-y-3 p-4">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-10" />)}</div>
        ) : rows.length === 0 ? (
          activeFilters.length || q ? (
            <EmptyState icon={Users} title="No one matches" action={<Button variant="secondary" onClick={() => { setSearch(''); clearFilters() }}>Clear search and filters</Button>}>Try a different name or phone number, or remove a filter.</EmptyState>
          ) : (
            <EmptyState icon={Users} title="Add your first people" action={can('people.edit') && <div className="flex gap-2"><Button icon={Upload} variant="secondary" onClick={() => setImporting(true)}>Import a spreadsheet</Button><Button icon={Plus} onClick={() => setAdding(true)}>Add person</Button></div>}>
              People are also added automatically when visitors check in with your QR code.
            </EmptyState>
          )
        ) : (
          <>
            <Table>
              <thead><tr>
                {can('people.edit') && <Th className="w-10"><input type="checkbox" aria-label="Select all on this page" checked={allSelected} onChange={e => setSelected(e.target.checked ? new Set(rows.map(r => r.id)) : new Set())} className="h-4 w-4 accent-brand-700" /></Th>}
                <Th>Name</Th><Th>Status</Th><Th>Phone</Th>{multiBranch && <Th>Branch</Th>}<Th>Last attended</Th><Th className="text-right">Visits</Th>
              </tr></thead>
              <tbody className={loading ? 'opacity-60' : ''}>
                {rows.map(p => (
                  <tr key={p.id} className="cursor-pointer hover:bg-mist-50/70" onClick={() => navigate(`/app/people/${p.id}`)}>
                    {can('people.edit') && <Td className="w-10" ><input type="checkbox" aria-label={`Select ${personName(p)}`} checked={selected.has(p.id)} onClick={e => e.stopPropagation()}
                      onChange={e => setSelected(s => { const n = new Set(s); e.target.checked ? n.add(p.id) : n.delete(p.id); return n })} className="h-4 w-4 accent-brand-700" /></Td>}
                    <Td>
                      <Link to={`/app/people/${p.id}`} onClick={e => e.stopPropagation()} className="flex items-center gap-3">
                        <Avatar person={p} />
                        <span className="min-w-0">
                          <span className="block truncate font-medium text-ink">{personName(p)}</span>
                          {p.unit_name && <span className="block truncate text-xs text-mist-500">{p.unit_name}</span>}
                        </span>
                        {p.open_followups > 0 && <Badge tone="warning">Follow-up</Badge>}
                      </Link>
                    </Td>
                    <Td><Badge tone={PERSON_TONE[p.status]}>{STATUS_LABELS[p.status]}</Badge></Td>
                    <Td className="tabular whitespace-nowrap text-mist-600">{p.phone || <span className="text-mist-300">—</span>}</Td>
                    {multiBranch && <Td className="text-mist-600">{p.branch_name || '—'}</Td>}
                    <Td className="whitespace-nowrap text-mist-600" ><span title={p.last_seen_at ? fmtDate(p.last_seen_at, tz) : ''}>{p.last_seen_at ? relative(p.last_seen_at) : <span className="text-mist-400">Never</span>}</span></Td>
                    <Td className="tabular text-right text-mist-600">{p.visit_count}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <Pagination total={data.total} limit={LIMIT} offset={offset} onChange={(o) => setParam('offset', String(o))} />
          </>
        )}
      </div>

      <Modal open={adding} onClose={() => setAdding(false)} title="Add person" size="lg">
        <PersonForm onCancel={() => setAdding(false)} onSaved={(p) => { setAdding(false); toast(`${p.first_name} added`); navigate(`/app/people/${p.id}`) }} />
      </Modal>
      <ImportPeople open={importing} onClose={() => { setImporting(false); if (params.get('import')) setParam('import', '') }} onDone={() => reload()} />
      <BulkEdit open={bulk} ids={[...selected]} units={units.data || []} onClose={() => setBulk(false)} onDone={(n) => { setBulk(false); setSelected(new Set()); toast(`${n} updated`); reload() }} />
    </div>
  )
}

function BulkEdit({ open, ids, units, onClose, onDone }) {
  const [status, setStatus] = useState('')
  const [unitId, setUnitId] = useState('__keep')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function save() {
    setBusy(true); setError('')
    try {
      const body = { ids }
      if (status) body.status = status
      if (unitId !== '__keep') body.unitId = unitId || null
      const r = await api.post('/people/bulk', body)
      onDone(r.updated)
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  return (
    <Modal open={open} onClose={onClose} title={`Update ${ids.length} ${ids.length === 1 ? 'person' : 'people'}`} size="sm"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={save} loading={busy} disabled={!status && unitId === '__keep'}>Apply changes</Button></>}>
      {error && <p className="mb-3 text-sm text-red-700">{error}</p>}
      <Select label="Status" value={status} onChange={e => setStatus(e.target.value)}>
        <option value="">Keep current</option>
        {Object.entries(STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
      </Select>
      <Select label="Service unit" value={unitId} onChange={e => setUnitId(e.target.value)}>
        <option value="__keep">Keep current</option>
        <option value="">No unit</option>
        {units.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
      </Select>
    </Modal>
  )
}
