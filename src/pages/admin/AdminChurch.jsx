import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, Mail } from 'lucide-react'
import { api } from '../../lib/api'
import { useLoad, PageLoader, ErrorState, Table, Th, Td, Button, Modal, Select, Input, Toggle, useToast, useConfirm, Badge } from '../../components/ui'
import { fmtDate, relative } from '../../lib/format'
import { adminPath } from '../../lib/host'
import { money, planLabel, PlanBadge, StatusBadge, Stat, WeekBars, actionLabel } from './shared'

function Row({ label, children }) {
  return <div className="flex justify-between gap-4 py-2 text-sm"><dt className="text-mist-500">{label}</dt><dd className="text-right text-ink">{children}</dd></div>
}

function ManualPlanModal({ open, onClose, onSave }) {
  const inAYear = new Date(Date.now() + 365 * 86400e3).toISOString().slice(0, 10)
  const [f, setF] = useState({ plan: 'church', interval: 'yearly', until: inAYear })
  const [busy, setBusy] = useState(false)
  return (
    <Modal open={open} onClose={onClose} title="Set a plan by hand" description="For a church that paid you another way, such as a bank transfer. The plan stays active until the date you choose, then the church is asked to pay as normal."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button loading={busy} onClick={async () => { setBusy(true); try { await onSave(f) } finally { setBusy(false) } }}>Set plan</Button></>}>
      <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
        <Select label="Plan" value={f.plan} onChange={e => setF({ ...f, plan: e.target.value })}><option value="church">Single church ($19 / $190)</option><option value="network">Church network ($59 / $590)</option></Select>
        <Select label="Counts as" value={f.interval} onChange={e => setF({ ...f, interval: e.target.value })}><option value="monthly">Monthly</option><option value="yearly">Yearly</option></Select>
      </div>
      <Input label="Paid until" type="date" value={f.until} min={new Date().toISOString().slice(0, 10)} onChange={e => setF({ ...f, until: e.target.value })} />
    </Modal>
  )
}

function CloseModal({ open, onClose, name, onConfirm }) {
  const [text, setText] = useState('')
  return (
    <Modal open={open} onClose={onClose} title={`Close ${name}?`} description="Their team loses access and their public check-in links stop working. Nothing is deleted, and you can reactivate the church later."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="danger" disabled={text.trim() !== name.trim()} onClick={onConfirm}>Close church</Button></>}>
      <Input label={`Type ${name} to confirm`} value={text} onChange={e => setText(e.target.value)} />
    </Modal>
  )
}

