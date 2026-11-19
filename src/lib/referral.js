// The church that invited a visitor ("Get this for your church" links: gatherhq.org/?ref=CODE).
// Kept for this browser tab only, so it survives moving from the home page to sign-up.
const KEY = 'ghq_ref'
export function currentRef() {
  if (typeof window === 'undefined') return null
  const fromUrl = new URLSearchParams(window.location.search).get('ref')
  const clean = (v) => (v && /^[a-z0-9]{4,12}$/i.test(v) ? v.toLowerCase() : null)
  if (clean(fromUrl)) { try { sessionStorage.setItem(KEY, clean(fromUrl)) } catch {} return clean(fromUrl) }
  try { return clean(sessionStorage.getItem(KEY)) } catch { return null }
}
export const referralHref = (code) => `/?ref=${encodeURIComponent(code)}&utm_source=powered_by&utm_medium=referral&utm_campaign=get_this_for_your_church`
