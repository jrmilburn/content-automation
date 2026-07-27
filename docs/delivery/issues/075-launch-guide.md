Backlog metadata — Priority: P0 · Size: M · Product area: Launch readiness · Target release: v1.0-internal · Parent capability: {{ISSUE:cap-launch}} [Capability] Testing, deployment and launch readiness

## Outcome

Studio Parallel can operate v1 safely after a documented go/no-go review with no open P0/release blocker, named owners, known limitations and a practical internal guide.

## Context

This issue delivers one implementation outcome within [Capability] Testing, deployment and launch readiness and follows the versioned product/technical contracts.

Relevant documentation:

* `docs/technical/deployment-and-operations.md`
* `docs/product/v1-product-definition.md`

## Scope

* Create concise internal guide for sign-in, connect/reconnect, sync, upload/analyse, trends/strategy/recommendations, failures and deletion/escalation.
* Compile launch checklist evidence, open defects/risks/costs/provider settings and accepted limitations.
* Run go/no-go with product, engineering, security/privacy and operator owners.
* Record release SHA/config/schema/model/API versions and post-launch review/rollback triggers.

## Acceptance criteria

- [ ] Guide covers every primary journey and manual-attention action using canonical wording.
- [ ] Root/capability checklists and dependencies are reconciled; no orphan/duplicate/oversized issue remains.
- [ ] No open P0 or designated release blocker remains; accepted limitations have owner/review date/user wording.
- [ ] Meta live contract, paid Gemini settings, security review, E2E/UAT, deploy, alert and restore evidence are linked.
- [ ] Production on-call/escalation, cost budgets and credential owners are named.
- [ ] Go/no-go and exact release/version inventory are recorded.
- [ ] Post-launch observation/review and rollback criteria are scheduled.

## Out of scope

Public launch communications, marketing, client support and SLA.

## UI and content notes

There is no dedicated screen. Any surfaced state or error uses the canonical terminology and safe redacted detail defined by the parent capability.

## Implementation notes

This is the final release gate; do not close for schedule pressure without explicit accepted-risk record.

## Data and permissions

Guide/evidence remain internal and do not expose credentials, private content or sensitive infrastructure details.

## Test notes

* Manual launch checklist audit.
* Documentation link/terminology/version consistency check.
* Final production smoke after approved deployment.

## Dependencies

Blocked by:

* {{ISSUE:backup-monitoring}} Verify backups, restore, monitoring and production alerts
* {{ISSUE:acceptance-a11y}} Complete cross-browser, mobile, accessibility and Studio Parallel acceptance
* {{ISSUE:security-review}} Complete pre-launch security and privacy review
* {{ISSUE:operations-runbooks}} Create internal operating and failure-recovery runbooks

Blocks:

* None
