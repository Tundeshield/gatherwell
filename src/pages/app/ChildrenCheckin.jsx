// The children's check-in screen: on a tablet at the door, or a phone at the welcome desk.
// Signed in as a member of the children's team; parents use it themselves.
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Check, Plus, X, Printer, ArrowLeft } from 'lucide-react'
import { api } from '../../lib/api'
import { useSession } from '../../lib/session'
import { Notice, Spinner } from '../../components/ui'
import { printLabels } from '../../components/children/labels'

const big = 'h-14 w-full rounded-xl bg-brand-700 text-[17px] font-semibold text-white hover:bg-brand-800 disabled:opacity-50'
const input = 'field h-12 text-[16px]'
const initials = (n) => n.split(' ').map(x => x[0]).slice(0, 2).join('').toUpperCase()

function Shell({ children, onBack }) {
  const { me } = useSession()
  return (
    <div className="min-h-screen bg-ivory">
      <div className="mx-auto flex min-h-screen max-w-lg flex-col px-5 pb-8 pt-6">
        <div className="mb-6 flex items-center justify-between">
          {onBack ? <button type="button" onClick={onBack} className="-ml-2 flex h-11 w-11 items-center justify-center rounded-lg text-ink hover:bg-white" aria-label="Back"><ArrowLeft size={20} /></button> : <span className="w-11" />}
          <div className="text-center"><div className="text-[13px] font-semibold text-ink">{me.org.name}</div><div className="text-xs text-mist-500">Children’s check-in</div></div>
          <Link to="/app/children" className="flex h-11 items-center rounded-lg px-2 text-xs text-mist-500 hover:bg-white hover:text-ink">Exit</Link>
        </div>
        {children}
      </div>
    </div>
  )
}

function NewFamily({ phone, onDone, onBack }) {
  const [parent, setParent] = useState({ firstName: '', lastName: '', phone })
  const [kids, setKids] = useState([{ firstName: '', lastName: '', birthDate: '', allergies: '' }])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const setKid = (i, k) => (e) => setKids(xs => xs.map((x, j) => (j === i ? { ...x, [k]: e.target.value } : x)))
  async function submit(e) {
    e.preventDefault(); setBusy(true); setError('')
    try {
      const fam = await api.post('/children/register', { parent, children: kids.filter(k => k.firstName.trim()).map(k => ({ ...k, lastName: k.lastName || parent.lastName })) })
      onDone(fam, true)
    } catch (err) { setError(err.message) } finally { setBusy(false) }
  }
  return (
    <Shell onBack={onBack}>
      <form onSubmit={submit} className="flex flex-1 flex-col gap-5">
        <div><h1 className="text-[24px] font-semibold text-ink">Welcome! Let’s add your family</h1><p className="mt-1 text-sm text-mist-500">This takes a minute, once. Next time, just your phone number.</p></div>
        {error && <Notice tone="danger">{error}</Notice>}
        <section className="panel space-y-3 px-4 py-4">
          <div className="text-sm font-semibold text-ink">You</div>
          <div className="grid grid-cols-2 gap-3">
            <input className={input} placeholder="First name" aria-label="Your first name" value={parent.firstName} onChange={e => setParent({ ...parent, firstName: e.target.value })} required />
            <input className={input} placeholder="Last name" aria-label="Your last name" value={parent.lastName} onChange={e => setParent({ ...parent, lastName: e.target.value })} />
          </div>
          <input className={input} type="tel" inputMode="tel" placeholder="Phone number" aria-label="Your phone number" value={parent.phone} onChange={e => setParent({ ...parent, phone: e.target.value })} required />
        </section>
        {kids.map((k, i) => (
          <section key={i} className="panel space-y-3 px-4 py-4">
            <div className="flex items-center justify-between"><div className="text-sm font-semibold text-ink">Child {kids.length > 1 ? i + 1 : ''}</div>
              {kids.length > 1 && <button type="button" onClick={() => setKids(xs => xs.filter((_, j) => j !== i))} className="rounded p-1 text-mist-400 hover:text-ink" aria-label={`Remove child ${i + 1}`}><X size={16} /></button>}</div>
            <div className="grid grid-cols-2 gap-3">
              <input className={input} placeholder="First name" aria-label={`Child ${i + 1} first name`} value={k.firstName} onChange={setKid(i, 'firstName')} required={i === 0} />
              <input className={input} placeholder={parent.lastName || 'Last name'} aria-label={`Child ${i + 1} last name`} value={k.lastName} onChange={setKid(i, 'lastName')} />
            </div>
            <label className="block text-xs text-mist-500">Date of birth (places them in the right class)
              <input className={`${input} mt-1`} type="date" max={new Date().toISOString().slice(0, 10)} value={k.birthDate} onChange={setKid(i, 'birthDate')} required />
            </label>
            <input className={input} placeholder="Allergies (if any)" aria-label={`Child ${i + 1} allergies`} value={k.allergies} onChange={setKid(i, 'allergies')} />
          </section>
        ))}
        <button type="button" onClick={() => setKids(xs => [...xs, { firstName: '', lastName: '', birthDate: '', allergies: '' }])} className="flex items-center gap-2 self-start text-sm font-medium text-brand-700"><Plus size={17} />Add another child</button>
        <div className="flex-1" />
        <button type="submit" className={big} disabled={busy}>{busy ? 'Saving…' : 'Continue'}</button>
        <p className="text-center text-xs text-mist-500">Your details are kept by the church to keep your children safe, and only seen by the children’s team.</p>
      </form>
    </Shell>
  )
}

