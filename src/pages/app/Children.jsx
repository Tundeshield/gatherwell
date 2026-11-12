import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Baby, ScanLine, UserCheck, Plus, MessageCircle, Printer } from 'lucide-react'
import { api } from '../../lib/api'
import { useSession } from '../../lib/session'
import { useLoad, PageLoader, ErrorState, PageHeader, Button, Segmented, Table, Th, Td, Badge, SearchInput, EmptyState } from '../../components/ui'
import { relative, fmtDate } from '../../lib/format'
import ChildForm from '../../components/children/ChildForm'
import { printLabels } from '../../components/children/labels'
import { whatsappLink } from '../../../shared/automation.js'

const time = (d) => new Date(d).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

function Today() {
  const { me } = useSession()
  const { data, error, loading, reload } = useLoad(() => api.get('/children/today'), [])
  if (loading && !data) return <PageLoader />
  if (error) return <ErrorState error={error} onRetry={reload} />
  const t = data.totals
  const diff = data.prevCount != null ? t.checkedIn - data.prevCount : null
  if (t.children === 0) {
    return (
      <EmptyState icon={Baby} title="No children yet" action={<Link to="/app/children/checkin" className="rounded-lg bg-brand-700 px-4 py-2 text-sm font-medium text-white hover:bg-brand-800">Open the check-in screen</Link>}>
        Families are added the first time they check in: a parent gives their phone number and their children’s names. You can also add children from the Children tab.
      </EmptyState>
    )
  }
  return (
    <div className="space-y-6">
      <section className="panel grid grid-cols-2 divide-mist-100 lg:grid-cols-4 lg:divide-x">
        {[
          [t.here, 'Children here', diff == null ? `${t.checkedIn} checked in today` : `${diff >= 0 ? '+' : ''}${diff} on ${fmtDate(data.prevDay)}`],
          [t.firstTime, 'First-time children', t.firstTime ? 'Welcome follow-ups created for their parents' : 'None today'],
          [t.adults, 'Teachers and helpers', t.short ? `${t.short} more needed` : 'Enough in every class'],
          [t.pickedUp, 'Picked up', `${t.here} still in classes`],
        ].map(([n, l, h], i) => (
          <div key={l} className="px-5 py-4">
            <div className="tabular text-2xl font-semibold text-ink">{n}</div>
            <div className="text-sm text-mist-500">{l}</div>
            <div className={`mt-0.5 text-xs ${i === 2 && t.short ? 'font-medium text-gold-700' : 'text-mist-400'}`}>{h}</div>
          </div>
        ))}
      </section>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {data.rooms.map(r => (
          <Link key={r.id} to={`/app/children/rooms/${r.id}`} className={`panel block px-4 py-4 transition-shadow hover:shadow-card ${r.short ? 'ring-2 ring-gold-500' : ''}`}>
            <div className="flex items-baseline justify-between gap-2"><div className="font-semibold text-ink">{r.name}</div>{r.location && <div className="text-xs text-mist-500">{r.location}</div>}</div>
            <div className="mt-2 text-2xl font-semibold text-ink">{r.here}{r.capacity && <span className="text-sm font-normal text-mist-500"> of {r.capacity} places</span>}</div>
            {r.capacity && <div className="mt-2 h-1.5 rounded-full bg-mist-100"><div className={`h-1.5 rounded-full ${r.full ? 'bg-red-600' : r.short ? 'bg-gold-500' : 'bg-brand-500'}`} style={{ width: `${Math.min(100, (r.here / r.capacity) * 100)}%` }} /></div>}
            <div className={`mt-2 text-xs ${r.short ? 'font-medium text-gold-700' : 'text-mist-500'}`}>
              {r.adults} {r.adults === 1 ? 'adult' : 'adults'}{r.ratio ? (r.short ? ` · ${r.short} more needed` : r.here ? ' · enough' : '') : ''}{r.full ? ' · full' : ''}
            </div>
          </Link>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1.6fr)_1fr]">
        <section className="panel overflow-hidden">
          <div className="border-b border-mist-100 px-4 py-3"><h2 className="text-[15px] font-semibold text-ink">Checked in today</h2></div>
          {data.latest.length === 0 ? <p className="px-4 py-6 text-sm text-mist-400">No one checked in yet today.</p> : (
            <Table>
              <thead><tr><Th>Child</Th><Th>Class</Th><Th>Code</Th><Th>Parent</Th><Th>In</Th><Th /></tr></thead>
              <tbody>{data.latest.map(k => (
                <tr key={k.id}>
                  <Td><span className="font-medium text-ink">{k.childName}</span>
                    {k.firstTime && <Badge tone="gold" className="ml-2">First visit</Badge>}
                    {k.alert && <Badge tone="danger" className="ml-2">Allergy</Badge>}
                    {k.pickedUpAt && <Badge className="ml-2">Picked up {time(k.pickedUpAt)}</Badge>}</Td>
                  <Td className="whitespace-nowrap">{k.roomName}</Td>
                  <Td className="font-semibold tracking-wider">{k.code}</Td>
                  <Td className="text-mist-600">{k.guardianName || '—'}</Td>
                  <Td className="whitespace-nowrap text-mist-600">{time(k.checkedInAt)}</Td>
                  <Td>{!k.pickedUpAt && me.org.kidsLabels !== 'none' && <button type="button" onClick={() => printLabels({ checkins: [k], code: k.code, orgName: me.org.name, parentTag: false })} className="rounded p-1.5 text-mist-400 hover:bg-mist-100 hover:text-ink" aria-label={`Reprint ${k.firstName}’s label`} title="Reprint label"><Printer size={15} /></button>}</Td>
                </tr>
              ))}</tbody>
            </Table>
          )}
        </section>
        <section className="panel overflow-hidden">
          <div className="border-b border-mist-100 px-4 py-3"><h2 className="text-[15px] font-semibold text-ink">Haven’t come in 3 weeks</h2><p className="text-xs text-mist-500">A good moment to check in with their parents.</p></div>
          {data.missing.length === 0 ? <p className="px-4 py-6 text-sm text-mist-400">Every child has been recently.</p> : (
            <ul className="divide-y divide-mist-100">
              {data.missing.map(c => (
                <li key={c.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                  <div className="min-w-0"><div className="truncate font-medium text-ink">{c.name}</div><div className="truncate text-xs text-mist-500">{c.room || 'No class'} · last {relative(c.lastCheckinAt)}{c.guardian ? ` · ${c.guardian.name}` : ''}</div></div>
                  {c.guardian?.phoneNorm && <a href={whatsappLink({ phoneNorm: c.guardian.phoneNorm, template: `Hi ${c.guardian.firstName}, we’ve missed ${c.name.split(' ')[0]} at children’s church. Hope you’re all well!` })} target="_blank" rel="noreferrer" className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-brand-700 hover:underline"><MessageCircle size={14} />WhatsApp</a>}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}

function ChildrenList() {
  const { can } = useSession()
  const { data, error, loading, reload } = useLoad(() => api.get('/children'), [])
  const [q, setQ] = useState('')
  const [editing, setEditing] = useState(undefined)
  if (loading && !data) return <PageLoader />
  if (error) return <ErrorState error={error} onRetry={reload} />
  const rows = data.rows.filter(c => !q || `${c.name} ${c.guardians.map(g => g.name).join(' ')}`.toLowerCase().includes(q.toLowerCase()))
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <SearchInput value={q} onChange={setQ} placeholder="Search child or parent" className="w-full sm:w-72" />
        {can('children.edit') && <Button icon={Plus} onClick={() => setEditing(null)}>Add a child</Button>}
      </div>
      <section className="panel overflow-hidden">
        {rows.length === 0 ? <EmptyState icon={Baby} title={data.rows.length ? 'No children match' : 'No children yet'}>{data.rows.length ? 'Try another name.' : 'Families are added at check-in, or add a child here.'}</EmptyState> : (
          <Table>
            <thead><tr><Th>Child</Th><Th>Age</Th><Th>Class</Th><Th>Parents</Th><Th>Last here</Th></tr></thead>
            <tbody>{rows.map(c => (
              <tr key={c.id} onClick={() => can('children.edit') && setEditing(c)} className={can('children.edit') ? 'cursor-pointer hover:bg-mist-50' : ''}>
                <Td><span className="font-medium text-ink">{c.name}</span>{c.allergies && <Badge tone="danger" className="ml-2">Allergy: {c.allergies}</Badge>}{c.medical && <Badge tone="warning" className="ml-2">Medical note</Badge>}</Td>
                <Td className="tabular">{c.age ?? '—'}</Td>
                <Td>{c.room?.name || <span className="text-mist-400">Add a date of birth</span>}{c.roomId && <span className="text-xs text-mist-400"> (chosen)</span>}</Td>
                <Td className="text-mist-600">{c.guardians.length ? c.guardians.map(g => <Link key={g.id} to={`/app/people/${g.id}`} onClick={e => e.stopPropagation()} className="mr-2 hover:underline">{g.name}</Link>) : '—'}</Td>
                <Td className="whitespace-nowrap text-mist-600">{c.lastCheckinAt ? relative(c.lastCheckinAt) : 'Never'}</Td>
              </tr>
            ))}</tbody>
          </Table>
        )}
      </section>
      <ChildForm open={editing !== undefined} onClose={() => setEditing(undefined)} child={editing} rooms={data.rooms} onSaved={reload} />
    </div>
  )
}

export default function Children() {
  const { can } = useSession()
  const [params, setParams] = useSearchParams()
  const tab = params.get('tab') === 'list' ? 'list' : 'today'
  return (
    <div>
      <PageHeader title="Children’s Church" description={tab === 'today' ? 'Today, live. Children are counted separately from adult attendance.' : 'Every child, with their class and parents.'}
        actions={can('children.checkin') && <div className="flex flex-wrap gap-2">
          <Link to="/app/children/pickup" className="inline-flex items-center gap-2 rounded-lg border border-mist-200 bg-white px-3.5 py-2 text-sm font-medium text-ink hover:border-mist-300"><UserCheck size={16} />Pick up</Link>
          <Link to="/app/children/checkin" className="inline-flex items-center gap-2 rounded-lg bg-brand-700 px-3.5 py-2 text-sm font-medium text-white hover:bg-brand-800"><ScanLine size={16} />Open check-in screen</Link>
        </div>} />
      <div className="mb-5"><Segmented value={tab} onChange={v => setParams(v === 'list' ? { tab: 'list' } : {}, { replace: true })} options={[{ value: 'today', label: 'Today' }, { value: 'list', label: 'Children' }]} /></div>
      {tab === 'today' ? <Today /> : <ChildrenList />}
    </div>
  )
}

