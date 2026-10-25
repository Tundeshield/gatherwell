import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useSession } from '../../lib/session'
import { signInWithPassword, sendReset } from '../../lib/firebase'
import { Button, Input, Notice } from '../../components/ui'
import AuthLayout from './AuthLayout'

export default function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(false)
  const [resetMode, setResetMode] = useState(false)
  const { refresh } = useSession()
  const navigate = useNavigate()
  const [params] = useSearchParams()

  async function submit(e) {
    e.preventDefault()
    setLoading(true); setError(''); setNotice('')
    try {
      if (resetMode) {
        await sendReset(email)
        setNotice(`If an account exists for ${email}, a password reset link is on its way. Check your inbox and spam folder.`)
        setResetMode(false)
        return
      }
      await signInWithPassword(email, password)
      const me = await refresh()
      const next = params.get('next')
      navigate(next && next.startsWith('/') && !next.startsWith('//') ? next : me?.org ? '/app' : '/welcome', { replace: true })
    } catch (err) { setError(err.message); setPassword('') }
    finally { setLoading(false) }
  }

  return (
    <AuthLayout title={resetMode ? 'Reset your password' : 'Sign in'} subtitle={resetMode ? "We'll email you a link to choose a new password." : "Welcome back. Sign in to your church's workspace."}
      footer={<>New to Gatherwell? <Link to="/signup" className="link">Create a church account</Link></>}>
      <form onSubmit={submit} noValidate>
        {error && <Notice tone="danger" className="mb-4">{error}</Notice>}
        {notice && <Notice tone="success" className="mb-4">{notice}</Notice>}
        <Input label="Email" type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} required autoFocus />
        {!resetMode && <Input label="Password" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required />}
        <Button type="submit" className="mt-2 w-full" size="lg" loading={loading} disabled={!email || (!resetMode && !password)}>{resetMode ? 'Send reset link' : 'Sign in'}</Button>
      </form>
      <button type="button" onClick={() => { setResetMode(m => !m); setError(''); setNotice('') }} className="mt-4 text-sm text-mist-500 hover:text-ink">
        {resetMode ? 'Back to sign in' : 'Forgot your password?'}
      </button>
    </AuthLayout>
  )
}
