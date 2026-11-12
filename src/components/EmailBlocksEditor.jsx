import { useRef, useState } from 'react'
import { ArrowUp, ArrowDown, Trash2, Heading, Type, MousePointerClick, Image as ImageIcon, Minus, Upload } from 'lucide-react'
import { api } from '../lib/api'
import { Button, Input, useToast } from './ui'
import { MERGE_FIELDS } from '../../shared/email.js'
import { prepareImage } from '../lib/image'

// The email block editor used for messages and the welcome-journey emails.
// Blocks carry a local _k key for React; use stripKeys() before saving.
export const BLOCKS = {
  heading: ['Heading', Heading, () => ({ type: 'heading', text: '' })],
  text: ['Text', Type, () => ({ type: 'text', text: '' })],
  button: ['Button', MousePointerClick, () => ({ type: 'button', label: 'Learn more', url: '' })],
  image: ['Image', ImageIcon, () => ({ type: 'image', url: '', alt: '', link: '' })],
  divider: ['Divider', Minus, () => ({ type: 'divider' })],
}
let keySeq = 0
export const withKeys = (blocks) => blocks.map(b => ({ ...b, _k: ++keySeq }))
export const stripKeys = (blocks) => blocks.map(({ _k, ...b }) => b)

function BlockCard({ block, index, count, onChange, onMove, onRemove, onFocusField }) {
  const [label, Icon] = BLOCKS[block.type]
  const toast = useToast()
  const [uploading, setUploading] = useState(false)
  const fileRef = useRef(null)
  const set = (k) => (e) => onChange({ ...block, [k]: e.target.value })
  const focus = (field) => (e) => onFocusField({ index, field, el: e.target })

  async function upload(file) {
    if (!file) return
    setUploading(true)
    try {
      const dataUrl = await prepareImage(file, { maxWidth: 1200 })
      const { url } = await api.post('/email/assets', { dataUrl })
      onChange({ ...block, url, alt: block.alt || file.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ') })
    } catch (e) { toast(e.message, 'error') } finally { setUploading(false); if (fileRef.current) fileRef.current.value = '' }
  }

  return (
    <div className="panel px-4 py-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-md bg-mist-100 text-mist-600"><Icon size={15} /></span>
        <span className="flex-1 text-sm font-medium text-ink">{label}</span>
        <Button size="sm" variant="ghost" icon={ArrowUp} aria-label="Move up" disabled={index === 0} onClick={() => onMove(-1)} />
        <Button size="sm" variant="ghost" icon={ArrowDown} aria-label="Move down" disabled={index === count - 1} onClick={() => onMove(1)} />
        <Button size="sm" variant="ghost" icon={Trash2} aria-label="Remove" onClick={onRemove} />
      </div>
      {block.type === 'heading' && <Input className="mb-0" aria-label="Heading" value={block.text} onChange={set('text')} onFocus={focus('text')} placeholder="e.g. You’re invited, {first_name}" />}
      {block.type === 'text' && (
        <textarea aria-label="Text" value={block.text} onChange={set('text')} onFocus={focus('text')} rows={Math.min(14, Math.max(4, block.text.split('\n').length + 1))}
          className="field" placeholder="Write your message. Leave an empty line between paragraphs. Links like https://… become clickable." />
      )}
      {block.type === 'button' && (
        <div className="grid grid-cols-1 gap-x-3 sm:grid-cols-2">
          <Input className="mb-0" label="Button text" value={block.label} onChange={set('label')} onFocus={focus('label')} />
          <Input className="mb-0" label="Link" value={block.url} onChange={set('url')} placeholder="https://" error={block.url && !/^https?:\/\//.test(block.url) ? 'Start with https://' : undefined} />
        </div>
      )}
      {block.type === 'image' && (
        <div className="space-y-3">
          {block.url && <img src={block.url} alt={block.alt} className="max-h-48 rounded-lg border border-mist-200 object-contain" />}
          <div className="flex flex-wrap items-center gap-2">
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" className="hidden" onChange={e => upload(e.target.files[0])} />
            <Button size="sm" variant="secondary" icon={Upload} loading={uploading} onClick={() => fileRef.current?.click()}>{block.url ? 'Replace image' : 'Upload image'}</Button>
            <span className="text-xs text-mist-400">or paste an image link below</span>
          </div>
          <div className="grid grid-cols-1 gap-x-3 sm:grid-cols-2">
            <Input className="mb-0" label="Image link" value={block.url} onChange={set('url')} placeholder="https://" />
            <Input className="mb-0" label="Describe the image" hint="Shown if the image doesn’t load." value={block.alt} onChange={set('alt')} />
          </div>
          <Input className="mb-0" label="Open this link when tapped (optional)" value={block.link} onChange={set('link')} placeholder="https://" />
        </div>
      )}
      {block.type === 'divider' && <hr className="my-2 border-mist-200" />}
    </div>
  )
}


export default function EmailBlocksEditor({ blocks, setBlocks }) {
  const toast = useToast()
  const lastField = useRef(null)
  const update = (i, b) => setBlocks(bs => bs.map((x, j) => (j === i ? { ...b, _k: x._k } : x)))
  const move = (i, d) => setBlocks(bs => { const a = [...bs]; const [x] = a.splice(i, 1); a.splice(i + d, 0, x); return a })
  const remove = (i) => setBlocks(bs => bs.filter((_, j) => j !== i))
  const add = (type) => setBlocks(bs => [...bs, ...withKeys([BLOCKS[type][2]()])])
  function insertField(tag) {
    const f = lastField.current
    if (!f || !blocks[f.index]) { toast('Click into a heading or text box first'); return }
    const el = f.el
    const cur = String(blocks[f.index][f.field] || '')
    const pos = el && typeof el.selectionStart === 'number' ? el.selectionStart : cur.length
    update(f.index, { ...blocks[f.index], [f.field]: cur.slice(0, pos) + tag + cur.slice(pos) })
    setTimeout(() => { try { el.focus(); el.setSelectionRange(pos + tag.length, pos + tag.length) } catch { /* ignore */ } }, 0)
  }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-mist-500">Personalise:</span>
        {MERGE_FIELDS.map(([tag, label]) => (
          <button key={tag} type="button" onMouseDown={e => e.preventDefault()} onClick={() => insertField(tag)}
            className="rounded-full border border-mist-200 bg-white px-2.5 py-1 text-xs font-medium text-mist-600 hover:border-brand-300 hover:text-brand-700">+ {label}</button>
        ))}
      </div>
      {blocks.map((b, i) => (
        <BlockCard key={b._k} block={b} index={i} count={blocks.length} onChange={(nb) => update(i, nb)} onMove={(d) => move(i, d)} onRemove={() => remove(i)}
          onFocusField={(f) => { lastField.current = f }} />
      ))}
      <div className="rounded-xl border border-dashed border-mist-300 bg-white/60 p-3">
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-mist-500">Add to email</p>
        <div className="flex flex-wrap gap-2">
          {Object.entries(BLOCKS).map(([k, [label, Icon]]) => <Button key={k} size="sm" variant="secondary" icon={Icon} onClick={() => add(k)}>{label}</Button>)}
        </div>
      </div>
    </div>
  )
}
