// Minimal HTTP helpers and router for the single /api/* function.

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message)
    this.status = status
    this.details = details
  }
}

export const bad = (msg, details) => new HttpError(400, msg, details)
export const unauthorized = (msg = 'Please sign in to continue.') => new HttpError(401, msg)
export const forbidden = (msg = "You don't have permission to do that.") => new HttpError(403, msg)
export const notFound = (msg = 'Not found.') => new HttpError(404, msg)
export const conflict = (msg, details) => new HttpError(409, msg, details)
export const tooMany = (msg = 'Too many attempts. Please wait a moment and try again.') => new HttpError(429, msg)

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  })
}

export function parseCookies(req) {
  const out = {}
  const raw = req.headers.get('cookie') || ''
  for (const part of raw.split(';')) {
    const i = part.indexOf('=')
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

export function clientIp(req) {
  return req.headers.get('x-nf-client-connection-ip') || req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
}

export class Router {
  constructor() { this.routes = [] }
  add(method, pattern, opts, handler) {
    if (typeof opts === 'function') { handler = opts; opts = {} }
    const keys = []
    const re = new RegExp('^' + pattern.replace(/\/:(\w+)/g, (_, k) => { keys.push(k); return '/([^/]+)' }) + '/?$')
    this.routes.push({ method, re, keys, opts, handler })
    return this
  }
  get(p, o, h) { return this.add('GET', p, o, h) }
  post(p, o, h) { return this.add('POST', p, o, h) }
  patch(p, o, h) { return this.add('PATCH', p, o, h) }
  delete(p, o, h) { return this.add('DELETE', p, o, h) }
  match(method, path) {
    let pathMatched = false
    for (const r of this.routes) {
      const m = r.re.exec(path)
      if (!m) continue
      pathMatched = true
      if (r.method !== method) continue
      const params = {}
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]) })
      return { route: r, params }
    }
    return { pathMatched }
  }
}

// --- input validation helpers -------------------------------------------------
export function str(v, { max = 500, required = false, name = 'Field' } = {}) {
  if (v === undefined || v === null) { if (required) throw bad(`${name} is required.`); return null }
  const s = String(v).trim()
  if (!s) { if (required) throw bad(`${name} is required.`); return null }
  if (s.length > max) throw bad(`${name} is too long (max ${max} characters).`)
  return s
}

export function oneOf(v, allowed, { name = 'Value', fallback } = {}) {
  if (v === undefined || v === null || v === '') return fallback ?? null
  if (!allowed.includes(v)) throw bad(`${name} must be one of: ${allowed.join(', ')}.`)
  return v
}

export function int(v, { min, max, name = 'Number' } = {}) {
  if (v === undefined || v === null || v === '') return null
  const n = Number(v)
  if (!Number.isInteger(n)) throw bad(`${name} must be a whole number.`)
  if (min !== undefined && n < min) throw bad(`${name} must be at least ${min}.`)
  if (max !== undefined && n > max) throw bad(`${name} must be at most ${max}.`)
  return n
}

export function date(v, { name = 'Date', required = false } = {}) {
  if (!v) { if (required) throw bad(`${name} is required.`); return null }
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) throw bad(`${name} is not a valid date.`)
  return d.toISOString()
}

export function email(v, { required = false } = {}) {
  const s = str(v, { max: 254, required, name: 'Email' })
  if (!s) return null
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw bad('Please enter a valid email address.')
  return s.toLowerCase()
}

// Firestore document IDs (auto IDs are 20 chars; we allow our own slug-like IDs too).
const ID_RE = /^[A-Za-z0-9_-]{6,64}$/
export function uuid(v, { name = 'ID', required = false } = {}) {
  if (!v) { if (required) throw bad(`${name} is required.`); return null }
  if (!ID_RE.test(String(v))) throw notFound(`${name} not found.`)
  return String(v)
}
export const isUuid = (v) => ID_RE.test(String(v || ''))
