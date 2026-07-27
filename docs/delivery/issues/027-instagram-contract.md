Backlog metadata — Priority: P0 · Size: M · Product area: Instagram integration · Target release: v1.0-internal · Parent capability: {{ISSUE:cap-instagram-connection}} [Capability] Instagram account integration

## Outcome

Engineering has a recorded, sanitised production-path proof that the target Studio Parallel Business/Creator account can authorise the required read-only media and insights access under a pinned Meta API version.

## Context

This issue delivers one implementation outcome within [Capability] Instagram account integration and follows the versioned product/technical contracts.

Relevant documentation:

* `docs/technical/instagram-integration.md`
* `docs/repository-assessment.md`

## Scope

* Identify Meta business/app/account ownership and choose Instagram Login or documented fallback.
* Configure development redirect/use-case settings and request only required scopes.
* Exercise account identity, media pagination, Reel classification, representative insight groups, empty data, usage headers and token metadata.
* Capture sanitised fixtures and document Standard versus Advanced Access/App Review decision.

## Acceptance criteria

- [ ] Target account is confirmed Business or Creator and ownership/access level is recorded.
- [ ] The selected path returns account and owned Reel media using least-privilege scopes.
- [ ] At least three representative Reels prove supported, unavailable and error insight behaviour.
- [ ] Exact Graph API version, host, scope names, rate-usage headers and token response fields are documented.
- [ ] Fixtures contain no tokens, sensitive captions/content or unsafe provider identifiers.
- [ ] Any contradiction updates docs and dependent acceptance before build.
- [ ] App Review/business verification prerequisites have owners and lead-time risk.

## Out of scope

Production OAuth implementation, publishing/comment/message scopes and third-party client accounts.

## UI and content notes

There is no dedicated screen. Any surfaced state or error uses the canonical terminology and safe redacted detail defined by the parent capability.

## Implementation notes

Use official Meta docs/Postman as source. Do not use Graph Explorer tokens as the production design.

## Data and permissions

Perform with authorised test content/account; redact tokens, request URLs, captions and provider IDs in committed fixtures.

## Test notes

* Live manual contract proof plus deterministic adapter fixture review.
* Negative unsupported/missing metric and 429 fixture.

## Dependencies

Blocked by:

* {{ISSUE:foundation-approval}} Confirm v1 product, terminology, screen map and architecture baseline
* {{ISSUE:foundation-scaffold}} Scaffold the TypeScript web and worker workspace

Blocks:

* {{ISSUE:instagram-oauth}} Implement Instagram connection callback and encrypted credential storage
