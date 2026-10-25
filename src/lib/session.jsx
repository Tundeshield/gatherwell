import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { api } from './api'

const SessionContext = createContext(null)
const BRANCH_KEY = 'gw_branch'

function readBranch(orgId) {
  try { return JSON.parse(localStorage.getItem(BRANCH_KEY) || '{}')[orgId] || 'all' } catch { return 'all' }
}
function writeBranch(orgId, id) {
  try { const all = JSON.parse(localStorage.getItem(BRANCH_KEY) || '{}'); all[orgId] = id; localStorage.setItem(BRANCH_KEY, JSON.stringify(all)) } catch {}
}

export function SessionProvider({ children }) {
  const [me, setMe] = useState(undefined) // undefined = loading, null = signed out
  const [branch, setBranchState] = useState('all')

  const refresh = useCallback(async () => {
    try {
      const data = await api.get('/me')
      setMe(data)
      if (data.org) {
        const saved = readBranch(data.org.id)
        const valid = saved === 'all' || data.branches.some(b => b.id === saved)
        // Single-branch users always work in their branch.
        setBranchState(data.branches.length === 1 ? data.branches[0].id : valid ? saved : 'all')
      }
      return data
    } catch (e) {
      if (e.status === 401) { setMe(null); return null }
      throw e
    }
  }, [])

  useEffect(() => {
    refresh().catch(() => setMe(null))
    const onUnauth = () => setMe(null)
    window.addEventListener('gw:unauthorized', onUnauth)
    return () => window.removeEventListener('gw:unauthorized', onUnauth)
  }, [refresh])

  const setBranch = useCallback((id) => { setBranchState(id); if (me?.org) writeBranch(me.org.id, id) }, [me])

  const value = useMemo(() => {
    const caps = new Set(me?.caps || [])
    const activeBranches = (me?.branches || []).filter(b => b.status === 'active')
    return {
      me, refresh, branch, setBranch,
      can: (cap) => caps.has(cap),
      branches: me?.branches || [],
      activeBranches,
      branchName: (id) => me?.branches?.find(b => b.id === id)?.name,
      multiBranch: (me?.branches || []).length > 1,
      tz: me?.org?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
      logout: async () => { await api.post('/auth/logout').catch(() => {}); setMe(null) },
    }
  }, [me, refresh, branch, setBranch])

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

export function useSession() { return useContext(SessionContext) }

// Branch to send to list endpoints (the user's selection; 'all' means their full scope).
export function useBranchParam() {
  const { branch } = useSession()
  return branch === 'all' ? undefined : branch
}
