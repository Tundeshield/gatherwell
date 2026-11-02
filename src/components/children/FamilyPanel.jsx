// The "Family" panel on a person's page: their children, with alerts and who else can collect them.
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Plus, Baby } from 'lucide-react'
import { api } from '../../lib/api'
import { useSession } from '../../lib/session'
import { useLoad, Button, Skeleton } from '../ui'
import ChildForm from './ChildForm'

export default function FamilyPanel({ person }) {
  const { can } = useSession()
  const { data, loading, error, reload } = useLoad(() => api.get(`/children/family/${person.id}`), [person.id])
  const [editing, setEditing] = useState(undefined)
  if (error) return null
  const me = { id: person.id, name: [person.first_name, person.last_name].filter(Boolean).join(' '), phone: person.phone }
  const others = (data?.adults || []).filter(a => a.id !== person.id)
  // Sundays (days) of the last 8 weeks, to show who came.
  const recentDays = (days) => {
    const cutoff = new Date(Date.now() - 56 * 86400e3).toISOString().slice(0, 10)
    return days.filter(d => d >= cutoff).length
  }
  return (
    <section className="panel px-5 py-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[15px] font-semibold text-ink">Family</h2>
        {can('children.edit') && <Button size="sm" variant="secondary" icon={Plus} onClick={() => setEditing(null)}>Add child</Button>}
      </div>
      {loading && !data ? <Skeleton className="mt-3 h-16" /> : data.children.length === 0 ? (
        <p className="mt-2 text-sm text-mist-500">No children linked. Children added at children’s check-in appear here.</p>
      ) : (
        <ul className="mt-3 space-y-3">
          {data.children.map(c => (
            <li key={c.id}>
              <button type="button" onClick={() => can('children.edit') && setEditing(c)} className="w-full rounded-xl border border-mist-200 px-3.5 py-3 text-left hover:border-mist-300">
                <div className="flex items-center gap-3">
                  <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${c.allergies ? 'bg-gold-100 text-gold-700' : 'bg-brand-50 text-brand-700'}`}><Baby size={17} /></span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium text-ink">{c.name}</span>
                    <span className="block text-xs text-mist-500">{c.age != null ? `Age ${c.age}` : 'Age not set'}{c.room ? ` · ${c.room.name}` : ''} · {recentDays(c.days)} of the last 8 weeks</span>
                  </span>
                </div>
                {(c.allergies || c.medical) && <div className="mt-2 rounded-lg bg-red-50 px-2.5 py-1.5 text-xs text-red-800">{c.allergies && <><b>Allergy:</b> {c.allergies}. </>}{c.medical}</div>}
                {c.pickupNotes && <div className="mt-1.5 text-xs text-mist-600"><b className="text-ink">Also collects:</b> {c.pickupNotes}</div>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {others.length > 0 && <p className="mt-3 text-xs text-mist-500">Other parents: {others.map((a, i) => <span key={a.id}>{i > 0 && ', '}<Link to={`/app/people/${a.id}`} className="hover:underline">{a.name}</Link></span>)}</p>}
      {data && <ChildForm open={editing !== undefined} onClose={() => setEditing(undefined)} child={editing} rooms={data.rooms} defaultGuardian={me} onSaved={reload} />}
    </section>
  )
}
