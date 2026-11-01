import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../../lib/api'
import { useLoad, PageLoader, ErrorState, Table, Th, Td, SearchInput, Badge, EmptyState, useDebounced } from '../../components/ui'
import { fmtDate, relative } from '../../lib/format'
import { adminPath } from '../../lib/host'

export default function AdminUsers() {
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  const dq = useDebounced(q, 250)
  const { data, error, loading, reload } = useLoad(() => api.get(`/platform/users?q=${encodeURIComponent(dq)}`), [dq])
  return (
    <div>
      <h1 className="text-[26px] font-semibold text-ink">Users</h1>
      <p className="mt-1 text-sm text-mist-500">Everyone who can sign in to GatherHQ. Find someone to help them get back in or see their churches.</p>
      <SearchInput value={q} onChange={setQ} placeholder="Search name or email" className="mt-6 w-full sm:w-80" autoFocus />
      <section className="panel mt-4 overflow-hidden">
        {error ? <ErrorState error={error} onRetry={reload} /> : loading && !data ? <PageLoader /> : data.users.length === 0 ? <EmptyState title="No one found">Check the spelling, or search by email.</EmptyState> : (
          <>
            <Table>
              <thead><tr><Th>Name</Th><Th>Email</Th><Th>Joined</Th><Th>Last signed in</Th></tr></thead>
              <tbody>{data.users.map(u => (
                <tr key={u.id} onClick={() => navigate(adminPath(`/users/${u.id}`))} className="cursor-pointer hover:bg-mist-50">
                  <Td><span className="font-medium text-ink">{u.name}</span>{u.is_platform_admin && <Badge tone="brand" className="ml-2">Admin</Badge>}</Td>
                  <Td className="text-mist-600">{u.email}</Td>
                  <Td className="whitespace-nowrap text-mist-600">{fmtDate(u.created_at)}</Td>
                  <Td className="whitespace-nowrap text-mist-600">{u.last_login_at ? relative(u.last_login_at) : 'Never'}</Td>
                </tr>
              ))}</tbody>
            </Table>
            {data.total > data.users.length && <p className="border-t border-mist-100 px-4 py-3 text-xs text-mist-500">Showing {data.users.length} of {data.total}. Search to narrow it down.</p>}
          </>
        )}
      </section>
    </div>
  )
}
