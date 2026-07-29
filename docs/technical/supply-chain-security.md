# Supply-chain security

This document is the operating detail behind the "Dependency and supply-chain security" section of `security-and-privacy.md`. It covers what is enforced, where it runs, who owns an accepted risk and how a media-parser emergency is handled.

## Principles

- Prefer fewer direct dependencies. Every direct dependency is a standing obligation, not a one-time decision.
- Pin everything that can move: dependency versions, GitHub Actions, container base images.
- Scan results are triaged, never blindly ignored. Accepted risk is owned, evidenced and expires.
- Untrusted pull-request code never receives a deployment or provider secret.
- A control that only exists in a document is not a control. Each policy below has an executable check.

## Enforcement points

| Control | Check | Where |
| --- | --- | --- |
| Lockfile-immutable install | `npm ci` | Every CI job and every container stage |
| Known-vulnerable dependencies | `npm run security:dependencies` (`npm audit --audit-level=high`) | `supply-chain.yml` policy job |
| Newly introduced dependencies and licences | `actions/dependency-review-action`, `fail-on-severity: high` | `supply-chain.yml`, pull requests only |
| Static analysis | CodeQL `security-and-quality` for JavaScript/TypeScript | `supply-chain.yml` |
| Committed secrets | `npm run security:secrets` | `supply-chain.yml` policy job |
| Action pins, workflow permissions, secret exposure | `npm run security:workflows` | `supply-chain.yml` policy job |
| Direct dependency necessity, licence and maintenance | `npm run security:direct-dependencies` | `supply-chain.yml` policy job |
| Accepted-risk owner, evidence and expiry | `npm run security:exceptions` | `supply-chain.yml` policy job |
| Image vulnerabilities | Trivy, fails on fixable `CRITICAL`/`HIGH` | `supply-chain.yml` container job |
| Container hardening | `scripts/container/verify-image.sh` | `supply-chain.yml` container job |
| SBOM | `npm run security:sbom` (CycloneDX) | `supply-chain.yml` and `release.yml` |
| Signed provenance and SBOM attestation | `actions/attest-build-provenance`, `actions/attest-sbom` | `release.yml` |

`npm run security:supply-chain` runs the repository-local subset and is part of `npm run validate:local`.

## GitHub Actions

- Every `uses:` reference is pinned to a full 40-character commit SHA with a trailing `# <version>` comment recording which release the pin represents. Tags and branches are mutable and are rejected by `security:workflows`.
- Every workflow declares a top-level `permissions:` block. The default is `contents: read`; a job raises its own permissions only for what it needs.
- `pull_request_target` is not permitted. It runs with a trusted context against untrusted code.
- A workflow triggered by `pull_request` may reference `secrets.GITHUB_TOKEN` and nothing else. Any other `secrets.*` reference fails the policy check, which is the enforcement behind "untrusted pull-request code cannot access production environments or secrets".
- Checkout never persists credentials.
- Dependabot maintains the pins. It rewrites the SHA and the version comment together, so an update stays legible.

