# Studio Parallel content intelligence

Internal tooling for analysing Studio Parallel Instagram video content alongside its observed performance and producing evidence-linked content strategy.

The v1 product and engineering baseline is indexed in [`docs/README.md`](docs/README.md). Contributions must follow [`CONTRIBUTING.md`](CONTRIBUTING.md): one issue, one dedicated branch and one pull request.

## Prerequisites

- Node.js 24.18.x (see `.node-version` and `.nvmrc`)
- npm 11.x

No database or provider credentials are required for this scaffold. Local, test and preview environments use `PROVIDER_MODE=fake`.

## Install

```powershell
Copy-Item .env.example .env
npm ci
```

Use `npm ci` on clean checkouts and in CI so installation is reproduced from `package-lock.json`.

## Development

```powershell
npm run dev
```

This builds the shared packages, then runs:

- Next.js web: <http://localhost:3000>
- Web liveness/readiness: <http://localhost:3000/health/live> and
  <http://localhost:3000/health/ready>
- Worker liveness/readiness: <http://localhost:3001/health/live> and
  <http://localhost:3001/health/ready>

The original `/api/health` and worker `/health` paths remain liveness aliases. Health responses
contain fixed status labels only; deployment configuration and secrets are never returned.

Run either process independently with `npm run dev:web` or `npm run dev:worker`.

## Validation and builds

```powershell
npm run check
npm run build
```

`check` runs formatting verification, ESLint, strict TypeScript and unit tests. `build` compiles shared packages, the worker and the separately deployable Next.js web application in dependency order.

After a production build, run the processes separately:

```powershell
npm run start:web
npm run start:worker
```

## Configuration

Configuration is parsed by `@studio-parallel/config`. Errors identify invalid field names and constraints but never echo values. Production-like environments require an HTTPS non-localhost `PUBLIC_ORIGIN`; local, test and preview environments reject `PROVIDER_MODE=live`.

`APP_RELEASE` is the safe immutable release identifier included in structured diagnostics. It
defaults to `development` locally and should be set to the deployed commit or image identifier in
staging and production.

Database and provider credentials must remain in the deployment secret manager. Do not add real secrets to examples, fixtures, browser code or logs.

### Google Workspace authentication

The web app uses the pinned Auth.js v5 Google OIDC provider. Register
`${PUBLIC_ORIGIN}/api/auth/callback/google` as the exact authorised redirect URI and supply
`AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `AUTH_SECRET` and `GOOGLE_WORKSPACE_DOMAIN` from the
environment. Staging and production reject placeholder credentials, non-HTTPS origins and origins
containing paths or credentials.

Access is allowlist-first: an active `InternalUser` with the normalised Google Workspace email must
already exist in an active workspace. Its nullable `oidcSubject` binds to Google's stable `sub` on
the first approved sign-in; a changed subject is denied. The application does not persist or place
Google access tokens, ID tokens, email addresses or display names in the session cookie.

Sessions use encrypted JWT cookies with `Secure` outside local/test, `HttpOnly`, `SameSite=Lax` and
an eight-hour default absolute lifetime. Auth.js re-encrypts a valid cookie when a session is
resolved, while the original session start remains hard-bounded. Every session resolution checks
the current user, workspace and `sessionVersion`; disabling a user increments that version and
immediately invalidates older cookies. Rotating `AUTH_SECRET` invalidates every outstanding session.
Server code must enter protected work through `requireAuthenticatedActor` and fetch entity data
through a workspace-scoped repository or `requireWorkspaceResource`.

## Observability

`@studio-parallel/observability` provides correlation propagation, allowlisted JSON logging,
safe operational errors, an environment/release-aware error-monitoring adapter and basic metric
hooks. Web request, domain command and worker event contexts retain the same validated
`x-correlation-id`. See [`packages/observability/README.md`](packages/observability/README.md) for
the safe-field contract and examples.

## Database development

The PostgreSQL/Prisma foundation is documented in [`packages/db/README.md`](packages/db/README.md). To create an isolated PostgreSQL container, apply the committed migrations, seed the single non-PII development workspace, verify drift and run the real-database tests:

```powershell
npm run test:db:integration
```

The script owns its dedicated Docker Compose project and removes its test volume when finished. It never uses `DATABASE_URL` from another environment.

## Quality gates

GitHub-hosted Actions are temporarily disabled to avoid runner spend during early internal development. Before opening or merging a pull request, install from the lockfile and run the complete local gate:

```powershell
npm ci
npm run test:e2e:install
npm run validate:local
```

`validate:local` covers formatting, linting, strict type checks, unit/component tests, dependency and secret checks, a disposable real-PostgreSQL migration/integration suite, the production build, and desktop/mobile Playwright accessibility smoke tests. Record the commands and results in the pull request. Tests run in deterministic fake mode and require no production provider credentials or content.

Hosted CI must be restored before internal launch or before branch protection relies on required remote checks.
