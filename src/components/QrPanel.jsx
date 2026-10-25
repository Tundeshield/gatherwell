import { useRef, useState } from 'react'
import { QRCodeCanvas, QRCodeSVG } from 'qrcode.react'
import { Copy, Download, Maximize2, X, ExternalLink } from 'lucide-react'
import { Button, useToast } from './ui'
import { COLORS } from '../brand'

// Draws a printable A5-ratio poster onto a canvas and downloads it.
function downloadPoster({ qrCanvas, title, subtitle, orgName, cta }) {
  const W = 1240, H = 1754
  const c = document.createElement('canvas')
  c.width = W; c.height = H
  const ctx = c.getContext('2d')
  ctx.fillStyle = COLORS.ivory; ctx.fillRect(0, 0, W, H)
  ctx.fillStyle = COLORS.white
  roundRect(ctx, 90, 90, W - 180, H - 180, 48); ctx.fill()
  ctx.textAlign = 'center'
  ctx.fillStyle = COLORS.muted; ctx.font = '500 40px Inter, system-ui, sans-serif'
  ctx.fillText(orgName, W / 2, 250)
  ctx.fillStyle = COLORS.navy; ctx.font = '600 76px Inter, system-ui, sans-serif'
  wrap(ctx, title, W / 2, 360, W - 320, 88)
  const size = 760
  ctx.drawImage(qrCanvas, (W - size) / 2, 520, size, size)
  ctx.fillStyle = COLORS.forest; ctx.font = '600 56px Inter, system-ui, sans-serif'
  ctx.fillText(cta, W / 2, 1400)
  ctx.fillStyle = COLORS.muted; ctx.font = '400 36px Inter, system-ui, sans-serif'
  if (subtitle) ctx.fillText(subtitle, W / 2, 1465)
  ctx.font = '500 30px Inter, system-ui, sans-serif'
  ctx.fillText('Gatherwell', W / 2, H - 140)
  const a = document.createElement('a')
  a.download = `${title.replace(/[^\w]+/g, '-')}-QR.png`
  a.href = c.toDataURL('image/png')
  a.click()
}
function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath() }
function wrap(ctx, text, x, y, max, lh) {
  const words = String(text).split(' '); let line = ''; let yy = y
  for (const w of words) { const t = line ? line + ' ' + w : w; if (ctx.measureText(t).width > max && line) { ctx.fillText(line, x, yy); line = w; yy += lh } else line = t }
  ctx.fillText(line, x, yy)
}

export default function QrPanel({ url, title, subtitle, orgName, cta = 'Scan to check in', disabledReason }) {
  const toast = useToast()
  const canvasRef = useRef(null)
  const [full, setFull] = useState(false)

  async function copy() {
    try { await navigator.clipboard.writeText(url); toast('Link copied') } catch { toast("Couldn't copy — select the link and copy it manually", 'error') }
  }

  return (
    <div className="panel px-5 py-5">
      <div className="flex items-center justify-between">
        <h2 className="text-[15px] font-semibold text-ink">QR check-in</h2>
        <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-brand-700 hover:underline">Open <ExternalLink size={13} /></a>
      </div>
      <div className={`mx-auto mt-4 w-fit rounded-xl border border-mist-200 p-3 ${disabledReason ? 'opacity-40' : ''}`}>
        <QRCodeSVG value={url} size={176} fgColor={COLORS.navy} level="M" marginSize={0} />
      </div>
      {disabledReason && <p className="mt-3 text-center text-sm text-amber-800">{disabledReason}</p>}
      <div className="mt-3 flex items-center gap-2 rounded-lg bg-mist-50 px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-xs text-mist-600" title={url}>{url.replace(/^https?:\/\//, '')}</span>
        <button type="button" onClick={copy} className="text-mist-500 hover:text-ink" aria-label="Copy link"><Copy size={15} /></button>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <Button variant="secondary" size="sm" icon={Download} onClick={() => downloadPoster({ qrCanvas: canvasRef.current, title, subtitle, orgName, cta })}>Poster</Button>
        <Button variant="secondary" size="sm" icon={Maximize2} onClick={() => setFull(true)}>Display</Button>
      </div>
      <div className="hidden"><QRCodeCanvas ref={canvasRef} value={url} size={760} fgColor={COLORS.navy} level="M" marginSize={1} /></div>

      {full && (
        <div className="fixed inset-0 z-[70] flex flex-col items-center justify-center bg-white p-6" role="dialog" aria-label="QR code display">
          <button type="button" onClick={() => setFull(false)} className="absolute right-5 top-5 rounded-lg p-2 text-mist-500 hover:bg-mist-100" aria-label="Close display"><X size={26} /></button>
          <div className="text-lg text-mist-500">{orgName}</div>
          <div className="mt-1 text-center text-4xl font-semibold text-ink sm:text-5xl">{title}</div>
          <div className="mt-8 rounded-2xl border border-mist-200 p-5"><QRCodeSVG value={url} size={Math.min(window.innerHeight * 0.55, window.innerWidth * 0.8)} fgColor={COLORS.navy} level="M" marginSize={0} /></div>
          <div className="mt-8 text-3xl font-semibold text-brand-700">{cta}</div>
          <div className="mt-2 text-lg text-mist-500">Point your phone camera at the code</div>
        </div>
      )}
    </div>
  )
}
