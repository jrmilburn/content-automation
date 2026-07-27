Backlog metadata — Priority: P0 · Size: M · Product area: Security and privacy · Target release: v1.0-internal · Parent capability: {{ISSUE:cap-security}} [Capability] Security, privacy and data lifecycle

## Outcome

The build and runtime use locked, reviewed and scanned dependencies/actions/images/media tooling with an SBOM and a practical patch/escalation path.

## Context

This issue delivers one implementation outcome within [Capability] Security, privacy and data lifecycle and follows the versioned product/technical contracts.

Relevant documentation:

* `docs/technical/security-and-privacy.md`
* `docs/technical/deployment-and-operations.md`

## Scope

* Enable dependency review/update automation, CodeQL/SAST, secret scan and licence/direct-dependency review.
* Pin third-party GitHub Actions by commit and production base image/tooling by immutable version/digest.
* Build minimal non-root container, generate SBOM/provenance and scan OS/image packages.
* Document ffmpeg/media-parser update cadence and emergency response.

## Acceptance criteria

- [ ] CI install is lockfile-immutable and fails on unapproved critical/high dependency/image findings.
- [ ] Third-party actions have commit pins and least-privilege token permissions.
- [ ] Runtime container is non-root/minimal and identifies exact Node/media tool versions.
- [ ] SBOM and signed/provenance artifact attach to release without secrets.
- [ ] Untrusted PR code cannot access production environments/secrets.
- [ ] Direct dependencies have documented necessity/maintenance/licence review.
- [ ] Patch/exception process names owner, expiry and evidence.

## Out of scope

Enterprise software-composition platform and formal certification.

## UI and content notes

There is no dedicated screen. Any surfaced state or error uses the canonical terminology and safe redacted detail defined by the parent capability.

## Implementation notes

Prefer fewer direct dependencies. Scan results are triaged, not blindly ignored; accepted risk needs expiry.

## Data and permissions

Artifacts/scans contain package metadata only, not application content or secrets.

## Test notes

* CI failure test with known policy fixture where practical.
* Container user/health/tool version and action-permission review.
* SBOM generation/release smoke.

## Dependencies

Blocked by:

* {{ISSUE:foundation-ci}} Establish CI and automated test quality gates
* {{ISSUE:foundation-scaffold}} Scaffold the TypeScript web and worker workspace

Blocks:

* {{ISSUE:security-review}} Complete pre-launch security and privacy review
* {{ISSUE:deployment-pipeline}} Provision staging/production and implement the safe deployment pipeline
