Backlog metadata — Priority: P1 · Size: M · Product area: Internal operations · Target release: v1.0-internal · Parent capability: {{ISSUE:cap-operations}} [Capability] Internal operations and failure recovery

## Outcome

Authorised admins can inspect active API/schema/prompt/model/analytics versions and edit only allowlisted safe runtime limits/schedules/retention settings with validation, audit and no secret exposure.

## Context

This issue delivers one implementation outcome within [Capability] Internal operations and failure recovery and follows the versioned product/technical contracts.

Relevant documentation:

* `docs/design/screen-map.md`
* `docs/technical/deployment-and-operations.md`
* `docs/technical/security-and-privacy.md`

## Scope

* Build typed allowlisted SystemSetting read/change service and /settings groups.
* Show current/previous active analysis/strategy schema/prompt/model, Graph API and analytics versions plus effective time.
* Allow configured concurrency, upload limits, sync cadence/tolerances, budgets and approved retention values where safe.
* Require confirmation/reason for critical changes and show downstream stale/reanalysis/recalculation implications.

## Acceptance criteria

- [ ] Unknown/unallowlisted keys, secret values and unsafe ranges cannot be read or written through UI/API.
- [ ] Settings changes are versioned, actor/reason audited and take effect atomically.
- [ ] Secret fields display status/fingerprint only and cannot be returned by generic settings query.
- [ ] Changing analytics/schema-related config marks affected data stale/dirty but does not auto bulk reanalyse.
- [ ] Non-admin/crafted scope actions fail server-side.
- [ ] Loading/empty/conflict/error and 390px/keyboard/axe states pass.
- [ ] Schema/range/optimistic concurrency/authorisation tests pass.

## Out of scope

Secret editor, arbitrary feature flags, source code prompt editor and complex roles.

## UI and content notes

Group by Integration, Analysis, Analytics, Storage/retention and Cost. Show consequences before Save; success states name effective version/time.

## Implementation notes

Secrets remain deployment secret-manager entries. Prompt/schema content may be read-only metadata/artifact link, not edited ad hoc.

## Data and permissions

Settings belong to workspace/global environment; audit changes. Never include token, API key or raw prompt response.

## Test notes

* Allowlist/type/range/version conflict unit/integration tests.
* Admin/non-admin/secret-absence tests.
* Settings consequence/mobile/accessibility UI tests.

## Dependencies

Blocked by:

* {{ISSUE:access-shell}} Build the responsive accessible internal application shell
* {{ISSUE:analysis-contract}} Define and evaluate the v1 analysis schema, taxonomy and prompt
* {{ISSUE:analytics-recalculation}} Publish versioned account analytics through a debounced recalculation job
* {{ISSUE:strategy-contract}} Define the structured strategy and recommendation prompt contract

Blocks:

* None
