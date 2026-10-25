import { useState } from 'react'
import { FileSpreadsheet, Download, CheckCircle2 } from 'lucide-react'
import { api } from '../lib/api'
import { useSession, useBranchParam } from '../lib/session'
import { Modal, Button, Select, Notice, Badge } from './ui'

const TARGETS = [
  { key: 'firstName', label: 'First name', match: /^(first|given|fore)\s*name|^first$/i },
  { key: 'lastName', label: 'Last name', match: /^(last|sur|family)\s*name|^surname$|^last$/i },
  { key: 'fullName', label: 'Full name', match: /^(full\s*)?name$/i },
  { key: 'phone', label: 'Phone', match: /phone|mobile|cell|tel|whatsapp/i },
  { key: 'email', label: 'Email', match: /e-?mail/i },
  { key: 'gender', label: 'Gender', match: /gender|sex/i },
  { key: 'status', label: 'Status', match: /status|membership/i },
  { key: 'joinedAt', label: 'Date joined', match: /join|member\s*since/i },
  { key: 'birthday', label: 'Birthday', match: /birth|dob/i },
]

function guessMapping(headers) {
  const map = {}
  for (const t of TARGETS) {
    const i = headers.findIndex((h, idx) => t.match.test(String(h).trim()) && !Object.values(map).includes(idx))
    if (i >= 0) map[t.key] = i
  }
  if (map.firstName !== undefined && map.fullName !== undefined) delete map.fullName
  return map
}

function toCsv(rows) {
  const esc = (v) => /[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? '')
  return rows.map(r => r.map(esc).join(',')).join('\n')
}

