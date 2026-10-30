import { useEffect, useMemo, useRef, useState } from 'react'
import { Monitor, Smartphone } from 'lucide-react'
import { renderEmail } from '../../shared/email.js'
import { Segmented } from './ui'

// Live preview of an email, rendered by the same code the server uses to send it.
export default function EmailPreview({ org, branding, subject, preheader, blocks, person, fromAddress, compact = false }) {
  const [mode, setMode] = useState('desktop')
  const [height, setHeight] = useState(600)
  const frame = useRef(null)
  const email = useMemo(() => renderEmail({ org, branding, subject, preheader, blocks, person, unsubscribeUrl: '#' }),
    [org, branding, subject, preheader, blocks, person])
  const sender = branding?.fromName || org?.name || 'Your church'

  // Fit the frame to its content.
  useEffect(() => {
    const f = frame.current
    if (!f) return
    const measure = () => { try { setHeight(Math.max(320, f.contentDocument.documentElement.scrollHeight + 4)) } catch { /* ignore */ } }
    f.addEventListener('load', measure)
    const t = setTimeout(measure, 120)
    return () => { f.removeEventListener('load', measure); clearTimeout(t) }
  }, [email.html, mode])

  const phone = mode === 'phone'
  return (
    <div>
      {!compact && (
        <div className="mb-3 flex items-center justify-between gap-3">
          <p className="text-sm font-medium text-ink">Preview</p>
          <Segmented size="sm" value={mode} onChange={setMode} options={[
            { value: 'desktop', label: <><Monitor size={14} /> Desktop</> },
            { value: 'phone', label: <><Smartphone size={14} /> Phone</> },
          ]} />
        </div>
      )}
      <div className={`mx-auto overflow-hidden rounded-2xl border border-mist-200 bg-white shadow-card ${phone ? 'max-w-[390px] rounded-[28px] border-[6px] border-ink/85' : ''}`}>
        {/* How it appears in the inbox list */}
        <div className="border-b border-mist-100 bg-mist-50/70 px-4 py-3">
          <div className="flex items-baseline justify-between gap-2">
            <p className="truncate text-sm font-semibold text-ink">{sender}</p>
            <p className="shrink-0 text-xs text-mist-400">now</p>
          </div>
          <p className="truncate text-sm font-medium text-ink">{email.subject || <span className="text-mist-400">No subject yet</span>}</p>
          <p className="truncate text-xs text-mist-500">{preheader || 'Add preview text to show a line here in the inbox.'}</p>
          {fromAddress && !phone && <p className="mt-1 truncate text-[11px] text-mist-400">From {fromAddress}</p>}
        </div>
        <iframe ref={frame} title="Email preview" srcDoc={email.html} sandbox="allow-same-origin allow-popups"
          style={{ height }} className="block w-full border-0 bg-[#F3F4F0]" />
      </div>
    </div>
  )
}
