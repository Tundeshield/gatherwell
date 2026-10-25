import crypto from 'node:crypto'
import { fb } from './firebase.js'
import { tooMany } from './http.js'

// --- tokens & passwords ---------------------------------------------------------
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url')
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex')

const ALPHABET = '23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ'
export function shortId(len = 10) {
  const bytes = crypto.randomBytes(len)
  let s = ''
  for (let i = 0; i < len; i++) s += ALPHABET[bytes[i] % ALPHABET.length]
  return s
}
export function ticketCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const b = crypto.randomBytes(6)
  let s = ''
  for (let i = 0; i < 6; i++) s += A[b[i] % A.length]
  return s
}

export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16)
  const key = await new Promise((res, rej) => crypto.scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1 }, (e, k) => e ? rej(e) : res(k)))
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`
}

export async function verifyPassword(pw, stored) {
  const [alg, saltB64, keyB64] = String(stored || '').split('$')
  if (alg !== 'scrypt' || !saltB64 || !keyB64) return false
  const expected = Buffer.from(keyB64, 'base64')
  const key = await new Promise((res, rej) => crypto.scrypt(pw, Buffer.from(saltB64, 'base64'), expected.length, { N: 16384, r: 8, p: 1 }, (e, k) => e ? rej(e) : res(k)))
  return crypto.timingSafeEqual(key, expected)
}

// --- phones & names -------------------------------------------------------------
// Normalises to digits with country code. Default country code is Nigeria (234) for local numbers
// starting with 0; organisations can override via settings.defaultCountryCode.
export function normalizePhone(raw, defaultCc = '234') {
  if (!raw) return null
  let s = String(raw).trim()
  const plus = s.startsWith('+')
  s = s.replace(/[^\d]/g, '')
  if (!s) return null
  if (s.startsWith('00')) s = s.slice(2)
  else if (!plus && s.startsWith('0')) s = defaultCc + s.slice(1)
  else if (!plus && s.length <= 10 && defaultCc) s = defaultCc + s
  if (s.length < 8 || s.length > 15) return null
  return s
}

export function maskName(first, last) {
  const f = (first || '').trim()
  const l = (last || '').trim()
  const m = f ? f[0].toUpperCase() + '•'.repeat(Math.max(2, Math.min(f.length - 1, 5))) : '•••'
  return l ? `${m} ${l[0].toUpperCase()}.` : m
}

export function slugify(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 40) || 'church'
}

// --- rate limiting (fixed window, stored in Firestore) --------------------------------
export async function rateLimit(key, limit, windowSeconds) {
  const { db } = await fb()
  const ref = db.collection('rateLimits').doc(sha256(key).slice(0, 40))
  const count = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    const now = Date.now()
    const d = snap.exists ? snap.data() : null
    const start = d?.window_start ? (d.window_start.toDate ? d.window_start.toDate().getTime() : new Date(d.window_start).getTime()) : 0
    const fresh = !d || now - start > windowSeconds * 1000
    const n = fresh ? 1 : (d.count || 0) + 1
    tx.set(ref, { window_start: fresh ? new Date(now) : new Date(start), count: n, expires_at: new Date(now + windowSeconds * 1000) })
    return n
  })
  if (count > limit) throw tooMany()
}

export async function audit(ctx, action, entity, entityId, meta = {}) {
  try {
    if (!ctx?.org?.id) return
    const { db } = await fb()
    await db.collection('orgs').doc(ctx.org.id).collection('audit').add({
      action, entity: entity || null, entity_id: entityId ? String(entityId) : null, meta: JSON.parse(JSON.stringify(meta || {})),
      user_id: ctx.user?.id || null, user_name: ctx.user?.name || null, created_at: new Date(),
    })
  } catch (e) {
    console.error('audit failed', action, e.message)
  }
}

// Start of "today" (or of the day containing `date`) in an IANA timezone, as a Date.
export function startOfDayInTz(tz, date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date).map(p => [p.type, p.value]))
  const guess = Date.UTC(+parts.year, +parts.month - 1, +parts.day)
  return new Date(guess - tzOffsetMs(tz, new Date(guess)))
}
export function tzOffsetMs(tz, date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(date).map(x => [x.type, x.value]))
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - Math.floor(date.getTime() / 1000) * 1000
}
// Monday-of-week key (YYYY-MM-DD) for a date, in a timezone.
export function weekKey(date, tz) {
  const d = new Date(date.getTime() + tzOffsetMs(tz, date))
  const day = (d.getUTCDay() + 6) % 7
  d.setUTCDate(d.getUTCDate() - day)
  return d.toISOString().slice(0, 10)
}
export function monthKey(date, tz) { return new Date(date.getTime() + tzOffsetMs(tz, date)).toISOString().slice(0, 7) }

// Default form for new gatherings and events.
export const DEFAULT_CHECKIN_FORM = [
  { id: 'first_name', type: 'text', label: 'First name', required: true, core: true },
  { id: 'last_name', type: 'text', label: 'Last name', required: true, core: true },
  { id: 'phone', type: 'phone', label: 'Phone number', required: true, core: true },
  { id: 'email', type: 'email', label: 'Email', required: false, core: true },
]

export const FIELD_TYPES = ['text', 'email', 'phone', 'select', 'checkbox', 'textarea', 'date']

export function sanitizeForm(form) {
  if (!Array.isArray(form)) return DEFAULT_CHECKIN_FORM
  const out = []
  const seen = new Set()
  for (const f of form.slice(0, 30)) {
    if (!f || typeof f !== 'object') continue
    const type = FIELD_TYPES.includes(f.type) ? f.type : 'text'
    let id = String(f.id || '').replace(/[^\w]/g, '').slice(0, 40) || `f_${out.length}`
    if (seen.has(id)) id = `${id}_${out.length}`
    seen.add(id)
    const field = {
      id, type,
      label: String(f.label || 'Question').slice(0, 120),
      required: !!f.required,
      help: f.help ? String(f.help).slice(0, 200) : undefined,
      core: ['first_name', 'last_name', 'phone', 'email'].includes(id) || undefined,
    }
    if (type === 'select') field.options = (Array.isArray(f.options) ? f.options : []).map(o => String(o).slice(0, 80)).filter(Boolean).slice(0, 30)
    out.push(field)
  }
  // The identity fields are always present.
  for (const core of DEFAULT_CHECKIN_FORM.slice(0, 3)) if (!seen.has(core.id)) out.unshift(core)
  return out
}

export function validateAnswers(form, input) {
  const answers = {}
  const errors = {}
  for (const f of form) {
    let v = input?.[f.id]
    if (f.type === 'checkbox') v = !!v
    else if (v !== undefined && v !== null) v = String(v).trim().slice(0, f.type === 'textarea' ? 2000 : 300)
    if (f.required && (v === undefined || v === null || v === '' || v === false)) { errors[f.id] = `${f.label} is required.`; continue }
    if (v && f.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) { errors[f.id] = 'Enter a valid email.'; continue }
    if (v && f.type === 'select' && f.options?.length && !f.options.includes(v)) { errors[f.id] = 'Choose one of the options.'; continue }
    if (v !== undefined && v !== '') answers[f.id] = v
  }
  return { answers, errors }
}