function AddChildInline({ guardian, onAdded }) {
  const [open, setOpen] = useState(false)
  const [k, setK] = useState({ firstName: '', birthDate: '', allergies: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  if (!open) return <button type="button" onClick={() => setOpen(true)} className="flex items-center gap-2 self-start text-sm font-medium text-brand-700"><Plus size={17} />Add another child</button>
  return (
    <form className="panel space-y-3 px-4 py-4" onSubmit={async e => {
      e.preventDefault(); setBusy(true); setError('')
      try { const c = await api.post('/children', { ...k, lastName: guardian.lastName, guardianIds: [guardian.id] }); onAdded(c.id); setOpen(false); setK({ firstName: '', birthDate: '', allergies: '' }) } catch (err) { setError(err.message) } finally { setBusy(false) }
    }}>
      {error && <Notice tone="danger">{error}</Notice>}
      <input className={input} placeholder="Child’s first name" aria-label="Child’s first name" value={k.firstName} onChange={e => setK({ ...k, firstName: e.target.value })} required />
      <label className="block text-xs text-mist-500">Date of birth<input className={`${input} mt-1`} type="date" max={new Date().toISOString().slice(0, 10)} value={k.birthDate} onChange={e => setK({ ...k, birthDate: e.target.value })} required /></label>
      <input className={input} placeholder="Allergies (if any)" aria-label="Allergies" value={k.allergies} onChange={e => setK({ ...k, allergies: e.target.value })} />
      <div className="flex gap-2"><button type="submit" disabled={busy} className="h-11 flex-1 rounded-lg bg-brand-700 text-sm font-semibold text-white">Add</button><button type="button" onClick={() => setOpen(false)} className="h-11 rounded-lg border border-mist-200 px-4 text-sm">Cancel</button></div>
    </form>
  )
}

export default function ChildrenCheckin() {
  const { me } = useSession()
  const [step, setStep] = useState('phone')
  const [phone, setPhone] = useState('')
  const [fam, setFam] = useState(null)
  const [picked, setPicked] = useState({})
  const [roomPick, setRoomPick] = useState({})
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const timer = useRef(null)
  const labelsOn = me.org.kidsLabels !== 'none'

  const reset = () => { clearTimeout(timer.current); setStep('phone'); setPhone(''); setFam(null); setPicked({}); setRoomPick({}); setResult(null); setError('') }
  useEffect(() => () => clearTimeout(timer.current), [])

  function showFamily(f) {
    setFam(f)
    setPicked(Object.fromEntries(f.children.filter(c => !c.checkedIn).map(c => [c.id, true])))
    setStep('family'); setError('')
  }
  async function lookup(e) {
    e.preventDefault(); setBusy(true); setError('')
    try {
      const r = await api.post('/children/lookup', { phone })
      if (!r.found) { setStep('notfound'); return }
      showFamily(r)
    } catch (err) { setError(err.message) } finally { setBusy(false) }
  }
  async function refreshFamily(newId) {
    const r = await api.get(`/children/checkin-family/${fam.guardian.id}`)
    setFam(r); setPicked(p => ({ ...p, [newId]: true }))
  }
  async function checkIn() {
    setBusy(true); setError('')
    const ids = Object.keys(picked).filter(id => picked[id])
    try {
      const r = await api.post('/children/checkin', { guardianId: fam.guardian.id, childIds: ids, rooms: roomPick })
      setResult(r); setStep('done')
      const fresh = r.checkins.filter(k => !k.alreadyCheckedIn)
      if (labelsOn && fresh.length) printLabels({ checkins: fresh, code: r.code, orgName: me.org.name })
      timer.current = setTimeout(reset, 45000)
    } catch (err) { setError(err.details?.code === 'room_required' ? `${err.message} Choose it below.` : err.message) } finally { setBusy(false) }
  }

  if (step === 'new') return <NewFamily phone={phone} onBack={reset} onDone={showFamily} />

  if (step === 'done' && result) {
    return (
      <Shell>
        <div className="flex flex-1 flex-col items-center text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-brand-700 text-white"><Check size={32} strokeWidth={2.5} /></div>
          <h1 className="mt-5 text-[24px] font-semibold text-ink">You’re checked in</h1>
          <p className="mt-1 text-sm text-mist-500">Keep this code. You’ll need it to collect your {result.checkins.length === 1 ? 'child' : 'children'}.</p>
          <div className="mt-6 w-full rounded-2xl border-t-8 border-brand-700 bg-white px-6 py-6 shadow-card">
            <div className="text-xs font-semibold uppercase tracking-wider text-mist-500">Pickup code</div>
            <div className="mt-1 text-[64px] font-extrabold leading-none tracking-[0.12em] text-ink">{result.code}</div>
          </div>
          <ul className="mt-5 w-full space-y-2 text-left">
            {result.checkins.map(k => (
              <li key={k.id} className="flex items-center justify-between rounded-xl bg-white px-4 py-3 text-sm shadow-card">
                <span className="font-medium text-ink">{k.firstName}</span>
                <span className="text-mist-600">{k.roomName}{k.alreadyCheckedIn ? ' · already in' : ''}</span>
              </li>
            ))}
          </ul>
          <div className="flex-1" />
          <div className="mt-6 flex w-full flex-col gap-3">
            {labelsOn && <button type="button" onClick={() => printLabels({ checkins: result.checkins, code: result.code, orgName: me.org.name })} className="flex h-12 items-center justify-center gap-2 rounded-xl border border-mist-200 bg-white text-sm font-medium text-ink"><Printer size={17} />Print labels again</button>}
            <button type="button" onClick={reset} className={big}>Done</button>
          </div>
        </div>
      </Shell>
    )
  }

  if (step === 'family' && fam) {
    const count = Object.values(picked).filter(Boolean).length
    return (
      <Shell onBack={reset}>
        <div className="flex flex-1 flex-col gap-4">
          <div className="panel px-5 py-4"><h1 className="text-[21px] font-semibold text-ink">Welcome{fam.children.length ? ' back' : ''}, {fam.guardian.firstName}</h1><p className="mt-0.5 text-sm text-mist-500">Tap the children who are here today.</p></div>
          {error && <Notice tone="danger">{error}</Notice>}
          {fam.children.length === 0 && <p className="text-sm text-mist-500">No children are linked to you yet. Add them below.</p>}
          {fam.children.map(c => {
            const on = !!picked[c.id]
            return (
              <div key={c.id}>
                <label className={`flex cursor-pointer items-center gap-4 rounded-2xl border-2 bg-white px-4 py-3.5 ${c.checkedIn ? 'border-mist-200 opacity-70' : on ? 'border-brand-700' : 'border-mist-200'}`}>
                  <input type="checkbox" className="h-6 w-6 accent-brand-700" checked={c.checkedIn || on} disabled={c.checkedIn} onChange={e => setPicked(p => ({ ...p, [c.id]: e.target.checked }))} />
                  <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full font-semibold ${c.allergies ? 'bg-gold-100 text-gold-700' : 'bg-brand-100 text-brand-700'}`}>{initials(c.name)}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[16px] font-semibold text-ink">{c.name}</span>
                    <span className="block text-[13px] text-mist-500">{c.checkedIn ? `Already checked in · ${c.code}` : <>{c.age != null ? `Age ${c.age} · ` : ''}{c.room ? <>goes to <b className="font-semibold text-ink">{c.room.name}</b></> : 'choose a class'}</>}</span>
                    {c.allergies && <span className="mt-1 inline-block rounded-md bg-red-50 px-2 py-0.5 text-xs font-semibold text-red-700">Allergy: {c.allergies}</span>}
                  </span>
                </label>
                {!c.room && on && !c.checkedIn && (
                  <select className="field mt-2" aria-label={`Class for ${c.firstName}`} value={roomPick[c.id] || ''} onChange={e => setRoomPick(r => ({ ...r, [c.id]: e.target.value }))}>
                    <option value="">Choose a class for {c.firstName}</option>
                    {fam.rooms.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                  </select>
                )}
              </div>
            )
          })}
          <AddChildInline guardian={fam.guardian} onAdded={refreshFamily} />
          <div className="flex-1" />
          <div className="text-center text-xs text-mist-500">Checking in as {fam.guardian.name}{fam.guardian.phone ? ` · ${fam.guardian.phone.replace(/\d(?=\d{4})/g, '•')}` : ''}. <button type="button" onClick={reset} className="link">Not you?</button></div>
          <button type="button" className={big} disabled={!count || busy} onClick={checkIn}>{busy ? 'Checking in…' : count ? `Check in ${count} ${count === 1 ? 'child' : 'children'}` : 'Choose a child'}</button>
          {labelsOn && <p className="text-center text-xs text-mist-500">Name labels and your pickup tag print next.</p>}
        </div>
      </Shell>
    )
  }

  return (
    <Shell>
      <form onSubmit={lookup} className="flex flex-1 flex-col gap-5">
        <div className="pt-6 text-center">
          <h1 className="text-[28px] font-semibold text-ink">Children’s check-in</h1>
          <p className="mt-2 text-[15px] text-mist-500">Enter the parent’s phone number.</p>
        </div>
        {error && <Notice tone="danger">{error}</Notice>}
        {step === 'notfound' && <Notice tone="info" title="We don’t know this number yet">If this is your first time, add your family. It only takes a minute.</Notice>}
        <input className="field h-16 text-center text-[24px] tracking-wider" type="tel" inputMode="tel" autoComplete="off" placeholder="0803 000 0000" aria-label="Parent’s phone number" value={phone} onChange={e => { setPhone(e.target.value); if (step === 'notfound') setStep('phone') }} autoFocus />
        <button type="submit" className={big} disabled={busy || phone.replace(/\D/g, '').length < 7}>{busy ? <Spinner className="mx-auto" /> : 'Find my family'}</button>
        <div className="flex-1" />
        <button type="button" onClick={() => setStep('new')} className={`h-14 w-full rounded-xl border-2 text-[16px] font-semibold ${step === 'notfound' ? 'border-brand-700 bg-white text-brand-700' : 'border-mist-200 bg-white text-ink'}`}>First time? Add your family</button>
      </form>
    </Shell>
  )
}
