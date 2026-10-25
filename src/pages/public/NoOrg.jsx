import { useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { api } from '../../lib/api'
import { useSession } from '../../lib/session'
import { Button, Input, Notice, PageLoader } from '../../components/ui'
import AuthLayout from './AuthLayout'

// Shown to signed-in users who aren't part of any active church (e.g. access revoked).
export default function NoOrg() {
  const { me, refresh, logout } = useSession()
  const navigate = useNavigate()
  const [orgName, setOrgName] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  if (me === undefined) return <PageLoader />
  if (!me) return <Navigate to="/login" replace />
  if (me.org) return <Navigate to="/app" replace />

  async function create(e) {
    e.preventDefault()
    setLoading(true); setError('')
    try {
      await api.post('/me/orgs', { orgName, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone })
      await refresh(); navigate('/app', { replace: true })
    } catch (err) { setError(err.message) } finally { setLoading(false) }
  }

  return (
    <AuthLayout title={`Hi ${me.user.name.split(' ')[0]}`} subtitle="You're not part of an active church on Gatherwell right now."
      footer={<button className="link" onClick={async () => { await logout(); navigate('/login') }}>Sign out</button>}>
      <p className="mb-5 text-sm text-mist-600">If you were expecting access, ask your church admin to send you an invitation link. Or start a new church account:</p>
      <form onSubmit={create}>
        {error && <Notice tone="danger" className="mb-4">{error}</Notice>}
        <Input label="Church name" value={orgName} onChange={e => setOrgName(e.target.value)} required />
        <Button type="submit" className="w-full" loading={loading}>Create church account</Button>
      </form>
    </AuthLayout>
  )
}