export default function AdminChurch() {
  const { id } = useParams()
  const toast = useToast()
  const confirm = useConfirm()
  const { data: o, error, loading, reload } = useLoad(() => api.get(`/platform/orgs/${id}`), [id])
  const [days, setDays] = useState('14')
  const [modal, setModal] = useState(null)
  if (loading && !o) return <PageLoader />
  if (error) return <ErrorState error={error} onRetry={reload} />

  const patch = async (body, msg) => {
    try { await api.patch(`/platform/orgs/${id}`, body); await reload(); setModal(null); toast(msg) } catch (e) { toast(e.message, 'error') }
  }
  const ask = async (opts, body, msg) => { if (await confirm(opts)) await patch(body, msg) }
  const b = o.billing, bd = o.billing_detail
  const isFree = b.state === 'free'

  return (
    <div>
      <Link to={adminPath('/churches')} className="inline-flex items-center gap-1.5 text-sm text-mist-500 hover:text-ink"><ArrowLeft size={15} />Churches</Link>
      <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2"><h1 className="text-[26px] font-semibold text-ink">{o.name}</h1><StatusBadge status={o.status} /><PlanBadge billing={b} /></div>
          <p className="mt-1 text-sm text-mist-500">{[o.country, o.timezone, `joined ${fmtDate(o.created_at)}`].filter(Boolean).join(' · ')}</p>
        </div>
        {o.owner_email && <a href={`mailto:${o.owner_email}`} className="inline-flex items-center gap-2 rounded-lg border border-mist-200 bg-white px-3.5 py-2 text-sm font-medium text-ink hover:border-mist-300"><Mail size={15} />Email {o.owner_name?.split(' ')[0] || 'the owner'}</a>}
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-6">
          <section className="panel grid grid-cols-2 divide-mist-100 sm:grid-cols-3 sm:divide-x">
            <Stat label="People" value={o.people.toLocaleString()} />
            <Stat label="Check-ins, 7 days" value={o.checkins_7d} hint={o.last_checkin_at ? `last ${relative(o.last_checkin_at)}` : 'none yet'} />
            <Stat label="Services recorded" value={o.sessions} />
            <Stat label="Team members" value={o.team} />
            <Stat label="Events" value={o.counts.events} />
            <Stat label="Messages" value={o.counts.messages} />
          </section>

          <section className="panel px-5 py-4">
            <div className="flex items-baseline justify-between"><h2 className="text-[15px] font-semibold text-ink">Check-ins each week</h2><span className="text-xs text-mist-400">Last 8 weeks</span></div>
            <div className="mt-6"><WeekBars data={o.weekly_checkins} label="Check-ins each week" height={100} /></div>
          </section>

          <section className="panel overflow-hidden">
            <div className="border-b border-mist-100 px-4 py-3"><h2 className="text-[15px] font-semibold text-ink">Team</h2></div>
            <Table>
              <thead><tr><Th>Name</Th><Th>Role</Th><Th>Last signed in</Th></tr></thead>
              <tbody>
                {o.team_members.map(m => (
                  <tr key={m.user_id}>
                    <Td><Link to={adminPath(`/users/${m.user_id}`)} className="font-medium text-ink hover:underline">{m.name}</Link><div className="text-xs text-mist-500">{m.email}</div></Td>
                    <Td>{m.role_label}{m.status !== 'active' && <Badge className="ml-2">{m.status}</Badge>}</Td>
                    <Td className="whitespace-nowrap text-mist-600">{m.last_login_at ? relative(m.last_login_at) : 'Never'}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </section>

          <section className="panel overflow-hidden">
            <div className="border-b border-mist-100 px-4 py-3"><h2 className="text-[15px] font-semibold text-ink">Recent activity</h2><p className="text-xs text-mist-400">What was done and by whom. Details of people’s records are not shown.</p></div>
            {o.activity.length === 0 ? <p className="px-4 py-6 text-sm text-mist-400">Nothing yet.</p> : (
              <ul className="max-h-96 divide-y divide-mist-100 overflow-y-auto">
                {o.activity.map((a, i) => (
                  <li key={i} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                    <span className="min-w-0 truncate text-ink">{actionLabel(a.action)}{a.by && <span className="text-mist-500"> · {a.by}</span>}</span>
                    <span className="shrink-0 text-xs text-mist-400">{relative(a.at)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <div className="space-y-6">
          <section className="panel px-5 py-4">
            <h2 className="text-[15px] font-semibold text-ink">Plan</h2>
            <dl className="mt-2 divide-y divide-mist-100">
              <Row label="Now">{planLabel(b)}</Row>
              {b.state === 'trialing' && <Row label="Trial ends">{fmtDate(b.trialEndsAt)}</Row>}
              {b.renewsAt && <Row label={b.manual ? 'Paid until' : b.cancelling ? 'Ends' : 'Renews'}>{fmtDate(b.renewsAt)}</Row>}
              {o.mrr > 0 && <Row label="Worth">{money(o.mrr, o.mrr % 1 !== 0)} / month</Row>}
              {bd.card && <Row label="Card">{bd.card.brand} •••• {bd.card.last4}{bd.card.exp ? ` · ${bd.card.exp}` : ''}</Row>}
              {bd.last_payment_at && <Row label="Last payment">{fmtDate(bd.last_payment_at)}</Row>}
              {bd.email && <Row label="Billing email">{bd.email}</Row>}
              {bd.customer_code && <Row label="Stripe customer"><span className="font-mono text-xs">{bd.customer_code}</span></Row>}
              {bd.last_error && b.state === 'past_due' && <Row label="Last error"><span className="text-red-700">{bd.last_error}</span></Row>}
            </dl>
            {!isFree && (
              <div className="mt-4 border-t border-mist-100 pt-4">
                <div className="text-sm font-medium text-ink">Give more trial time</div>
                <div className="mt-2 flex gap-2">
                  <select className="field flex-1" value={days} onChange={e => setDays(e.target.value)} aria-label="Days to add">
                    {['7', '14', '30', '60', '90'].map(d => <option key={d} value={d}>{d} more days</option>)}
                  </select>
                  <Button variant="secondary" onClick={() => patch({ extendTrialDays: Number(days) }, `Trial extended by ${days} days`)} disabled={b.state === 'active' || b.state === 'past_due'}>Extend</Button>
                </div>
                {(b.state === 'active' || b.state === 'past_due') && <p className="mt-1.5 text-xs text-mist-400">This church is on a paid plan.</p>}
              </div>
            )}
            <div className="mt-4 flex flex-col gap-2 border-t border-mist-100 pt-4">
              {!isFree && (b.manual
                ? <Button variant="secondary" onClick={() => ask({ title: 'Remove the hand-set plan?', message: 'The church goes back to its trial, or is asked to choose a plan if the trial has ended.', confirmLabel: 'Remove plan' }, { manualPlan: null }, 'Plan removed')}>Remove hand-set plan</Button>
                : <Button variant="secondary" onClick={() => setModal('manual')}>Set a plan by hand</Button>)}
              <Button variant="ghost" onClick={() => ask(isFree
                ? { title: `Put ${o.name} back on paid plans?`, message: 'They return to their normal trial or plan.', confirmLabel: 'Confirm' }
                : { title: `Make ${o.name} free?`, message: 'They will never be asked to pay. You can change this later.', confirmLabel: 'Make free' },
              { plan: isFree ? 'trial' : 'free' }, isFree ? 'Back on paid plans' : `${o.name} is now free`)}>{isFree ? 'Remove free access' : 'Make this church free'}</Button>
            </div>
          </section>

          <section className="panel px-5 py-3">
            <h2 className="pt-1 text-[15px] font-semibold text-ink">Features</h2>
            <Toggle label="Multiple branches" hint={o.branches > 1 ? `${o.branches} branches: ${o.branch_list.map(x => x.name).join(', ')}` : 'Lets them add branches and campuses.'}
              checked={o.multi_branch} onChange={on => ask({ title: on ? 'Turn on multiple branches?' : 'Turn off multiple branches?', message: on ? 'They can add branches and campuses, give people branch access, and see reports by branch.' : 'They won’t be able to add new branches. Branches they already have keep working.', confirmLabel: on ? 'Turn on' : 'Turn off' }, { multiBranch: on }, on ? 'Multiple branches on' : 'Multiple branches off')} />
            <Toggle label="Children’s church" hint="Check-in with labels and pickup codes. Churches can also switch this on themselves."
              checked={!!o.children} onChange={on => ask({ title: on ? 'Turn on children’s church?' : 'Turn off children’s church?', message: on ? 'Adds a Children page to their menu with check-in, classes and pickup.' : 'Their Children page disappears. Nothing is deleted.', confirmLabel: on ? 'Turn on' : 'Turn off' }, { children: on }, on ? 'Children’s church on' : 'Children’s church off')} />
          </section>

          <section className="panel px-5 py-4">
            <h2 className="text-[15px] font-semibold text-ink">Access</h2>
            <dl className="mt-1 divide-y divide-mist-100">
              <Row label="Agreed to terms">{o.terms_accepted_at ? fmtDate(o.terms_accepted_at) : '—'}</Row>
              <Row label="Signed the DPA">{o.dpa_accepted_at ? fmtDate(o.dpa_accepted_at) : 'Not yet'}</Row>
            </dl>
            <div className="mt-3 flex flex-col gap-2">
              {o.status === 'active'
                ? <Button variant="secondary" onClick={() => ask({ title: `Suspend ${o.name}?`, message: 'Their team keeps their logins but loses access, and public check-in links stop working, until you reactivate them. No data is deleted.', confirmLabel: 'Suspend', danger: true }, { status: 'suspended' }, `${o.name} suspended`)}>Suspend church</Button>
                : <Button onClick={() => patch({ status: 'active' }, `${o.name} reactivated`)}>Reactivate church</Button>}
              {o.status !== 'closed' && <Button variant="ghost" className="text-red-700" onClick={() => setModal('close')}>Close church…</Button>}
            </div>
          </section>
        </div>
      </div>

      <ManualPlanModal open={modal === 'manual'} onClose={() => setModal(null)} onSave={f => patch({ manualPlan: { ...f, until: new Date(`${f.until}T23:59:59Z`).toISOString() } }, 'Plan set')} />
      <CloseModal open={modal === 'close'} onClose={() => setModal(null)} name={o.name} onConfirm={() => patch({ status: 'closed', confirm: 'close' }, `${o.name} closed`)} />
    </div>
  )
}
