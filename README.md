# GatherHQ

Multi-branch church operations: QR attendance, visitor follow-up, events with tickets, reports, and team permissions.
*A better way to bring church life together.* (The name is provisional — change it in `src/brand.js`, `index.html` and `public/manifest.webmanifest`.)

## Stack
- **Front end:** React 18, Vite, Tailwind (tokens in `tailwind.config.js`, see `BRAND.md`)
- **API:** one Netlify Function (`netlify/functions/api.mjs` → `server/`), path `/api/*`
- **Data:** Cloud Firestore via `firebase-admin` (server only). **Auth:** Firebase Auth (email/password, password-reset emails).
- **Rules & indexes:** `firestore.rules` (deny all client access) and `firestore.indexes.json`, published automatically before each Netlify build by `scripts/firebase-setup.mjs`.

## Security model
- Browsers never talk to Firestore. Every read and write goes through the API, which resolves the user's organisation, branch scope and role from an HttpOnly Firebase session cookie.
- All church data lives under `orgs/{orgId}/…`; the API only ever touches the signed-in user's org. Branch scope is enforced on every list, read and write (out-of-scope rows return 404).
- Capabilities per role live in `server/access.js`. Exports need the `export` capability and are audit-logged.
- Phone numbers, event registrations and automatic follow-ups are de-duplicated with key documents claimed inside Firestore transactions.
- Public check-in returns only a masked name hint; a returning person must confirm their first name. Rate-limited per IP and per phone.
- Mutations must be JSON (CSRF protection). Platform admin (`/platform`) requires `users.is_platform_admin` or an email in `PLATFORM_ADMIN_EMAILS` — never church ownership.

## Firestore layout
`users/{uid}`, `memberships/{orgId}_{uid}`, `invites/{id}`, `publicLinks/{token}`, `orgSlugs/{slug}`, `rateLimits/{key}`,
`orgs/{orgId}` with subcollections `branches`, `people`, `phones`, `units`, `templates`, `gatherings`, `checkins`, `events`,
`registrations`, `regKeys`, `followups` (+ `notes`), `followupKeys`, `messages`, `audit`.

## Environment variables (Netlify)
| Name | Purpose |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | **Secret.** Whole service-account JSON (Firebase console → Project settings → Service accounts) |
| `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_APP_ID` | Firebase web app settings (public) |
| `PLATFORM_ADMIN_EMAILS` | Comma-separated emails allowed into `/platform` |
| `AWS_LAMBDA_JS_RUNTIME` | `nodejs22.x` — firebase-admin needs Node 22 in functions |
| `SMS_PROVIDER`, `EMAIL_PROVIDER`, `WHATSAPP_PROVIDER` | Reserved — messaging stays draft-only until a provider is integrated |

## Develop
```bash
npm install
npm test                                     # 22 integration tests (in-memory Firestore that enforces index rules)
npm run build:web && node scripts/local-server.mjs --seed   # http://localhost:8888 with demo data
```
Demo logins: `ada@grace.local` / `password123` (owner), `usher@grace.local` / `password123` (usher).

## Not built yet (deliberately)
Billing and plan limits, email/SMS/WhatsApp delivery, volunteer rotas, AI summaries. See the product brief for the staged plan.
