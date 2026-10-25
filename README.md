# Gatherwell

Multi-branch church operations: QR attendance, visitor follow-up, events with tickets, reports, and team permissions.
*A better way to bring church life together.* (The name is provisional — change it in `src/brand.js`, `index.html` and `public/manifest.webmanifest`.)

## Stack
- **Front end:** React 18, Vite, Tailwind (tokens in `tailwind.config.js`, see `BRAND.md`)
- **API:** one Netlify Function (`netlify/functions/api.mjs` → `server/`), path `/api/*`
- **Database:** Postgres via Netlify Database (`@netlify/database`). Migrations in `netlify/database/migrations/` apply automatically on deploy.
  Set `DATABASE_URL` to use any other Postgres (e.g. a free Neon database) instead.

## Security model
- Every tenant table carries `org_id`; every query filters on the signed-in user's organisation, resolved server-side from an HttpOnly session cookie.
- Branch scope (`memberships.branch_ids`) is enforced on every list, read and write. Rows outside scope return 404.
- Capabilities per role live in `server/access.js`. Exports need the `export` capability and are written to the audit log.
- Public check-in returns only a masked name hint; a returning person must confirm their first name. Rate-limited per IP and per phone.
- Mutations must be JSON (CSRF protection); passwords are scrypt-hashed; sessions are revocable.
- Platform admin (`/platform`) requires `users.is_platform_admin` or an email in `PLATFORM_ADMIN_EMAILS` — never church ownership.

## Environment variables
| Name | Purpose |
|---|---|
| `PLATFORM_ADMIN_EMAILS` | Comma-separated emails allowed into `/platform` |
| `DATABASE_URL` | Optional — overrides Netlify Database with another Postgres |
| `SMS_PROVIDER`, `EMAIL_PROVIDER`, `WHATSAPP_PROVIDER` | Reserved — messaging stays draft-only until a provider is integrated |

## Develop
```bash
npm install
npm test                                   # 20 integration tests on a local Postgres
npm run build && node scripts/local-server.mjs --seed   # http://localhost:8888, demo data
```
Demo logins: `ada@grace.local` / `password123` (owner), `usher@grace.local` / `password123` (usher).

## Not built yet (deliberately)
Billing and plan limits, email/SMS/WhatsApp delivery, password-reset email, volunteer rotas, AI summaries. See the product brief for the staged plan.
