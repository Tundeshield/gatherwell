// Staging/production separation guards (server/env.js). See DEPLOYMENT.md.
import test from 'node:test'
import assert from 'node:assert/strict'
import { assertDatabaseAllowed, stripeKeyAllowed, emailAllowed, hostAllowed, PRODUCTION_FIREBASE_PROJECT } from '../server/env.js'
import { sendEmails } from '../server/email.js'
import { handle } from '../server/app.js'

const withEnv = async (vars, fn) => {
  const old = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]))
  Object.assign(process.env, vars)
  try { return await fn() } finally { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } }
}

test('staging refuses the production database; production and the staging project are allowed', async () => {
  await withEnv({ APP_ENV: 'staging' }, () => {
    assert.throws(() => assertDatabaseAllowed(PRODUCTION_FIREBASE_PROJECT), /production Firebase project/)
    assert.doesNotThrow(() => assertDatabaseAllowed('gather-hq-staging'))
  })
  await withEnv({ APP_ENV: 'production' }, () => assert.doesNotThrow(() => assertDatabaseAllowed(PRODUCTION_FIREBASE_PROJECT)))
})

test('staging never accepts a live Stripe key', async () => {
  await withEnv({ APP_ENV: 'staging' }, () => {
    assert.equal(stripeKeyAllowed('sk_live_abc'), false)
    assert.equal(stripeKeyAllowed('sk_test_abc'), true)
  })
  await withEnv({ APP_ENV: 'production' }, () => assert.equal(stripeKeyAllowed('sk_live_abc'), true))
})

test('staging only emails the allowlist, and skips everyone else without calling the email service', async () => {
  await withEnv({ APP_ENV: 'staging', STAGING_EMAIL_ALLOWLIST: 'pastor@test.church, @example.test' }, async () => {
    assert.equal(emailAllowed('pastor@test.church'), true)
    assert.equal(emailAllowed('anyone@example.test'), true)
    assert.equal(emailAllowed('real.member@gmail.com'), false)
    const calls = []
    const realFetch = globalThis.fetch
    globalThis.fetch = async (url, init) => { calls.push(JSON.parse(init.body)); return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } }) }
    try {
      const res = await sendEmails({ key: 'k', domain: 'mail.test' }, [
        { from: 'a@mail.test', to: ['real.member@gmail.com'], subject: 'x', html: 'x' },
        { from: 'a@mail.test', to: ['"Pastor" <pastor@test.church>'], subject: 'y', html: 'y' },
      ])
      assert.equal(res[0].ok, false); assert.equal(res[0].skipped, true)
      assert.equal(res[1].ok, true)
      assert.equal(JSON.stringify(calls).includes('real.member@gmail.com'), false, 'blocked address never reaches the provider')
    } finally { globalThis.fetch = realFetch }
  })
  await withEnv({ APP_ENV: 'production', STAGING_EMAIL_ALLOWLIST: '' }, () => assert.equal(emailAllowed('real.member@gmail.com'), true))
})

test('the production API refuses preview and branch-deploy addresses, which carry production secrets', async () => {
  await withEnv({ APP_ENV: 'production' }, async () => {
    assert.equal(hostAllowed('gatherhq.org'), true)
    assert.equal(hostAllowed('admin.gatherhq.org'), true)
    assert.equal(hostAllowed('main--gatherhq-app.netlify.app'), true)
    assert.equal(hostAllowed('deploy-preview-12--gatherhq-app.netlify.app'), false)
    assert.equal(hostAllowed('staging--gatherhq-app.netlify.app'), false)
    const r = await handle(new Request('https://deploy-preview-12--gatherhq-app.netlify.app/api/health', { headers: { host: 'deploy-preview-12--gatherhq-app.netlify.app' } }))
    assert.equal(r.status, 503)
  })
  await withEnv({ APP_ENV: 'staging' }, async () => {
    assert.equal(hostAllowed('gatherhq-staging.netlify.app'), true)
    const r = await handle(new Request('https://gatherhq-staging.netlify.app/api/health', { headers: { host: 'gatherhq-staging.netlify.app' } }))
    assert.equal(r.status, 200)
    assert.equal((await r.json()).env, 'staging')
  })
})