export default function ImportPeople({ open, onClose, onDone }) {
  const { activeBranches } = useSession()
  const branchParam = useBranchParam()
  const [step, setStep] = useState('upload') // upload | map | preview | done
  const [fileName, setFileName] = useState('')
  const [sheet, setSheet] = useState({ headers: [], rows: [] })
  const [mapping, setMapping] = useState({})
  const [branchId, setBranchId] = useState(branchParam || activeBranches[0]?.id || '')
  const [policy, setPolicy] = useState('skip')
  const [preview, setPreview] = useState(null)
  const [summary, setSummary] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  function reset() { setStep('upload'); setSheet({ headers: [], rows: [] }); setMapping({}); setPreview(null); setSummary(null); setError(''); setFileName('') }
  function close() { reset(); onClose() }

  async function readFile(file) {
    setError(''); setBusy(true)
    try {
      const XLSX = await import('xlsx')
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true })
      const ws = wb.Sheets[wb.SheetNames[0]]
      const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' }).filter(r => r.some(c => String(c).trim()))
      if (aoa.length < 2) throw new Error('That file has no data rows. The first row should be column headings.')
      const headers = aoa[0].map((h, i) => String(h).trim() || `Column ${i + 1}`)
      setSheet({ headers, rows: aoa.slice(1) })
      setMapping(guessMapping(headers))
      setFileName(file.name)
      setStep('map')
    } catch (e) { setError(e.message || "Couldn't read that file.") } finally { setBusy(false) }
  }

  const records = () => sheet.rows.map(r => Object.fromEntries(Object.entries(mapping).filter(([, i]) => i !== undefined && i !== '').map(([k, i]) => [k, r[i]])))

  async function runPreview() {
    if (mapping.firstName === undefined && mapping.fullName === undefined) { setError('Choose which column holds first names (or full names).'); return }
    setError(''); setBusy(true)
    try { setPreview(await api.post('/people/import/preview', { branchId, rows: records() })); setStep('preview') }
    catch (e) { setError(e.message) } finally { setBusy(false) }
  }

  async function commit() {
    setError(''); setBusy(true)
    try { const r = await api.post('/people/import/commit', { branchId, rows: records(), duplicatePolicy: policy }); setSummary(r.summary); setStep('done'); onDone?.() }
    catch (e) { setError(e.message) } finally { setBusy(false) }
  }

  function downloadErrors() {
    const bad = preview.rows.filter(r => r.action === 'reject')
    const csv = toCsv([['Row', ...sheet.headers, 'Problem'], ...bad.map(r => [r.index + 2, ...sheet.rows[r.index], r.errors.join('; ')])])
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }))
    a.download = `import-problems-${fileName.replace(/\.\w+$/, '')}.csv`
    a.click()
  }

  const ACTION = { create: ['brand', 'New'], duplicate: ['info', 'Already exists'], skip: ['neutral', 'Repeated in file'], reject: ['danger', 'Problem'] }
  const footer = {
    upload: <Button variant="secondary" onClick={close}>Cancel</Button>,
    map: <><Button variant="secondary" onClick={reset}>Back</Button><Button onClick={runPreview} loading={busy}>Check {sheet.rows.length.toLocaleString()} rows</Button></>,
    preview: <><Button variant="secondary" onClick={() => setStep('map')}>Back</Button>
      <Button onClick={commit} loading={busy} disabled={!preview || (preview.summary.create === 0 && (policy === 'skip' || preview.summary.duplicate === 0))}>
        Import {preview ? (preview.summary.create + (policy === 'update' ? preview.summary.duplicate : 0)).toLocaleString() : ''} people
      </Button></>,
    done: <Button onClick={close}>Done</Button>,
  }[step]

  return (
    <Modal open={open} onClose={close} title="Import people" size="lg" description={fileName || 'From an Excel or CSV file'} footer={footer}>
      {error && <Notice tone="danger" className="mb-4">{error}</Notice>}

      {step === 'upload' && (
        <div className="pb-2">
          <label className="flex cursor-pointer flex-col items-center rounded-xl border-2 border-dashed border-mist-200 px-6 py-10 text-center hover:border-brand-300 hover:bg-brand-50/30">
            <FileSpreadsheet size={28} className="text-brand-600" />
            <span className="mt-3 text-sm font-medium text-ink">{busy ? 'Reading file…' : 'Choose a spreadsheet'}</span>
            <span className="mt-1 text-xs text-mist-500">.xlsx, .xls or .csv — up to 5,000 rows. First row must be headings.</span>
            <input type="file" accept=".xlsx,.xls,.csv" className="sr-only" onChange={e => e.target.files[0] && readFile(e.target.files[0])} />
          </label>
          <p className="mt-4 text-xs text-mist-500">You'll see exactly what will happen before anything is saved. People who already exist (same phone number) are never duplicated.</p>
        </div>
      )}

      {step === 'map' && (
        <div>
          <Select label="Add these people to branch" value={branchId} onChange={e => setBranchId(e.target.value)}>
            {activeBranches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
          </Select>
          <p className="mb-3 text-sm text-mist-600">Match your columns to GatherHQ fields. We've guessed where we could.</p>
          <div className="grid gap-x-4 sm:grid-cols-2">
            {TARGETS.map(t => (
              <Select key={t.key} label={t.label} value={mapping[t.key] ?? ''} onChange={e => setMapping(m => ({ ...m, [t.key]: e.target.value === '' ? undefined : Number(e.target.value) }))}>
                <option value="">Don't import</option>
                {sheet.headers.map((h, i) => <option key={i} value={i}>{h}{sheet.rows[0]?.[i] ? ` — e.g. ${String(sheet.rows[0][i]).slice(0, 24)}` : ''}</option>)}
              </Select>
            ))}
          </div>
          <p className="text-xs text-mist-500">Status values other than visitor, member, inactive or transferred are imported as member.</p>
        </div>
      )}

      {step === 'preview' && preview && (
        <div>
          <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[['New people', preview.summary.create, 'text-brand-700'], ['Already exist', preview.summary.duplicate, 'text-sky-800'], ['Repeated in file', preview.summary.skip, 'text-mist-600'], ['With problems', preview.summary.rejected, 'text-red-700']].map(([l, n, c]) => (
              <div key={l} className="rounded-lg border border-mist-200 px-3 py-2.5"><div className={`tabular text-xl font-semibold ${c}`}>{n.toLocaleString()}</div><div className="text-xs text-mist-500">{l}</div></div>
            ))}
          </div>
          {preview.summary.duplicate > 0 && (
            <fieldset className="mb-4 rounded-lg border border-mist-200 px-4 py-3">
              <legend className="px-1 text-sm font-medium text-ink">For the {preview.summary.duplicate} people who already exist</legend>
              <label className="mt-1 flex items-start gap-2 text-sm"><input type="radio" name="policy" checked={policy === 'skip'} onChange={() => setPolicy('skip')} className="mt-1 accent-brand-700" /><span>Leave them unchanged</span></label>
              <label className="mt-2 flex items-start gap-2 text-sm"><input type="radio" name="policy" checked={policy === 'update'} onChange={() => setPolicy('update')} className="mt-1 accent-brand-700" /><span>Fill in missing details only<span className="block text-xs text-mist-500">Existing information is never overwritten.</span></span></label>
            </fieldset>
          )}
          {preview.summary.rejected > 0 && (
            <Notice tone="warning" className="mb-4" action={<Button size="sm" variant="secondary" icon={Download} onClick={downloadErrors}>Problem rows</Button>}>
              {preview.summary.rejected} row{preview.summary.rejected === 1 ? '' : 's'} can't be imported. Download them, fix and import again.
            </Notice>
          )}
          <div className="max-h-64 overflow-auto rounded-lg border border-mist-200">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-mist-50 text-left text-xs text-mist-500"><tr><th className="px-3 py-2 font-medium">Row</th><th className="px-3 py-2 font-medium">Name</th><th className="px-3 py-2 font-medium">Result</th></tr></thead>
              <tbody>
                {[...preview.rows].sort((a, b) => ['reject', 'duplicate', 'skip', 'create'].indexOf(a.action) - ['reject', 'duplicate', 'skip', 'create'].indexOf(b.action)).slice(0, 300).map(r => (
                  <tr key={r.index} className="border-t border-mist-100">
                    <td className="tabular px-3 py-2 text-mist-500">{r.index + 2}</td>
                    <td className="px-3 py-2">{r.name || <span className="text-mist-400">—</span>}</td>
                    <td className="px-3 py-2"><Badge tone={ACTION[r.action][0]}>{ACTION[r.action][1]}</Badge><span className="ml-2 text-xs text-mist-500">{r.errors.join('; ') || r.note}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {step === 'done' && summary && (
        <div className="py-6 text-center">
          <CheckCircle2 size={36} className="mx-auto text-brand-600" />
          <h3 className="mt-3 text-lg font-semibold text-ink">Import complete</h3>
          <p className="mt-1 text-sm text-mist-600">
            {summary.created.toLocaleString()} added · {summary.updated.toLocaleString()} updated · {summary.skipped.toLocaleString()} skipped · {summary.rejected.toLocaleString()} not imported
          </p>
        </div>
      )}
    </Modal>
  )
}
