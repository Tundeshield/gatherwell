// Renders a configured attendance / registration form.
export default function DynamicForm({ fields = [], values, onChange, errors = {}, large = false }) {
  const set = (id, v) => onChange({ ...values, [id]: v })
  const size = large ? 'h-12 text-[16px]' : ''
  return (
    <div>
      {fields.map(f => {
        const err = errors[f.id]
        const common = { id: `f-${f.id}`, 'aria-invalid': !!err, required: f.required }
        let control
        if (f.type === 'textarea') control = <textarea {...common} rows={3} className={`field ${err ? 'field-error' : ''}`} value={values[f.id] || ''} onChange={e => set(f.id, e.target.value)} />
        else if (f.type === 'select') control = (
          <select {...common} className={`field ${size} ${err ? 'field-error' : ''}`} value={values[f.id] || ''} onChange={e => set(f.id, e.target.value)}>
            <option value="">Choose…</option>
            {(f.options || []).map(o => <option key={o}>{o}</option>)}
          </select>
        )
        else if (f.type === 'checkbox') {
          return (
            <label key={f.id} className="mb-4 flex cursor-pointer items-start gap-3 rounded-lg border border-mist-200 px-3 py-3">
              <input type="checkbox" checked={!!values[f.id]} onChange={e => set(f.id, e.target.checked)} className="mt-0.5 h-5 w-5 accent-brand-700" />
              <span className="text-[15px] text-ink">{f.label}{f.required && <span className="text-red-600"> *</span>}
                {f.help && <span className="block text-xs text-mist-400">{f.help}</span>}
                {err && <span className="block text-xs text-red-700">{err}</span>}
              </span>
            </label>
          )
        }
        else {
          const type = f.type === 'phone' ? 'tel' : f.type === 'email' ? 'email' : f.type === 'date' ? 'date' : 'text'
          const auto = { first_name: 'given-name', last_name: 'family-name', phone: 'tel', email: 'email' }[f.id]
          control = <input {...common} type={type} inputMode={f.type === 'phone' ? 'tel' : undefined} autoComplete={auto} className={`field ${size} ${err ? 'field-error' : ''}`} value={values[f.id] || ''} onChange={e => set(f.id, e.target.value)} />
        }
        return (
          <div key={f.id} className="mb-4">
            <label htmlFor={`f-${f.id}`} className={`label ${large ? 'text-[15px]' : ''}`}>{f.label}{f.required ? <span className="ml-0.5 text-red-600">*</span> : <span className="ml-1 font-normal text-mist-400">(optional)</span>}</label>
            {control}
            {err ? <p className="mt-1 text-xs text-red-700" role="alert">{err}</p> : f.help ? <p className="hint">{f.help}</p> : null}
          </div>
        )
      })}
    </div>
  )
}
