import { useState } from 'react'
import { Plus, Paperclip, Pencil, Trash2, Download } from 'lucide-react'
import { api } from '../../lib/api'
import { useLoad, Button, Input, Select, Textarea, Modal, Skeleton, ErrorState, EmptyState, Notice, Badge, useToast, useConfirm } from '../../components/ui'
import { Kpi, Panel, PageTitle, MonthBars, RangePicker, rangeQuery, fmtMoney, fmtDate } from './shared'

const CAT = { hosting: 'Hosting & infrastructure', email: 'Email services', messaging: 'SMS & WhatsApp providers', software: 'Software subscriptions', domains: 'Domains & security', marketing: 'Marketing & advertising', contractors: 'Contractors & professional services', other: 'Other operating expenses' }
const REC = { one_off: 'One-off', monthly: 'Monthly', yearly: 'Yearly' }
const blank = () => ({ name: '', category: 'hosting', amount: '', currency: 'usd', date: new Date().toISOString().slice(0, 10), vendor: '', description: '', recurring: 'one_off' })

export default function AdminExpenses() {
  const toast = useToast()
  const confirm = useConfirm()
  const [range, setRange] = useState({ range: 'year', from: '', to: '' })
  const [cat, setCat] = useState('')
  const { data, error, loading, reload } = useLoad(() => api.get(`/platform/expenses?${rangeQuery(range)}&category=${cat}`), [range.range, range.from, range.to, cat])
  const [edit, setEdit] = useState(null)
  const [file, setFile] = useState(null)
  const [busy, setBusy] = useState(false)
  if (error) return <ErrorState error={error} onRetry={reload} />
  if (loading && !data) return <Skeleton className="h-64" />

  async function save() {
    setBusy(true)
    try {
      const body = { ...edit, amount: Number(edit.amount) }
      const saved = edit.id ? await api.patch(`/platform/expenses/${edit.id}`, body) : await api.post('/platform/expenses', body)
      if (file) {
        const dataUrl = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file) })
        await api.post(`/platform/expenses/${saved.id}/receipt`, { name: file.name, type: file.type, data: dataUrl })
      }
      toast('Expense saved'); setEdit(null); setFile(null); reload()
    } catch (e) { toast(e.message, 'error') } finally { setBusy(false) }
  }
  const currencies = Object.keys(data.totals)
  const main = currencies[0] || 'usd'
  return (
    <div className="space-y-6">
      <PageTitle title="Expenses" sub="What it costs to run GatherHQ, recorded by hand." action={<div className="flex flex-wrap gap-2"><RangePicker value={range} onChange={setRange} /><Button icon={Plus} onClick={() => { setEdit(blank()); setFile(null) }}>Add expense</Button></div>} />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Object.entries(data.pnl).slice(0, 2).flatMap(([c, x]) => [
          <Kpi key={`e${c}`} label={`Expenses (${c.toUpperCase()})`} value={fmtMoney(x.expenses, c)} sub={data.range.label} />,
          <Kpi key={`r${c}`} label={`Revenue less expenses (${c.toUpperCase()})`} value={fmtMoney(x.result, c)} sub={x.margin == null ? `Net revenue ${fmtMoney(x.revenue, c)}` : `${x.margin}% estimated operating margin`} tone={x.result < 0 ? 'bad' : undefined} />,
        ])}
        {!Object.keys(data.pnl).length && <Kpi label="Expenses" value={fmtMoney(0)} sub={data.range.label} />}
        <Kpi label="Messaging costs" value={fmtMoney(data.by_category.messaging?.[main] || 0, main)} sub="Recorded under SMS & WhatsApp providers" />
      </div>
      <Notice>{data.note}</Notice>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1.4fr_1fr]">
        <Panel title={`Expenses by month (${main.toUpperCase()})`}><div className="px-5 py-4"><MonthBars data={data.months} series={[{ key: main, label: main.toUpperCase(), color: '#334155' }]} format={(v) => fmtMoney(v, main, false)} label="Expenses by month" /></div></Panel>
        <Panel title="By category">
          <ul className="divide-y divide-slate-100 text-sm">{Object.entries(data.by_category).map(([k, v]) => <li key={k} className="flex justify-between px-5 py-2"><button type="button" className="hover:underline" onClick={() => setCat(cat === k ? '' : k)}>{CAT[k]}{cat === k ? ' ✓' : ''}</button><span className="tabular">{Object.entries(v).map(([c, a]) => fmtMoney(a, c)).join(' + ')}</span></li>)}
            {!Object.keys(data.by_category).length && <li className="px-5 py-4 text-slate-500">Nothing recorded in this period.</li>}</ul>
        </Panel>
      </div>
      <Panel title={cat ? `${CAT[cat]}` : 'All expenses'} action={cat && <Button size="sm" variant="ghost" onClick={() => setCat('')}>Show all</Button>}>
        {data.rows.length ? <div className="overflow-x-auto"><table className="w-full text-sm">
          <thead><tr className="text-left text-xs text-slate-500"><th className="px-5 py-2 font-medium">Date</th><th className="px-3 py-2 font-medium">Expense</th><th className="px-3 py-2 font-medium">Category</th><th className="px-3 py-2 text-right font-medium">Amount</th><th className="px-5 py-2"><span className="sr-only">Actions</span></th></tr></thead>
          <tbody className="divide-y divide-slate-100">{data.rows.map(e => <tr key={e.id}>
            <td className="whitespace-nowrap px-5 py-2.5 text-slate-600">{fmtDate(e.date)}</td>
            <td className="px-3 py-2.5"><span className="font-medium text-slate-900">{e.name}</span>{e.vendor && <span className="text-slate-500"> · {e.vendor}</span>}{e.recurring !== 'one_off' && <Badge className="ml-2">{REC[e.recurring]}</Badge>}{e.description && <span className="block text-xs text-slate-500">{e.description}</span>}</td>
            <td className="px-3 py-2.5 text-slate-600">{CAT[e.category]}</td>
            <td className="tabular whitespace-nowrap px-3 py-2.5 text-right">{fmtMoney(e.amount, e.currency)}</td>
            <td className="whitespace-nowrap px-5 py-2.5 text-right">
              {e.receipt && <a href={`/api/platform/expenses/${e.id}/receipt`} className="inline-flex rounded p-1.5 text-slate-500 hover:bg-slate-100" title={`Receipt: ${e.receipt.name}`} aria-label="Download receipt"><Download size={15} /></a>}
              <button type="button" className="rounded p-1.5 text-slate-500 hover:bg-slate-100" aria-label="Edit" onClick={() => { setEdit({ ...e }); setFile(null) }}><Pencil size={15} /></button>
              <button type="button" className="rounded p-1.5 text-slate-500 hover:bg-slate-100" aria-label="Delete" onClick={async () => { if (await confirm({ title: `Delete “${e.name}”?`, message: 'This removes the expense and its receipt.', confirmLabel: 'Delete', danger: true })) { await api.del(`/platform/expenses/${e.id}`); reload() } }}><Trash2 size={15} /></button>
            </td></tr>)}</tbody></table></div>
          : <EmptyState title="No expenses yet">Record hosting, providers, software and other costs to see what GatherHQ costs to run.</EmptyState>}
      </Panel>
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? 'Edit expense' : 'Add expense'} footer={<><Button variant="secondary" onClick={() => setEdit(null)}>Cancel</Button><Button loading={busy} onClick={save}>Save</Button></>}>
        {edit && <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
          <div className="sm:col-span-2"><Input label="Expense" value={edit.name} onChange={e => setEdit({ ...edit, name: e.target.value })} placeholder="Netlify Pro" /></div>
          <Select label="Category" value={edit.category} onChange={e => setEdit({ ...edit, category: e.target.value })}>{Object.entries(CAT).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
          <Input label="Vendor" value={edit.vendor || ''} onChange={e => setEdit({ ...edit, vendor: e.target.value })} placeholder="Netlify" />
          <Input label="Amount" type="number" step="0.01" min="0" value={edit.amount} onChange={e => setEdit({ ...edit, amount: e.target.value })} />
          <Select label="Currency" value={edit.currency} onChange={e => setEdit({ ...edit, currency: e.target.value })}>{['usd', 'gbp', 'eur', 'ngn', 'ghs', 'kes', 'zar', 'xof'].map(c => <option key={c} value={c}>{c.toUpperCase()}</option>)}</Select>
          <Input label="Date" type="date" value={edit.date} onChange={e => setEdit({ ...edit, date: e.target.value })} />
          <Select label="Type" value={edit.recurring} onChange={e => setEdit({ ...edit, recurring: e.target.value })}>{Object.entries(REC).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
          <div className="sm:col-span-2"><Textarea label="Notes (optional)" rows={2} value={edit.description || ''} onChange={e => setEdit({ ...edit, description: e.target.value })} /></div>
          <div className="sm:col-span-2"><label className="label" htmlFor="receipt">Receipt (optional, PDF or image up to 700 KB)</label>
            <input id="receipt" type="file" accept="application/pdf,image/png,image/jpeg,image/webp" onChange={e => setFile(e.target.files?.[0] || null)} className="block w-full text-sm" />
            {edit.receipt && !file && <p className="mt-1 flex items-center gap-1 text-xs text-slate-500"><Paperclip size={12} />{edit.receipt.name} attached</p>}
            <p className="mt-1 text-xs text-slate-500">Recurring expenses are a label only: add each month’s or year’s payment as it happens.</p></div>
        </div>}
      </Modal>
    </div>
  )
}
