// Local full-stack server for development and screenshots: real API + in-memory Firestore/Auth stand-in + built SPA.
// Usage: npm run build:web && node scripts/local-server.mjs [--seed]
// Without Firebase web settings, the login page posts email/password to /auth/session; this server converts
// that into a stand-in ID token. The production function ignores those fields.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { setFirebase } from '../server/firebase.js'
import { handle } from '../server/app.js'
import { createFakeFirebase } from '../tests/fake-firebase.js'

process.env.GW_INSECURE_COOKIES = '1'
process.env.PLATFORM_ADMIN_EMAILS ||= 'ops@gatherwell.local'
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const PORT = Number(process.env.PORT || 8888)
const fake = createFakeFirebase()
setFirebase(fake)

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' }
const server = http.createServer(async (req, res) => {
  if (req.url.startsWith('/api/')) {
    const chunks = []
    for await (const c of req) chunks.push(c)
    let body = chunks.length ? Buffer.concat(chunks) : undefined
    if (req.url === '/api/auth/session' && body) {
      const j = JSON.parse(body.toString())
      if (j.devEmail) body = Buffer.from(JSON.stringify({ idToken: fake.auth.signIn(j.devEmail, j.devPassword) || 'bad' }))
    }
    const r = await handle(new Request(`http://localhost:${PORT}${req.url}`, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body }))
    res.writeHead(r.status, Object.fromEntries(r.headers))
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
  await seed(PORT, fake)
  console.log('Seeded. Sign in as ada@grace.local / password123 (owner), usher@grace.local / password123 (usher)')
}
