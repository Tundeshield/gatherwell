# GatherHQ deployment and release process

Every change goes **feature branch → `staging` → review on staging → approval → `main` (production)**.
Production only ever receives a commit that has already run on staging.

| | Production | Staging |
| --- | --- | --- |
| URL | https://gatherhq.org (team console: https://admin.gatherhq.org) | https://staging.gatherhq.org (until DNS is set: https://gatherhq-staging.netlify.app) |
| Netlify site | `gatherhq-app` | `gatherhq-staging` |
| Git branch | `main` | `staging` |
| Firebase project | `gather-hq-main` | `gather-hq-staging` (separate database and sign-in) |
| Stripe | Live mode (`sk_live_…`) | Test mode (`sk_test_…`) only |
| Email | Sends to everyone | Only to `STAGING_EMAIL_ALLOWLIST` |
| Scheduler (journeys, Monday brief, trial reminders) | Runs | Runs, but emails only reach the allowlist |
| `APP_ENV` | not set (= production) | `staging` |

## Built-in safeguards (server/env.js, tests/env.test.js)

- A staging site configured with the production Firebase project refuses every request (503).
- A live Stripe key on staging is ignored: billing switches off instead of charging anyone.
- On staging, emails to addresses not on the allowlist are skipped and never reach Resend.
- The production API refuses `*.netlify.app` preview and branch addresses, because Netlify gives those the production secrets.
- Staging falls back to nothing (not production) if its Firebase web settings are missing.
- The test suite runs before every Netlify build, with all real secrets removed. A failing test stops the deploy.
- `GET /api/health` on each site reports `env`, `commit`, `firebaseProject` and `billing` (`live`/`test`/`off`).

## 1. Developing a change

```bash
git checkout staging && git pull
git checkout -b feature/short-name
# …work, commit…
npm test && npm run build:web
```

## 2. Deploying to staging

Merge the feature branch into `staging` and push. The `gatherhq-staging` site deploys it automatically.

```bash
git checkout staging && git merge --no-ff feature/short-name && git push origin staging
```

GitHub Actions runs the tests on every push to `staging` and `main` (`.github/workflows/ci.yml`).

## 3. Accessing staging

Open https://staging.gatherhq.org. A gold **Staging** bar shows on every page with the build's commit.
Sign up test churches with addresses on the allowlist, for example `you+church1@gmail.com`.
Name test churches clearly ("Staging – Grace Test Church").

## 4. Testing before approval

Check on staging, desktop and phone:

- [ ] Netlify build and tests passed (Deploys tab of `gatherhq-staging`)
- [ ] `/api/health` shows `env: staging`, `firebaseProject: gather-hq-staging`, `billing: test`
- [ ] Sign up, sign in, sign out, password reset
- [ ] Two test churches cannot see each other's people or children
- [ ] Create a session, check in by QR (new and returning), close the session
- [ ] People: add, import a spreadsheet, edit, follow-ups
- [ ] Children's check-in and pickup with the matching code
- [ ] Reports load; exports download
- [ ] Billing: checkout with test card `4242 4242 4242 4242`, then the billing portal
- [ ] Main pages on a phone

## 5. Approving a release

Tell the developer (or Claude) "approved: staging at commit `abc1234`". Nothing reaches production without this.

## 6. Promoting to production

Production gets exactly the tested commit. A fast-forward merge means no new code is added on the way:

```bash
git fetch origin
git checkout main && git pull
git merge --ff-only origin/staging      # fails if main has anything staging doesn't
git push origin main                     # gatherhq-app deploys main
```

Then verify production:

- [ ] Netlify deploy of `gatherhq-app` is "Published" with the approved commit
- [ ] `https://gatherhq.org/api/health` shows `env: production`, the approved `commit`, `billing: live`
- [ ] Home page loads; sign in works; open a church overview
- [ ] One check-in on a test session; no errors in Netlify function logs

## 7. Rolling back

1. **Fastest:** Netlify → `gatherhq-app` → Deploys → choose the previous published deploy → **Publish deploy**. This takes seconds and touches no code. Netlify then stops auto-publishing until you unlock it.
2. **Then fix Git:** `git revert <bad commit>` on `staging`, test it there, and promote it as normal. Unlock auto-publishing afterwards.

**Data is not rolled back.** Firestore has no schema migrations. A release that writes new fields or reshapes documents keeps those writes after a code rollback. Releases that change stored data must therefore:

- read both the old and the new shape;
- say in the release notes what they write;
- only remove old-shape support in a later release.

## 8. Environment variables

Set in Netlify → site → Site configuration → Environment variables. **Never commit secrets.** Staging never reuses a production secret.

| Variable | Production (`gatherhq-app`) | Staging (`gatherhq-staging`) | Secret |
| --- | --- | --- | --- |
| `APP_ENV` | not set | `staging` | no |
| `VITE_APP_ENV` | not set | `staging` | no |
| `FIREBASE_SERVICE_ACCOUNT` | `gather-hq-main` key | `gather-hq-staging` key | yes |
| `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_APP_ID` | optional (built-in defaults) | staging project's web settings | no |
| `STRIPE_SECRET_KEY` | `sk_live_…` | `sk_test_…` | yes |
| `STRIPE_WEBHOOK_SECRET` | live endpoint's `whsec_…` | test endpoint's `whsec_…` | yes |
| `RESEND_API_KEY` | production key | separate staging key | yes |
| `EMAIL_FROM_DOMAIN` | `mail.gatherhq.org` | `mail.gatherhq.org` | no |
| `STAGING_EMAIL_ALLOWLIST` | not set | addresses or `@domain`s, comma-separated | no |
| `PLATFORM_ADMIN_EMAILS` | team emails | team emails | yes |
| `EMAIL_SIGNING_SECRET` | optional | different value if set | yes |
| `SMS_PROVIDER`, `WHATSAPP_PROVIDER` | not used yet | not used yet; sandbox only | — |

A missing or wrong variable shows a plain error. Examples: "not connected to Firebase yet", "configured with the production Firebase project", or billing simply shows as unavailable.

## 9. Database changes

- Firestore rules (`firestore.rules`) and indexes (`firestore.indexes.json`) are version-controlled. `scripts/firebase-setup.mjs` applies them to **whichever project that site's `FIREBASE_SERVICE_ACCOUNT` belongs to** on each build. Staging builds therefore only change the staging project, and production gets them when the release is promoted.
- New indexes can take minutes to build. Promote releases with new indexes outside service times.
- Staging data is disposable. To reset it, delete the test churches, or delete and recreate the Firestore database in the `gather-hq-staging` Firebase console; the next deploy re-applies rules and indexes.
- Never copy production data into staging. Use synthetic test churches only.

## 10. Testing Stripe without charging anyone

Staging uses Stripe **test mode**. Products and prices are created automatically by lookup key the first time checkout runs.

| Scenario | How |
| --- | --- |
| Successful subscription | Card `4242 4242 4242 4242`, any future date, any CVC |
| Card declined at checkout | `4000 0000 0000 0002` |
| Payment fails later (renewal) | Subscribe with `4000 0000 0000 0341` (attaches, then fails on charge), or advance a Stripe **test clock** |
| Cancellation | Billing portal → Cancel; the plan runs to period end, then the church is read-only |
| Renewal | Stripe dashboard (test mode) → Billing → Test clocks → advance one month |
| Webhook delivery | Stripe (test mode) → Developers → Webhooks → endpoint `https://staging.gatherhq.org/api/webhooks/stripe` → send test events |

The live Stripe account, its products, prices and webhook are never touched by staging.
