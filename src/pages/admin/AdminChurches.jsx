import { useSearchParams, useNavigate } from 'react-router-dom'
import { api } from '../../lib/api'
import { useLoad, Button, Skeleton, ErrorState, EmptyState, Badge } from '../../components/ui'
import { adminPath } from '../../lib/host'
import { PageTitle, Panel, PlanBadge, StatusBadge, fmtMoney, fmtDate } from './shared'

const FILTERS = [['', 'All churches'], ['paying', 'Paying'], ['annual', 'On annual plans'], ['trialing', 'In trial'], ['trial_ending', 'Trial ending in 7 days'], ['failed', 'Payment problems'], ['expired', 'Trial or plan ended'], ['churned', 'Churned'], ['free', 'Free'], ['suspended', 'Suspended']]

export default function AdminChurches() {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const q = params.get('q') || '', state = params.get('state') || '', page = Number(params.get('page') || 1)
  const set = (p) => setParams(Object.fromEntries(Object.entries({ q, state, page: 1, ...p }).filter(([, v]) => v)))
  const { data, error, loading, reload } = useLoad(() => api.get(`/platform/churches?q=${encodeURIComponent(q)}&state=${state}&page=${page}`), [q, state, page])
  return (
    <div>
      <PageTitle title="Churches" sub={data ? `${data.total} ${data.total === 1 ? 'church' : 'churches'}` : null} />
      <div className="mb-4 flex flex-wrap gap-2">
        <input type="search" aria-label="Search churches" placeholder="Search by name or email" defaultValue={q} className="field !w-64" onKeyDown={e => e.key === 'Enter' && set({ q: e.target.value })} />
        <select aria-label="Filter" className="field !w-auto" value={state} onChange={e => set({ state: e.target.value })}>{FILTERS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
      </div>
      {error ? <ErrorState error={error} onRetry={reload} /> : loading && !data ? <Skeleton className="h-72" /> : !data.rows.length ? <EmptyState title="No churches match" /> : (
        <Panel>
          <div className="overflow-x-auto"><table className="w-full text-sm">
            <thead><tr className="border-b border-slate-100 text-left text-xs text-slate-500">
              <th className="px-4 py-2.5 font-medium">Church</th><th className="px-3 py-2.5 font-medium">Plan</th><th className="px-3 py-2.5 font-medium">Next billing / trial end</th>
              <th className="px-3 py-2.5 text-right font-medium">People</th><th className="px-3 py-2.5 text-right font-medium">Branches</th><th className="px-3 py-2.5 text-right font-medium">Users</th>
              <th className="px-3 py-2.5 font-medium">Last activity</th><th className="px-4 py-2.5 text-right font-medium">Lifetime revenue</th></tr></thead>
            <tbody className="divide-y divide-slate-100">{data.rows.map(o => (
              <tr key={o.id} onClick={() => navigate(adminPath(`/churches/${o.id}`))} className="cursor-pointer hover:bg-slate-50">
                <td className="px-4 py-2.5"><div className="flex items-center gap-2.5">
                  {o.logo_url ? <img src={o.logo_url} alt="" className="h-7 w-7 rounded object-cover" /> : <span className="flex h-7 w-7 items-center justify-center rounded bg-slate-100 text-xs font-semibold text-slate-500">{(o.name || '?').slice(0, 1)}</span>}
                  <span className="min-w-0"><span className="block truncate font-medium text-slate-900">{o.name}</span><span className="text-xs text-slate-500">Joined {fmtDate(o.created_at)}{o.contact_email ? ` · ${o.contact_email}` : ''}</span></span>
                  {o.status !== 'active' && <StatusBadge status={o.status} />}{o.has_failed_payment && <Badge tone="danger">Payment failed</Badge>}
                </div></td>
                <td className="px-3 py-2.5"><PlanBadge billing={{ state: o.sub.state, plan: o.sub.plan, interval: o.sub.interval, daysLeft: o.sub.days_left, manual: o.sub.manual, cancelling: o.sub.cancelling, lapsed: o.sub.ever_paid }} /></td>
                <td className="whitespace-nowrap px-3 py-2.5 text-slate-600">{fmtDate(o.sub.renews_at || o.sub.trial_ends_at)}</td>
                <td className="tabular px-3 py-2.5 text-right">{o.people ?? '—'}</td><td className="tabular px-3 py-2.5 text-right">{o.branches ?? '—'}</td><td className="tabular px-3 py-2.5 text-right">{o.users ?? '—'}</td>
                <td className="whitespace-nowrap px-3 py-2.5 text-slate-600">{o.last_activity_at ? fmtDate(o.last_activity_at) : 'No check-ins yet'}</td>
                <td className="tabular whitespace-nowrap px-4 py-2.5 text-right">{Object.keys(o.lifetime).length ? Object.entries(o.lifetime).map(([c, v]) => fmtMoney(v, c)).join(' + ') : '—'}{o.payments ? <span className="block text-xs text-slate-500">{o.payments} payments</span> : null}</td>
              </tr>))}</tbody>
          </table></div>
          {data.pages > 1 && <div className="flex items-center justify-between border-t border-slate-100 px-4 py-2.5 text-sm"><span className="text-slate-500">Page {data.page} of {data.pages}</span><span className="flex gap-2"><Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => set({ page: page - 1 })}>Previous</Button><Button size="sm" variant="secondary" disabled={page >= data.pages} onClick={() => set({ page: page + 1 })}>Next</Button></span></div>}
        </Panel>
      )}
    </div>
  )
}
