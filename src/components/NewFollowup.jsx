import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { useSession } from '../lib/session'
import { Modal, Button, Input, Select, Notice, useLoad } from './ui'
import { personName, toLocalInput, fromLocalInput } from '../lib/format'

export function useTeam() {
  return useLoad(() => api.get('/team/assignees').catch(() => []), [])
}

export default function NewFollowup({ open, person, onClose, onCreated }) {
  const { me } = useSession()
  const team = useTeam()
  const [title, setTitle] = useState('')
  const [dueAt, setDueAt] = useState('')
  const [assignee, setAssignee] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (open) { setTitle(''); setError(''); setAssignee(me.user.id); setDueAt(toLocalInput(new Date(Date.now() + 2 * 86400000).setHours(18, 0, 0, 0))) }
  }, [open, me.user.id])

  async function save(e) {
    e.preventDefault()
    setBusy(true); setError('')
    try { await api.post('/followups', { personId: person.id, title, dueAt: fromLocalInput(dueAt), assigneeUserId: assignee || null }); onCreated() }
    catch (err) { setError(err.message) } finally { setBusy(false) }
  }

  return (
    <Modal open={open} onClose={onClose} title={`Follow up with ${person ? personName(person) : ''}`} size="sm"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={save} loading={busy} disabled={!title.trim()}>Create follow-up</Button></>}>
      <form onSubmit={save}>
        {error && <Notice tone="danger" className="mb-4">{error}</Notice>}
        <Input label="What's this about?" placeholder="e.g. Pray with them about the new job" value={title} onChange={e => setTitle(e.target.value)} required />
        <Input label="Due" type="datetime-local" value={dueAt} onChange={e => setDueAt(e.target.value)} />
        <Select label="Assign to" value={assignee} onChange={e => setAssignee(e.target.value)}>
          <option value={me.user.id}>Me</option>
          {(team.data || []).filter(m => m.user_id !== me.user.id).map(m => <option key={m.user_id} value={m.user_id}>{m.name}</option>)}
          <option value="">No one yet</option>
        </Select>
      </form>
    </Modal>
  )
}
