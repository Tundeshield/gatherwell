import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Plus, Tag as TagIcon, X } from 'lucide-react'
import { api } from '../lib/api'
import { useToast } from './ui'

export const TAG_STYLES = {
  forest: 'bg-brand-50 text-brand-800 ring-brand-200',
  sage: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
  amber: 'bg-amber-50 text-amber-800 ring-amber-200',
  navy: 'bg-slate-100 text-slate-800 ring-slate-300',
  plum: 'bg-purple-50 text-purple-800 ring-purple-200',
  rose: 'bg-rose-50 text-rose-800 ring-rose-200',
  sky: 'bg-sky-50 text-sky-800 ring-sky-200',
  slate: 'bg-mist-100 text-mist-700 ring-mist-300',
}
export const TAG_COLORS = Object.keys(TAG_STYLES)

// Shared tag list for the church, loaded once per page and refreshable after changes.
let cache = null
const listeners = new Set()
export async function loadTags(force = false) {
  if (!cache || force) cache = api.get('/tags').catch(() => [])
  const tags = await cache
  listeners.forEach(fn => fn(tags))
  return tags
}
export function useTags() {
  const [tags, setTags] = useState([])
  useEffect(() => { listeners.add(setTags); loadTags().then(setTags); return () => listeners.delete(setTags) }, [])
  return { tags, byId: useMemo(() => new Map(tags.map(t => [t.id, t])), [tags]), reload: () => loadTags(true) }
}

export function TagChip({ tag, onRemove, size = 'md' }) {
  if (!tag) return null
  return (
    <span className={`inline-flex max-w-full items-center gap-1 rounded-full ring-1 ring-inset ${TAG_STYLES[tag.color] || TAG_STYLES.slate} ${size === 'sm' ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-0.5 text-xs'} font-medium`}>
      <span className="truncate">{tag.name}</span>
      {onRemove && <button type="button" onClick={(e) => { e.stopPropagation(); onRemove() }} aria-label={`Remove ${tag.name}`} className="-mr-0.5 rounded-full opacity-60 hover:opacity-100"><X size={12} /></button>}
    </span>
  )
}

export function TagList({ ids = [], byId, max = 3, size = 'sm' }) {
  const tags = ids.map(id => byId.get(id)).filter(Boolean)
  if (!tags.length) return null
  return (
    <span className="flex flex-wrap gap-1">
      {tags.slice(0, max).map(t => <TagChip key={t.id} tag={t} size={size} />)}
      {tags.length > max && <span className="text-[11px] text-mist-500">+{tags.length - max}</span>}
    </span>
  )
}

/**
 * Dropdown to choose tags, with "create" for a new name.
 * `selected` is an array of tag ids; `onToggle(tag, on)` is called for each change.
 */
export function TagPicker({ selected = [], onToggle, label = 'Add tag', allowCreate = true, align = 'left' }) {
  const { tags, reload } = useTags()
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const box = useRef(null)
  useEffect(() => {
    if (!open) return
    const close = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])
  const term = q.trim()
  const shown = tags.filter(t => t.name.toLowerCase().includes(term.toLowerCase()))
  const exact = tags.some(t => t.name.toLowerCase() === term.toLowerCase())

  async function create() {
    if (!term) return
    setBusy(true)
    try {
      const t = await api.post('/tags', { name: term })
      await reload()
      onToggle(t, true); setQ('')
    } catch (e) { toast(e.message, 'error') } finally { setBusy(false) }
  }

  return (
    <div className="relative inline-block" ref={box}>
      <button type="button" onClick={() => setOpen(o => !o)}
        className="inline-flex items-center gap-1 rounded-full border border-dashed border-mist-300 px-2.5 py-0.5 text-xs font-medium text-mist-600 hover:border-brand-400 hover:text-brand-700">
        <Plus size={12} />{label}
      </button>
      {open && (
        <div className={`absolute z-30 mt-1.5 w-64 rounded-xl border border-mist-200 bg-white p-2 shadow-pop ${align === 'right' ? 'right-0' : 'left-0'}`}>
          <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder={allowCreate ? 'Find or create a tag' : 'Find a tag'} maxLength={40}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); if (allowCreate && term && !exact) create(); else if (shown[0]) onToggle(shown[0], !selected.includes(shown[0].id)) } if (e.key === 'Escape') setOpen(false) }}
            className="field mb-2 h-9 text-sm" />
          <div className="max-h-56 overflow-y-auto">
            {shown.map(t => {
              const on = selected.includes(t.id)
              return (
                <button key={t.id} type="button" onClick={() => onToggle(t, !on)}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-mist-50">
                  <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${on ? 'border-brand-700 bg-brand-700 text-white' : 'border-mist-300'}`}>{on && <Check size={11} />}</span>
                  <TagChip tag={t} size="sm" />
                  {typeof t.count === 'number' && <span className="ml-auto text-xs text-mist-400">{t.count}</span>}
                </button>
              )
            })}
            {!shown.length && !term && <p className="px-2 py-3 text-center text-xs text-mist-500">No tags yet. Type a name to create one, like “Choir” or “Youth”.</p>}
          </div>
          {allowCreate && term && !exact && (
            <button type="button" onClick={create} disabled={busy}
              className="mt-1 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm font-medium text-brand-700 hover:bg-brand-50">
              <TagIcon size={14} />Create “{term}”
            </button>
          )}
        </div>
      )}
    </div>
  )
}
