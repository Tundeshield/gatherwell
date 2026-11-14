// Cookieless website statistics for the public pages (home, pricing, sign-up, sign-in, legal).
// Nothing is stored on the visitor's device. Browsers asking not to be tracked (Global Privacy
// Control or Do Not Track) and automated browsers send nothing.
import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { isAdminHost } from './host'

const TRACKED = /^\/(?:|pricing|signup|login|legal\/[a-z-]+)\/?$/
const off = typeof navigator === 'undefined' || isAdminHost || navigator.webdriver || navigator.globalPrivacyControl || navigator.doNotTrack === '1' || window.doNotTrack === '1'

let current = null // { path, visibleSince, ms }
let firstHit = true

function send(data) {
  try { fetch('/api/t', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data), keepalive: true, credentials: 'same-origin' }).catch(() => {}) } catch {}
}

function flush() {
  if (!current) return
  const ms = current.ms + (current.visibleSince ? Date.now() - current.visibleSince : 0)
  current.ms = 0
  if (current.visibleSince) current.visibleSince = Date.now()
  const s = Math.round(ms / 1000)
  if (s >= 1) send({ k: 'eng', path: current.path, s })
}

function pageview(path, search) {
  flush()
  current = { path, visibleSince: document.visibilityState === 'visible' ? Date.now() : null, ms: 0 }
  const data = { k: 'pv', path }
  if (firstHit) {
    const q = new URLSearchParams(search)
    Object.assign(data, {
      ref: document.referrer || null,
      utm: Object.fromEntries(['source', 'medium', 'campaign', 'term', 'content'].map(k => [k, q.get(`utm_${k}`)]).filter(([, v]) => v)),
      screen: `${screen.width}x${screen.height}`, viewport: `${window.innerWidth}x${window.innerHeight}`, dpr: window.devicePixelRatio,
      lang: navigator.language, langs: navigator.languages, touch: navigator.maxTouchPoints > 0,
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    })
    firstHit = false
  }
  send(data)
}

if (!off && typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (!current) return
    if (document.visibilityState === 'hidden') { if (current.visibleSince) { current.ms += Date.now() - current.visibleSince; current.visibleSince = null } flush() }
    else current.visibleSince = Date.now()
  })
  window.addEventListener('pagehide', flush)
}

export function usePageTracking() {
  const { pathname, search } = useLocation()
  useEffect(() => {
    if (off) return
    if (TRACKED.test(pathname)) pageview(pathname.length > 1 ? pathname.replace(/\/$/, '') : '/', search)
    else { flush(); current = null }
  }, [pathname]) // eslint-disable-line react-hooks/exhaustive-deps
}
