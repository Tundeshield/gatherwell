import { lazy } from 'react'

// After a new version is deployed, an open tab still points at the old page files, which no
// longer exist, so loading a page it hasn't visited yet fails. When that happens we reload once
// to pick up the new version. The timestamp guard stops a reload loop if the network is down.
const KEY = 'gw:chunk-reload'

export function reloadForNewVersion() {
  let last = 0
  try { last = Number(sessionStorage.getItem(KEY) || 0) } catch { /* storage unavailable */ }
  if (Date.now() - last < 15000) return false
  try { sessionStorage.setItem(KEY, String(Date.now())) } catch { /* ignore */ }
  window.location.reload()
  return true
}

export function lazyPage(load) {
  return lazy(() => load().catch((err) => {
    if (reloadForNewVersion()) return new Promise(() => {}) // keep showing the loader while reloading
    throw err
  }))
}
