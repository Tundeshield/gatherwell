// Which environment this deploy is, and the guards that keep staging away from production.
// Production is the default: only the staging Netlify site sets APP_ENV=staging.
// See DEPLOYMENT.md.

export const PRODUCTION_FIREBASE_PROJECT = 'gather-hq-main'

export const appEnv = () => (String(process.env.APP_ENV || 'production').trim().toLowerCase() || 'production')
export const isProduction = () => appEnv() === 'production'

// Staging must never use the production database.
export function assertDatabaseAllowed(projectId) {
  if (!isProduction() && projectId === PRODUCTION_FIREBASE_PROJECT) {
    const err = new Error(`This ${appEnv()} site is configured with the production Firebase project (${projectId}). Set FIREBASE_SERVICE_ACCOUNT to the staging project's key.`)
    err.status = 503
    throw err
  }
}

// Staging must never use live Stripe keys.
export function stripeKeyAllowed(key) {
  return isProduction() || !String(key || '').startsWith('sk_live')
}

// Outside production, email only goes to approved test recipients: STAGING_EMAIL_ALLOWLIST is a
// comma-separated list of addresses and/or domains (for example "you@gmail.com, @example.test").
export function emailAllowed(address) {
  if (isProduction()) return true
  const a = String(address || '').trim().toLowerCase()
  const list = String(process.env.STAGING_EMAIL_ALLOWLIST || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  return list.some(e => (e.startsWith('@') ? a.endsWith(e) : a === e))
}

// The production site's previews and branch deploys carry production secrets on Netlify, so the
// production API only answers on its real addresses. Other *.netlify.app addresses are refused.
const PRODUCTION_NETLIFY = /^(main--)?gatherhq-app\.netlify\.app$/i
export function hostAllowed(host) {
  if (!isProduction()) return true
  const h = String(host || '').split(':')[0].toLowerCase()
  if (!h.endsWith('.netlify.app')) return true
  return PRODUCTION_NETLIFY.test(h)
}
