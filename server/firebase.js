// Firebase access for the server. Production uses firebase-admin with FIREBASE_SERVICE_ACCOUNT;
// tests and the local demo server inject an in-memory implementation via setFirebase().
import { HttpError } from './http.js'

let impl = null

export function setFirebase(f) { impl = f }

async function load() {
  if (impl) return impl
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT
  if (!raw) throw new HttpError(503, 'Gatherwell is not connected to Firebase yet. Add FIREBASE_SERVICE_ACCOUNT in Netlify and redeploy.')
  let sa
  try { sa = JSON.parse(raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8')) }
  catch { throw new HttpError(503, 'FIREBASE_SERVICE_ACCOUNT is not valid JSON. Paste the whole service-account file contents.') }
  const { initializeApp, getApps, cert } = await import('firebase-admin/app')
  const { getFirestore, FieldValue } = await import('firebase-admin/firestore')
  const { getAuth } = await import('firebase-admin/auth')
  const app = getApps()[0] || initializeApp({ credential: cert(sa), projectId: sa.project_id })
  const db = getFirestore(app)
  try { db.settings({ ignoreUndefinedProperties: true }) } catch {}
  impl = { db, auth: getAuth(app), FieldValue }
  return impl
}

export async function fb() { return load() }

// Field transforms, resolved against whichever implementation is active.
export const F = {
  inc: (n = 1) => impl.FieldValue.increment(n),
  del: () => impl.FieldValue.delete(),
  union: (...v) => impl.FieldValue.arrayUnion(...v),
  remove: (...v) => impl.FieldValue.arrayRemove(...v),
}

// --- path helpers ------------------------------------------------------------------
export const org = (db, orgId) => db.collection('orgs').doc(orgId)
export const col = (db, orgId, name) => db.collection('orgs').doc(orgId).collection(name)

// --- conversion --------------------------------------------------------------------
// Firestore Timestamps → ISO strings, recursively, for JSON responses.
export function plain(v) {
  if (v === null || v === undefined) return v ?? null
  if (typeof v.toDate === 'function') return v.toDate().toISOString()
  if (v instanceof Date) return v.toISOString()
  if (Array.isArray(v)) return v.map(plain)
  if (typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = plain(x); return o }
  return v
}
export const docOut = (snap) => (snap?.exists ? { id: snap.id, ...plain(snap.data()) } : null)
export const docsOut = (qs) => qs.docs.map(docOut)
export const toDate = (v) => (v ? (typeof v.toDate === 'function' ? v.toDate() : new Date(v)) : null)
export const ms = (v) => (v ? toDate(v).getTime() : 0)

export const isAlreadyExists = (e) => e?.code === 6 || e?.code === 'already-exists' || /already exists/i.test(e?.message || '')

// getAll in chunks (Firestore caps each call).
export async function getMany(db, refs) {
  const out = []
  for (let i = 0; i < refs.length; i += 300) out.push(...(refs.length ? await db.getAll(...refs.slice(i, i + 300)) : []))
  return out
}

// Search tokens: lowercase prefixes of each name word, the full name, email and phone digits.
export function searchTokens({ first_name, last_name, email, phone_norm }) {
  const t = new Set()
  const add = (w, min = 1) => { w = String(w || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, ''); for (let i = min; i <= Math.min(w.length, 20); i++) t.add(w.slice(0, i)) }
  for (const w of `${first_name || ''} ${last_name || ''}`.split(/\s+/)) add(w)
  if (email) add(email.split('@')[0], 2)
  if (phone_norm) {
    // Match on the trailing digits people actually type ("8031234567", "1234567", "4567").
    for (let n = 4; n <= phone_norm.length; n++) t.add(phone_norm.slice(-n))
  }
  return [...t]
}
