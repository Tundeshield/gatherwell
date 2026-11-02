// Handing children back: the code on the parent's tag must match.
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, Check, ShieldAlert } from 'lucide-react'
import { api } from '../../lib/api'
import { Notice, useToast } from '../../components/ui'

const and = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`)
const time = (d) => new Date(d).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

export default function ChildrenPickup() {
  const toast = useToast()
  const [code, setCode] = useState('')
  const [res, setRes] = useState(null)
  const [picked, setPicked] = useState({})
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function find(e) {
    e?.preventDefault(); setBusy(true); setError(''); setRes(null)
    try {
      const r = await api.post('/children/pickup/lookup', { code })
      setRes(r)
      if (r.found) setPicked(Object.fromEntries(r.checkins.filter(k => !k.pickedUpAt).map(k => [k.id, true])))
    } catch (err) { setError(err.message) } finally { setBusy(false) }
  }
  async function handOver() {
    const ids = Object.keys(picked).filter(id => picked[id])
    setBusy(true); setError('')
    try {
      await api.post('/children/pickup', { checkinIds: ids, code: res.code })
      const names = res.checkins.filter(k => picked[k.id]).map(k => k.firstName)
      toast(`${and(names)} handed over`)
      setCode(''); setRes(null); setPicked({})
    } catch (err) { setError(err.message) } finally { setBusy(false) }
  }

  const waiting = res?.found ? res.checkins.filter(k => !k.pickedUpAt) : []
  const count = Object.values(picked).filter(Boolean).length
  return (
    <div className="min-h-screen bg-ivory">
      <div className="mx-auto flex min-h-screen max-w-lg flex-col px-5 pb-6 pt-4">
        <div className="mb-4 flex items-center gap-2">
          <Link to="/app/children" className="-ml-2 flex h-11 w-11 items-center justify-center rounded-lg hover:bg-white" aria-label="Back to Children’s Church"><ArrowLeft size={20} /></Link>
          <h1 className="text-lg font-semibold text-ink">Pick up</h1>
        </div>
        <form onSubmit={find} className="space-y-2">
          <label htmlFor="pickup-code" className="text-sm font-medium text-ink">Code on the parent’s tag or phone</label>
          <input id="pickup-code" value={code} onChange={e => { setCode(e.target.value.toUpperCase().slice(0, 4)); setRes(null) }} autoFocus autoComplete="off" autoCapitalize="characters"
            className="field h-16 text-center text-[32px] font-extrabold tracking-[0.25em]" placeholder="K7M" />
          <button type="submit" disabled={code.trim().length < 3 || busy} className="h-12 w-full rounded-xl border border-mist-200 bg-white text-sm font-semibold text-ink disabled:opacity-50">Find</button>
        </form>

        {error && <Notice tone="danger" className="mt-4">{error}</Notice>}
        {res && !res.found && (
          <div className="mt-4 rounded-2xl border-2 border-red-600 bg-white px-4 py-4">
            <div className="flex items-center gap-2 font-semibold text-red-700"><ShieldAlert size={20} />No child has code {res.code} today</div>
            <p className="mt-1.5 text-sm text-ink-soft">Don’t hand any child over. Check the code again, or ask the children’s leader to help.</p>
          </div>
        )}

        {res?.found && (
          <div className="mt-4 overflow-hidden rounded-2xl border-2 border-green-700 bg-white">
            <div className="flex items-center gap-2 bg-green-50 px-4 py-3 font-semibold text-green-800"><Check size={19} strokeWidth={2.5} />Code {res.code} matches</div>
            <ul className="divide-y divide-mist-100">
              {res.checkins.map(k => (
                <li key={k.id} className="px-4 py-3">
                  <label className={`flex items-center gap-3 ${k.pickedUpAt ? 'opacity-60' : 'cursor-pointer'}`}>
                    <input type="checkbox" className="h-6 w-6 accent-brand-700" disabled={!!k.pickedUpAt} checked={!!k.pickedUpAt || !!picked[k.id]} onChange={e => setPicked(p => ({ ...p, [k.id]: e.target.checked }))} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[17px] font-semibold text-ink">{k.childName}</span>
                      <span className="block text-[13px] text-mist-500">{k.pickedUpAt ? `Picked up at ${time(k.pickedUpAt)}${k.pickedUpBy ? ` by ${k.pickedUpBy}` : ''}` : `${k.roomName} · in at ${time(k.checkedInAt)}${k.guardianName ? ` by ${k.guardianName}` : ''}`}</span>
                    </span>
                  </label>
                  {!k.pickedUpAt && (k.allowed.length > 0 || k.pickupNotes) && (
                    <div className="mt-2 rounded-lg bg-mist-50 px-3 py-2 text-[13px] text-ink-soft"><b className="text-ink">Allowed to collect:</b> {[...k.allowed, k.pickupNotes].filter(Boolean).join(' · ')}</div>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex-1" />
        {waiting.length > 0 && (
          <button type="button" onClick={handOver} disabled={!count || busy} className="mt-6 h-14 w-full rounded-xl bg-brand-700 text-[17px] font-semibold text-white hover:bg-brand-800 disabled:opacity-50">
            {busy ? 'Saving…' : `Hand over ${and(res.checkins.filter(k => picked[k.id]).map(k => k.firstName)) || '…'}`}
          </button>
        )}
        <p className="mt-4 text-center text-xs text-mist-500">If the code doesn’t match, don’t release the child.</p>
      </div>
    </div>
  )
}
