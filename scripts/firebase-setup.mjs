// Runs before each Netlify build: publishes firestore.rules and creates the composite indexes
// in firestore.indexes.json, using FIREBASE_SERVICE_ACCOUNT. Never fails the build — it prints
// what to do if a permission is missing, because the site itself can still deploy.
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const raw = process.env.FIREBASE_SERVICE_ACCOUNT
const warn = (m) => console.warn(`\n⚠ ${m}\n`)

if (!raw) {
  warn('FIREBASE_SERVICE_ACCOUNT is not set — skipping Firestore rules/index setup. The app needs it to work.')
  process.exit(0)
}
for (const k of ['VITE_FIREBASE_API_KEY', 'VITE_FIREBASE_AUTH_DOMAIN', 'VITE_FIREBASE_PROJECT_ID', 'VITE_FIREBASE_APP_ID']) {
  if (!process.env[k]) warn(`${k} is not set — sign-in in the browser will not work until it is.`)
}

let sa
try { sa = JSON.parse(raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8')) }
catch { warn('FIREBASE_SERVICE_ACCOUNT is not valid JSON.'); process.exit(0) }
const project = sa.project_id

try {
  const { cert } = await import('firebase-admin/app')
  const { access_token: token } = await cert(sa).getAccessToken()
  const call = async (method, url, body) => {
    const res = await fetch(url, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
    const data = await res.json().catch(() => ({}))
    return { ok: res.ok, status: res.status, data }
  }

  // 1. Security rules (deny all client access).
  const rules = fs.readFileSync(path.join(root, 'firestore.rules'), 'utf8')
  const rs = await call('POST', `https://firebaserules.googleapis.com/v1/projects/${project}/rulesets`, { source: { files: [{ name: 'firestore.rules', content: rules }] } })
  if (!rs.ok) warn(`Could not upload Firestore rules (${rs.status}): ${rs.data?.error?.message || ''}\nPaste firestore.rules into Firebase console → Firestore → Rules instead.`)
  else {
    const releaseName = `projects/${project}/releases/cloud.firestore`
    let rel = await call('PATCH', `https://firebaserules.googleapis.com/v1/${releaseName}`, { release: { name: releaseName, rulesetName: rs.data.name } })
    if (rel.status === 404) rel = await call('POST', `https://firebaserules.googleapis.com/v1/projects/${project}/releases`, { name: releaseName, rulesetName: rs.data.name })
    console.log(rel.ok ? '✓ Firestore rules published (clients denied; server-only access).' : `⚠ Rules release failed (${rel.status}): ${rel.data?.error?.message || ''}`)
  }

  // 2. Composite indexes (existing ones are skipped).
  const { indexes } = JSON.parse(fs.readFileSync(path.join(root, 'firestore.indexes.json'), 'utf8'))
  let created = 0, existing = 0, failed = 0
  for (const ix of indexes) {
    const r = await call('POST', `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/collectionGroups/${ix.collectionGroup}/indexes`,
      { queryScope: ix.queryScope, fields: ix.fields.map(f => ({ fieldPath: f.fieldPath, order: f.order })) })
    if (r.ok) created++
    else if (r.status === 409 || /already exists/i.test(r.data?.error?.message || '')) existing++
    else { failed++; if (failed === 1) warn(`Index creation failed (${r.status}): ${r.data?.error?.message || ''}`) }
  }
  console.log(`✓ Firestore indexes: ${created} created, ${existing} already present${failed ? `, ${failed} failed` : ''}.${created ? ' New indexes take a few minutes to build.' : ''}`)
  if (failed) warn('Give the service account the "Cloud Datastore Index Admin" role in Google Cloud IAM, or deploy firestore.indexes.json with the Firebase CLI.')
} catch (e) {
  warn(`Firestore setup skipped: ${e.message}`)
}
