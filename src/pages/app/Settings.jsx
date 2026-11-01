import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Plus, Copy, Building2, Users, Layers, FileText, Trash2, Pencil, Upload, CheckCircle2 } from 'lucide-react'
import { api } from '../../lib/api'
import { useSession } from '../../lib/session'
import { useLoad, PageHeader, Button, Badge, Modal, Input, Select, Notice, Toggle, Checkbox, EmptyState, ErrorState, Skeleton, useToast, useConfirm, Table, Th, Td, IconButton, Textarea } from '../../components/ui'
import { fmtDate, relative } from '../../lib/format'
import { COUNTRIES } from '../public/Signup'
import { changePassword } from '../../lib/firebase'
import EmailPreview from '../../components/EmailPreview'
import { TagChip, TAG_STYLES, TAG_COLORS, useTags, loadTags } from '../../components/Tags'
import EmailBlocksEditor, { withKeys, stripKeys } from '../../components/EmailBlocksEditor'
import { JOURNEY_STEPS, DELAY_OPTIONS, WHATSAPP_KINDS } from '../../../shared/automation.js'
import { prepareImage } from '../../lib/image'

const ROLE_HELP = {
  owner: 'Everything, including church settings and billing.',
  admin: 'Manages people, attendance, events, follow-ups and the team.',
  lead: 'Runs attendance and events, edits people, handles follow-ups.',
  usher: 'Checks people in at sessions and events. No access to the people directory.',
  viewer: 'Sees the overview and reports. Read-only.',
}
const ROLE_LABEL = { owner: 'Owner', admin: 'Admin', lead: 'Attendance lead', usher: 'Usher', viewer: 'Viewer' }

function ChurchTab() {
  const { me, refresh } = useSession()
  const toast = useToast()
  const o = me.org
  const [f, setF] = useState({ name: o.name, timezone: o.timezone, country: o.country || '', contactEmail: o.contactEmail || '', contactPhone: o.contactPhone || '', settings: { absenceWeeks: 3, firstVisitFollowup: true, firstVisitHours: 48, secondVisitFollowup: true, defaultCountryCode: '234', ...o.settings } })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const set = (k) => (e) => setF(x => ({ ...x, [k]: e.target.value }))
  const setS = (k, v) => setF(x => ({ ...x, settings: { ...x.settings, [k]: v } }))
  async function save(e) {
    e.preventDefault(); setBusy(true); setError('')
    try { await api.patch('/org', { ...f, settings: { ...f.settings, absenceWeeks: Number(f.settings.absenceWeeks), firstVisitHours: Number(f.settings.firstVisitHours) } }); await refresh(); toast('Settings saved') }
    catch (err) { setError(err.message) } finally { setBusy(false) }
  }
  const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [o.timezone]
  return (
    <form onSubmit={save} className="space-y-6">
      {error && <Notice tone="danger">{error}</Notice>}
      <section className="panel px-6 py-5">
        <h2 className="mb-4 text-[15px] font-semibold text-ink">Church details</h2>
        <div className="grid gap-x-4 sm:grid-cols-2">
          <Input label="Church name" value={f.name} onChange={set('name')} required className="sm:col-span-2" />
          <Select label="Timezone" value={f.timezone} onChange={set('timezone')} hint="Used for 'today', due dates and reports.">{zones.map(z => <option key={z}>{z}</option>)}</Select>
          <Select label="Default phone country" value={f.settings.defaultCountryCode} onChange={e => setS('defaultCountryCode', e.target.value)} hint="Numbers starting with 0 are read as this country.">
            {COUNTRIES.filter(c => c.cc).map(c => <option key={c.name} value={c.cc}>{c.name} (+{c.cc})</option>)}
          </Select>
          <Input label="Contact email" type="email" value={f.contactEmail} onChange={set('contactEmail')} />
          <Input label="Contact phone" value={f.contactPhone} onChange={set('contactPhone')} />
        </div>
      </section>
      <section className="panel px-6 py-5">
        <h2 className="text-[15px] font-semibold text-ink">Follow-up rules</h2>
        <p className="mb-3 text-sm text-mist-500">Suggestions for your team, not obligations. You can always close or reassign.</p>
        <div className="divide-y divide-mist-100">
          <Toggle label="Welcome first-time visitors" hint="Create a follow-up when a visitor checks in for the first time." checked={f.settings.firstVisitFollowup} onChange={v => setS('firstVisitFollowup', v)} />
          {f.settings.firstVisitFollowup && (
            <div className="py-3"><Input className="mb-0 max-w-[220px]" label="Due within (hours)" type="number" min="1" max="336" value={f.settings.firstVisitHours} onChange={e => setS('firstVisitHours', e.target.value)} /></div>
          )}
          <Toggle label="Invite second-time visitors to connect" hint="When a visitor returns, close the welcome task and suggest a next step." checked={f.settings.secondVisitFollowup} onChange={v => setS('secondVisitFollowup', v)} />
          <div className="py-3">
            <Input className="mb-0 max-w-[220px]" label="Absence threshold (weeks)" type="number" min="1" max="26" value={f.settings.absenceWeeks} onChange={e => setS('absenceWeeks', e.target.value)}
              hint="Members not seen for this long appear in the absence review." />
          </div>
        </div>
      </section>
      <div className="flex justify-end"><Button type="submit" loading={busy}>Save settings</Button></div>
    </form>
  )
}

