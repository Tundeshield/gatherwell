import { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from 'react'
import { X, Loader2, AlertCircle, CheckCircle2, Info, ChevronLeft, ChevronRight } from 'lucide-react'
import { initials } from '../lib/format'

const ring = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2'

// --- Button -------------------------------------------------------------------------
const VARIANTS = {
  primary: 'bg-brand-700 text-white border-brand-700 hover:bg-brand-800 hover:border-brand-800',
  secondary: 'bg-white text-ink border-mist-200 hover:bg-mist-50 hover:border-mist-300',
  ghost: 'bg-transparent text-mist-600 border-transparent hover:bg-mist-100 hover:text-ink',
  danger: 'bg-red-600 text-white border-red-600 hover:bg-red-700',
  'danger-ghost': 'bg-transparent text-red-700 border-transparent hover:bg-red-50',
  subtle: 'bg-brand-50 text-brand-700 border-brand-100 hover:bg-brand-100',
}
const SIZES = { sm: 'h-8 px-3 text-[13px] gap-1.5', md: 'h-10 px-4 text-sm gap-2', lg: 'h-12 px-5 text-[15px] gap-2' }

export function Button({ variant = 'primary', size = 'md', loading = false, icon: Icon, children, className = '', disabled, type = 'button', ...props }) {
  return (
    <button type={type} disabled={disabled || loading}
      className={`inline-flex shrink-0 items-center justify-center rounded-lg border font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-55 ${ring} ${VARIANTS[variant]} ${SIZES[size]} ${className}`}
      {...props}>
      {loading ? <Loader2 size={16} className="animate-spin" /> : Icon ? <Icon size={size === 'sm' ? 15 : 17} strokeWidth={2} /> : null}
      {children}
    </button>
  )
}

export function IconButton({ icon: Icon, label, className = '', size = 34, ...props }) {
  return (
    <button type="button" aria-label={label} title={label}
      className={`inline-flex items-center justify-center rounded-lg text-mist-500 transition-colors hover:bg-mist-100 hover:text-ink ${ring} ${className}`}
      style={{ width: size, height: size }} {...props}>
      <Icon size={17} />
    </button>
  )
}

// --- Form fields ------------------------------------------------------------------------
export function Field({ label, hint, error, required, children, className = '' }) {
  const id = useId()
  const child = typeof children === 'function' ? children(id) : children
  return (
    <div className={`mb-4 ${className}`}>
      {label && <label htmlFor={id} className="label">{label}{required && <span className="ml-0.5 text-red-600" aria-hidden>*</span>}</label>}
      {child}
      {error ? <p className="mt-1 text-xs text-red-700" role="alert">{error}</p> : hint ? <p className="hint">{hint}</p> : null}
    </div>
  )
}

export function Input({ label, hint, error, required, className = '', ...props }) {
  return (
    <Field label={label} hint={hint} error={error} required={required} className={className}>
      {(id) => <input id={id} required={required} aria-invalid={!!error} className={`field ${error ? 'field-error' : ''}`} {...props} />}
    </Field>
  )
}

export function Textarea({ label, hint, error, required, className = '', rows = 3, ...props }) {
  return (
    <Field label={label} hint={hint} error={error} required={required} className={className}>
      {(id) => <textarea id={id} rows={rows} required={required} aria-invalid={!!error} className={`field resize-y ${error ? 'field-error' : ''}`} {...props} />}
    </Field>
  )
}

export function Select({ label, hint, error, required, className = '', children, ...props }) {
  return (
    <Field label={label} hint={hint} error={error} required={required} className={className}>
      {(id) => <select id={id} required={required} aria-invalid={!!error} className={`field cursor-pointer pr-8 ${error ? 'field-error' : ''}`} {...props}>{children}</select>}
    </Field>
  )
}

export function Checkbox({ label, hint, checked, onChange, className = '' }) {
  return (
    <label className={`flex cursor-pointer items-start gap-2.5 ${className}`}>
      <input type="checkbox" checked={!!checked} onChange={e => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 rounded border-mist-300 text-brand-700 accent-brand-700 focus:ring-brand-500" />
      <span>
        <span className="text-sm text-ink">{label}</span>
        {hint && <span className="block text-xs text-mist-400">{hint}</span>}
      </span>
    </label>
  )
}

export function Toggle({ checked, onChange, label, hint }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2">
      <div>
        <div className="text-sm font-medium text-ink">{label}</div>
        {hint && <div className="mt-0.5 text-xs text-mist-400">{hint}</div>}
      </div>
      <button type="button" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)}
        className={`relative mt-0.5 h-6 w-10 shrink-0 rounded-full transition-colors ${checked ? 'bg-brand-700' : 'bg-mist-300'} ${ring}`}>
        <span className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-4' : ''}`} />
      </button>
    </div>
  )
}

