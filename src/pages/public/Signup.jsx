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
  const [form, setForm] = useState({ orgName: '', branchName: '', name: '', email: '', password: '', country: 'Nigeria', acceptTerms: false })
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
    if (!form.acceptTerms) errs.acceptTerms = 'Please agree to continue.'
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
        <Select label="Country" value={form.country} onChange={set('country')} hint="Sets your timezone and phone number format.">
          {COUNTRIES.map(c => <option key={c.name}>{c.name}</option>)}
        </Select>
        <div className="my-5 border-t border-mist-100" />
        <Input label="Your name" autoComplete="name" value={form.name} onChange={set('name')} error={fieldErrors.name} required />
        <Input label="Email" type="email" autoComplete="email" value={form.email} onChange={set('email')} error={fieldErrors.email} required />
        <Input label="Password" type="password" autoComplete="new-password" value={form.password} onChange={set('password')} error={fieldErrors.password} hint="At least 8 characters." required />
        <label className="mb-4 mt-1 flex items-start gap-2.5 text-sm text-mist-600">
          <input type="checkbox" checked={form.acceptTerms} onChange={e => setForm(f => ({ ...f, acceptTerms: e.target.checked }))} className="mt-0.5 h-4 w-4 shrink-0 accent-brand-700" />
          <span>I agree to the <Link to="/legal/terms" target="_blank" className="link">Terms of Service</Link>, <Link to="/legal/privacy" target="_blank" className="link">Privacy Policy</Link> and <Link to="/legal/dpa" target="_blank" className="link">Data Processing Agreement</Link>, and will collect my church’s information lawfully.</span>
        </label>
        {fieldErrors.acceptTerms && <p className="-mt-2 mb-3 text-xs text-red-700">{fieldErrors.acceptTerms}</p>}
        <Button type="submit" size="lg" className="w-full" loading={loading}>Create account</Button>
      </form>
    </AuthLayout>
  )
}