function BranchesTab() {
  const { can, refresh } = useSession()
  const toast = useToast()
  const confirm = useConfirm()
  const { data, error, loading, reload } = useLoad(() => api.get('/branches'), [])
  const [edit, setEdit] = useState(null)
  const [f, setF] = useState({})
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (edit) { setF(edit === 'new' ? { name: '', address: '', phone: '' } : { name: edit.name, address: edit.address || '', phone: edit.phone || '' }); setErr('') } }, [edit])
  async function save() {
    setBusy(true); setErr('')
    try { edit === 'new' ? await api.post('/branches', f) : await api.patch(`/branches/${edit.id}`, f); setEdit(null); toast('Branch saved'); reload(); refresh() }
    catch (e) { setErr(e.message) } finally { setBusy(false) }
  }
  async function toggleArchive(b) {
    const archiving = b.status === 'active'
    if (archiving && !(await confirm({ title: `Archive ${b.name}?`, message: 'It disappears from forms and new sessions, but its people and history are kept. You can restore it any time.', confirmLabel: 'Archive branch' }))) return
    try { await api.patch(`/branches/${b.id}`, { status: archiving ? 'archived' : 'active' }); toast(archiving ? 'Branch archived' : 'Branch restored'); reload(); refresh() } catch (e) { toast(e.message, 'error') }
  }
  if (error) return <ErrorState error={error} onRetry={reload} />
  return (
    <section className="panel overflow-hidden">
      <div className="flex items-center justify-between border-b border-mist-100 px-5 py-4">
        <div><h2 className="text-[15px] font-semibold text-ink">Branches</h2><p className="text-sm text-mist-500">Campuses or locations. Each has its own sessions, people and reports.</p></div>
        {can('branches.create') && <Button size="sm" icon={Plus} onClick={() => setEdit('new')}>Add branch</Button>}
      </div>
      {loading && !data ? <Skeleton className="m-5 h-20" /> : (
        <ul className="divide-y divide-mist-100">
          {data.map(b => (
            <li key={b.id} className="flex items-center gap-3 px-5 py-3.5">
              <Building2 size={18} className="text-mist-400" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2"><span className="font-medium text-ink">{b.name}</span>{b.status === 'archived' && <Badge>Archived</Badge>}</div>
                <div className="truncate text-xs text-mist-500">{[b.address, `${b.people_count} people`].filter(Boolean).join(' · ')}</div>
              </div>
              <Button size="sm" variant="ghost" onClick={() => setEdit(b)}>Edit</Button>
              <Button size="sm" variant="ghost" onClick={() => toggleArchive(b)}>{b.status === 'active' ? 'Archive' : 'Restore'}</Button>
            </li>
          ))}
        </ul>
      )}
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit === 'new' ? 'Add branch' : 'Edit branch'} size="sm"
        footer={<><Button variant="secondary" onClick={() => setEdit(null)}>Cancel</Button><Button onClick={save} loading={busy} disabled={!f.name?.trim()}>Save</Button></>}>
        {err && <Notice tone="danger" className="mb-4">{err}</Notice>}
        <Input label="Name" value={f.name || ''} onChange={e => setF(x => ({ ...x, name: e.target.value }))} required placeholder="e.g. Ikeja campus" />
        <Input label="Address" value={f.address || ''} onChange={e => setF(x => ({ ...x, address: e.target.value }))} />
        <Input label="Phone" value={f.phone || ''} onChange={e => setF(x => ({ ...x, phone: e.target.value }))} />
      </Modal>
    </section>
  )
}

function BranchPicker({ value, onChange, branches, allowAll }) {
  const all = value === null
  return (
    <div className="mb-4">
      <div className="label">Branch access</div>
      {allowAll && <Checkbox label="All branches, including future ones" checked={all} onChange={v => onChange(v ? null : [])} className="mb-2" />}
      {!all && (
        <div className="grid gap-2 rounded-lg border border-mist-200 p-3 sm:grid-cols-2">
          {branches.map(b => <Checkbox key={b.id} label={b.name} checked={value.includes(b.id)} onChange={v => onChange(v ? [...value, b.id] : value.filter(x => x !== b.id))} />)}
        </div>
      )}
    </div>
  )
}

