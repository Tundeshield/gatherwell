import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../../lib/api'
import { useSession } from '../../lib/session'
import { Button, Input, Select, Notice } from '../../components/ui'
import { signInWithPassword } from '../../lib/firebase'
import AuthLayout from './AuthLayout'

export const COUNTRIES = [
  { name: 'Nigeria', cc: '234', tz: 'Africa/Lagos' },
  { name: "Côte d'Ivoire", cc: '225', tz: 'Africa/Abidjan' },
  { name: 'Ghana', cc: '233', tz: 'Africa/Accra' },
  { name: 'Kenya', cc: '254', tz: 'Africa/Nairobi' },
  { name: 'South Africa', cc: '27', tz: 'Africa/Johannesburg' },
  { name: 'United Kingdom', cc: '44', tz: 'Europe/London' },
  { name: 'United States', cc: '1', tz: 'America/New_York' },
  { name: 'Canada', cc: '1', tz: 'America/Toronto' },
  { name: 'Other', cc: '', tz: Intl.DateTimeFormat().resolvedOptions().timeZone },
]

export default function Signup() {
  const [form, setForm] = useState({ orgName: '', branchName: '', name: '', email: '', password: '', country: 'Nigeria' })
  const [error, setError] = useState('')
  const [fieldErrors, setFieldErrors] = useState({})
  const [loading, setLoading] = useState(false)
  const { refresh } = useSession()
  const navigate = useNavigate()
  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }))

  async function submit(e) {
    e.preventDefault()
    const errs = {}
    if (!form.orgName.trim()) errs.orgName = 'Enter your church name.'
    if (!form.name.trim()) errs.name = 'Enter your name.'
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) errs.email = 'Enter a valid email.'
    if (form.password.length < 8) errs.password = 'Use at least 8 characters.'
    setFieldErrors(errs)
    if (Object.keys(errs).length) return
    setLoading(true); setError('')
    const c = COUNTRIES.find(x => x.name === form.country) || COUNTRIES.at(-1)
    try {
      await api.post('/auth/signup', { ...form, timezone: c.tz, defaultCountryCode: c.cc })
      await signInWithPassword(form.email, form.password)
      await refresh()
      navigate('/app?welcome=1', { replace: true })
    } catch (err) { setError(err.message) }
    finally { setLoading(false) }
  }

  return (
    <AuthLayout title="Create your church account" subtitle="Free for 30 days. No card needed."
      footer={<>Already using GatherHQ? <Link to="/login" className="link">Sign in</Link></>}>
      <form onSubmit={submit} noValidate>
        {error && <Notice tone="danger" className="mb-4">{error}</Notice>}
        <Input label="Church name" placeholder="e.g. Grace Community Church" value={form.orgName} onChange={set('orgName')} error={fieldErrors.orgName} required autoFocus />
        <Input label="First branch or campus" placeholder="Main campus" hint="You can add more branches later." value={form.branchName} onChange={set('branchName')} />
        <Select label="Country" value={form.country} onChange={set('country')} hint="Sets your timezone and phone number format.">
          {COUNTRIES.map(c => <option key={c.name}>{c.name}</option>)}
        </Select>
        <div className="my-5 border-t border-mist-100" />
        <Input label="Your name" autoComplete="name" value={form.name} onChange={set('name')} error={fieldErrors.name} required />
        <Input label="Email" type="email" autoComplete="email" value={form.email} onChange={set('email')} error={fieldErrors.email} required />
        <Input label="Password" type="password" autoComplete="new-password" value={form.password} onChange={set('password')} error={fieldErrors.password} hint="At least 8 characters." required />
        <Button type="submit" size="lg" className="mt-2 w-full" loading={loading}>Create account</Button>
        <p className="mt-4 text-xs text-mist-400">By creating an account you agree to keep your members' information confidential and to collect it with their consent.</p>
      </form>
    </AuthLayout>
  )
}
