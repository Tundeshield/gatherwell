import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { api } from '../../lib/api'
import { useSession } from '../../lib/session'
import { useLoad, PageLoader, ErrorState, Badge, Table, Th, Td, SearchInput, useToast, useConfirm, Button } from '../../components/ui'
import { fmtDate, relative } from '../../lib/format'
import Logo from '../../components/Logo'

export default function Platform() {
  const { me } = useSession()
  const toast = useToast()
  const confirm = useConfirm()
  const { data, error, loading, reload } = useLoad(() => api.get('/platform/summary'), [])
  const [q, setQ] = useState('')
  if (loading && !data) return <PageLoader />
  if (error) return <ErrorState error={error} onRetry={reload} />

  async function setStatus(o, status) {
    const ok = await confirm({
      title: status === 'suspended' ? `Suspend ${o.name}?` : `Reactivate ${o.name}?`,
      message: status === 'suspended' ? 'Their team keeps their logins but loses access, and public check-in links stop working, until reactivated. No data is deleted.' : 'Their team and public links work again immediately.',
      confirmLabel: status === 'suspended' ? 'Suspend' : 'Reactivate', danger: status === 'suspended',
    })
    if (!ok) return
    try { await api.patch(`/platform/orgs/${o.id}`, { status }); toast(`${o.name} ${status === 'active' ? 'reactivated' : 'suspended'}`); reload() } catch (e) { toast(e.message, 'error') }
  }

  const t = data.totals
  const rows = data.orgs.filter(o => !q || `${o.name} ${o.owner_email} ${o.slug}`.toLowerCase().includes(q.toLowerCase()))
  return (
    <div className="min-h-screen bg-ivory">
      <header className="flex items-center justify-between border-b border-mist-200 bg-white px-6 py-3">
        <Logo size={28} subtitle="Platform administration" />
        {me.org && <Link to="/app" className="inline-flex items-center gap-1.5 text-sm text-mist-600 hover:text-ink"><ArrowLeft size={15} />Back to {me.org.name}</Link>}
      </header>
      <div className="mx-auto max-w-page px-6 py-8">
        <h1 className="text-[26px] font-semibold text-ink">Platform</h1>
        <p className="mt-1 text-sm text-mist-500">Aggregate figures only. Member records and notes are never shown here.</p>
        <section className="panel my-6 grid grid-cols-2 divide-mist-100 sm:grid-cols-3 lg:grid-cols-6 lg:divide-x">
          {[['Churches', t.orgs], ['Active', t.active_orgs], ['Branches', t.branches], ['People', t.people], ['Check-ins, 7 days', t.checkins_7d], ['Users', t.users]].map(([l, n]) => (
            <div key={l} className="px-5 py-4"><div className="tabular text-2xl font-semibold text-ink">{n.toLocaleString()}</div><div className="text-sm text-mist-500">{l}</div></div>
          ))}
        </section>
        <section className="panel overflow-hidden">
          <div className="flex items-center justify-between border-b border-mist-100 px-4 py-3">
            <h2 className="text-[15px] font-semibold text-ink">Churches</h2>
            <SearchInput value={q} onChange={setQ} placeholder="Search church or owner" className="w-64" />
          </div>
          <Table>
            <thead><tr><Th>Church</Th><Th>Owner</Th><Th>Status</Th><Th className="text-right">Branches</Th><Th className="text-right">People</Th><Th className="text-right">Sessions</Th><Th>Last check-in</Th><Th>Created</Th><Th /></tr></thead>
            <tbody>{rows.map(o => (
              <tr key={o.id}>
                <Td><div className="font-medium text-ink">{o.name}</div><div className="text-xs text-mist-500">{o.country || '—'} · {o.plan}{o.plan === 'trial' && o.trial_ends_at ? ` until ${fmtDate(o.trial_ends_at)}` : ''}</div></Td>
                <Td className="text-mist-600">{o.owner_email}</Td>
                <Td><Badge tone={o.status === 'active' ? 'success' : o.status === 'suspended' ? 'warning' : 'neutral'}>{o.status}</Badge></Td>
                <Td className="tabular text-right">{o.branches}</Td><Td className="tabular text-right">{o.people.toLocaleString()}</Td><Td className="tabular text-right">{o.sessions}</Td>
                <Td className="whitespace-nowrap text-mist-600">{o.last_checkin_at ? relative(o.last_checkin_at) : 'Never'}</Td>
                <Td className="whitespace-nowrap text-mist-600">{fmtDate(o.created_at)}</Td>
                <Td>{o.status === 'active' ? <Button size="sm" variant="ghost" onClick={() => setStatus(o, 'suspended')}>Suspend</Button> : o.status === 'suspended' && <Button size="sm" variant="ghost" onClick={() => setStatus(o, 'active')}>Reactivate</Button>}</Td>
              </tr>
            ))}</tbody>
          </Table>
        </section>
      </div>
    </div>
  )
}
