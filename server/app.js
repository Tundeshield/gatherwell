import { Router, HttpError, json, forbidden, unauthorized } from './http.js'
import { fb } from './firebase.js'
import { ensureIndexes } from './setup.js'
import { loadContext, requireOrg, requireUser } from './access.js'
import authRoutes from './routes/auth.js'
import orgRoutes from './routes/org.js'
import peopleRoutes from './routes/people.js'
import gatheringRoutes from './routes/gatherings.js'
import eventRoutes from './routes/events.js'
import followupRoutes from './routes/followups.js'
import insightRoutes from './routes/insights.js'
import messageRoutes from './routes/messages.js'
import platformRoutes from './routes/platform.js'
import publicRoutes from './routes/public.js'
import tagRoutes from './routes/tags.js'
import automationRoutes from './routes/automation.js'
import billingRoutes from './routes/billing.js'
import childrenRoutes from './routes/children.js'
import { isExpired, billingEnabled } from './billing.js'
import { appEnv, hostAllowed } from './env.js'
import { COMMIT } from './version.js'

// What an account whose trial has ended may still do: pay, manage its account, and erase people.
const READ_ONLY_ALLOWED = [/^\/billing(\/|$)/, /^\/auth\//, /^\/me(\/|$)/, /^\/org\/dpa\//, Object.assign(/^\/people\/[^/]+$/, { method: 'DELETE' }), /^\/people\/[^/]+\/email-consent$/,
  // Children already checked in must always be handed back safely, even if a trial ends mid-service.
  /^\/children\/(pickup|pickup\/lookup)$/]

const router = new Router()
for (const register of [authRoutes, orgRoutes, peopleRoutes, gatheringRoutes, eventRoutes, followupRoutes, insightRoutes, messageRoutes, platformRoutes, publicRoutes, tagRoutes, automationRoutes, billingRoutes, childrenRoutes]) {
  register(router)
}

// Route options:
//   auth: 'public' | 'user' (signed in, no org needed) | 'org' (default) | 'platform'
export async function handle(req) {
  const url = new URL(req.url)
  const path = url.pathname.replace(/^\/api/, '') || '/'
  const method = req.method.toUpperCase()

  // Production secrets must only serve production addresses (see server/env.js).
  if (!hostAllowed(req.headers.get('host') || url.host)) return json({ error: 'This preview address is not connected to GatherHQ. Use staging for testing.' }, 503)
  if (path === '/health' && method === 'GET') {
    let project = null
    try { const raw = process.env.FIREBASE_SERVICE_ACCOUNT || ''; project = JSON.parse(raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8')).project_id || null } catch {}
    return json({ ok: true, env: appEnv(), commit: COMMIT, firebaseProject: project, billing: billingEnabled() ? (String(process.env.STRIPE_SECRET_KEY).startsWith('sk_live') ? 'live' : 'test') : 'off' })
  }

  try {
    const { route, params, pathMatched } = router.match(method, path)
    if (!route) return json({ error: pathMatched ? 'Method not allowed.' : 'Not found.' }, pathMatched ? 405 : 404)

    // CSRF: state-changing requests must be JSON. Browsers can't send cross-site JSON
    // without a CORS preflight, which this API never approves.
    if (method !== 'GET' && method !== 'HEAD' && method !== 'DELETE' && !route.opts.form) {
      const ct = req.headers.get('content-type') || ''
      if (!ct.includes('application/json')) return json({ error: 'Unsupported content type.' }, 415)
    }

    let body = {}
    let raw = ''
    if (method !== 'GET' && method !== 'HEAD' && method !== 'DELETE' && !route.opts.form) {
      const text = await req.text()
      raw = text
      if (text.length > 6_000_000) return json({ error: 'Request too large.' }, 413)
      try { body = text ? JSON.parse(text) : {} } catch { return json({ error: 'Invalid JSON.' }, 400) }
    }

    const mode = route.opts.auth || 'org'
    let ctx = null
    if (mode !== 'public' || route.opts.optionalUser) ctx = await loadContext(req)
    if (mode === 'user') requireUser(ctx)
    if (mode === 'org') requireOrg(ctx)
    if (mode === 'platform') {
      if (!ctx?.user) throw unauthorized()
      if (!ctx.user.isPlatformAdmin) throw forbidden()
    }

    // After the free trial, an unpaid church can still view and download everything, but not make changes.
    if (mode === 'org' && !['GET', 'HEAD'].includes(method) && isExpired(ctx.org) && !READ_ONLY_ALLOWED.some(re => re.test(path) && (re.method ? re.method === method : true))) {
      return json({ error: 'Your free trial has ended. Choose a plan in Settings › Billing to keep using GatherHQ. Everything you’ve recorded is safe.', details: { code: 'billing_required' } }, 402)
    }
    const result = await route.handler({ req, url, params, body, raw, query: Object.fromEntries(url.searchParams), ctx })
    if (result instanceof Response) return result
    return json(result ?? { ok: true })
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message, details: e.details }, e.status)
    // Firestore: a composite index is missing or still building (first deploys).
    if (e?.code === 9 && /index/i.test(e.message || '')) {
      console.error('Firestore index needed', e.message)
      const f = await fb().catch(() => null)
      const st = await ensureIndexes(f?.credential, f?.project)
      const error = st?.failed && !st.created && !st.existing
        ? `GatherHQ could not finish its database setup (${st.error}). Share this message with your administrator.`
        : 'GatherHQ is finishing its database setup. Please try again in a few minutes.'
      return json({ error }, 503)
    }
    console.error('API error', method, path, e)
    return json({ error: 'Something went wrong on our side. Please try again.' }, 500)
  }
}
