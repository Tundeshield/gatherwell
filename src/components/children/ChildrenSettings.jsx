import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Plus, Pencil, Trash2 } from 'lucide-react'
import { api } from '../../lib/api'
import { useSession } from '../../lib/session'
import { useLoad, Button, Modal, Input, Toggle, Table, Th, Td, IconButton, Segmented, Notice, Skeleton, useToast, useConfirm } from '../ui'

function RoomModal({ room, onClose, onSaved }) {
  const toast = useToast()
  const [f, setF] = useState(() => room?.id ? { name: room.name, minAge: room.minAge, maxAge: room.maxAge, capacity: room.capacity ?? '', ratio: room.ratio ?? '', location: room.location ?? '' } : { name: '', minAge: 0, maxAge: 4, capacity: '', ratio: '', location: '' })
  const [busy, setBusy] = useState(false)
  const set = (k) => (e) => setF(x => ({ ...x, [k]: e.target.value }))
  async function save() {
    setBusy(true)
    try { room?.id ? await api.patch(`/children/rooms/${room.id}`, f) : await api.post('/children/rooms', f); await onSaved(); toast('Saved'); onClose() } catch (e) { toast(e.message, 'error') } finally { setBusy(false) }
  }
  return (
    <Modal open onClose={onClose} title={room?.id ? `Edit ${room.name}` : 'Add a class'} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} onClick={save} disabled={!f.name.trim()}>Save</Button></>}>
      <Input label="Name" value={f.name} onChange={set('name')} placeholder="For example: Toddlers (2–4)" />
      <div className="grid grid-cols-2 gap-x-4">
        <Input label="Youngest age" type="number" min="0" max="18" value={f.minAge} onChange={set('minAge')} />
        <Input label="Oldest age" type="number" min="0" max="18" value={f.maxAge} onChange={set('maxAge')} />
        <Input label="Places" type="number" min="1" value={f.capacity} onChange={set('capacity')} hint="Optional. Warns when full." />
        <Input label="Children per adult" type="number" min="1" value={f.ratio} onChange={set('ratio')} hint="Optional. Warns when more adults are needed." />
      </div>
      <Input label="Room or location" value={f.location} onChange={set('location')} placeholder="For example: Room 3" />
    </Modal>
  )
}

export default function ChildrenSettings() {
  const { me, can, refresh } = useSession()
  const toast = useToast()
  const confirm = useConfirm()
  const on = !!me.org.childrenEnabled
  const rooms = useLoad(() => (on ? api.get('/children/rooms') : Promise.resolve({ rooms: [] })), [on])
  const [editing, setEditing] = useState(null)

  async function toggle(v) {
    if (!v && !(await confirm({ title: 'Switch off children’s church?', message: 'The Children page and check-in screen disappear. Nothing is deleted: switch it back on any time and everything is still there.', confirmLabel: 'Switch off' }))) return
    try { await api.patch('/children/settings', { enabled: v }); await refresh(); toast(v ? 'Children’s church is on' : 'Children’s church is off') } catch (e) { toast(e.message, 'error') }
  }
  async function setLabels(v) {
    try { await api.patch('/children/settings', { labels: v }); await refresh(); toast('Saved') } catch (e) { toast(e.message, 'error') }
  }
  async function remove(r) {
    if (!(await confirm({ title: `Remove ${r.name}?`, message: 'Past check-ins keep their class. Children placed here by hand go back to their age group.', confirmLabel: 'Remove', danger: true }))) return
    try { await api.del(`/children/rooms/${r.id}`); await rooms.reload(); toast(`${r.name} removed`) } catch (e) { toast(e.message, 'error') }
  }

  return (
    <div className="space-y-6">
      <section className="panel px-5 py-4">
        <h2 className="text-[16px] font-semibold text-ink">Children’s church</h2>
        <p className="mt-1 text-sm text-mist-500">Safe check-in for children with name labels and matching pickup codes, a live view of every class, and pickup checks. Children are counted separately from adult attendance and aren’t added to your people list.</p>
        <div className="mt-2 border-t border-mist-100 pt-2">
          <Toggle label="Use children’s church" hint={can('org.manage') ? 'On for every church. Switch it off to hide the Children page; nothing is deleted.' : 'Only the church owner can change this.'} checked={on} onChange={v => can('org.manage') && toggle(v)} />
        </div>
      </section>

      {on && (
        <>
          <section className="panel overflow-hidden">
            <div className="flex items-center justify-between border-b border-mist-100 px-4 py-3">
              <div><h2 className="text-[15px] font-semibold text-ink">Classes</h2><p className="text-xs text-mist-500">Children go to the class for their age automatically. You can move a child by hand on their record.</p></div>
              {can('children.manage') && <Button size="sm" icon={Plus} onClick={() => setEditing({})}>Add class</Button>}
            </div>
            {rooms.loading && !rooms.data ? <div className="p-4"><Skeleton className="h-24" /></div> : (
              <Table>
                <thead><tr><Th>Class</Th><Th>Ages</Th><Th>Places</Th><Th>Children per adult</Th><Th /></tr></thead>
                <tbody>{rooms.data?.rooms.map(r => (
                  <tr key={r.id}>
                    <Td><span className="font-medium text-ink">{r.name}</span>{r.location && <span className="text-mist-500"> · {r.location}</span>}</Td>
                    <Td className="tabular">{r.minAge}–{r.maxAge}</Td>
                    <Td className="tabular">{r.capacity ?? '—'}</Td>
                    <Td className="tabular">{r.ratio ?? '—'}</Td>
                    <Td className="whitespace-nowrap text-right">{can('children.manage') && <><IconButton icon={Pencil} label={`Edit ${r.name}`} onClick={() => setEditing(r)} /><IconButton icon={Trash2} label={`Remove ${r.name}`} onClick={() => remove(r)} /></>}</Td>
                  </tr>
                ))}</tbody>
              </Table>
            )}
          </section>

          <section className="panel px-5 py-4">
            <h2 className="text-[15px] font-semibold text-ink">Labels</h2>
            <p className="mt-1 text-sm text-mist-500">Name labels and pickup tags print on standard 4 × 2 inch labels (Dymo, Brother and similar). Connect the printer to the tablet or computer you use for check-in.</p>
            <div className="mt-3"><Segmented value={me.org.kidsLabels === 'none' ? 'none' : 'print'} onChange={v => can('children.manage') && setLabels(v)}
              options={[{ value: 'print', label: 'Print labels' }, { value: 'none', label: 'No printer: show the code on screen' }]} /></div>
          </section>

          <Notice tone="info" title="Setting up for Sunday">
            Put a tablet at the children’s church door, sign in, and open <Link to="/app/children/checkin" className="font-medium underline">the check-in screen</Link>. Give teachers and helpers the <b>Children’s team</b> role in Settings › Team: they see only children’s church, including allergies and medical notes.
          </Notice>
        </>
      )}
      {editing && <RoomModal room={editing} onClose={() => setEditing(null)} onSaved={rooms.reload} />}
    </div>
  )
}