export function SearchInput({ value, onChange, placeholder = 'Search', className = '', autoFocus }) {
  return (
    <div className={`relative ${className}`}>
      <svg className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-mist-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
      <input type="search" value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} autoFocus={autoFocus}
        aria-label={placeholder} className="field h-10 pl-9" />
    </div>
  )
}

// Segmented control for filters / tabs.
export function Segmented({ options, value, onChange, size = 'md' }) {
  return (
    <div className="inline-flex max-w-full overflow-x-auto rounded-lg border border-mist-200 bg-white p-0.5 scrollbar-none" role="tablist">
      {options.map(o => (
        <button key={o.value} type="button" role="tab" aria-selected={value === o.value} onClick={() => onChange(o.value)}
          className={`flex items-center gap-1.5 whitespace-nowrap rounded-md px-3 ${size === 'sm' ? 'py-1 text-[13px]' : 'py-1.5 text-sm'} font-medium transition-colors ${ring}
            ${value === o.value ? 'bg-brand-50 text-brand-700' : 'text-mist-500 hover:text-ink'}`}>
          {o.label}
          {o.count !== undefined && <span className={`tabular rounded px-1.5 text-xs ${value === o.value ? 'bg-brand-100' : 'bg-mist-100'} ${o.alert && o.count > 0 ? 'text-red-700' : ''}`}>{o.count}</span>}
        </button>
      ))}
    </div>
  )
}

