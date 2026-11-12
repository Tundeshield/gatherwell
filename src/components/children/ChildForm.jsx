import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { api } from '../../lib/api'
import { Drawer, Button, Input, Textarea, Select, Field, useToast, useConfirm } from '../ui'
import { useSession } from '../../lib/session'

// Find a parent from the people list.
function ParentPicker({ value, onChange }) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState([])
  useEffect(() => {
    if (q.trim().length < 2) { setResults([]); return }
    const t = setTimeout(() => api.get(`/people?q=${encodeURIComponent(q.trim())}&limit=8`).then(r => setResults(r.rows)).catch(() => setResults([])), 250)
    return () => clearTimeout(t)
  }, [q])
  return (
    <Field label="Parents and guardians" hint="They can check this child in, and their phone number finds the family at check-in.">
      <div className="space-y-2">
        {value.map(g => (
          <div key={g.id} className="flex items-center justify-between rounded-lg border border-mist-200 px-3 py-2 text-sm">
            <span><span className="font-medium text-ink">{g.name}</span>{g.phone && <span className="text-mist-500"> · {g.phone}</span>}</span>
            <button type="button" onClick={() => onChange(value.filter(x => x.id !== g.id))} aria-label={`Remove ${g.name}`} className="rounded p-1 text-mist-400 hover:bg-mist-100 hover:text-ink"><X size={15} /></button>
          </div>
        ))}
        <div className="relative">
          <input className="field" value={q} onChange={e => setQ(e.target.value)} placeholder="Search people by name or phone" aria-label="Search for a parent" />
          {results.length > 0 && (
            <ul className="absolute z-10 mt-1 max-h-56 w-full overflow-y-auto rounded-lg border border-mist-200 bg-white shadow-pop">
              {results.filter(p => !value.some(v => v.id === p.id)).map(p => (
                <li key={p.id}><button type="button" className="w-full px-3 py-2 text-left text-sm hover:bg-mist-50" onClick={() => { onChange([...value, { id: p.id, name: [p.first_name, p.last_name].filter(Boolean).join(' '), phone: p.phone }]); setQ(''); setResults([]) }}>
                  <span className="font-medium text-ink">{[p.first_name, p.last_name].filter(Boolean).join(' ')}</span>{p.phone && <span className="text-mist-500"> · {p.phone}</span>}
                </button></li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Field>
  )
}

/** Add or edit a child. `child` null = new; `defaultGuardian` pre-fills the parent. */
export default function ChildForm({ open, onClose, child, rooms, defaultGuardian, onSaved }) {
  const toast = useToast()
  const confirm = useConfirm()
  const { can } = useSession()
  const blank = { firstName: '', lastName: defaultGuardian?.name?.split(' ').slice(1).join(' ') || '', birthDate: '', roomId: '', allergies: '', medical: '', pickupNotes: '', notes: '' }
  const [f, setF] = useState(blank)
  const [guardians, setGuardians] = useState([])
  const [errors, setErrors] = useState({})
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!open) return
    setErrors({})
    if (child) {
      setF({ firstName: child.firstName || '', lastName: child.lastName || '', birthDate: child.birthDate || '', roomId: child.roomId || '', allergies: child.allergies || '', medical: child.medical || '', pickupNotes: child.pickupNotes || '', notes: child.notes || '' })
      setGuardians(child.guardians || [])
    } else { setF(blank); setGuardians(defaultGuardian ? [defaultGuardian] : []) }
  }, [open, child?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k) => (e) => setF(x => ({ ...x, [k]: e.target.value }))

  async function save() {
    setBusy(true); setErrors({})
    try {
      const body = { ...f, roomId: f.roomId || null, guardianIds: guardians.map(g => g.id) }
      const saved = child ? await api.patch(`/children/${child.id}`, body) : await api.post('/children', body)
      await onSaved?.(saved)
      toast(child ? 'Saved' : `${saved.firstName} added`); onClose()
    } catch (e) { setErrors(e.details?.fields || {}); toast(e.message, 'error') } finally { setBusy(false) }
  }
  async function remove() {
    if (!(await confirm({ title: `Delete ${child.firstName}’s record?`, message: 'Their details and check-in history are erased. This can’t be undone.', confirmLabel: 'Delete', danger: true }))) return
    setBusy(true)
    try { await api.del(`/children/${child.id}`); await onSaved?.(null); toast('Deleted'); onClose() } catch (e) { toast(e.message, 'error') } finally { setBusy(false) }
  }

  return (
    <Drawer open={open} onClose={onClose} title={child ? `Edit ${child.firstName}` : 'Add a child'}
      footer={<>
        {child && can('children.manage') && <Button variant="ghost" className="mr-auto text-red-700" onClick={remove} disabled={busy}>Delete</Button>}
        <Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} onClick={save} disabled={!f.firstName.trim()}>{child ? 'Save' : 'Add child'}</Button>
      </>}>
      <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
        <Input label="First name" required value={f.firstName} onChange={set('firstName')} error={errors.firstName} />
        <Input label="Last name" value={f.lastName} onChange={set('lastName')} />
        <Input label="Date of birth" type="date" value={f.birthDate} onChange={set('birthDate')} error={errors.birthDate} hint="Places them in the right class by age." max={new Date().toISOString().slice(0, 10)} />
        <Select label="Class" value={f.roomId} onChange={set('roomId')} hint="Leave on automatic to go by age.">
          <option value="">Automatic (by age)</option>
          {rooms.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
        </Select>
      </div>
      <Input label="Allergies" value={f.allergies} onChange={set('allergies')} placeholder="For example: peanuts, dairy" hint="Printed on their label." />
      <Textarea label="Medical notes" value={f.medical} onChange={set('medical')} rows={2} placeholder="For example: asthma, inhaler in bag" hint="Seen by the children’s team only. Not printed." />
      <ParentPicker value={guardians} onChange={setGuardians} />
      <Input label="Others allowed to collect" value={f.pickupNotes} onChange={set('pickupNotes')} placeholder="For example: Mrs Bose Ade (grandmother)" />
      <Textarea label="Notes for teachers" value={f.notes} onChange={set('notes')} rows={2} />
      <p className="text-xs text-mist-500">Children’s details are only visible to the children’s team and admins.</p>
    </Drawer>
  )
}
