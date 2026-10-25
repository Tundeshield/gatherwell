// Self-healing database setup: when Firestore reports a missing composite index, the server
// creates every index GatherHQ needs using its own service-account credential. Runs at most
// once per function instance; the outcome is kept so errors can be reported.
import { INDEXES } from './indexes.js'

let running = null
let last = null

export function setupStatus() { return last }

export function ensureIndexes(credential, project) {
  if (!credential || !project) return Promise.resolve(null)
  if (running) return running
  running = (async () => {
    try {
      const { access_token: token } = await credential.getAccessToken()
      let created = 0, existing = 0, failed = 0, firstError = ''
      await Promise.all(INDEXES.map(async (ix) => {
        const res = await fetch(`https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/collectionGroups/${ix.collectionGroup}/indexes`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ queryScope: ix.queryScope, fields: ix.fields.map(f => ({ fieldPath: f.fieldPath, order: f.order })) }),
        })
        const data = await res.json().catch(() => ({}))
        const msg = data?.error?.message || ''
        if (res.ok) created++
        else if (res.status === 409 || /already exists/i.test(msg)) existing++
        else { failed++; firstError ||= `${res.status} ${msg}` }
      }))
      last = { at: new Date().toISOString(), created, existing, failed, error: firstError || null }
      console.log('GatherHQ index setup', JSON.stringify(last))
    } catch (e) {
      last = { at: new Date().toISOString(), failed: INDEXES.length, error: e.message }
      console.error('GatherHQ index setup failed', e)
    }
    // Allow a retry later in this instance if something failed.
    if (last.failed) setTimeout(() => { running = null }, 60_000).unref?.()
    return last
  })()
  return running
}
