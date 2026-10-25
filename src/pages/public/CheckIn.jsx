import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Check, Loader2, ArrowLeft } from 'lucide-react'
import { api } from '../../lib/api'
import { LogoMark } from '../../components/Logo'
import { Button, Notice } from '../../components/ui'
import { fmtDateTime } from '../../lib/format'
import DynamicForm from '../../components/DynamicForm'

const PHONE_KEY = 'gw_checkin_phone'
const readPhone = () => { try { return localStorage.getItem(PHONE_KEY) || '' } catch { return '' } }
const savePhone = (p) => { try { p ? localStorage.setItem(PHONE_KEY, p) : localStorage.removeItem(PHONE_KEY) } catch {} }

export function PublicFrame({ orgName, branchName, children }) {
  return (
    <div className="flex min-h-screen flex-col bg-ivory">
      <div className="mx-auto flex w-full max-w-md flex-1 flex-col px-4 pb-8 pt-6 sm:pt-12">
        {orgName && (
          <div className="mb-5 text-center">
            <div className="text-[15px] font-semibold text-ink">{orgName}</div>
            {branchName && <div className="text-sm text-mist-500">{branchName}</div>}
          </div>
        )}
        <div className="panel flex-none px-5 py-6 sm:px-7 sm:py-8">{children}</div>
        <div className="mt-auto flex items-center justify-center gap-1.5 pt-8 text-xs text-mist-400">
          <LogoMark size={14} /> Powered by Gatherwell
        </div>
      </div>
    </div>
  )
}

export function SuccessMark() {
  return (
    <div className="animate-pop mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-brand-700 text-white">
      <Check size={32} strokeWidth={2.5} />
    </div>
  )
}

