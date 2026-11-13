import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, Copy, KeyRound, LogOut, Mail } from 'lucide-react'
import { api } from '../../lib/api'
import { useAdmin } from './AdminApp'
import { useLoad, PageLoader, ErrorState, Button, Toggle, Notice, Badge, useToast, useConfirm } from '../../components/ui'
import { fmtDate, relative } from '../../lib/format'
import { adminPath } from '../../lib/host'

export default function AdminUser() {
  const { id } = useParams()
  const { me } = useAdmin()
  const toast = useToast()
  const confirm = useConfirm()
  const { data: u, error, loading, reload } = useLoad(() => api.get(`/platform/users/${id}`), [id])
  const [reset, setReset] = useState(null)
  const [busy, setBusy] = useState('')
  if (loading && !u) return <PageLoader />
  if (error) return <ErrorState error={error} onRetry={reload} />

  async function makeReset() {
    setBusy('reset')
    try { setReset(await api.post(`/platform/users/${id}/reset-link`, {})) } catch (e) { toast(e.message, 'error') } finally { setBusy('') }
  }
  async function signOut() {
    if (!(await confirm({ title: `Sign ${u.name} out everywhere?`, message: 'They’ll need to sign in again on every phone and computer. Useful if a device was lost or shared.', confirmLabel: 'Sign out everywhere' }))) return
    try { await api.post(`/platform/users/${id}/sign-out`, {}); toast(`${u.name} will need to sign in again`) } catch (e) { toast(e.message, 'error') }
  }
  async function setAdmin(on) {
    if (!(await confirm({ title: on ? `Give ${u.name} admin access?` : `Remove ${u.name}’s admin access?`,
      message: on ? 'They’ll be able to open this console, see every church, change plans and suspend churches.' : 'They’ll no longer be able to open this console.', confirmLabel: on ? 'Give access' : 'Remove access', danger: on }))) return
    try { await api.patch(`/platform/users/${id}`, { platformAdmin: on }); await reload(); toast(on ? 'Admin access given' : 'Admin access removed') } catch (e) { toast(e.message, 'error') }
  }

  return (
    <div className="max-w-3xl">
      <Link to={adminPath('/users')} className="inline-flex items-center gap-1.5 text-sm text-mist-500 hover:text-ink"><ArrowLeft size={15} />Users</Link>
      <div className="mt-3 flex flex-wrap items-center gap-2"><h1 className="text-[26px] font-semibold text-ink">{u.name}</h1>{u.is_platform_admin && <Badge tone="brand">Admin</Badge>}</div>
      <p className="mt-1 text-sm text-mist-500">{u.email} · joined {fmtDate(u.created_at)} · {u.last_login_at ? `last signed in ${relative(u.last_login_at)}` : 'never signed in'}</p>

      <section className="panel mt-6 overflow-hidden">
        <div className="border-b border-mist-100 px-4 py-3"><h2 className="text-[15px] font-semibold text-ink">Churches</h2></div>
        {u.churches.length === 0 ? <p className="px-4 py-6 text-sm text-mist-400">Not part of any church.</p> : (
          <ul className="divide-y divide-mist-100">
            {u.churches.map(c => (
              <li key={c.org_id}><Link to={adminPath(`/churches/${c.org_id}`)} className="flex items-center justify-between px-4 py-3 hover:bg-mist-50">
                <span className="font-medium text-ink">{c.org_name}</span>
                <span className="text-sm text-mist-500">{c.role_label}{c.status !== 'active' && ` · ${c.status}`}</span>
              </Link></li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel mt-6 px-5 py-4">
        <h2 className="text-[15px] font-semibold text-ink">Help them get in</h2>
        <p className="mt-1 text-sm text-mist-500">Sends a link to choose a new password. You also get the link, so you can share it on WhatsApp if the email doesn’t arrive.</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button icon={KeyRound} variant="secondary" loading={busy === 'reset'} onClick={makeReset}>Send password reset</Button>
          <Button icon={LogOut} variant="ghost" onClick={signOut}>Sign out everywhere</Button>
          <a href={`mailto:${u.email}`} className="inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium text-ink hover:bg-mist-100"><Mail size={16} />Email them</a>
        </div>
        {reset && (
          <Notice tone={reset.emailed ? 'success' : 'info'} className="mt-4" title={reset.emailed ? `Emailed to ${reset.email}` : 'Email isn’t set up, so share this link yourself'}>
            <div className="mt-1 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded bg-white/70 px-2 py-1 text-xs">{reset.link}</code>
              <Button size="sm" variant="secondary" icon={Copy} onClick={async () => { try { await navigator.clipboard.writeText(reset.link); toast('Link copied') } catch { toast('Couldn’t copy. Select the link instead.', 'error') } }}>Copy</Button>
            </div>
            <p className="mt-1 text-xs">The link works once and expires after a few hours.</p>
          </Notice>
        )}
      </section>

      <section className="panel mt-6 px-5 py-3">
        <Toggle label="GatherHQ admin" checked={u.is_platform_admin}
          hint={u.admin_from_settings ? 'Set by PLATFORM_ADMIN_EMAILS in Netlify. Change it there.' : u.id === me.user.id ? 'This is you. Another admin has to remove your access.' : 'Can open this console and manage every church.'}
          onChange={on => (u.admin_from_settings || (u.id === me.user.id && !on) ? toast(u.admin_from_settings ? 'Change this in Netlify.' : 'You can’t remove your own access.', 'error') : setAdmin(on))} />
      </section>
    </div>
  )
}
