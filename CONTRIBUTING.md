# Contributing

Studio Parallel delivers this repository through small, traceable GitHub issues and pull requests. The issue backlog is the source of truth for scope, dependencies, acceptance criteria and release intent.

## Required delivery unit

Every change must follow this lifecycle:

1. Select one open GitHub issue.
2. Create one dedicated branch from the latest `main`.
3. Implement only that issue's coherent outcome.
4. Open one pull request whose primary issue is that issue.
5. Merge only after the issue's acceptance criteria and required local checks are satisfied.

A branch or pull request must not implement multiple backlog issues. If work reveals another independently valuable outcome, create or use a separate issue and deliver it through a separate branch and pull request. Review fixes for the same outcome remain on the existing branch and pull request.

The repository's one-time empty bootstrap commit is the only initialization exception. Product, documentation, configuration and implementation changes must use the issue workflow.

## Branch naming

Use:

```text
<owner>/issue-<number>-<short-description>
```

Examples:

```text
agent/issue-16-planning-baseline
feature/issue-42-analysis-handler
```

The issue number is mandatory. Keep the description short, lowercase and hyphenated. Always branch from an up-to-date `main`; do not reuse a merged branch.

## Pull requests

- Open the pull request as a draft while work or validation remains.
- Use a concise outcome-oriented title, preferably `[#<issue>] <outcome>`.
- Identify the single primary issue in the description. Use `Closes #<issue>` when merging will satisfy every acceptance criterion; a draft may use `Tracks #<issue>` until required decisions or approvals are recorded.
- Describe the outcome, material decisions, user/developer impact and validation performed.
- Follow `.github/pull_request_template.md`.
- Keep unrelated formatting, refactors and dependency updates out of the diff.
- Call out security, privacy, data migration, AI-contract or operational implications.
- Add screenshots for user-facing changes and structured evidence for integration/background-job work.
- Do not merge a dependent issue before its blocking issues unless the dependency is explicitly revised.

Capability and project issues are tracking containers. Their child implementation issues should normally receive the code pull requests. A pull request may close a capability only when the capability itself defines a standalone documentation or coordination outcome.

## Commits and validation

- Stage intended paths explicitly; do not sweep unrelated working-tree changes into a commit.
- Use terse, outcome-oriented commit messages.
- Run the checks required by the linked issue, including relevant automated, negative-authorisation, retry/idempotency, accessibility or contract tests.
- Update affected documentation in the same pull request when it is necessary to keep that issue's behaviour and contracts accurate.
- Never commit credentials, access tokens, private source videos, transcripts, provider payloads or unredacted production logs.

### Quality gate

Hosted CI enforces the gates remotely, and local validation is still expected before you open a pull request. Run:

```text
npm ci
npm run test:e2e:install  # once per pinned Playwright browser version
npm run validate:local
```

`validate:local` runs the repository quality checks, dependency audit, redacting secret scan, supply-chain policy checks, disposable PostgreSQL suite, disposable MinIO storage suite, media validation suite, production build and desktop/mobile Playwright accessibility smoke. Documentation-only changes may mark database/browser checks not applicable when the pull request explains why; formatting, secret scanning and directly affected checks still run.

The media validation suite needs `ffmpeg` and `ffprobe` on `PATH`. They ship in the worker image; install them locally with `brew install ffmpeg` on macOS or `apt-get install ffmpeg` on Debian and Ubuntu. The runner names the missing tool rather than failing inside a test body.

Copy the executed commands and concise results into the pull request's Validation evidence section. Do not merge on an unverified verbal assertion.

### Supply-chain rules

- Pin every GitHub Action to a full commit SHA with a trailing `# <version>` comment. Declare least-privilege `permissions` on every workflow.
- Never give a pull-request-triggered workflow anything beyond `secrets.GITHUB_TOKEN`.
- Adding a direct dependency also means adding its necessity, maintenance and licence review to `security/direct-dependencies.json`. Prefer not adding one.
- Accepted risk goes in `security/exceptions.json` with an owner, evidence and an expiry. Expired exceptions fail the build.

`docs/technical/supply-chain-security.md` explains each rule and the media-tool emergency process.

## Completion

A pull request is ready for review when its linked issue is independently satisfied, dependencies are accurate, required checks pass, documentation is current, and any accepted limitations or manual verification steps are recorded. Merging the pull request closes its single primary issue.
