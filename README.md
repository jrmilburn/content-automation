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
- Web health: <http://localhost:3000/api/health>
- Worker health: <http://localhost:3001/health>

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

Provider credentials, authentication, database configuration and deployment wiring belong to their dedicated backlog issues. Do not add real secrets to examples, fixtures, browser code or logs.

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
