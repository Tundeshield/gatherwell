import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api } from '../../lib/api'
import { useSession } from '../../lib/session'
import { Button, Input, Notice, PageLoader } from '../../components/ui'
import AuthLayout from './AuthLayout'

export default function AcceptInvite() {
  const { token } = useParams()
  const [invite, setInvite] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const { refresh } = useSession()
  const navigate = useNavigate()

  useEffect(() => { api.get(`/public/invite/${token}`).then(setInvite).catch(e => setLoadError(e.message)) }, [token])

  async function submit(e) {
    e.preventDefault()
    setLoading(true); setError('')
    try {
      await api.post('/auth/accept-invite', { token, name, password })
      await refresh()
      navigate('/app', { replace: true })
    } catch (err) { setError(err.message) }
    finally { setLoading(false) }
  }

  if (loadError) return (
    <AuthLayout title="Invitation unavailable" footer={<Link to="/login" className="link">Go to sign in</Link>}>
      <Notice tone="warning">{loadError}</Notice>
    </AuthLayout>
  )
  if (!invite) return <PageLoader />

  return (
    <AuthLayout title={`Join ${invite.orgName}`} subtitle={`You've been invited as ${invite.roleLabel.toLowerCase()} (${invite.email}).`}>
      <form onSubmit={submit}>
        {error && <Notice tone="danger" className="mb-4">{error}</Notice>}
        {invite.hasAccount ? (
          <>
            <p className="mb-4 text-sm text-mist-500">You already have a Gatherwell account. Enter your password to accept.</p>
            <Input label="Password" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required autoFocus />
          </>
        ) : (
          <>
            <Input label="Your name" autoComplete="name" value={name} onChange={e => setName(e.target.value)} required autoFocus />
            <Input label="Create a password" type="password" autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} hint="At least 8 characters." required />
          </>
        )}
        <Button type="submit" size="lg" className="mt-2 w-full" loading={loading}>Accept invitation</Button>
      </form>
    </AuthLayout>
  )
}
