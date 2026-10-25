import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowUpRight, ArrowDownRight, Info } from 'lucide-react'
import { api, qs } from '../../lib/api'
import { useSession, useBranchParam } from '../../lib/session'
import { useLoad, PageHeader, Segmented, ErrorState, Skeleton, Table, Th, Td } from '../../components/ui'
import { StackedBars, HBars, CHART } from '../../components/Chart'
import { fmtDate, fmtDay, fmtNum, pctChange, KIND_LABELS } from '../../lib/format'

const RANGES = [{ value: '28', label: '4 weeks' }, { value: '84', label: '12 weeks' }, { value: '182', label: '6 months' }, { value: '365', label: '12 months' }]

function Stat({ label, value, prev, note }) {
  const ch = prev !== undefined ? pctChange(value, prev) : null
  return (
    <div className="px-5 py-4">
      <div className="tabular text-2xl font-semibold text-ink">{fmtNum(value)}</div>
      <div className="text-sm text-mist-500">{label}</div>
      {ch !== null && <div className={`mt-1 inline-flex items-center gap-0.5 text-xs font-medium ${ch >= 0 ? 'text-green-800' : 'text-red-700'}`}>{ch >= 0 ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />}{Math.abs(ch)}% vs previous period ({fmtNum(prev)})</div>}
      {note && <div className="mt-1 text-xs text-mist-400">{note}</div>}
    </div>
  )
}

function Section({ title, description, children, className = '' }) {
  return (
    <section className={`panel ${className}`}>
      <div className="border-b border-mist-100 px-5 py-4">
        <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
        {description && <p className="mt-0.5 text-sm text-mist-500">{description}</p>}
      </div>
      {children}
    </section>
  )
}