export default function CheckIn() {
  const { token } = useParams()
  const [info, setInfo] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [step, setStep] = useState('phone') // phone | confirm | new | done
  const [phone, setPhone] = useState(readPhone())
  const [remember, setRemember] = useState(true)
  const [hint, setHint] = useState('')
  const [firstName, setFirstName] = useState('')
  const [answers, setAnswers] = useState({})
  const [fieldErrors, setFieldErrors] = useState({})
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)

  useEffect(() => { api.get(`/public/g/${token}`).then(setInfo).catch(e => setLoadError(e.message)) }, [token])

  async function lookup(e) {
    e?.preventDefault()
    setError(''); setBusy(true)
    try {
      const r = await api.post(`/public/g/${token}/lookup`, { phone })
      if (r.found) {
        setHint(r.hint)
        setStep('confirm')
      } else {
        setAnswers({ phone })
        setStep('new')
      }
    } catch (err) { setError(err.message) } finally { setBusy(false) }
  }

  async function confirm(e) {
    e.preventDefault()
    setError(''); setBusy(true)
    try {
      const r = await api.post(`/public/g/${token}/checkin`, { mode: 'returning', phone, firstName })
      savePhone(remember ? phone : '')
      setResult({ name: r.firstName, already: r.alreadyCheckedIn, returning: true }); setStep('done')
    } catch (err) { setError(err.message) } finally { setBusy(false) }
  }

  async function submitNew(e) {
    e.preventDefault()
    setError(''); setFieldErrors({}); setBusy(true)
    try {
      const r = await api.post(`/public/g/${token}/checkin`, { mode: 'new', answers })
      savePhone(remember ? answers.phone : '')
      setResult({ name: r.firstName, firstTime: r.firstTime }); setStep('done')
    } catch (err) {
      if (err.details?.code === 'exists') { setPhone(answers.phone); setHint(err.details.hint); setStep('confirm'); setError('') }
      else { setError(err.message); setFieldErrors(err.details?.fields || {}) }
    } finally { setBusy(false) }
  }

  if (loadError) return <PublicFrame><Notice tone="warning" title="Check-in unavailable">{loadError}</Notice></PublicFrame>
  if (!info) return <div className="flex min-h-screen items-center justify-center bg-ivory"><Loader2 className="animate-spin text-brand-600" /></div>

  const tz = info.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone
  const head = (
    <div className="mb-6">
      <h1 className="text-[22px] font-semibold leading-tight text-ink">{info.gathering.name}</h1>
      <p className="mt-1 text-sm text-mist-500">{fmtDateTime(info.gathering.startsAt, tz)}</p>
    </div>
  )

  if (info.gathering.status !== 'open') {
    return (
      <PublicFrame orgName={info.orgName} branchName={info.branchName}>
        {head}
        <Notice tone="info">{info.gathering.status === 'scheduled' ? "Check-in hasn't opened yet. Please try again closer to the start time." : 'Check-in for this session has closed. Please see an usher if you need help.'}</Notice>
      </PublicFrame>
    )
  }

  if (step === 'done') {
    const title = result.already ? "You're already checked in" : result.firstTime ? `Welcome, ${result.name}!` : `Welcome back, ${result.name}!`
    return (
      <PublicFrame orgName={info.orgName} branchName={info.branchName}>
        <div className="py-4 text-center">
          <SuccessMark />
          <h1 className="mt-5 text-[24px] font-semibold text-ink">{title}</h1>
          <p className="mx-auto mt-2 max-w-xs text-[15px] text-mist-500">
            {result.already ? 'Your attendance for this session is already recorded.'
              : result.firstTime ? "We're so glad you're here. Someone from our team may reach out to say hello this week."
              : `You're checked in for ${info.gathering.name}.`}
          </p>
        </div>
      </PublicFrame>
    )
  }

  return (
    <PublicFrame orgName={info.orgName} branchName={info.branchName}>
      {head}
      {error && <Notice tone="danger" className="mb-4">{error}</Notice>}

      {step === 'phone' && (
        <form onSubmit={lookup}>
          <label htmlFor="phone" className="label text-[15px]">Your phone number</label>
          <input id="phone" type="tel" inputMode="tel" autoComplete="tel" value={phone} onChange={e => setPhone(e.target.value)}
            className="field h-12 text-[17px]" placeholder="e.g. 0803 123 4567" autoFocus required />
          <p className="hint">We use it to find your record. New here? We'll ask a few details next.</p>
          <Button type="submit" size="lg" className="mt-5 w-full" loading={busy} disabled={phone.replace(/\D/g, '').length < 7}>Continue</Button>
        </form>
      )}

      {step === 'confirm' && (
        <form onSubmit={confirm}>
          <p className="text-[15px] text-ink">We found <span className="font-semibold">{hint}</span> for this number.</p>
          <label htmlFor="fname" className="label mt-4 text-[15px]">To confirm it's you, type your first name</label>
          <input id="fname" value={firstName} onChange={e => setFirstName(e.target.value)} autoComplete="given-name" className="field h-12 text-[17px]" autoFocus required />
          <label className="mt-4 flex items-center gap-2 text-sm text-mist-600">
            <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} className="h-4 w-4 accent-brand-700" />
            Remember my number on this phone
          </label>
          <Button type="submit" size="lg" className="mt-5 w-full" loading={busy} disabled={!firstName.trim()}>Check in</Button>
          <button type="button" onClick={() => { setStep('phone'); setError(''); setFirstName('') }} className="mt-3 flex w-full items-center justify-center gap-1.5 py-2 text-sm text-mist-500 hover:text-ink">
            <ArrowLeft size={15} /> Use a different number
          </button>
        </form>
      )}

      {step === 'new' && (
        <form onSubmit={submitNew} noValidate>
          <p className="mb-5 text-[15px] text-mist-600">We don't have this number yet — welcome! Tell us a little about you.</p>
          <DynamicForm fields={info.form} values={answers} onChange={setAnswers} errors={fieldErrors} large />
          <label className="mb-1 mt-1 flex items-center gap-2 text-sm text-mist-600">
            <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} className="h-4 w-4 accent-brand-700" />
            Remember my number on this phone
          </label>
          <p className="mb-4 text-xs text-mist-400">{info.orgName} uses these details to record attendance and to welcome you. They're never shared publicly.</p>
          <Button type="submit" size="lg" className="w-full" loading={busy}>Check in</Button>
          <button type="button" onClick={() => setStep('phone')} className="mt-3 flex w-full items-center justify-center gap-1.5 py-2 text-sm text-mist-500 hover:text-ink">
            <ArrowLeft size={15} /> Back
          </button>
        </form>
      )}
    </PublicFrame>
  )
}
