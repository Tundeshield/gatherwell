import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Loader2, MapPin, CalendarDays, Users, CalendarPlus } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import { api } from '../../lib/api'
import { Button, Notice } from '../../components/ui'
import { fmtDateTime, fmtTime } from '../../lib/format'
import DynamicForm from '../../components/DynamicForm'
import { PublicFrame, SuccessMark } from './CheckIn'
import { COLORS } from '../../brand'

function icsFile(ev, orgName) {
  const stamp = (d) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  const end = ev.endsAt || new Date(new Date(ev.startsAt).getTime() + 2 * 3600e3).toISOString()
  const esc = (s) => String(s || '').replace(/[\\;,]/g, (m) => '\\' + m).replace(/\n/g, '\\n')
  const body = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Gatherwell//EN', 'BEGIN:VEVENT',
    `UID:${stamp(ev.startsAt)}-${Math.random().toString(36).slice(2)}@gatherwell`, `DTSTAMP:${stamp(new Date())}`,
    `DTSTART:${stamp(ev.startsAt)}`, `DTEND:${stamp(end)}`, `SUMMARY:${esc(ev.name)}`,
    `LOCATION:${esc(ev.location)}`, `DESCRIPTION:${esc(`${orgName}\n${ev.description || ''}`)}`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n')
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([body], { type: 'text/calendar' }))
  a.download = `${ev.name.replace(/[^\w]+/g, '-')}.ics`
  a.click()
}

export default function EventRegister() {
  const { token } = useParams()
  const [info, setInfo] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [answers, setAnswers] = useState({})
  const [errors, setErrors] = useState({})
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(null)
  useEffect(() => { api.get(`/public/e/${token}`).then(setInfo).catch(e => setLoadError(e.message)) }, [token])

  async function submit(e) {
    e.preventDefault()
    setBusy(true); setError(''); setErrors({})
    try { setDone(await api.post(`/public/e/${token}/register`, { answers })) }
    catch (err) { setError(err.message); setErrors(err.details?.fields || {}) }
    finally { setBusy(false) }
  }

  if (loadError) return <PublicFrame><Notice tone="warning" title="Event unavailable">{loadError}</Notice></PublicFrame>
  if (!info) return <div className="flex min-h-screen items-center justify-center bg-ivory"><Loader2 className="animate-spin text-brand-600" /></div>
  const ev = info.event
  const tz = info.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone

  if (done) {
    return (
      <PublicFrame orgName={info.orgName} branchName={info.branchName}>
        <div className="text-center">
          <SuccessMark />
          <h1 className="mt-5 text-[22px] font-semibold text-ink">{done.status === 'waitlist' ? "You're on the waitlist" : "You're registered"}</h1>
          <p className="mx-auto mt-2 max-w-xs text-[15px] text-mist-500">
            {done.status === 'waitlist' ? "The event is full right now. If a place opens up, you'll be moved onto the list automatically." : `See you at ${ev.name}. Show this code at the door.`}
          </p>
          <div className="mx-auto mt-6 inline-block rounded-xl border border-mist-200 p-4">
            <QRCodeSVG value={done.code} size={168} fgColor={COLORS.navy} level="M" />
            <div className="tabular mt-3 text-2xl font-semibold tracking-[0.2em] text-ink">{done.code}</div>
          </div>
          <p className="mt-3 text-xs text-mist-400">Take a screenshot to keep your ticket.</p>
          <Button variant="secondary" icon={CalendarPlus} className="mt-5" onClick={() => icsFile(ev, info.orgName)}>Add to calendar</Button>
        </div>
      </PublicFrame>
    )
  }

  const state = info.registration
  const sameDay = ev.endsAt && new Date(ev.endsAt).toDateString() === new Date(ev.startsAt).toDateString()
  return (
    <PublicFrame orgName={info.orgName} branchName={info.branchName}>
      <h1 className="text-[24px] font-semibold leading-tight text-ink">{ev.name}</h1>
      <ul className="mt-4 space-y-2 text-[15px] text-mist-600">
        <li className="flex gap-2.5"><CalendarDays size={18} className="mt-0.5 shrink-0 text-brand-600" />
          {fmtDateTime(ev.startsAt, tz)}{ev.endsAt && (sameDay ? ` – ${fmtTime(ev.endsAt, tz)}` : ` – ${fmtDateTime(ev.endsAt, tz)}`)}</li>
        {ev.location && <li className="flex gap-2.5"><MapPin size={18} className="mt-0.5 shrink-0 text-brand-600" />{ev.location}</li>}
        {ev.capacity && <li className="flex gap-2.5"><Users size={18} className="mt-0.5 shrink-0 text-brand-600" />
          {ev.spotsLeft > 0 ? `${ev.spotsLeft} of ${ev.capacity} places left` : 'Full — new registrations join the waitlist'}</li>}
      </ul>
      {ev.description && <p className="mt-4 whitespace-pre-line text-[15px] leading-relaxed text-ink-soft">{ev.description}</p>}
      <div className="my-6 border-t border-mist-100" />
      {state === 'open' ? (
        <form onSubmit={submit} noValidate>
          {error && <Notice tone="danger" className="mb-4">{error}</Notice>}
          <DynamicForm fields={info.form} values={answers} onChange={setAnswers} errors={errors} large />
          <Button type="submit" size="lg" className="w-full" loading={busy}>{ev.capacity && ev.spotsLeft === 0 ? 'Join the waitlist' : 'Register'}</Button>
        </form>
      ) : (
        <Notice tone="info">
          {{ not_yet: `Registration opens ${fmtDateTime(ev.registrationOpensAt, tz)}.`, closed: 'Registration for this event has closed.', cancelled: 'This event has been cancelled.', postponed: 'This event has been postponed. Check back for a new date.' }[state]}
        </Notice>
      )}
    </PublicFrame>
  )
}
