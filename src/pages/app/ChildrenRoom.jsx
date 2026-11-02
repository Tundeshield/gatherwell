// A teacher's view of one class today: who's in, alerts first, calling a parent, and the adult count.
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Minus, Plus, Phone, MessageCircle, RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { useSession } from '../../lib/session'
import { useLoad, PageLoader, ErrorState, useToast } from '../../components/ui'

const time = (d) => new Date(d).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

function Kid({ k, org }) {
  const wa = k.guardianPhone ? `https://wa.me/${String(k.guardianPhone).replace(/\D/g, '')}?text=${encodeURIComponent(`Hi ${String(k.guardianName || '').split(' ')[0]}, this is ${org} children’s church. Could you come to ${k.roomName} for ${k.firstName}, please?`)}` : null
  return (
    <li className="rounded-xl border border-mist-200 bg-white px-3.5 py-3">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-semibold text-ink">{k.childName} <span className="text-[13px] font-normal text-mist-500">· {k.code}</span></div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {k.alert && <span className="rounded-md bg-red-50 px-2 py-0.5 text-xs font-semibold text-red-700">Allergy: {k.alert}</span>}
            {k.medical && <span className="rounded-md bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800">{k.medical}</span>}
            {k.firstTime && <span className="rounded-md bg-gold-100 px-2 py-0.5 text-xs font-medium text-gold-700">First visit</span>}
            {!k.alert && !k.medical && !k.firstTime && <span className="text-xs text-mist-500">In at {time(k.checkedInAt)}{k.guardianName ? ` · ${k.guardianName}` : ''}</span>}
          </div>
        </div>
        {(k.alert || k.medical || k.firstTime) && k.guardianPhone && (
          <div className="flex shrink-0 gap-1">
            {wa && <a href={wa} target="_blank" rel="noreferrer" aria-label={`WhatsApp ${k.guardianName}`} className="flex h-10 w-10 items-center justify-center rounded-lg border border-mist-200 text-ink"><MessageCircle size={17} /></a>}
            <a href={`tel:${k.guardianPhone.replace(/\s/g, '')}`} aria-label={`Call ${k.guardianName}`} className="flex h-10 w-10 items-center justify-center rounded-lg border border-mist-200 text-ink"><Phone size={17} /></a>
          </div>
        )}
      </div>
      {!(k.alert || k.medical || k.firstTime) && k.guardianPhone && (
        <div className="mt-2 flex gap-2">
          {wa && <a href={wa} target="_blank" rel="noreferrer" className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-mist-200 px-3 text-xs font-medium text-ink"><MessageCircle size={14} />Message parent</a>}
          <a href={`tel:${k.guardianPhone.replace(/\s/g, '')}`} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-mist-200 px-3 text-xs font-medium text-ink"><Phone size={14} />Call</a>
        </div>
      )}
    </li>
  )
}

export default function ChildrenRoom() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { me, can } = useSession()
  const toast = useToast()
  const { data, error, loading, reload } = useLoad(() => api.get(`/children/rooms/${id}/today`), [id])
  const [adults, setAdults] = useState(null)
  useEffect(() => { if (data) setAdults(data.room.adults) }, [data])
  // Keep the list fresh while a teacher has it open.
  useEffect(() => { const t = setInterval(() => reload(), 30000); return () => clearInterval(t) }, [id]) // eslint-disable-line react-hooks/exhaustive-deps
  if (loading && !data) return <PageLoader />
  if (error) return <ErrorState error={error} onRetry={reload} />
  const r = data.room
  const inRoom = data.checkins.filter(k => !k.pickedUpAt)
  const gone = data.checkins.filter(k => k.pickedUpAt)
  const flagged = inRoom.filter(k => k.alert || k.medical || k.firstTime)
  const rest = inRoom.filter(k => !(k.alert || k.medical || k.firstTime))
  const needed = r.ratio ? Math.ceil(inRoom.length / r.ratio) : 0
  const short = Math.max(0, needed - (adults ?? 0))

  async function setCount(n) {
    if (n < 0) return
    setAdults(n)
    try { await api.post(`/children/rooms/${id}/adults`, { adults: n }) } catch (e) { toast(e.message, 'error'); reload() }
  }

  return (
    <div className="min-h-screen bg-ivory">
      <div className="mx-auto max-w-lg">
        <header className="bg-brand-700 px-5 pb-5 pt-4 text-white">
          <div className="flex items-center justify-between">
            <Link to="/app/children" className="-ml-2 flex h-11 w-11 items-center justify-center rounded-lg hover:bg-white/10" aria-label="Back to Children’s Church"><ArrowLeft size={20} /></Link>
            <button type="button" onClick={reload} className="flex h-11 w-11 items-center justify-center rounded-lg hover:bg-white/10" aria-label="Refresh"><RefreshCw size={17} /></button>
          </div>
          <label className="block">
            <span className="text-xs text-brand-200">{r.location ? `${r.location} · ` : ''}Today</span>
            <select value={id} onChange={e => navigate(`/app/children/rooms/${e.target.value}`, { replace: true })} aria-label="Class"
              className="mt-0.5 block w-full appearance-none bg-transparent text-[22px] font-semibold text-white focus:outline-none">
              {data.rooms.map(x => <option key={x.id} value={x.id} className="text-ink">{x.name}</option>)}
            </select>
          </label>
          <div className="mt-4 grid grid-cols-3 gap-2">
            <div className="rounded-xl bg-white/10 px-3 py-2.5"><div className="text-[22px] font-semibold">{inRoom.length}</div><div className="text-xs text-brand-100">in the room</div></div>
            <div className="rounded-xl bg-white/10 px-3 py-2.5"><div className="text-[22px] font-semibold">{gone.length}</div><div className="text-xs text-brand-100">picked up</div></div>
            <div className={`rounded-xl px-3 py-2.5 ${short ? 'bg-gold-500 text-ink' : 'bg-white/10'}`}>
              <div className="flex items-center justify-between">
                {can('children.checkin') && <button type="button" onClick={() => setCount((adults ?? 0) - 1)} aria-label="One fewer adult" className="flex h-7 w-7 items-center justify-center rounded-md bg-black/10"><Minus size={14} /></button>}
                <span className="text-[22px] font-semibold">{adults ?? 0}</span>
                {can('children.checkin') && <button type="button" onClick={() => setCount((adults ?? 0) + 1)} aria-label="One more adult" className="flex h-7 w-7 items-center justify-center rounded-md bg-black/10"><Plus size={14} /></button>}
              </div>
              <div className={`text-center text-xs ${short ? '' : 'text-brand-100'}`}>{r.ratio ? `adults · ${needed} needed` : 'adults'}</div>
            </div>
          </div>
        </header>

        <div className="space-y-4 px-4 py-4">
          {short > 0 && <div className="rounded-xl border border-gold-200 bg-gold-50 px-3.5 py-2.5 text-sm text-gold-700">{short === 1 ? 'One more adult is' : `${short} more adults are`} needed for {inRoom.length} children (1 adult for every {r.ratio}).</div>}
          {r.capacity && inRoom.length >= r.capacity && <div className="rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-800">This class is full ({r.capacity} places).</div>}

          {inRoom.length === 0 && <p className="py-10 text-center text-sm text-mist-500">No children in this class yet.</p>}
          {flagged.length > 0 && <div><h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-mist-500">Alerts and first visits</h2><ul className="space-y-2">{flagged.map(k => <Kid key={k.id} k={k} org={me.org.name} />)}</ul></div>}
          {rest.length > 0 && <div><h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-mist-500">In the room</h2><ul className="space-y-2">{rest.map(k => <Kid key={k.id} k={k} org={me.org.name} />)}</ul></div>}
          {gone.length > 0 && <div><h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-mist-500">Picked up</h2>
            <ul className="divide-y divide-mist-100 rounded-xl border border-mist-200 bg-white">{gone.map(k => <li key={k.id} className="flex justify-between px-3.5 py-2.5 text-sm"><span className="text-mist-600">{k.childName}</span><span className="text-mist-500">{time(k.pickedUpAt)}</span></li>)}</ul></div>}
        </div>

        {can('children.checkin') && <div className="sticky bottom-0 bg-gradient-to-t from-ivory via-ivory px-4 pb-5 pt-3">
          <Link to="/app/children/pickup" className="flex h-14 items-center justify-center rounded-xl bg-brand-700 text-[16px] font-semibold text-white hover:bg-brand-800">Pick up a child</Link>
        </div>}
      </div>
    </div>
  )
}
