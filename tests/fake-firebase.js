// In-memory stand-in for the parts of firebase-admin (Firestore + Auth) Gatherwell uses.
// Used by the integration tests and the local demo server, because the Firestore emulator
// can't be downloaded in every environment. It deliberately ENFORCES Firestore's index rules:
// a query that would need a composite index not declared in firestore.indexes.json throws,
// just as production would.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const INDEXES = JSON.parse(fs.readFileSync(path.resolve(path.dirname(new URL(import.meta.url).pathname), '../firestore.indexes.json'), 'utf8')).indexes

class Timestamp {
  constructor(ms) { this._ms = ms }
  toDate() { return new Date(this._ms) }
  toMillis() { return this._ms }
}
const isSentinel = (v) => v && typeof v === 'object' && v.__op
const cmpVal = (v) => (v instanceof Date ? v.getTime() : v instanceof Timestamp ? v._ms : v)
function compare(a, b) {
  a = cmpVal(a); b = cmpVal(b)
  if (a === b) return 0
  if (a === undefined || a === null) return -1
  if (b === undefined || b === null) return 1
  return a < b ? -1 : 1
}
function clone(v) {
  if (v instanceof Date) return new Timestamp(v.getTime())
  if (v instanceof Timestamp) return new Timestamp(v._ms)
  if (Array.isArray(v)) return v.map(clone)
  if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) if (x !== undefined) o[k] = clone(x); return o }
  return v
}
function applyWrite(existing, data, merge) {
  const out = merge && existing ? { ...existing } : {}
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue
    if (isSentinel(v)) {
      if (v.__op === 'del') delete out[k]
      else if (v.__op === 'inc') out[k] = (Number(out[k]) || 0) + v.n
      else if (v.__op === 'union') out[k] = [...new Set([...(out[k] || []), ...v.vals])]
      else if (v.__op === 'remove') out[k] = (out[k] || []).filter(x => !v.vals.includes(x))
    } else out[k] = clone(v)
  }
  return out
}
function firestoreError(code, message) { const e = new Error(message); e.code = code; return e }

// --- index rules -------------------------------------------------------------------
function hasIndex(collectionGroup, fields) {
  return INDEXES.some(ix => ix.collectionGroup === collectionGroup && ix.fields.length === fields.length &&
    ix.fields.every((f, i) => f.fieldPath === fields[i].fieldPath && (f.order || (f.arrayConfig ? 'CONTAINS' : 'ASCENDING')) === fields[i].order))
}
function checkIndex(group, filters, orders, isCount = false) {
  const eq = filters.filter(f => f.op === '==' || f.op === 'in').map(f => f.field)
  const arr = filters.filter(f => f.op === 'array-contains')
  const range = filters.filter(f => ['<', '<=', '>', '>='].includes(f.op))
  const rangeFields = [...new Set(range.map(f => f.field))]
  if (rangeFields.length > 1) throw firestoreError(9, 'Fake Firestore: range filters on more than one field need special indexes — avoid.')
  if (rangeFields.length && orders.length && orders[0].field !== rangeFields[0]) throw firestoreError(3, `Fake Firestore: first orderBy must be the range field ${rangeFields[0]}.`)
  const sort = orders.length ? orders : rangeFields.map(field => ({ field, dir: 'asc' }))
  if (arr.length) {
    if (eq.length || sort.length) throw firestoreError(9, `Fake Firestore: array-contains combined with other clauses on ${group} needs a composite index.`)
    return
  }
  if (!sort.length) return // equality-only: Firestore merges single-field indexes
  if (!eq.length && sort.length === 1) return // single-field index
  const uniqEq = [...new Set(eq)]
  // Count queries with a range filter (no explicit order) can use an index in either direction.
  if (isCount && !orders.length) {
    for (const dir of ['asc', 'desc']) { try { return checkIndex(group, filters, rangeFields.map(field => ({ field, dir }))) } catch {} }
  }
  const sortFields = sort.map(o => ({ fieldPath: o.field, order: o.dir === 'desc' ? 'DESCENDING' : 'ASCENDING' }))
  // Exact composite: all equality fields (any order) + sort fields.
  const exact = INDEXES.some(ix => ix.collectionGroup === group && ix.fields.length === uniqEq.length + sortFields.length &&
    uniqEq.every(f => ix.fields.slice(0, uniqEq.length).some(x => x.fieldPath === f)) &&
    sortFields.every((s, i) => ix.fields[uniqEq.length + i].fieldPath === s.fieldPath && (ix.fields[uniqEq.length + i].order || 'ASCENDING') === s.order))
  if (exact) return
  // Index merging: one composite [eqField, ...sort] per equality field.
  if (uniqEq.length && uniqEq.every(f => hasIndex(group, [{ fieldPath: f, order: 'ASCENDING' }, ...sortFields]))) return
  throw firestoreError(9, `Fake Firestore: query on "${group}" needs a composite index on [${[...uniqEq, ...sortFields.map(s => `${s.fieldPath} ${s.order}`)].join(', ')}]. Add it to firestore.indexes.json.`)
}

