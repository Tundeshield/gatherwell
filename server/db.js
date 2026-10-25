// Postgres access via DATABASE_URL (Neon, Supabase or any Postgres).
// For serverless, use the provider's *pooled* connection string.
import pg from 'pg'
import { HttpError } from './http.js'

let pool = null

export function setPool(p) { pool = p }

function getPool() {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL
    if (!connectionString) throw new HttpError(503, 'Gatherwell is not connected to its database yet. Set DATABASE_URL in Netlify and redeploy.')
    const local = /localhost|127\.0\.0\.1/.test(connectionString)
    pool = new pg.Pool({
      connectionString,
      max: 3,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
      ssl: local ? undefined : { rejectUnauthorized: false },
    })
    pool.on('error', (e) => console.error('pg pool error', e.message))
  }
  return pool
}

// q(text, params) -> rows
export async function q(text, params = []) {
  const res = await getPool().query(text, params)
  return res.rows
}

export async function one(text, params = []) {
  const rows = await q(text, params)
  return rows[0] || null
}

// Run fn(client) inside a transaction. client.q / client.one mirror the helpers above.
export async function tx(fn) {
  const client = await getPool().connect()
  const wrap = {
    q: async (text, params = []) => (await client.query(text, params)).rows,
    one: async (text, params = []) => (await client.query(text, params)).rows[0] || null,
  }
  try {
    await client.query('BEGIN')
    const out = await fn(wrap)
    await client.query('COMMIT')
    return out
  } catch (e) {
    try { await client.query('ROLLBACK') } catch {}
    throw e
  } finally {
    client.release()
  }
}

// Builds parameterised WHERE clauses: const b = builder(); b.add('org_id = ?', orgId)
export function builder(start = []) {
  const params = [...start]
  const parts = []
  return {
    params,
    p(v) { params.push(v); return `$${params.length}` },
    add(sqlWithQ, ...vals) {
      let s = sqlWithQ
      for (const v of vals) s = s.replace('?', this.p(v))
      parts.push(s)
      return this
    },
    sql(prefix = 'WHERE') { return parts.length ? `${prefix} ${parts.join(' AND ')}` : '' },
  }
}