// --- Display -----------------------------------------------------------------------------
const BADGE = {
  neutral: 'bg-mist-100 text-mist-600',
  brand: 'bg-brand-50 text-brand-700',
  success: 'bg-green-50 text-green-800',
  warning: 'bg-amber-50 text-amber-800',
  danger: 'bg-red-50 text-red-700',
  info: 'bg-sky-50 text-sky-800',
  gold: 'bg-gold-100 text-gold-700',
}
export function Badge({ tone = 'neutral', children, dot = false, className = '' }) {
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5 text-xs font-medium ${BADGE[tone]} ${className}`}>
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" />}{children}
    </span>
  )
}

export const PERSON_TONE = { visitor: 'gold', member: 'brand', inactive: 'neutral', transferred: 'info', archived: 'neutral' }
export const SESSION_TONE = { open: 'success', scheduled: 'info', closed: 'neutral', draft: 'neutral', archived: 'neutral' }

export function Avatar({ person, size = 32 }) {
  const hue = [...(person?.id || person?.first_name || 'x')].reduce((a, c) => a + c.charCodeAt(0), 0) % 3
  const tones = ['bg-brand-50 text-brand-700', 'bg-gold-100 text-gold-700', 'bg-sky-50 text-sky-800']
  return (
    <span className={`inline-flex shrink-0 items-center justify-center rounded-full font-semibold ${tones[hue]}`} style={{ width: size, height: size, fontSize: size * 0.38 }} aria-hidden>
      {initials(person)}
    </span>
  )
}

export function Spinner({ className = '' }) {
  return <Loader2 className={`animate-spin text-brand-600 ${className}`} size={20} aria-label="Loading" />
}

export function PageLoader() {
  return <div className="flex h-64 items-center justify-center"><Spinner /></div>
}

export function Skeleton({ className = '' }) {
  return <div className={`animate-pulse rounded-md bg-mist-100 ${className}`} />
}

export function EmptyState({ icon: Icon, title, children, action, className = '' }) {
  return (
    <div className={`flex flex-col items-center px-6 py-14 text-center ${className}`}>
      {Icon && <span className="mb-4 flex h-11 w-11 items-center justify-center rounded-full bg-brand-50 text-brand-700"><Icon size={20} /></span>}
      <h3 className="text-[15px] font-semibold text-ink">{title}</h3>
      {children && <div className="mt-1.5 max-w-sm text-sm text-mist-500">{children}</div>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  )
}

export function ErrorState({ error, onRetry }) {
  return (
    <div className="flex flex-col items-center px-6 py-14 text-center">
      <span className="mb-4 flex h-11 w-11 items-center justify-center rounded-full bg-red-50 text-red-700"><AlertCircle size={20} /></span>
      <h3 className="text-[15px] font-semibold text-ink">This page didn't load</h3>
      <p className="mt-1.5 max-w-sm text-sm text-mist-500">{error?.message || 'Something went wrong.'}</p>
      {onRetry && <Button variant="secondary" className="mt-5" onClick={onRetry}>Try again</Button>}
    </div>
  )
}

export function Notice({ tone = 'info', title, children, action, className = '' }) {
  const tones = {
    info: ['bg-sky-50 border-sky-200 text-sky-900', Info],
    success: ['bg-green-50 border-green-200 text-green-900', CheckCircle2],
    warning: ['bg-amber-50 border-amber-200 text-amber-900', AlertCircle],
    danger: ['bg-red-50 border-red-200 text-red-900', AlertCircle],
  }
  const [cls, Icon] = tones[tone]
  return (
    <div className={`flex items-start gap-3 rounded-lg border px-4 py-3 ${cls} ${className}`} role={tone === 'danger' ? 'alert' : undefined}>
      <Icon size={18} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1 text-sm">
        {title && <div className="font-semibold">{title}</div>}
        {children && <div className={title ? 'mt-0.5 opacity-90' : ''}>{children}</div>}
      </div>
      {action}
    </div>
  )
}

export function PageHeader({ title, description, actions, back }) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        {back}
        <h1 className="text-[26px] font-semibold leading-tight text-ink">{title}</h1>
        {description && <p className="mt-1 text-sm text-mist-500">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

export function Pagination({ total, limit, offset, onChange }) {
  if (total <= limit) return null
  const page = Math.floor(offset / limit) + 1
  const pages = Math.ceil(total / limit)
  return (
    <div className="flex items-center justify-between border-t border-mist-200 px-4 py-3 text-sm text-mist-500">
      <span className="tabular">{offset + 1}–{Math.min(offset + limit, total)} of {total.toLocaleString()}</span>
      <div className="flex items-center gap-1">
        <IconButton icon={ChevronLeft} label="Previous page" disabled={page <= 1} onClick={() => onChange(Math.max(0, offset - limit))} className="disabled:opacity-40" />
        <span className="tabular px-2">Page {page} of {pages}</span>
        <IconButton icon={ChevronRight} label="Next page" disabled={page >= pages} onClick={() => onChange(offset + limit)} className="disabled:opacity-40" />
      </div>
    </div>
  )
}

// --- Overlays ------------------------------------------------------------------------------
function useEscape(open, onClose) {
  useEffect(() => {
    if (!open) return
    const h = (e) => e.key === 'Escape' && onClose?.()
    document.addEventListener('keydown', h)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.removeEventListener('keydown', h); document.body.style.overflow = prev }
  }, [open, onClose])
}

export function Modal({ open, onClose, title, description, children, footer, size = 'md' }) {
  useEscape(open, onClose)
  const ref = useRef(null)
  useEffect(() => { if (open) setTimeout(() => ref.current?.querySelector('input,select,textarea,button:not([aria-label="Close"])')?.focus(), 30) }, [open])
  if (!open) return null
  const width = { sm: 'max-w-md', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' }[size]
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/40 p-0 sm:items-center sm:p-4" onMouseDown={e => e.target === e.currentTarget && onClose?.()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={title}
        className={`animate-in flex max-h-[92vh] w-full ${width} flex-col rounded-t-2xl bg-white shadow-pop sm:rounded-2xl`}>
        <div className="flex items-start justify-between gap-4 px-6 pb-2 pt-5">
          <div>
            <h2 className="text-lg font-semibold text-ink">{title}</h2>
            {description && <p className="mt-0.5 text-sm text-mist-500">{description}</p>}
          </div>
          <IconButton icon={X} label="Close" onClick={onClose} className="-mr-2" />
        </div>
        <div className="overflow-y-auto px-6 py-3">{children}</div>
        {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-mist-100 px-6 py-4">{footer}</div>}
      </div>
    </div>
  )
}

export function Drawer({ open, onClose, title, children, footer, width = 'max-w-xl' }) {
  useEscape(open, onClose)
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-ink/30" onMouseDown={e => e.target === e.currentTarget && onClose?.()}>
      <div role="dialog" aria-modal="true" aria-label={title} className={`flex h-full w-full ${width} flex-col bg-white shadow-pop`} style={{ animation: 'gw-in .18s ease-out' }}>
        <div className="flex items-center justify-between border-b border-mist-100 px-6 py-4">
          <h2 className="truncate text-lg font-semibold text-ink">{title}</h2>
          <IconButton icon={X} label="Close" onClick={onClose} />
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-5">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-mist-100 px-6 py-4">{footer}</div>}
      </div>
    </div>
  )
}

// --- Confirm dialog --------------------------------------------------------------------------
const ConfirmContext = createContext(null)
export function ConfirmProvider({ children }) {
  const [state, setState] = useState(null)
  const confirm = useCallback((opts) => new Promise((resolve) => setState({ ...opts, resolve })), [])
  const close = (v) => { state?.resolve(v); setState(null) }
  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Modal open={!!state} onClose={() => close(false)} title={state?.title} size="sm"
        footer={<><Button variant="secondary" onClick={() => close(false)}>Cancel</Button>
          <Button variant={state?.danger ? 'danger' : 'primary'} onClick={() => close(true)}>{state?.confirmLabel || 'Confirm'}</Button></>}>
        <p className="pb-2 text-sm text-mist-600">{state?.message}</p>
      </Modal>
    </ConfirmContext.Provider>
  )
}
export const useConfirm = () => useContext(ConfirmContext)

// --- Toasts ---------------------------------------------------------------------------------
const ToastContext = createContext(null)
export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])
  const toast = useCallback((message, tone = 'success') => {
    const id = Math.random().toString(36).slice(2)
    setToasts(t => [...t, { id, message, tone }])
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), tone === 'error' ? 6000 : 3500)
  }, [])
  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex flex-col items-center gap-2 px-4 sm:bottom-auto sm:left-auto sm:right-4 sm:top-4 sm:items-end" aria-live="polite">
        {toasts.map(t => (
          <div key={t.id} className="animate-in pointer-events-auto flex max-w-sm items-start gap-2.5 rounded-lg bg-ink px-4 py-3 text-sm text-white shadow-pop">
            {t.tone === 'error' ? <AlertCircle size={17} className="mt-px shrink-0 text-red-300" /> : <CheckCircle2 size={17} className="mt-px shrink-0 text-brand-200" />}
            <span>{t.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}
export const useToast = () => useContext(ToastContext)

// --- Data loading hook ------------------------------------------------------------------------
export function useLoad(fn, deps = []) {
  const [state, setState] = useState({ data: null, error: null, loading: true })
  const seq = useRef(0)
  const run = useCallback(async () => {
    const n = ++seq.current
    setState(s => ({ ...s, loading: true, error: null }))
    try {
      const data = await fn()
      if (n === seq.current) setState({ data, error: null, loading: false })
    } catch (error) {
      if (n === seq.current) setState(s => ({ ...s, error, loading: false }))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  useEffect(() => { run() }, [run])
  return { ...state, reload: run, setData: (d) => setState(s => ({ ...s, data: typeof d === 'function' ? d(s.data) : d })) }
}

export function useDebounced(value, ms = 300) {
  const [v, setV] = useState(value)
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t) }, [value, ms])
  return v
}

// Table primitives keep spacing consistent.
export function Table({ children }) {
  return <div className="overflow-x-auto"><table className="w-full min-w-[640px] text-left text-sm">{children}</table></div>
}
export function Th({ children, className = '' }) {
  return <th scope="col" className={`whitespace-nowrap border-b border-mist-200 bg-mist-50/60 px-4 py-2.5 text-xs font-medium text-mist-500 ${className}`}>{children}</th>
}
export function Td({ children, className = '' }) {
  return <td className={`border-b border-mist-100 px-4 py-3 align-middle ${className}`}>{children}</td>
}
