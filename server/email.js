// Email delivery (Resend), unsubscribe links and hosted images for church emails.
// Sending is enabled when RESEND_API_KEY and EMAIL_FROM_DOMAIN are set in Netlify.
import crypto from 'node:crypto'

export function emailProvider() {
  const key = process.env.RESEND_API_KEY
  const domain = (process.env.EMAIL_FROM_DOMAIN || '').trim().toLowerCase()
  return key && domain ? { key, domain } : null
}

// "Grace Community Church" <grace-community-church@mail.gatherhq.app>
export function fromAddress(org, branding, domain) {
  const name = String(branding.fromName || org.name || 'GatherHQ').replace(/["<>\r\n]/g, '').slice(0, 80)
  const local = String(org.slug || 'hello').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40) || 'hello'
  return `"${name}" <${local}@${domain}>`
}

function secret() {
  if (process.env.EMAIL_SIGNING_SECRET) return process.env.EMAIL_SIGNING_SECRET
  const sa = process.env.FIREBASE_SERVICE_ACCOUNT || 'gatherhq-dev-secret'
  return crypto.createHash('sha256').update('unsubscribe:' + sa).digest('hex')
}
export const unsubToken = (orgId, personId) => crypto.createHmac('sha256', secret()).update(`${orgId}.${personId}`).digest('hex').slice(0, 32)
export function checkUnsubToken(orgId, personId, token) {
  const want = unsubToken(orgId, personId)
  return typeof token === 'string' && token.length === want.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(want))
}
export function siteOrigin(url) {
  return (process.env.URL || url?.origin || '').replace(/\/$/, '')
}
export const unsubscribeUrl = (origin, orgId, personId) =>
  `${origin}/api/public/unsubscribe?o=${encodeURIComponent(orgId)}&p=${encodeURIComponent(personId)}&t=${unsubToken(orgId, personId)}`

const RESEND = 'https://api.resend.com'

async function post(provider, path, payload, idempotencyKey) {
  const headers = { authorization: `Bearer ${provider.key}`, 'content-type': 'application/json' }
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey.slice(0, 256)
  const res = await fetch(RESEND + path, { method: 'POST', headers, body: JSON.stringify(payload) })
  const data = await res.json().catch(() => ({}))
  return { ok: res.ok, status: res.status, data, error: res.ok ? null : (data?.message || data?.error || `Email service error (${res.status})`) }
}

/**
 * Sends up to 100 emails. Returns one { ok, error } per email, in order.
 * If the batch is rejected, emails are retried one by one so a single bad address
 * doesn't fail everyone else.
 */
export async function sendEmails(provider, emails, idempotencyKey) {
  if (!emails.length) return []
  const r = await post(provider, '/emails/batch', emails, idempotencyKey)
  if (r.ok) return emails.map(() => ({ ok: true }))
  if (r.status === 401 || r.status === 403) return emails.map(() => ({ ok: false, error: 'The email service rejected our API key. Check RESEND_API_KEY in Netlify.', fatal: true }))
  if (r.status === 429 || r.status >= 500) return emails.map(() => ({ ok: false, error: r.error, retry: true }))
  const out = []
  for (const [i, e] of emails.entries()) {
    const one = await post(provider, '/emails', e, idempotencyKey ? `${idempotencyKey}-${i}` : undefined)
    out.push(one.ok ? { ok: true } : { ok: false, error: one.error })
  }
  return out
}

// --- hosted images (logos and pictures inside emails) ---------------------------------
const MIME = { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }
export function parseImage(dataUrl) {
  const m = /^data:(image\/(png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''))
  if (!m) return null
  const bytes = Buffer.from(m[3], 'base64')
  if (bytes.length > 600_000) return { tooBig: true }
  const sig = bytes.subarray(0, 12)
  const real = sig[0] === 0x89 && sig[1] === 0x50 ? 'png' : sig[0] === 0xff && sig[1] === 0xd8 ? 'jpeg' : sig.toString('ascii', 0, 3) === 'GIF' ? 'gif' : sig.toString('ascii', 8, 12) === 'WEBP' ? 'webp' : null
  if (!real) return null
  return { mime: MIME[real], data: bytes.toString('base64'), size: bytes.length }
}
