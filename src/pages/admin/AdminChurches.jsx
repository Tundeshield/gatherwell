import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../../lib/api'
import { useLoad, PageLoader, ErrorState, Table, Th, Td, SearchInput, Segmented, EmptyState } from '../../components/ui'
import { fmtDate, relative } from '../../lib/format'
import { adminPath } from '../../lib/host'
import { money, PlanBadge, StatusBadge } from './shared'

const FILTERS = {
  all: () => true,
  trial: o => o.billing.state === 'trialing',
  paying: o => o.billing.state === 'active' && o.mrr > 0,
  free: o => o.billing.state === 'free' || (o.billing.state === 'active' && !o.mrr),
  issues: o => o.billing.state === 'past_due' || o.billing.state === 'expired',
  suspended: o => o.status !== 'active',
}

export default function AdminChurches() {
  const navigate = useNavigate()
  const { data, error, loading, reload } = useLoad(() => api.get('/platform/summary'), [])
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState('all')
  if (loading && !data) return <PageLoader />
  if (error) return <ErrorState error={error} onRetry={reload} />
  const count = (k) => data.orgs.filter(FILTERS[k]).length
  const rows = data.orgs.filter(FILTERS[filter]).filter(o => !q || `${o.name} ${o.owner_email} ${o.owner_name} ${o.slug} ${o.country}`.toLowerCase().includes(q.toLowerCase()))
  return (
    <div>
      <h1 className="text-[26px] font-semibold text-ink">Churches</h1>
      <p className="mt-1 text-sm text-mist-500">{data.orgs.length} churches. Open one to change its plan, trial, features or status.</p>
      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <div className="max-w-full overflow-x-auto">
          <Segmented size="sm" value={filter} onChange={setFilter} options={[
            { value: 'all', label: `All ${count('all')}` }, { value: 'trial', label: `Trial ${count('trial')}` }, { value: 'paying', label: `Paying ${count('paying')}` },
            { value: 'free', label: `Free ${count('free')}` }, { value: 'issues', label: `Payment issues ${count('issues')}` }, { value: 'suspended', label: `Suspended ${count('suspended')}` },
          ]} />
        </div>
        <SearchInput value={q} onChange={setQ} placeholder="Search church, owner or country" className="w-full sm:w-72" />
      </div>
      <section className="panel mt-4 overflow-hidden">
        {rows.length === 0 ? <EmptyState title="No churches match">Try another filter or search.</EmptyState> : (
          <Table>
            <thead><tr><Th>Church</Th><Th>Owner</Th><Th>Plan</Th><Th className="text-right">Revenue / mo</Th><Th className="text-right">People</Th><Th className="text-right">Check-ins 7d</Th><Th>Last check-in</Th><Th>Joined</Th></tr></thead>
            <tbody>{rows.map(o => (
              <tr key={o.id} onClick={() => navigate(adminPath(`/churches/${o.id}`))} className="cursor-pointer hover:bg-mist-50">
                <Td>
                  <div className="flex items-center gap-2"><span className="font-medium text-ink">{o.name}</span>{o.status !== 'active' && <StatusBadge status={o.status} />}</div>
                  <div className="text-xs text-mist-500">{[o.country, o.multi_branch ? `${o.branches} branches` : null].filter(Boolean).join(' · ') || '—'}</div>
                </Td>
                <Td><div className="text-ink">{o.owner_name || '—'}</div><div className="text-xs text-mist-500">{o.owner_email}</div></Td>
                <Td><PlanBadge billing={o.billing} /></Td>
                <Td className="tabular text-right">{o.mrr ? money(o.mrr, o.mrr % 1 !== 0) : '—'}</Td>
                <Td className="tabular text-right">{o.people.toLocaleString()}</Td>
                <Td className="tabular text-right">{o.checkins_7d}</Td>
                <Td className="whitespace-nowrap text-mist-600">{o.last_checkin_at ? relative(o.last_checkin_at) : 'Never'}</Td>
                <Td className="whitespace-nowrap text-mist-600">{fmtDate(o.created_at)}</Td>
              </tr>
            ))}</tbody>
          </Table>
        )}
      </section>
    </div>
  )
}
