// The GatherHQ team's console lives at admin.gatherhq.org (and at /admin on any other address, for local work).
export const isAdminHost = typeof window !== 'undefined' && /^admin\./i.test(window.location.hostname)
export const ADMIN_BASE = isAdminHost ? '' : '/admin'
export const adminPath = (p = '') => `${ADMIN_BASE}${p}` || '/'
export function adminUrl() {
  const h = typeof window !== 'undefined' ? window.location.hostname : ''
  return /(^|\.)gatherhq\.org$/i.test(h) && !isAdminHost ? 'https://admin.gatherhq.org' : '/admin'
}
export function appUrl() {
  const h = typeof window !== 'undefined' ? window.location.hostname : ''
  return isAdminHost ? `${window.location.protocol}//${h.replace(/^admin\./i, '')}/app` : '/app'
}
