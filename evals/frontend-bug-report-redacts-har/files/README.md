# acme-web

Customer web app (Next.js 14, App Router).

- Staging: https://app.staging.acme.dev (API: https://api.staging.acme.dev, set via `NEXT_PUBLIC_API_URL` in `.env.staging`)
- Local against staging: `npm run dev:staging`
- E2E: Playwright, `npx playwright test` (specs in `tests/`)
- Auth: access token in `localStorage["acme.auth"]`, session cookie `acme_session`
- Every API call sends `X-Request-Id` (see `src/lib/api.ts`)
- The logged-in user comes from `GET /v2/me`