function TeamTab() {
  const { me, activeBranches, branchName, multiBranch } = useSession()
  const toast = useToast()
  const confirm = useConfirm()
  const { data, error, loading, reload } = useLoad(() => api.get('/team'), [])
  const [inviting, setInviting] = useState(false)
  const [editing, setEditing] = useState(null)
  const [f, setF] = useState({ email: '', role: 'usher', branchIds: [], canExport: false })
  const [link, setLink] = useState(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const scoped = !!me.membership.branchIds

  function openInvite() { setF({ email: '', role: 'usher', branchIds: scoped ? [...me.membership.branchIds] : null, canExport: false }); setErr(''); setLink(null); setInviting(true) }
  function openEdit(m) { setF({ role: m.role, branchIds: m.branch_ids, canExport: m.can_export }); setErr(''); setEditing(m) }
  async function invite() {
    setBusy(true); setErr('')
    try { const r = await api.post('/team/invites', f); setLink(`${window.location.origin}${r.path}`); reload() } catch (e) { setErr(e.message) } finally { setBusy(false) }
  }
  async function saveMember() {
    setBusy(true); setErr('')
    try { await api.patch(`/team/members/${editing.id}`, f); setEditing(null); toast('Access updated'); reload() } catch (e) { setErr(e.message) } finally { setBusy(false) }
  }
  async function revoke(m) {
    if (!(await confirm({ title: `Remove ${m.name}'s access?`, message: "They'll be signed out and can no longer see this church. Their past activity stays in the records.", confirmLabel: 'Remove access', danger: true }))) return
    try { await api.patch(`/team/members/${m.id}`, { status: 'revoked' }); toast('Access removed'); reload() } catch (e) { toast(e.message, 'error') }
  }
  async function restore(m) { try { await api.patch(`/team/members/${m.id}`, { status: 'active' }); toast('Access restored'); reload() } catch (e) { toast(e.message, 'error') } }
  async function cancelInvite(i) { try { await api.del(`/team/invites/${i.id}`); toast('Invitation cancelled'); reload() } catch (e) { toast(e.message, 'error') } }
  const copy = async () => { try { await navigator.clipboard.writeText(link); toast('Link copied') } catch { toast('Copy the link manually', 'error') } }
  const scopeText = (ids) => !ids ? 'All branches' : ids.map(branchName).filter(Boolean).join(', ') || 'No branches'

  if (error) return <ErrorState error={error} onRetry={reload} />
  const roles = data?.assignableRoles || []
  const roleFields = (
    <>
      <Select label="Role" value={f.role} onChange={e => setF(x => ({ ...x, role: e.target.value }))} hint={ROLE_HELP[f.role]}>
        {roles.filter(r => inviting ? r !== 'owner' : true).map(r => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
      </Select>
      {f.role !== 'owner' && multiBranch && <BranchPicker value={f.branchIds} onChange={v => setF(x => ({ ...x, branchIds: v }))} branches={activeBranches} allowAll={!scoped} />}
      {['admin', 'lead'].includes(f.role) && (me.membership.role === 'owner' || me.membership.canExport) && (
        <Checkbox label="Can export personal data" hint="Download people, attendance and registration lists as spreadsheets." checked={f.canExport} onChange={v => setF(x => ({ ...x, canExport: v }))} className="mb-2" />
      )}
    </>
  )

  return (
    <div className="space-y-6">
      <section className="panel overflow-hidden">
        <div className="flex items-center justify-between border-b border-mist-100 px-5 py-4">
          <div><h2 className="text-[15px] font-semibold text-ink">Team</h2><p className="text-sm text-mist-500">People who can sign in, and what they can do.</p></div>
          <Button size="sm" icon={Plus} onClick={openInvite}>Invite</Button>
        </div>
        {loading && !data ? <Skeleton className="m-5 h-20" /> : (
          <Table>
            <thead><tr><Th>Name</Th><Th>Role</Th>{multiBranch && <Th>Branches</Th>}<Th>Last signed in</Th><Th className="w-32" /></tr></thead>
            <tbody>{data.members.map(m => (
              <tr key={m.id} className={m.status === 'revoked' ? 'opacity-50' : ''}>
                <Td><div className="font-medium text-ink">{m.name}{m.isMe && <span className="ml-1 font-normal text-mist-400">(you)</span>}</div><div className="text-xs text-mist-500">{m.email}</div></Td>
                <Td><Badge tone={m.role === 'owner' ? 'gold' : 'neutral'}>{m.roleLabel}</Badge>{m.can_export && m.role !== 'owner' && <span className="ml-1.5 text-xs text-mist-500">can export</span>}</Td>
                {multiBranch && <Td className="max-w-[220px] truncate text-mist-600">{m.role === 'owner' ? 'All branches' : scopeText(m.branch_ids)}</Td>}
                <Td className="whitespace-nowrap text-mist-600">{m.status === 'revoked' ? 'Access removed' : m.last_login_at ? relative(m.last_login_at) : 'Not yet'}</Td>
                <Td className="text-right">{m.manageable && (m.status === 'active'
                  ? <div className="flex justify-end gap-1"><IconButton icon={Pencil} label={`Edit ${m.name}`} onClick={() => openEdit(m)} /><IconButton icon={Trash2} label={`Remove ${m.name}`} onClick={() => revoke(m)} /></div>
                  : <Button size="sm" variant="ghost" onClick={() => restore(m)}>Restore</Button>)}</Td>
              </tr>
            ))}</tbody>
          </Table>
        )}
      </section>
      {data?.invites.length > 0 && (
        <section className="panel overflow-hidden">
          <h2 className="border-b border-mist-100 px-5 py-4 text-[15px] font-semibold text-ink">Pending invitations</h2>
          <ul className="divide-y divide-mist-100">
            {data.invites.map(i => (
              <li key={i.id} className="flex items-center gap-3 px-5 py-3 text-sm">
                <span className="min-w-0 flex-1"><span className="font-medium text-ink">{i.email}</span><span className="block text-xs text-mist-500">{[i.roleLabel, multiBranch && scopeText(i.branch_ids)].filter(Boolean).join(' · ')} · expires {fmtDate(i.expires_at)}</span></span>
                <Button size="sm" variant="ghost" onClick={() => cancelInvite(i)}>Cancel</Button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <Modal open={inviting} onClose={() => setInviting(false)} title="Invite a team member" size="md"
        footer={link ? <Button onClick={() => setInviting(false)}>Done</Button> : <><Button variant="secondary" onClick={() => setInviting(false)}>Cancel</Button><Button onClick={invite} loading={busy} disabled={!f.email || (f.branchIds && !f.branchIds.length)}>Create invitation</Button></>}>
        {err && <Notice tone="danger" className="mb-4">{err}</Notice>}
        {link ? (
          <div className="pb-2">
            <Notice tone="success" title="Invitation created">Send this link to {f.email}. It works once and expires in 14 days.</Notice>
            <div className="mt-4 flex gap-2"><input readOnly value={link} className="field text-xs" onFocus={e => e.target.select()} aria-label="Invitation link" /><Button variant="secondary" icon={Copy} onClick={copy}>Copy</Button></div>
            <a className="link mt-3 inline-block text-sm" href={`https://wa.me/?text=${encodeURIComponent(`You've been invited to join ${me.org.name} on GatherHQ: ${link}`)}`} target="_blank" rel="noreferrer">Share on WhatsApp</a>
          </div>
        ) : <><Input label="Email" type="email" value={f.email} onChange={e => setF(x => ({ ...x, email: e.target.value }))} required />{roleFields}</>}
      </Modal>
      <Modal open={!!editing} onClose={() => setEditing(null)} title={`Edit ${editing?.name}`} size="md"
        footer={<><Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button><Button onClick={saveMember} loading={busy}>Save</Button></>}>
        {err && <Notice tone="danger" className="mb-4">{err}</Notice>}
        {roleFields}
      </Modal>
    </div>
  )
}

function UnitsTab() {
  const { activeBranches, me, multiBranch } = useSession()
  const toast = useToast()
  const confirm = useConfirm()
  const { data, error, loading, reload } = useLoad(() => api.get('/units'), [])
  const [edit, setEdit] = useState(null)
  const [f, setF] = useState({})
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const scoped = !!me.membership.branchIds
  useEffect(() => { if (edit) { setF(edit === 'new' ? { name: '', description: '', branchId: scoped ? activeBranches[0]?.id : '' } : { name: edit.name, description: edit.description || '' }); setErr('') } }, [edit]) // eslint-disable-line
  async function save() {
    setBusy(true); setErr('')
    try { edit === 'new' ? await api.post('/units', { ...f, branchId: f.branchId || null }) : await api.patch(`/units/${edit.id}`, f); setEdit(null); toast('Unit saved'); reload() }
    catch (e) { setErr(e.message) } finally { setBusy(false) }
  }
  async function remove(u) {
    if (!(await confirm({ title: `Delete ${u.name}?`, message: `${u.member_count} people will no longer be assigned to a unit. Their records are kept.`, confirmLabel: 'Delete unit', danger: true }))) return
    try { await api.del(`/units/${u.id}`); toast('Unit deleted'); reload() } catch (e) { toast(e.message, 'error') }
  }
  if (error) return <ErrorState error={error} onRetry={reload} />
  return (
    <section className="panel overflow-hidden">
      <div className="flex items-center justify-between border-b border-mist-100 px-5 py-4">
        <div><h2 className="text-[15px] font-semibold text-ink">Service units</h2><p className="text-sm text-mist-500">Ministries, departments or teams — name them the way your church does.</p></div>
        <Button size="sm" icon={Plus} onClick={() => setEdit('new')}>Add unit</Button>
      </div>
      {loading && !data ? <Skeleton className="m-5 h-20" /> : data.length === 0 ? (
        <EmptyState icon={Layers} title="No units yet">e.g. Choir, Ushering, Children's church, Media. Assign people to units from their profile or in bulk.</EmptyState>
      ) : (
        <ul className="divide-y divide-mist-100">
          {data.map(u => (
            <li key={u.id} className="flex items-center gap-3 px-5 py-3.5">
              <div className="min-w-0 flex-1">
                <div className="font-medium text-ink">{u.name}</div>
                <div className="text-xs text-mist-500">{[`${u.member_count} people`, multiBranch && (u.branch_name || 'All branches'), u.leader_name && `Led by ${u.leader_name}`].filter(Boolean).join(' · ')}</div>
              </div>
              <a href={`/app/people?unit=${u.id}`} className="text-sm text-brand-700 hover:underline">View people</a>
              <IconButton icon={Pencil} label={`Edit ${u.name}`} onClick={() => setEdit(u)} />
              <IconButton icon={Trash2} label={`Delete ${u.name}`} onClick={() => remove(u)} />
            </li>
          ))}
        </ul>
      )}
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit === 'new' ? 'Add service unit' : 'Edit service unit'} size="sm"
        footer={<><Button variant="secondary" onClick={() => setEdit(null)}>Cancel</Button><Button onClick={save} loading={busy} disabled={!f.name?.trim()}>Save</Button></>}>
        {err && <Notice tone="danger" className="mb-4">{err}</Notice>}
        <Input label="Name" value={f.name || ''} onChange={e => setF(x => ({ ...x, name: e.target.value }))} required />
        <Textarea label="Responsibilities" value={f.description || ''} onChange={e => setF(x => ({ ...x, description: e.target.value }))} rows={2} />
        {edit === 'new' && multiBranch && (
          <Select label="Branch" value={f.branchId || ''} onChange={e => setF(x => ({ ...x, branchId: e.target.value }))}>
            {!scoped && <option value="">All branches</option>}
            {activeBranches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
          </Select>
        )}
      </Modal>
    </section>
  )
}

function TemplatesTab() {
  const toast = useToast()
  const { data, error, loading, reload } = useLoad(() => api.get('/templates'), [])
  async function remove(t) { try { await api.del(`/templates/${t.id}`); toast('Template deleted'); reload() } catch (e) { toast(e.message, 'error') } }
  if (error) return <ErrorState error={error} onRetry={reload} />
  return (
    <section className="panel overflow-hidden">
      <div className="border-b border-mist-100 px-5 py-4"><h2 className="text-[15px] font-semibold text-ink">Session templates</h2><p className="text-sm text-mist-500">Save a template when creating a session to reuse its name and form.</p></div>
      {loading && !data ? <Skeleton className="m-5 h-16" /> : data.length === 0 ? <EmptyState icon={FileText} title="No templates yet">Tick "Save as a template" when you create a session.</EmptyState> : (
        <ul className="divide-y divide-mist-100">{data.map(t => (
          <li key={t.id} className="flex items-center gap-3 px-5 py-3.5"><span className="flex-1"><span className="font-medium text-ink">{t.name}</span><span className="block text-xs text-mist-500">{t.form.length} questions</span></span><IconButton icon={Trash2} label={`Delete ${t.name}`} onClick={() => remove(t)} /></li>
        ))}</ul>
      )}
    </section>
  )
}

function AccountTab() {
  const { me, refresh } = useSession()
  const toast = useToast()
  const [name, setName] = useState(me.user.name)
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '' })
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState('')
  async function save(kind) {
    setBusy(kind); setErr('')
    try {
      if (kind === 'name') await api.patch('/me', { name })
      else await changePassword(me.user.email, pw.currentPassword, pw.newPassword)
      toast(kind === 'name' ? 'Name updated' : 'Password changed. Other devices were signed out.'); setPw({ currentPassword: '', newPassword: '' }); refresh()
    }
    catch (e) { setErr(e.message) } finally { setBusy('') }
  }
  return (
    <div className="space-y-6">
      {err && <Notice tone="danger">{err}</Notice>}
      <section className="panel px-6 py-5">
        <h2 className="mb-4 text-[15px] font-semibold text-ink">Your profile</h2>
        <div className="max-w-md">
          <Input label="Name" value={name} onChange={e => setName(e.target.value)} />
          <Input label="Email" value={me.user.email} disabled hint="Contact your church owner to change the email you sign in with." />
          <Button onClick={() => save('name')} loading={busy === 'name'} disabled={!name.trim() || name === me.user.name}>Save</Button>
        </div>
      </section>
      <BriefPreference />
      <section className="panel px-6 py-5">
        <h2 className="mb-4 text-[15px] font-semibold text-ink">Change password</h2>
        <div className="max-w-md">
          <Input label="Current password" type="password" autoComplete="current-password" value={pw.currentPassword} onChange={e => setPw(x => ({ ...x, currentPassword: e.target.value }))} />
          <Input label="New password" type="password" autoComplete="new-password" value={pw.newPassword} onChange={e => setPw(x => ({ ...x, newPassword: e.target.value }))} hint="At least 8 characters." />
          <Button onClick={() => save('pw')} loading={busy === 'pw'} disabled={!pw.currentPassword || pw.newPassword.length < 8}>Change password</Button>
        </div>
      </section>
    </div>
  )
}

const AUDIT_LABEL = (a) => a.replace(/^(\w+)\./, '$1 ').replace(/_/g, ' ')
function ActivityTab() {
  const { tz } = useSession()
  const { data, error, loading } = useLoad(() => api.get('/audit?limit=200'), [])
  if (error) return <ErrorState error={error} />
  return (
    <section className="panel overflow-hidden">
      <div className="border-b border-mist-100 px-5 py-4"><h2 className="text-[15px] font-semibold text-ink">Activity log</h2><p className="text-sm text-mist-500">Sensitive actions — exports, deletions, access changes — are recorded here.</p></div>
      {loading ? <Skeleton className="m-5 h-40" /> : (
        <Table>
          <thead><tr><Th>When</Th><Th>Who</Th><Th>What</Th></tr></thead>
          <tbody>{data.map(a => (
            <tr key={a.id}><Td className="whitespace-nowrap text-mist-600" ><span title={fmtDate(a.created_at, tz)}>{relative(a.created_at)}</span></Td><Td>{a.user_name || 'System'}</Td>
              <Td className="text-mist-600"><span className="capitalize">{AUDIT_LABEL(a.action)}</span>{a.meta?.name ? ` — ${a.meta.name}` : ''}{a.meta?.count !== undefined ? ` (${a.meta.count})` : ''}</Td></tr>
          ))}</tbody>
        </Table>
      )}
    </section>
  )
}


const BRAND_SWATCHES = ['#244E43', '#243447', '#1F4E8C', '#6B2D5C', '#8A3B12', '#B0362F', '#C69B55', '#2F6F4F']
const SAMPLE_BLOCKS = [
  { type: 'heading', text: 'You’re invited, {first_name}' },
  { type: 'text', text: 'Join us this Sunday at 9am for our family service. Bring a friend, there’s a seat for everyone.' },
  { type: 'button', label: 'Get directions', url: 'https://maps.google.com' },
]

function EmailTab() {
  const { me, can, refresh } = useSession()
  const toast = useToast()
  const canEdit = can('org.manage')
  const { data, error, reload } = useLoad(() => api.get('/email/settings'), [])
  const [f, setF] = useState(null)
  const [busy, setBusy] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [err, setErr] = useState('')
  const fileRef = useRef(null)
  useEffect(() => { if (data) setF({ ...data.branding }) }, [data])
  const set = (k) => (e) => setF(x => ({ ...x, [k]: e.target.value }))
  const sample = useMemo(() => SAMPLE_BLOCKS, [])
  const person = useMemo(() => ({ first_name: (me.user?.name || 'Ada').split(' ')[0] }), [me])

  async function uploadLogo(file) {
    if (!file) return
    setUploading(true); setErr('')
    try {
      const dataUrl = await prepareImage(file, { maxWidth: 600, keepTransparency: true, maxBytes: 300_000 })
      const { url } = await api.post('/email/assets', { dataUrl, kind: 'logo' })
      setF(x => ({ ...x, logoUrl: url }))
    } catch (e) { setErr(e.message) } finally { setUploading(false); if (fileRef.current) fileRef.current.value = '' }
  }
  async function save(e) {
    e.preventDefault(); setBusy(true); setErr('')
    try { const b = await api.patch('/email/branding', f); setF(b); toast('Email branding saved'); reload(); refresh?.() }
    catch (e2) { setErr(e2.message) } finally { setBusy(false) }
  }

  if (error) return <ErrorState error={error} onRetry={reload} />
  if (!f) return <Skeleton className="h-64" />
  return (
    <div className="grid items-start gap-6 2xl:grid-cols-[minmax(0,1fr)_minmax(0,520px)]">
      <form onSubmit={save} className="space-y-6">
        <section className={`panel flex items-start gap-3 px-6 py-4 ${data.connected ? '' : 'bg-mist-50/60'}`}>
          {data.connected ? <CheckCircle2 size={20} className="mt-0.5 shrink-0 text-green-700" /> : <span className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full bg-mist-300" />}
          <div className="text-sm">
            <p className="font-medium text-ink">{data.connected ? 'Email sending is on' : 'Email sending isn’t switched on yet'}</p>
            <p className="text-mist-500">{data.connected ? <>Emails go out from <span className="font-medium text-ink">{data.fromAddress}</span>. Up to {data.dailyLimit.toLocaleString()} a day ({data.usedToday.toLocaleString()} used today).</> : 'You can set up your branding and write emails now. Sending starts once the GatherHQ email domain is connected.'}</p>
          </div>
        </section>
        {err && <Notice tone="danger">{err}</Notice>}
        <fieldset disabled={!canEdit} className="space-y-6">
          <section className="panel px-6 py-5">
            <h2 className="mb-1 text-[15px] font-semibold text-ink">Logo</h2>
            <p className="mb-4 text-sm text-mist-500">Shown at the top of every email. A wide logo on a transparent or white background works best.</p>
            <div className="flex flex-wrap items-center gap-4">
              <div className="flex h-20 w-48 items-center justify-center rounded-lg border border-mist-200 bg-white p-2">
                {f.logoUrl ? <img src={f.logoUrl} alt="Church logo" className="max-h-full max-w-full object-contain" /> : <span className="text-xs text-mist-400">No logo yet</span>}
              </div>
              <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" className="hidden" onChange={e => uploadLogo(e.target.files[0])} />
              <Button variant="secondary" icon={Upload} loading={uploading} onClick={() => fileRef.current?.click()}>{f.logoUrl ? 'Change logo' : 'Upload logo'}</Button>
              {f.logoUrl && <Button variant="ghost" onClick={() => setF(x => ({ ...x, logoUrl: '' }))}>Remove</Button>}
            </div>
          </section>
          <section className="panel px-6 py-5">
            <h2 className="mb-4 text-[15px] font-semibold text-ink">Look and sender</h2>
            <div className="mb-4">
              <p className="label">Brand colour</p>
              <div className="flex flex-wrap items-center gap-2">
                {BRAND_SWATCHES.map(c => (
                  <button key={c} type="button" aria-label={`Use colour ${c}`} aria-pressed={f.color === c} onClick={() => setF(x => ({ ...x, color: c }))}
                    className={`h-8 w-8 rounded-full border-2 ${f.color === c ? 'border-ink' : 'border-white ring-1 ring-mist-200'}`} style={{ background: c }} />
                ))}
                <label className="ml-1 flex items-center gap-2 text-sm text-mist-600">
                  <input type="color" value={f.color} onChange={set('color')} className="h-8 w-10 cursor-pointer rounded border border-mist-200 bg-white" aria-label="Custom colour" />
                  {f.color}
                </label>
              </div>
              <p className="hint">Used for the top bar, buttons and links.</p>
            </div>
            <div className="grid gap-x-4 sm:grid-cols-2">
              <Input label="Sender name" value={f.fromName} onChange={set('fromName')} hint="Who the email appears to be from." maxLength={80} />
              <Input label="Replies go to" type="email" value={f.replyTo} onChange={set('replyTo')} placeholder="office@yourchurch.org" hint="When someone replies, it lands here." />
            </div>
          </section>
          <section className="panel px-6 py-5">
            <h2 className="mb-4 text-[15px] font-semibold text-ink">Footer</h2>
            <Textarea label="Footer text" rows={3} value={f.footer} onChange={set('footer')} placeholder={'12 Church Road, Ikeja, Lagos\nSundays 8am and 10am'} maxLength={500} />
            <Input className="mb-0" label="Website" value={f.website} onChange={set('website')} placeholder="https://yourchurch.org" />
            <p className="hint">Every email also includes an unsubscribe link, added automatically.</p>
          </section>
        </fieldset>
        {canEdit ? <div className="flex justify-end"><Button type="submit" loading={busy}>Save branding</Button></div>
          : <Notice tone="info">Only the church owner can change email branding.</Notice>}
      </form>
      <div className="2xl:sticky 2xl:top-6">
        <EmailPreview org={me.org} branding={f} subject="This Sunday: Family Service" preheader="Bring a friend, there’s a seat for everyone" blocks={sample} person={person} fromAddress={data.fromAddress} />
      </div>
    </div>
  )
}


function TagsTab() {
  const { tags, reload } = useTags()
  const toast = useToast()
  const confirm = useConfirm()
  const [edit, setEdit] = useState(null)
  const [f, setF] = useState({ name: '', color: 'forest' })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  useEffect(() => { if (edit) { setF(edit === 'new' ? { name: '', color: TAG_COLORS[tags.length % TAG_COLORS.length] } : { name: edit.name, color: edit.color }); setErr('') } }, [edit]) // eslint-disable-line
  async function save() {
    setBusy(true); setErr('')
    try { edit === 'new' ? await api.post('/tags', f) : await api.patch(`/tags/${edit.id}`, f); await reload(); setEdit(null); toast('Tag saved') }
    catch (e) { setErr(e.message) } finally { setBusy(false) }
  }
  async function remove(t) {
    if (!(await confirm({ title: `Delete the tag “${t.name}”?`, message: `It will be removed from ${t.count} ${t.count === 1 ? 'person' : 'people'}. The people themselves are not affected.`, confirmLabel: 'Delete tag', danger: true }))) return
    try { await api.del(`/tags/${t.id}`); await loadTags(true); toast('Tag deleted') } catch (e) { toast(e.message, 'error') }
  }
  return (
    <section className="panel overflow-hidden">
      <div className="flex items-start justify-between gap-4 border-b border-mist-100 px-6 py-4">
        <div>
          <h2 className="text-[15px] font-semibold text-ink">Tags</h2>
          <p className="text-sm text-mist-500">Labels for grouping people, like “Choir”, “Youth” or “Newsletter”. Use them to filter the People list and choose who gets an email.</p>
        </div>
        <Button size="sm" icon={Plus} onClick={() => setEdit('new')}>New tag</Button>
      </div>
      {tags.length === 0 ? (
        <EmptyState icon={Layers} title="No tags yet">Create a tag here, or tick people on the People page and choose “Tag or update”.</EmptyState>
      ) : (
        <ul className="divide-y divide-mist-100">
          {tags.map(t => (
            <li key={t.id} className="flex items-center gap-3 px-6 py-3">
              <TagChip tag={t} />
              <span className="flex-1 text-sm text-mist-500">{t.count} {t.count === 1 ? 'person' : 'people'}</span>
              <a href={`/app/people?tag=${t.id}`} className="text-sm text-brand-700 hover:underline">View people</a>
              <IconButton icon={Pencil} label={`Edit ${t.name}`} onClick={() => setEdit(t)} />
              <IconButton icon={Trash2} label={`Delete ${t.name}`} onClick={() => remove(t)} />
            </li>
          ))}
        </ul>
      )}
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit === 'new' ? 'New tag' : 'Edit tag'} size="sm"
        footer={<><Button variant="secondary" onClick={() => setEdit(null)}>Cancel</Button><Button onClick={save} loading={busy} disabled={!f.name.trim()}>Save</Button></>}>
        {err && <Notice tone="danger" className="mb-4">{err}</Notice>}
        <Input label="Name" value={f.name} onChange={e => setF(x => ({ ...x, name: e.target.value }))} maxLength={40} autoFocus />
        <p className="label">Colour</p>
        <div className="flex flex-wrap gap-2">
          {TAG_COLORS.map(c => (
            <button key={c} type="button" onClick={() => setF(x => ({ ...x, color: c }))} aria-pressed={f.color === c}
              className={`rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset ${TAG_STYLES[c]} ${f.color === c ? 'outline outline-2 outline-offset-2 outline-ink' : ''}`}>
              {f.name.trim() || 'Tag'}
            </button>
          ))}
        </div>
      </Modal>
    </section>
  )
}


function BriefPreference() {
  const toast = useToast()
  const { data, reload } = useLoad(() => api.get('/me/notifications'), [])
  if (!data?.canReceiveBrief) return null
  async function set(v) {
    try { await api.patch('/me/notifications', { brief: v }); toast(v ? 'You’ll get the Monday brief' : 'Monday brief turned off'); reload() } catch (e) { toast(e.message, 'error') }
  }
  return (
    <section className="panel px-6 py-5">
      <h2 className="mb-1 text-[15px] font-semibold text-ink">Emails to you</h2>
      <Toggle checked={data.brief} onChange={set} label="Monday Pastor’s Brief" hint="Last week’s attendance, first-time visitors, people to check on and follow-ups, every Monday at 7am." />
    </section>
  )
}

function JourneyStep({ step, value, stats, connected, canEdit, onSaved }) {
  const toast = useToast()
  const { me } = useSession()
  const [open, setOpen] = useState(false)
  const [f, setF] = useState(null)
  const [blocks, setBlocks] = useState([])
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')
  useEffect(() => { if (open) { setF({ subject: value.subject, preheader: value.preheader || '', delayHours: value.delayHours }); setBlocks(withKeys(value.blocks)); setErr('') } }, [open]) // eslint-disable-line
  const draft = () => ({ ...f, blocks: stripKeys(blocks) })
  async function save(patch, label) {
    setBusy(label); setErr('')
    try { await api.patch('/automation', { journey: { [step.key]: patch } }); onSaved(); toast(label === 'toggle' ? (patch.enabled ? `“${step.label}” email switched on` : `“${step.label}” email switched off`) : 'Email saved'); if (label === 'save') setOpen(false) }
    catch (e) { setErr(e.message); toast(e.message, 'error') } finally { setBusy('') }
  }
  async function test() {
    setBusy('test'); setErr('')
    try { const r = await api.post('/automation/journey/test', { step: step.key, draft: draft() }); toast(`Test sent to ${r.to}`) }
    catch (e) { setErr(e.message) } finally { setBusy('') }
  }
  const delayLabel = DELAY_OPTIONS.find(([h]) => h === value.delayHours)?.[1] || `${value.delayHours} hours later`
  return (
    <div className="rounded-xl border border-mist-200 bg-white">
      <div className="flex flex-wrap items-center gap-4 px-5 py-4">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-ink">{step.label}</p>
          <p className="text-xs text-mist-500">{step.hint} Sent {delayLabel.toLowerCase()}. “{value.subject}”</p>
          {stats?.sent > 0 && <p className="mt-1 text-xs text-brand-700">Sent to {stats.sent} {stats.sent === 1 ? 'person' : 'people'} so far</p>}
        </div>
        <Button size="sm" variant="secondary" onClick={() => setOpen(o => !o)}>{open ? 'Close' : canEdit ? 'Edit email' : 'View email'}</Button>
        <label className={`flex items-center gap-2 text-sm font-medium ${canEdit ? 'cursor-pointer' : 'opacity-60'}`}>
          <input type="checkbox" className="peer sr-only" checked={value.enabled} disabled={!canEdit || busy === 'toggle'} onChange={e => save({ enabled: e.target.checked }, 'toggle')} />
          <span className="relative h-6 w-11 rounded-full bg-mist-200 transition-colors after:absolute after:left-0.5 after:top-0.5 after:h-5 after:w-5 after:rounded-full after:bg-white after:shadow after:transition-transform peer-checked:bg-brand-700 peer-checked:after:translate-x-5" />
          <span className={value.enabled ? 'text-brand-700' : 'text-mist-500'}>{value.enabled ? 'On' : 'Off'}</span>
        </label>
      </div>
      {open && f && (
        <div className="border-t border-mist-100 px-5 py-5">
          {err && <Notice tone="danger" className="mb-4">{err}</Notice>}
          <div className="grid items-start gap-6 2xl:grid-cols-[minmax(0,1fr)_minmax(0,480px)]">
            <fieldset disabled={!canEdit} className="space-y-4">
              <div className="grid gap-x-4 sm:grid-cols-[1fr_200px]">
                <Input label="Subject" value={f.subject} onChange={e => setF(x => ({ ...x, subject: e.target.value }))} maxLength={200} />
                <Select label="When to send" value={f.delayHours} onChange={e => setF(x => ({ ...x, delayHours: Number(e.target.value) }))}>
                  {DELAY_OPTIONS.map(([h, l]) => <option key={h} value={h}>{l}</option>)}
                </Select>
              </div>
              <Input label="Preview text" value={f.preheader} onChange={e => setF(x => ({ ...x, preheader: e.target.value }))} maxLength={200} hint="The short line shown next to the subject in the inbox." />
              <EmailBlocksEditor blocks={blocks} setBlocks={setBlocks} />
              {canEdit && (
                <div className="flex flex-wrap justify-end gap-2">
                  <Button variant="secondary" onClick={test} loading={busy === 'test'} disabled={!connected}>Send test to me</Button>
                  <Button onClick={() => save(draft(), 'save')} loading={busy === 'save'}>Save email</Button>
                </div>
              )}
            </fieldset>
            <EmailPreview org={me.org} branding={brandingPreview(me)} subject={f.subject} preheader={f.preheader} blocks={stripKeys(blocks)} person={{ first_name: 'Temi', last_name: 'Adebayo' }} />
          </div>
        </div>
      )}
    </div>
  )
}
// Branding for previews comes from the email settings, loaded once.
let brandingCache = null
function brandingPreview() { return brandingCache || {} }

function AutomationsTab() {
  const { can, me } = useSession()
  const toast = useToast()
  const canEdit = can('org.manage')
  const { data, error, reload } = useLoad(async () => {
    const [a, e] = await Promise.all([api.get('/automation'), api.get('/email/settings')])
    brandingCache = e.branding
    return a
  }, [])
  const [wa, setWa] = useState(null)
  const [preview, setPreview] = useState(null)
  const [busy, setBusy] = useState('')
  useEffect(() => { if (data) setWa({ ...data.whatsapp }) }, [data])

  if (error) return <ErrorState error={error} onRetry={reload} />
  if (!data || !wa) return <Skeleton className="h-64" />

  async function setBrief(v) {
    try { await api.patch('/automation', { briefEnabled: v }); toast(v ? 'Monday brief switched on' : 'Monday brief switched off'); reload() } catch (e) { toast(e.message, 'error') }
  }
  async function openPreview() {
    setBusy('preview')
    try { setPreview(await api.get('/automation/brief/preview')) } catch (e) { toast(e.message, 'error') } finally { setBusy('') }
  }
  async function testBrief() {
    setBusy('brief')
    try { const r = await api.post('/automation/brief/test'); toast(`Brief sent to ${r.to}`) } catch (e) { toast(e.message, 'error') } finally { setBusy('') }
  }
  async function saveWa() {
    setBusy('wa')
    try { await api.patch('/automation', { whatsapp: wa }); toast('WhatsApp messages saved'); reload() } catch (e) { toast(e.message, 'error') } finally { setBusy('') }
  }

  return (
    <div className="space-y-6">
      {!data.connected && <Notice tone="info" title="Email sending isn’t switched on yet">You can set everything up now. Emails start going out once sending is connected.</Notice>}

      <section className="panel px-6 py-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-xl">
            <h2 className="text-[15px] font-semibold text-ink">Monday Pastor’s Brief</h2>
            <p className="mt-1 text-sm text-mist-500">Every Monday at 7am, owners and admins get last week at a glance: attendance against the usual, first-time visitors by name, regulars who haven’t been seen for two weeks, overdue follow-ups, birthdays and upcoming events.</p>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={openPreview} loading={busy === 'preview'}>Preview</Button>
            {canEdit && <Button size="sm" variant="secondary" onClick={testBrief} loading={busy === 'brief'} disabled={!data.connected}>Send me one now</Button>}
          </div>
        </div>
        <div className="mt-2">
          <Toggle checked={data.briefEnabled} onChange={v => canEdit && setBrief(v)} label="Send the Monday brief" hint={canEdit ? 'Each person can also switch it off for themselves under My account.' : 'Only the church owner can change this.'} />
        </div>
      </section>

      <section className="panel px-6 py-5">
        <h2 className="text-[15px] font-semibold text-ink">Welcome journey</h2>
        <p className="mb-4 mt-1 max-w-2xl text-sm text-mist-500">Automatic emails to visitors after their first, second and third visits, from {me.org.name}, with your logo and colours. Each is off until you switch it on. Your follow-up team still gets call tasks as usual.</p>
        <div className="space-y-3">
          {JOURNEY_STEPS.map(step => <JourneyStep key={step.key} step={step} value={data.journey[step.key]} stats={data.journeyStats?.[step.key]} connected={data.connected} canEdit={canEdit} onSaved={reload} />)}
        </div>
        <p className="mt-3 text-xs text-mist-500">Only visitors with an email address who haven’t unsubscribed receive these. Nobody gets the same email twice.</p>
      </section>

      <section className="panel px-6 py-5">
        <h2 className="text-[15px] font-semibold text-ink">WhatsApp messages</h2>
        <p className="mb-4 mt-1 max-w-2xl text-sm text-mist-500">The ready-written message that opens in WhatsApp when your team taps WhatsApp on a follow-up or a person’s page. They can change it before sending. Use {'{first_name}'}, {'{church_name}'} and {'{my_name}'} (the person sending).</p>
        <fieldset disabled={!canEdit} className="grid gap-x-4 lg:grid-cols-2">
          {WHATSAPP_KINDS.map(([k, label]) => <Textarea key={k} label={label} rows={3} value={wa[k]} onChange={e => setWa(x => ({ ...x, [k]: e.target.value }))} maxLength={1000} />)}
        </fieldset>
        {canEdit && <div className="flex justify-end"><Button onClick={saveWa} loading={busy === 'wa'}>Save messages</Button></div>}
      </section>

      <Modal open={!!preview} onClose={() => setPreview(null)} title="This week’s brief" description={preview?.subject} size="xl">
        {preview && <iframe title="Brief preview" srcDoc={preview.html} sandbox="allow-same-origin allow-popups" className="h-[70vh] w-full rounded-lg border border-mist-200 bg-[#F3F4F0]" />}
      </Modal>
    </div>
  )
}

export default function Settings() {
  const { can, branchesEnabled } = useSession()
  const [params, setParams] = useSearchParams()
  const tabs = [
    can('org.manage') && ['church', 'Church'],
    can('branches.manage') && branchesEnabled && ['branches', 'Branches'],
    can('team.manage') && ['team', 'Team'],
    can('messages.manage') && ['email', 'Email'],
    (can('org.manage') || can('messages.manage')) && ['automations', 'Automations'],
    can('people.edit') && ['tags', 'Tags'],
    can('units.manage') && ['units', 'Service units'],
    can('attendance.manage') && ['templates', 'Templates'],
    ['account', 'My account'],
    can('org.manage') && ['activity', 'Activity log'],
  ].filter(Boolean)
  const tab = tabs.some(t => t[0] === params.get('tab')) ? params.get('tab') : tabs[0][0]
  const Body = { church: ChurchTab, branches: BranchesTab, team: TeamTab, email: EmailTab, automations: AutomationsTab, tags: TagsTab, units: UnitsTab, templates: TemplatesTab, account: AccountTab, activity: ActivityTab }[tab]
  return (
    <div>
      <PageHeader title="Settings" />
      <div className="grid gap-6 md:grid-cols-[200px_1fr]">
        <nav className="flex gap-1 overflow-x-auto md:flex-col scrollbar-none" aria-label="Settings sections">
          {tabs.map(([k, l]) => (
            <button key={k} type="button" onClick={() => setParams({ tab: k }, { replace: true })} aria-current={tab === k ? 'page' : undefined}
              className={`whitespace-nowrap rounded-lg px-3 py-2 text-left text-sm font-medium ${tab === k ? 'bg-white text-ink shadow-card ring-1 ring-mist-200' : 'text-mist-600 hover:bg-white/60 hover:text-ink'}`}>{l}</button>
          ))}
        </nav>
        <div className="min-w-0"><Body /></div>
      </div>
    </div>
  )
}
