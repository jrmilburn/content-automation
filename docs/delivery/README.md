# GitHub backlog import package

This package contains 76 import-ready issue bodies:

- 1 root project issue;
- 14 capability issues;
- 61 implementation/testing/launch issues.

## Import status

The repository was made private and the backlog was published on 28 July 2026. GitHub issues #1–#76 now contain the root project, 14 capabilities and 61 implementation/testing/launch issues. Every placeholder was replaced with its actual GitHub issue number.

## Contents

- `backlog-overview.md`: human-readable counts, capability links and delivery order.
- `manifest.json`: creation order, title, priority, size, product area, target release, existing labels, parent, dependencies, blocks and body path.
- `issues/*.md`: complete issue bodies in required format.
- `../../scripts/import-github-backlog.ps1`: dependency-ordered importer and second-pass reference resolver.
- `backlog-import-results.json`: published issue numbers, titles, URLs, labels and milestone state.

The source issue files retain `{{ISSUE:slug}}` and `{{TITLE:slug}}` tokens so the package remains reproducible. The published GitHub bodies contain resolved issue numbers and titles.

## Labels and milestone

The repository had no established taxonomy or milestone convention. The manifest reuses only GitHub's default `enhancement` label if it exists. Priority, size, product area and `v1.0-internal` are authoritative first-line body metadata. No milestone is created automatically.

## Re-import safety

The backlog is already imported. Do not run the importer again against this repository unless the existing issues are intentionally being replaced, because it creates new issues:

```powershell
./scripts/import-github-backlog.ps1 -Repository jrmilburn/content-automation
```

The script refuses to continue on unresolved references or a failed GitHub command and writes `docs/delivery/backlog-import-results.json` only after all bodies are backfilled.