Protected deployment environments with required reviewers belong to the deployment pipeline (issue #73). Until then, no workflow holds a deployment secret at all.

## Container images

Two runtime targets are built from one `Dockerfile`:

| Target | Contents | Media tooling |
| --- | --- | --- |
| `web` | Next.js standalone output only | None |
| `worker` | Production dependencies, compiled workspace output | `ffmpeg`/`ffprobe` |

Policy:

- The base image is pinned by immutable digest, not by tag. The tag is retained in the `ARG` for readability; the digest is what is resolved.
- Both images run as the unprivileged `node` user (uid 1000). `verify-image.sh` fails the build if a configured user is absent, is root, or if the running uid is 0.
- Neither image contains a build toolchain, development dependencies or the Prisma CLI.
- Neither image contains npm. A runtime container never installs a package, so the bundled package manager is pure attack surface, and its own vendored dependency tree was the only source of fixable critical/high findings in the first scanned build. Removing it is why the image scan gate passes on its merits rather than through a suppression.
- Each image writes `/app/build-info.json` recording the exact Node.js, OpenSSL and, for the worker, `ffmpeg`/`ffprobe` versions it shipped with. A scan finding can therefore be matched to a running container without guessing.
- `verify-image.sh` asserts the recorded Node.js version equals `.node-version`, so an image can never silently drift from the pinned toolchain.
- Both images declare a `HEALTHCHECK` against their liveness endpoint.

The media parser lives only in the worker image. The web image never decodes media, so it carries neither that attack surface nor its patch obligations. This is a deliberate size and risk trade-off: the worker image is substantially larger because `ffmpeg` pulls in a wide codec dependency set.

## Media tooling patch cadence and emergency response

`ffmpeg` and any future media parser are the highest-risk components in the system: they parse attacker-influenced bytes.

Routine cadence:

- Dependabot proposes base image digest updates weekly. Debian security updates for `ffmpeg` arrive through the base image rebuild, so accepting the digest bump is the normal patch path.
- The container job scans every pull request, so a newly published advisory against the pinned digest surfaces without waiting for a code change. The weekly scheduled run catches advisories against unchanged code.
- Record the shipped version from `/app/build-info.json` when investigating.

Emergency response for a critical media-parser advisory:

1. Confirm exposure: does the shipped `ffmpeg` version fall in the affected range, and does the affected code path involve a container/codec the validation policy accepts?
2. Stop the intake path first. Media validation is a background job, so pausing the validation queue and blocking new upload intents contains exposure without a deploy.
3. Rebuild the worker image on a patched base digest and verify the new version in `/app/build-info.json`.
4. If no patched base image is available, remove the affected codec or container from the accepted list in the validation policy rather than continuing to decode it.
5. Re-validate assets that were accepted during the exposure window if the advisory allows for a persisted malicious object.
6. Record the incident, the decision and the verification in the operations runbook (issue #64), and open an exception only if a residual risk remains.

Emergency changes still go through a pull request. The exception is that a media-parser fix may merge ahead of unrelated queued work.

## Direct dependency review

`security/direct-dependencies.json` records every external direct dependency across all workspace manifests with its necessity, maintenance assessment, licence, reviewer and review date. `npm run security:direct-dependencies` enforces:

- every declared direct dependency has a review entry, and every entry still corresponds to a declared dependency;
- versions are exact, never ranges;
- the recorded scope matches how the package is actually declared — a package is production scope if any manifest ships it at runtime;
- the licence is in the allowlist for that scope, or an active exception covers it;
- the recorded licence matches the licence of the installed package, so the register cannot drift from reality;
- a production dependency is not on a prerelease version without an active exception.

Licence allowlists differ by scope. Weak copyleft such as MPL-2.0 is acceptable for development tooling that never ships in a runtime image, and is not acceptable for production scope.

Review age past the cadence in `reviewIntervalDays` produces a warning rather than a failure. A date-triggered hard failure with no code change would push people to disable the gate; the accepted-risk expiry below is where the hard stop belongs.

## Accepted risk

`security/exceptions.json` is the register of accepted risk. `npm run security:exceptions` requires each entry to carry:

- a unique `id` and a declared `category`;
- the `subject` the exception applies to;
- a `reason` explaining why the risk is accepted rather than remediated;
- an `owner` accountable for it;
- `evidence` a reviewer can follow;
- `approvedOn` and `expiresOn`, where the granted window may not exceed `maximumExceptionDays`;
- a `reviewAction` naming what must happen before expiry.

An expired exception is a build failure, not a warning. That is the mechanism that stops accepted risk from quietly becoming permanent. Re-approval is a deliberate act with a fresh date and fresh evidence.

## Known limitations

Recorded honestly rather than presented as complete coverage:

- Trivy gates on fixable `CRITICAL`/`HIGH` findings. Unfixable findings are captured in an uploaded JSON report rather than blocking the build, because a Debian base image always carries some. Review the report; do not assume an empty gate means an empty report.
- `ffmpeg` is installed from the Debian archive rather than pinned to an exact package version. Exact apt pinning breaks builds when the archive rotates. The base image digest is the reproducibility anchor, and `build-info.json` records what actually shipped.
- The workflow policy checker parses YAML line by line rather than with a YAML parser. This deliberately avoids adding a direct dependency to a repository whose policy is to minimise them; it is sufficient for files this repository controls and would need replacing before it could be trusted against arbitrary input.
- The PostgreSQL service container in `ci.yml` is pinned by tag rather than digest. It is a disposable test fixture that never reaches production and holds no application data, so the maintenance cost of digest-pinning it outweighs the benefit. The production base image is digest-pinned; this one deliberately is not.
- Release provenance and SBOM attestation are exercised only when a release is published. They are syntax- and policy-checked on every pull request but not executed until the first release, which belongs to the deployment pipeline issue.
- Branch protection requiring these checks is a repository setting, not a file in this repository. It must be enabled separately.
