# Repository assessment

Assessment date: 2026-07-28

## Findings

At initial assessment, the local checkout and `jrmilburn/content-automation` remote were a greenfield repository:

- local `main` had no commits; a one-time empty bootstrap commit was subsequently created so documentation could be delivered through a pull request;
- working tree initially contained only `.git`;
- remote default branch is `main`; the repository was public during initial assessment and was made private before backlog publication; the connected GitHub identity has admin/push permission;
- no application/package configuration, framework, database, authentication, documentation, issue templates, labels taxonomy, milestones, issues, CI/CD, deployment, testing setup, conventions or partial product functionality existed;
- no `AGENTS.md` or repository-specific instructions existed.

## Consequences

- There is no existing work to preserve or duplicate.
- The planning documents establish the first product/technical conventions.
- The architecture adopts the brief’s practical TypeScript direction and explicitly minimises services for internal v1.
- GitHub backlog metadata is kept in issue bodies because there is no repository label/milestone convention to extend. Default GitHub labels may be reused where useful; a new taxonomy/milestone is not assumed merely for planning.

## Contradictions and resolutions

No material contradiction exists between repository code and the brief because there is no code.

One material delivery constraint exists: the local GitHub CLI has invalid cached credentials. The installed GitHub connector has repository write access and was therefore used to create/update issues #1–#76 after the repository became private. Its available operations do not expose milestone or label creation, so target release, priority, size, area and parent remain authoritative first-line issue metadata unless repository maintainers later create a taxonomy/milestone.

## Architecture assumptions introduced

- TypeScript monorepo; Next.js web plus separate Node worker.
- PostgreSQL/Prisma and PostgreSQL-backed queue to avoid Redis in v1.
- Private S3-compatible object storage.
- Google Workspace OIDC and explicit internal allowlist.
- Official Instagram API only; no scraping.
- Paid Gemini Developer API, one source video per analysis request.
- One Studio Parallel workspace in v1, with workspace ownership fields retained.

These are planning decisions, not implemented application code.