// --- refs ---------------------------------------------------------------------------
class DocSnapshot {
  constructor(ref, data) { this.ref = ref; this.id = ref.id; this._d = data }
  get exists() { return this._d !== undefined }
  data() { return this._d === undefined ? undefined : clone(this._d) }
  get(f) { return this._d?.[f] }
}
class QuerySnapshot {
  constructor(docs) { this.docs = docs }
  get empty() { return this.docs.length === 0 }
  get size() { return this.docs.length }
  forEach(fn) { this.docs.forEach(fn) }
}

class DocRef {
  constructor(db, p) { this.db = db; this.path = p; this.id = p.split('/').pop() }
  collection(name) { return new Query(this.db, `${this.path}/${name}`) }
  async get() { return new DocSnapshot(this, this.db._store.get(this.path)) }
  async set(data, opts = {}) { this.db._write(this.path, data, !!opts.merge) }
  async update(data) { if (!this.db._store.has(this.path)) throw firestoreError(5, `No document to update: ${this.path}`); this.db._write(this.path, data, true) }
  async create(data) { if (this.db._store.has(this.path)) throw firestoreError(6, `Document already exists: ${this.path}`); this.db._write(this.path, data, false) }
  async delete() { this.db._store.delete(this.path) }
}

class Query {
  constructor(db, collPath, state = {}) {
    this.db = db; this.path = collPath
    this.s = { filters: [], orders: [], limit: null, offset: 0, ...state }
  }
  _with(p) { return new Query(this.db, this.path, { ...this.s, ...p }) }
  doc(id) { return new DocRef(this.db, `${this.path}/${id || crypto.randomBytes(10).toString('hex')}`) }
  async add(data) { const ref = this.doc(); await ref.set(data); return ref }
  where(field, op, value) {
    if (op === 'in' && (!Array.isArray(value) || value.length > 30)) throw firestoreError(3, "'in' needs an array of at most 30 values")
    return this._with({ filters: [...this.s.filters, { field, op, value }] })
  }
  orderBy(field, dir = 'asc') { return this._with({ orders: [...this.s.orders, { field, dir }] }) }
  limit(n) { return this._with({ limit: n }) }
  offset(n) { return this._with({ offset: n }) }
  select() { return this }
  count() { const q = this; return { get: async () => { const docs = q._run(true, true); return { data: () => ({ count: docs.length }) } } } }
  _run(ignoreLimits = false, isCount = false) {
    const group = this.path.split('/').filter((_, i) => i % 2 === 0).pop()
    checkIndex(group, this.s.filters, this.s.orders, isCount)
    const prefix = this.path + '/'
    let rows = []
    for (const [p, d] of this.db._store) if (p.startsWith(prefix) && !p.slice(prefix.length).includes('/')) rows.push([p, d])
    for (const f of this.s.filters) {
      rows = rows.filter(([, d]) => {
        const v = d[f.field]
        switch (f.op) {
          case '==': return compare(v, f.value) === 0 && (v !== undefined || f.value === null)
          case 'in': return f.value.some(x => compare(v, x) === 0 && v !== undefined)
          case 'array-contains': return Array.isArray(v) && v.includes(f.value)
          case '<': return v !== undefined && v !== null && compare(v, f.value) < 0
          case '<=': return v !== undefined && v !== null && compare(v, f.value) <= 0
          case '>': return v !== undefined && v !== null && compare(v, f.value) > 0
          case '>=': return v !== undefined && v !== null && compare(v, f.value) >= 0
          default: throw firestoreError(3, `Fake Firestore: unsupported operator ${f.op}`)
        }
      })
    }
    // Firestore omits documents missing an orderBy field.
    for (const o of this.s.orders) rows = rows.filter(([, d]) => d[o.field] !== undefined)
    rows.sort(([pa, a], [pb, b]) => {
      for (const o of this.s.orders) { const c = compare(a[o.field], b[o.field]); if (c) return o.dir === 'desc' ? -c : c }
      return pa < pb ? -1 : 1
    })
    if (!ignoreLimits) {
      rows = rows.slice(this.s.offset || 0)
      if (this.s.limit !== null) rows = rows.slice(0, this.s.limit)
    }
    return rows.map(([p, d]) => new DocSnapshot(new DocRef(this.db, p), d))
  }
  async get() { return new QuerySnapshot(this._run()) }
}

