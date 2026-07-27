Backlog metadata — Priority: P1 · Size: M · Product area: Instagram integration · Target release: v1.0-internal · Parent capability: {{ISSUE:cap-instagram-connection}} [Capability] Instagram account integration

## Outcome

An authorised user can inspect connected account identity, scope/token/sync health, connect or reconnect, and explicitly disconnect without exposing credentials or accidentally deleting history.

## Context

This issue delivers one implementation outcome within [Capability] Instagram account integration and follows the versioned product/technical contracts.

Relevant documentation:

* `docs/design/screen-map.md`
* `docs/technical/instagram-integration.md`
* `docs/technical/security-and-privacy.md`

## Scope

* Build account list/detail configuration screens and connection/reconnect entry points.
* Show professional type, username, granted required scopes, API version, expiry/health, last successful sync and next action.
* Implement admin-only disconnect with impact confirmation, provider revocation attempt and credential purge.
* Preserve historical posts/analyses unless separate erase is chosen.

## Acceptance criteria

- [ ] No-account, connecting, connected, degraded, reconnect-required, disconnecting and provider-error states are distinct.
- [ ] Credential/token values and raw provider errors never render.
- [ ] Disconnect confirmation states that sync stops while history remains; repeated action is idempotent.
- [ ] Non-admin/crafted/cross-workspace account actions are denied server-side.
- [ ] Expired scope/token state links directly to reconnect.
- [ ] Keyboard, focus, mobile 390px and accessible status requirements pass.
- [ ] Provider revocation/purge outcome is audited and observable.

## Out of scope

Account data erase, multiple workspace/client onboarding and manual secret editing.

## UI and content notes

Lead with account identity and health, then required action, permissions and sync context. Use “Reconnect account,” not “fix token.” Error wording gives safe action and correlation ID.

## Implementation notes

Keep connect/reconnect callback server-side; UI polls/refreshes safe account status only.

## Data and permissions

Workspace owns account/history. Disconnect purges credential; full deletion is separate security work.

## Test notes

* UI state/component/Playwright connect-reconnect-disconnect fake flow.
* Admin/non-admin/crafted-ID tests.
* Revocation failure and idempotent purge tests.

## Dependencies

Blocked by:

* {{ISSUE:instagram-oauth}} Implement Instagram connection callback and encrypted credential storage
* {{ISSUE:instagram-token-health}} Implement Instagram token health, refresh and reconnect handling
* {{ISSUE:access-shell}} Build the responsive accessible internal application shell

Blocks:

* {{ISSUE:security-deletion}} Implement approved retention and full data-deletion workflows
* {{ISSUE:e2e-import}} Prove end-to-end Instagram connection, import and sync recovery
