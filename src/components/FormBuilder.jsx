import { useState } from 'react'
import { ArrowUp, ArrowDown, Trash2, Plus, Lock } from 'lucide-react'
import { IconButton, Button } from './ui'

export const DEFAULT_FORM = [
  { id: 'first_name', type: 'text', label: 'First name', required: true, core: true },
  { id: 'last_name', type: 'text', label: 'Last name', required: true, core: true },
  { id: 'phone', type: 'phone', label: 'Phone number', required: true, core: true },
  { id: 'email', type: 'email', label: 'Email', required: false, core: true },
]
const LOCKED = ['first_name', 'phone']
const TYPES = { text: 'Short answer', textarea: 'Long answer', select: 'Dropdown', checkbox: 'Checkbox', date: 'Date', email: 'Email', phone: 'Phone' }
const PRESETS = [
  { label: 'How did you hear about us?', type: 'select', options: ['Friend or family', 'Social media', 'Walked past', 'Online search', 'Other'] },
  { label: 'Would you like a call from a pastor?', type: 'checkbox' },
  { label: 'Prayer request', type: 'textarea' },
  { label: 'Area you live in', type: 'text' },
]

export default function FormBuilder({ value, onChange }) {
  const [adding, setAdding] = useState(false)
  const fields = value || DEFAULT_FORM
  const update = (i, patch) => onChange(fields.map((f, j) => j === i ? { ...f, ...patch } : f))
  const move = (i, d) => { const n = [...fields]; const [x] = n.splice(i, 1); n.splice(i + d, 0, x); onChange(n) }
  const remove = (i) => onChange(fields.filter((_, j) => j !== i))
  const add = (f) => { onChange([...fields, { id: `q_${Date.now().toString(36)}`, required: false, ...f }]); setAdding(false) }

  return (
    <div>
      <ul className="divide-y divide-mist-100 rounded-lg border border-mist-200">
        {fields.map((f, i) => (
          <li key={f.id} className="px-3 py-2.5">
            <div className="flex items-center gap-2">
              {LOCKED.includes(f.id) ? <Lock size={14} className="shrink-0 text-mist-300" aria-label="Always asked" /> : <span className="w-[14px]" />}
              {f.core ? <span className="flex-1 text-sm text-ink">{f.label}</span> : (
                <input value={f.label} onChange={e => update(i, { label: e.target.value })} aria-label="Question" className="field h-8 flex-1 py-1" />
              )}
              <span className="hidden text-xs text-mist-400 sm:block">{TYPES[f.type]}</span>
              <label className={`flex items-center gap-1 text-xs ${LOCKED.includes(f.id) ? 'text-mist-300' : 'text-mist-500'}`}>
                <input type="checkbox" disabled={LOCKED.includes(f.id)} checked={!!f.required} onChange={e => update(i, { required: e.target.checked })} className="h-3.5 w-3.5 accent-brand-700" />Required
              </label>
              <IconButton icon={ArrowUp} label="Move up" size={28} disabled={i === 0} onClick={() => move(i, -1)} className="disabled:opacity-30" />
              <IconButton icon={ArrowDown} label="Move down" size={28} disabled={i === fields.length - 1} onClick={() => move(i, 1)} className="disabled:opacity-30" />
              <IconButton icon={Trash2} label="Remove question" size={28} disabled={LOCKED.includes(f.id)} onClick={() => remove(i)} className="disabled:opacity-30" />
            </div>
            {f.type === 'select' && !f.core && (
              <input value={(f.options || []).join(', ')} onChange={e => update(i, { options: e.target.value.split(',').map(s => s.trimStart()) })}
                onBlur={e => update(i, { options: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })}
                placeholder="Options, separated by commas" aria-label="Dropdown options" className="field ml-6 mt-2 h-8 w-[calc(100%-1.5rem)] py-1 text-[13px]" />
            )}
          </li>
        ))}
      </ul>
      {adding ? (
        <div className="mt-2 rounded-lg border border-mist-200 p-3">
          <div className="mb-2 text-xs font-medium text-mist-500">Common questions</div>
          <div className="mb-3 flex flex-wrap gap-2">
            {PRESETS.map(p => <button key={p.label} type="button" onClick={() => add({ ...p })} className="rounded-full border border-mist-200 px-3 py-1 text-[13px] text-ink hover:border-brand-300 hover:bg-brand-50">{p.label}</button>)}
          </div>
          <div className="mb-2 text-xs font-medium text-mist-500">Or add your own</div>
          <div className="flex flex-wrap gap-2">
            {Object.entries(TYPES).filter(([k]) => !['email', 'phone'].includes(k)).map(([k, v]) => <Button key={k} size="sm" variant="secondary" onClick={() => add({ type: k, label: v === 'Dropdown' ? 'Choose one' : 'New question', options: k === 'select' ? ['Option 1', 'Option 2'] : undefined })}>{v}</Button>)}
            <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
          </div>
        </div>
      ) : (
        <Button size="sm" variant="ghost" icon={Plus} className="mt-2" onClick={() => setAdding(true)}>Add a question</Button>
      )}
    </div>
  )
}