class FakeFirestore {
  constructor() { this._store = new Map(); this._lock = Promise.resolve() }
  collection(p) { return new Query(this, p) }
  doc(p) { return new DocRef(this, p) }
  _write(p, data, merge) { this._store.set(p, applyWrite(this._store.get(p), data, merge)) }
  async getAll(...refs) { return refs.map(r => new DocSnapshot(r, this._store.get(r.path))) }
  batch() {
    const ops = []
    return {
      set: (ref, data, opts = {}) => { ops.push(['set', ref, data, opts]); },
      update: (ref, data) => { ops.push(['update', ref, data]) },
      create: (ref, data) => { ops.push(['create', ref, data]) },
      delete: (ref) => { ops.push(['delete', ref]) },
      commit: async () => this._commit(ops),
    }
  }
  _commit(ops) {
    for (const [op, ref] of ops) {
      if (op === 'create' && this._store.has(ref.path)) throw firestoreError(6, `Document already exists: ${ref.path}`)
      if (op === 'update' && !this._store.has(ref.path) && !ops.some(o => o[1].path === ref.path && (o[0] === 'set' || o[0] === 'create'))) throw firestoreError(5, `No document to update: ${ref.path}`)
    }
    for (const [op, ref, data, opts] of ops) {
      if (op === 'delete') this._store.delete(ref.path)
      else this._write(ref.path, data, op === 'update' || !!opts?.merge)
    }
  }
  async runTransaction(fn) {
    // Serialise transactions; buffer writes until the function succeeds.
    const prev = this._lock
    let release
    this._lock = new Promise(r => { release = r })
    await prev
    try {
      const ops = []
      let wrote = false
      const tx = {
        get: async (refOrQuery) => {
          if (wrote) throw firestoreError(3, 'Fake Firestore: transactions must do all reads before writes.')
          return refOrQuery instanceof DocRef ? refOrQuery.get() : refOrQuery.get()
        },
        getAll: async (...refs) => this.getAll(...refs),
        set: (ref, data, opts = {}) => { wrote = true; ops.push(['set', ref, data, opts]); return tx },
        update: (ref, data) => { wrote = true; ops.push(['update', ref, data]); return tx },
        create: (ref, data) => { wrote = true; ops.push(['create', ref, data]); return tx },
        delete: (ref) => { wrote = true; ops.push(['delete', ref]); return tx },
      }
      const out = await fn(tx)
      this._commit(ops)
      return out
    } finally { release() }
  }
}

export const FakeFieldValue = {
  increment: (n) => ({ __op: 'inc', n }),
  delete: () => ({ __op: 'del' }),
  arrayUnion: (...vals) => ({ __op: 'union', vals }),
  arrayRemove: (...vals) => ({ __op: 'remove', vals }),
}

// --- Auth ------------------------------------------------------------------------------
class FakeAuth {
  constructor() { this.users = new Map(); this.revoked = new Map() }
  async createUser({ email, password, displayName }) {
    email = email.toLowerCase()
    if ([...this.users.values()].some(u => u.email === email)) { const e = new Error('The email address is already in use by another account.'); e.code = 'auth/email-already-exists'; throw e }
    const uid = crypto.randomBytes(14).toString('hex')
    this.users.set(uid, { uid, email, password, displayName })
    return { uid, email, displayName }
  }
  async getUserByEmail(email) {
    const u = [...this.users.values()].find(x => x.email === email.toLowerCase())
    if (!u) { const e = new Error('no user'); e.code = 'auth/user-not-found'; throw e }
    return u
  }
  async updateUser(uid, props) { Object.assign(this.users.get(uid), props); return this.users.get(uid) }
  // Test helper standing in for the client SDK's signInWithEmailAndPassword + getIdToken.
  signIn(email, password) {
    const u = [...this.users.values()].find(x => x.email === email.toLowerCase())
    if (!u || u.password !== password) return null
    return `idtoken:${u.uid}:${Date.now()}`
  }
  async verifyIdToken(token) {
    const [kind, uid, at] = String(token).split(':')
    if (kind !== 'idtoken' || !this.users.has(uid)) { const e = new Error('invalid token'); e.code = 'auth/argument-error'; throw e }
    return { uid, email: this.users.get(uid).email, auth_time: Math.floor(Number(at) / 1000), name: this.users.get(uid).displayName }
  }
  async createSessionCookie(idToken) { const { uid } = await this.verifyIdToken(idToken); return `session.${uid}.${crypto.randomBytes(8).toString('hex')}` }
  async verifySessionCookie(cookie) {
    const [kind, uid] = String(cookie).split('.')
    if (kind !== 'session' || !this.users.has(uid) || this.revoked.get(uid)?.has(cookie)) { const e = new Error('invalid session'); e.code = 'auth/session-cookie-revoked'; throw e }
    return { uid, email: this.users.get(uid).email }
  }
  async revokeRefreshTokens() {}
}

export function createFakeFirebase() {
  return { db: new FakeFirestore(), auth: new FakeAuth(), FieldValue: FakeFieldValue }
}
