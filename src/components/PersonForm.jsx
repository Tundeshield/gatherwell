import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api'
import { useSession, useBranchParam } from '../lib/session'
import { useLoad, Button, Input, Select, Textarea, Notice } from './ui'
import { STATUS_LABELS } from '../lib/format'

export default function PersonForm({ person, onSaved, onCancel }) {
  const { activeBranches, can } = useSession()
  const branchParam = useBranchParam()
  const units = useLoad(() => api.get('/units'), [])
  const team = useLoad(() => api.get('/team/assignees').catch(() => []), [])
  const [f, setF] = useState(() => ({
    firstName: person?.first_name || '', lastName: person?.last_name || '', phone: person?.phone || '', email: person?.email || '',
    status: person?.status || 'visitor', branchId: person?.branch_id || branchParam || activeBranches[0]?.id || '',
    unitId: person?.unit_id || '', gender: person?.gender || '', birthday: person?.birthday ? String(person.birthday).slice(0, 10) : '',
    joinedAt: person?.joined_at ? String(person.joined_at).slice(0, 10) : '', notes: person?.notes || '', ownerUserId: person?.owner_user_id || '',
  }))
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const set = (k) => (e) => setF(x => ({ ...x, [k]: e.target.value }))

  async function submit(e) {
    e.preventDefault()
    setBusy(true); setError(null)
    const body = { ...f, unitId: f.unitId || null, gender: f.gender || null, birthday: f.birthday || null, joinedAt: f.joinedAt || null, ownerUserId: f.ownerUserId || null }
    try {
      const saved = person ? await api.patch(`/people/${person.id}`, body) : await api.post('/people', body)
      onSaved(saved)
    } catch (err) { setError(err) } finally { setBusy(false) }
  }

  return (
    <form onSubmit={submit}>
      {error && (
        <Notice tone="danger" className="mb-4">
          {error.message}{error.details?.existingId && <> <Link to={`/app/people/${error.details.existingId}`} className="font-medium underline">Open their profile</Link></>}
        </Notice>
      )}
      <div className="grid gap-x-4 sm:grid-cols-2">
        <Input label="First name" value={f.firstName} onChange={set('firstName')} required autoFocus />
        <Input label="Last name" value={f.lastName} onChange={set('lastName')} />
        <Input label="Phone" type="tel" value={f.phone} onChange={set('phone')} hint="Used to recognise them at check-in." />
        <Input label="Email" type="email" value={f.email} onChange={set('email')} />
        <Select label="Status" value={f.status} onChange={set('status')} hint="Their relationship with the church — separate from attendance.">
          {Object.entries(STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
        <Select label="Branch" value={f.branchId} onChange={set('branchId')} required>
          {activeBranches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
        </Select>
        <Select label="Service unit" value={f.unitId} onChange={set('unitId')}>
          <option value="">None</option>
          {(units.data || []).map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
        </Select>
        {team.data?.length > 0 && (
          <Select label="Pastoral contact" value={f.ownerUserId} onChange={set('ownerUserId')} hint="Who usually looks after them.">
            <option value="">No one assigned</option>
            {team.data.map(m => <option key={m.user_id} value={m.user_id}>{m.name}</option>)}
          </Select>
        )}
      </div>
      <details className="mb-4 rounded-lg border border-mist-200 px-4 py-3" open={!!(person?.gender || person?.birthday || person?.joined_at)}>
        <summary className="cursor-pointer text-sm font-medium text-ink">More details (optional)</summary>
        <div className="mt-4 grid gap-x-4 sm:grid-cols-3">
          <Select label="Gender" value={f.gender} onChange={set('gender')}>
            <option value="">Not recorded</option><option value="female">Female</option><option value="male">Male</option>
          </Select>
          <Input label="Birthday" type="date" value={f.birthday} onChange={set('birthday')} />
          <Input label="Date joined" type="date" value={f.joinedAt} onChange={set('joinedAt')} />
        </div>
      </details>
      <Textarea label="Notes" value={f.notes} onChange={set('notes')} hint="Visible to admins and leaders. Don't record sensitive pastoral or health details here." />
      <div className="flex justify-end gap-2 pb-2 pt-1">
        <Button variant="secondary" onClick={onCancel}>Cancel</Button>
        <Button type="submit" loading={busy}>{person ? 'Save changes' : 'Add person'}</Button>
      </div>
    </form>
  )
}
