// Local full-stack server for development and screenshots: real API + local Postgres (PGlite) + built SPA.
// Usage: npm run build && node scripts/local-server.mjs [--seed]
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import pg from 'pg'
import { NetlifyDB } from '@netlify/database-dev'
import { setPool } from '../server/db.js'
import { handle } from '../server/app.js'

process.env.GW_INSECURE_COOKIES = '1'
process.env.PLATFORM_ADMIN_EMAILS ||= 'ops@gatherwell.local'
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const PORT = Number(process.env.PORT || 8888)

const db = new NetlifyDB({ logger: () => {} })
const url = await db.start()
await db.applyMigrations(path.join(root, 'netlify/database/migrations'))
const pool = new pg.Pool({ connectionString: url, max: 1 })
setPool(pool)

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' }
const server = http.createServer(async (req, res) => {
  if (req.url.startsWith('/api/')) {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const body = chunks.length ? Buffer.concat(chunks) : undefined
    const r = await handle(new Request(`http://localhost:${PORT}${req.url}`, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body }))
    const headers = Object.fromEntries(r.headers)
    res.writeHead(r.status, headers)
    res.end(Buffer.from(await r.arrayBuffer()))
    return
  }
  let file = path.join(root, 'dist', decodeURIComponent(req.url.split('?')[0]))
  if (!file.startsWith(path.join(root, 'dist')) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'dist/index.html')
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' })
  fs.createReadStream(file).pipe(res)
})
server.listen(PORT, () => console.log(`Gatherwell local: http://localhost:${PORT}`))

if (process.argv.includes('--seed')) {
  const { seed } = await import('./seed.mjs')
  await seed(PORT, pool)
  console.log('Seeded. Sign in as ada@grace.local / password123 (owner), usher@grace.local / password123 (usher)')
}