export default function Reports() {
  const { tz, multiBranch, branch: branchSel, branchName } = useSession()
  const branch = useBranchParam()
  const [days, setDays] = useState('84')
  const range = useMemo(() => ({ from: new Date(Date.now() - Number(days) * 86400000).toISOString(), to: new Date().toISOString() }), [days])
  const att = useLoad(() => api.get(`/reports/attendance${qs({ ...range, branch })}`), [range, branch])
  const vis = useLoad(() => api.get(`/reports/visitors${qs({ ...range, branch })}`), [range, branch])
  const dq = useLoad(() => api.get(`/reports/data-quality${qs({ branch })}`), [branch])

  const scope = branchSel === 'all' ? (multiBranch ? 'all branches' : '') : branchName(branchSel)
  const period = att.data ? `${fmtDate(att.data.from, tz)} – ${fmtDate(att.data.to, tz)}` : ''
  if (att.error) return <ErrorState error={att.error} onRetry={att.reload} />

  const a = att.data, v = vis.data
  const avg = a && a.totals.sessions ? Math.round(a.totals.current / a.totals.sessions) : 0
  const funnelRows = v ? [
    { label: 'First visit in this period', n: v.funnel.first_visits },
    { label: 'Came back at least once', n: v.funnel.returned },
    { label: 'Came three or more times', n: v.funnel.returned_3 },
    { label: 'Now members', n: v.funnel.became_members },
  ] : []

  return (
    <div>
      <PageHeader title="Reports" description={`${period}${scope ? ` · ${scope}` : ''}`} actions={<Segmented value={days} onChange={setDays} options={RANGES} />} />

      {!a ? <Skeleton className="h-28" /> : (
        <section className="panel mb-6 grid grid-cols-2 divide-mist-100 md:grid-cols-4 md:divide-x">
          <Stat label="total check-ins" value={a.totals.current} prev={a.totals.previous} />
          <Stat label="different people" value={a.totals.unique_people} note="Counted once however often they came" />
          <Stat label="sessions held" value={a.totals.sessions} />
          <Stat label="average per session" value={avg} />
        </section>
      )}

      <div className="grid gap-6 lg:grid-cols-[1.6fr_1fr]">
        <Section title="Weekly attendance" description="Check-ins across all sessions, by week. First-time means a visitor's first ever check-in.">
          <div className="px-5 py-5">
            {!a ? <Skeleton className="h-48" /> : (
              <StackedBars
                data={a.weekly.map(w => { const d = new Date(w.week + 'T00:00:00'); return { label: d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }), title: `Week of ${d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })} · ${w.sessions} session${w.sessions === 1 ? '' : 's'}`, values: [w.attendance - w.first_timers, w.first_timers] } })}
                series={[{ name: 'Returning', color: CHART.primary }, { name: 'First-time', color: CHART.accent }]} />
            )}
          </div>
        </Section>

        <Section title="Visitor journey" description="People whose first visit was in this period, and what has happened since.">
          <div className="px-5 py-5">
            {!v ? <Skeleton className="h-40" /> : v.funnel.first_visits === 0 ? <p className="text-sm text-mist-500">No first-time visitors in this period.</p> : (
              <ul className="space-y-3">
                {funnelRows.map((r, i) => (
                  <li key={r.label}>
                    <div className="mb-1 flex justify-between text-sm"><span className="text-ink">{r.label}</span>
                      <span className="tabular font-medium text-ink">{fmtNum(r.n)}{i > 0 && <span className="ml-1.5 font-normal text-mist-500">{Math.round((r.n / funnelRows[0].n) * 100)}%</span>}</span></div>
                    <div className="h-2 rounded-full bg-mist-100"><div className="h-2 rounded-full" style={{ width: `${(r.n / funnelRows[0].n) * 100}%`, background: CHART.primary, minWidth: r.n ? 4 : 0 }} /></div>
                  </li>
                ))}
              </ul>
            )}
            {v && v.funnel.first_visits > 0 && v.funnel.first_visits < 20 && <p className="mt-4 flex gap-1.5 text-xs text-mist-500"><Info size={13} className="mt-px shrink-0" />Small numbers — percentages can swing a lot week to week.</p>}
          </div>
        </Section>

        {multiBranch && branchSel === 'all' && (
          <Section title="By branch" description="Total check-ins in this period.">
            <div className="px-5 py-5">{!a ? <Skeleton className="h-32" /> : <HBars rows={a.byBranch} valueKey="attendance" />}</div>
          </Section>
        )}

        <Section title="Follow-ups" description="Follow-ups created in this period.">
          {!v ? <Skeleton className="m-5 h-24" /> : (
            <div className="grid grid-cols-2 divide-x divide-mist-100">
              <Stat label="created" value={v.followups.created} />
              <Stat label="completed" value={v.followups.completed} note={v.followups.created ? `${Math.round((v.followups.completed / v.followups.created) * 100)}% of those created` : null} />
              <div className="col-span-2 border-t border-mist-100 px-5 py-3 text-sm text-mist-600">
                {v.followups.avg_hours_to_close !== null ? <>Average time to complete: <span className="font-medium text-ink">{v.followups.avg_hours_to_close < 48 ? `${v.followups.avg_hours_to_close} hours` : `${Math.round(v.followups.avg_hours_to_close / 24)} days`}</span></> : 'None completed yet.'}
                {v.followups.overdue > 0 && <> · <Link to="/app/follow-ups?bucket=overdue" className="font-medium text-red-700 hover:underline">{v.followups.overdue} overdue</Link></>}
              </div>
            </div>
          )}
        </Section>

        {a && a.byKind.length > 1 && (
          <Section title="By type of session">
            <div className="px-5 py-5"><HBars rows={a.byKind.map(k => ({ ...k, name: `${KIND_LABELS[k.kind] || k.kind} (${k.sessions})` }))} valueKey="attendance" /></div>
          </Section>
        )}

        <Section title="Data quality" description="Gaps that make follow-up harder.">
          {!dq.data ? <Skeleton className="m-5 h-24" /> : (
            <ul className="divide-y divide-mist-100 text-sm">
              {[[dq.data.counts.no_phone, 'people without a phone number', '/app/people'], [dq.data.counts.no_email, 'people without an email', null],
                [dq.data.possibleDuplicates.byName.length, 'names that appear more than once', null], [dq.data.possibleDuplicates.byEmail.length, 'emails shared by more than one person', null]].map(([n, l, to]) => (
                <li key={l} className="flex items-center justify-between px-5 py-3"><span className="text-mist-600">{l}</span><span className={`tabular font-medium ${n ? 'text-ink' : 'text-mist-400'}`}>{fmtNum(n)}</span></li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      {a && a.sessions.length > 0 && (
        <Section title="Sessions in this period" className="mt-6 overflow-hidden">
          <Table>
            <thead><tr><Th>Date</Th><Th>Session</Th>{multiBranch && <Th>Branch</Th>}<Th className="text-right">Attendance</Th><Th className="text-right">First-time</Th></tr></thead>
            <tbody>{a.sessions.map(s => (
              <tr key={s.id} className="hover:bg-mist-50/70">
                <Td className="whitespace-nowrap text-mist-600">{fmtDay(s.starts_at, tz)}</Td>
                <Td><Link to={`/app/attendance/${s.id}`} className="font-medium text-ink hover:text-brand-700">{s.name}</Link></Td>
                {multiBranch && <Td className="text-mist-600">{s.branch_name}</Td>}
                <Td className="tabular text-right font-medium text-ink">{s.attendance}</Td>
                <Td className="tabular text-right text-mist-600">{s.first_timers}</Td>
              </tr>
            ))}</tbody>
          </Table>
        </Section>
      )}
    </div>
  )
}
