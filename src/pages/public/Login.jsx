import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '../../lib/api'
import { useSession } from '../../lib/session'
import { Button, Input, Notice } from '../../components/ui'
import AuthLayout from './AuthLayout'

export default function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const { refresh } = useSession()
  const navigate = useNavigate()
  const [params] = useSearchParams()

  async function submit(e) {
    e.preventDefault()
    setLoading(true); setError('')
    try {
      await api.post('/auth/login', { email, password })
      const me = await refresh()
      const next = params.get('next')
      navigate(next && next.startsWith('/') && !next.startsWith('//') ? next : me?.org ? '/app' : '/welcome', { replace: true })
    } catch (err) { setError(err.message); setPassword('') }
    finally { setLoading(false) }
  }

  return (
    <AuthLayout title="Sign in" subtitle="Welcome back. Sign in to your church's workspace."
      footer={<>New to Gatherwell? <Link to="/signup" className="link">Create a church account</Link></>}>
      <form onSubmit={submit} noValidate>
        {error && <Notice tone="danger" className="mb-4">{error}</Notice>}
        <Input label="Email" type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} required autoFocus />
        <Input label="Password" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required />
        <Button type="submit" className="mt-2 w-full" size="lg" loading={loading} disabled={!email || !password}>Sign in</Button>
      </form>
      <p className="mt-5 text-xs text-mist-400">Forgot your password? Ask your church's Gatherwell owner to send you a new invitation link.</p>
    </AuthLayout>
  )
}
