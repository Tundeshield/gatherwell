// Postgres access. Uses Netlify Database when deployed; DATABASE_URL overrides it
// (e.g. an external Neon/Supabase database, or a local database in tests).
import { getDatabase } from '@netlify/database'

let pool = null

export function setPool(p) { pool = p }

function getPool() {
  if (!pool) {
    const opts = process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : undefined
    pool = getDatabase(opts).pool
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

// Builds parameterised WHERE clauses: const w = where(); w.add('org_id = ?', orgId)
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
