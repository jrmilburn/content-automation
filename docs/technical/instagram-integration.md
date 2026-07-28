# Instagram integration

Verified against Meta’s official Instagram documentation/Postman workspace on 2026-07-28. Meta capabilities are versioned and account-dependent; implementation must rerun the capability fixture against the chosen Graph API version before launch and on version upgrades.

## Selected v1 path

Prefer **Instagram API with Instagram Login** (`graph.instagram.com`) because it supports professional Business and Creator accounts without requiring a linked Facebook Page. Request only:

- `instagram_business_basic` for the authorised account/profile and owned media.
- `instagram_business_manage_insights` for account/media insights.

Do not request publish, message or comment-management scopes. Meta’s [official Instagram API collection](https://www.postman.com/meta/instagram/collection/6yqw8pt/instagram-api) and [Insights guide](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api?entity=request-23987686-26e7999c-fc7e-44c8-8f71-ab2de8d35c32) are the implementation baseline.

Fallback: Instagram API with Facebook Login is only selected if a proof against the target account shows the Instagram Login path cannot return required insights. It requires a linked Page and a different token/permission chain (`instagram_basic`, `instagram_manage_insights`, `pages_read_engagement`, with additional permissions in some Business Manager arrangements). The two paths must not be mixed in one credential.

## Account and access eligibility

- Only Instagram professional **Business** and **Creator** accounts are eligible; personal/consumer accounts are rejected.
- Standard Access is sufficient when the app serves accounts Studio Parallel owns/manages and those accounts/users are added appropriately to the Meta app.
- Advanced Access and Meta App Review are required if the app later serves professional accounts Studio Parallel does not own/manage. That is outside v1, but the production ownership arrangement must be confirmed.
- The app must be configured in the relevant Meta business/app dashboard with exact HTTPS redirect URIs, privacy/deletion information and requested use-case permissions.
- App-review or business-verification timelines are an external launch risk. A recorded end-to-end screencast, reviewer instructions and successful API calls should be prepared even if Standard Access is expected.

## OAuth and credential lifecycle

The deployed web application exposes
`GET /api/integrations/instagram/callback` so Meta can verify the exact HTTPS Business Login
redirect during development setup. Until issue #29 is delivered, this is a verification-only,
non-cacheable readiness endpoint: it ignores all query parameters and does not validate state,
exchange an authorisation code or persist credentials. Do not complete a real account
authorisation against the placeholder endpoint because any returned code will be discarded.

1. An authenticated internal user starts the connection.
2. The server creates high-entropy `state`, PKCE verifier/challenge where supported, nonce, requested-scope hash and a short expiry; values are bound to user/workspace/session.
3. The callback validates state, issuer/host, expiry and one-time use before code exchange.
4. The server exchanges the code using the selected documented flow, retrieves account identity and granted scopes, and verifies Business/Creator eligibility.
5. Exchange for the longest supported token form and store the returned `expires_in`/debug metadata rather than assuming permanence.
6. Encrypt the token using envelope encryption and store status/expiry/scope metadata separately.
7. Validate before scheduled work and refresh only through the selected flow’s current official endpoint. Refresh well before expiry, serialize refresh per credential, and atomically rotate ciphertext.
8. On invalid/revoked/expired token, stop provider jobs, mark `reauthorisation_required`, alert operations and never retry indefinitely.
9. Disconnect stops schedules, attempts provider revocation where supported, then purges local credential material. Historical imported data remains until a separate deletion request.

Meta has historically issued short-lived then approximately 60-day long-lived user tokens, but v1 treats the response and token-debug endpoint as authoritative. A launch contract test must verify exchange, refresh eligibility, revocation and expiry for the chosen current API flow; token rules are not hard-coded into product claims.

## Media retrieval

Use the authorised account’s owned-media edge with cursor pagination. Request only supported fields, initially:

- `id`
- `caption`
- `media_type`
- `media_product_type`
- `permalink`
- `timestamp`
- `thumbnail_url` where available
- `media_url` only as ephemeral display/import metadata
- username/owner fields where returned
- counts or duration only when the selected API version explicitly documents them

A published Reel may report `media_type=VIDEO`; use `media_product_type=REELS` to classify it, as Meta’s [official Reels publishing documentation](https://www.postman.com/meta/instagram/request/23987686-f1c081c0-be35-4ffa-84bb-2c1726860c2b) notes. Unknown product/media values are stored and shown as unsupported rather than discarded.

Store raw response, response hash, provider API version, retrieval time and normalised fields. Do not download or retain Instagram CDN media as the original source; URLs can expire and are not the user-supplied durable asset.

## Insights capability map

The adapter owns a versioned capability map by media product/type. It requests small compatible metric groups so one unsupported metric does not discard all returned data. Current official media-insight examples list metrics including:

- `views`, `plays` and replay/aggregate-play variants
- `reach`
- `likes`, `comments`, `shares`, `saved`
- `total_interactions`
- `follows`, `profile_visits`, `profile_activity`
- `ig_reels_video_view_total_time`, `ig_reels_avg_watch_time`
- `reels_skip_rate`
- Facebook/cross-post view fields

See Meta’s current [Media Insights request](https://www.postman.com/meta/instagram/request/23987686-0089d9e0-6141-4f69-a967-9d4c1c277ec9). Listing does not mean availability for every post. Fields are requested only when documented for the current API version/media type, stored under canonical names with the original provider name/unit, and never substituted for one another.

For every canonical metric record one of:

- `available` with numeric value and source name/unit;
- `unavailable` when Meta returns an empty data set (Meta explicitly says unavailable insight can be empty rather than zero);
- `not_applicable` for the media type;
- `permission_missing`;
- `provider_error` with retry class;
- `not_requested` under the capability map.

Account insight limits also matter: Meta states some account metrics are unavailable below 100 followers and account metric data is retained for limited periods (currently documented as up to 90 days). Media/account data and organic/ads-driven definitions must not be conflated. Store the provider’s title/description/period where returned.

## Metric snapshots and scheduling

Insights change after publication. Every successful observation is immutable and records `captured_at`, `post_age_seconds`, requested cadence, API version, raw payload and availability map.

Initial desired targets are import, ~1h, ~24h, ~3d, ~7d and ~30d. Scheduler behaviour:

- enqueue only due, eligible posts;
- permit a tolerance window rather than promise an exact timestamp;
- record missed cadence and reason;
- avoid backdating a late observation;
- deduplicate by post/capture bucket/payload hash;
- select comparable post-age windows in analytics.

The first internal release may guarantee manual sync plus daily scheduling and opportunistically fill finer cadences. The data model supports the full list.

## Incremental sync

- Bootstrap walks a configured recent horizon (default proposal: 180 days, bounded by provider availability) using cursor pagination.
- Incremental runs refetch the newest pages with overlap because captions/counts can change and order is not guaranteed.
- Insight work is separate per post so failures are isolated.
- Sync runs persist the opaque cursor/checkpoint after committed pages.
- Provider-deleted/unavailable media is tombstoned only after repeated confirmation; historical evidence is not silently erased.
- Manual and scheduled runs share the same idempotency path and one active run lock per account/purpose window.

## Polling and webhooks

Use polling for post discovery and metric snapshots. Meta webhooks are useful for supported interaction events, but do not replace scheduled retrieval of changing performance insights. V1 does not request messaging/comment scopes merely to obtain webhooks. A later `media`-event trigger may enqueue an earlier poll if the selected API version documents it, with polling/reconciliation remaining authoritative.

## Rate limiting and provider errors

Do not encode one universal calls-per-hour number. Meta applies limits by app, account/use case and endpoint, and communicates usage through response headers such as `x-app-usage`/business-use-case usage plus 429/error bodies.

- Limit concurrency per account and per app.
- Capture safe aggregate usage headers on every response.
- Throttle before exhaustion; honour retry hints when present.
- Retry 429/transient 5xx/timeouts with jitter and a provider-specific cap.
- Classify OAuth, permission, invalid-object, unsupported-metric and revoked-token errors as non-transient/manual.
- Never include access tokens in query/log output; prefer `Authorization: Bearer` where the endpoint supports it.

## Required launch proof

Against the real Studio Parallel test account and pinned Graph API version:

1. OAuth callback, account type and exact scopes.
2. Media pagination and Reel classification.
3. At least three representative Reels (recent, older, missing metric) and all configured insight groups.
4. Empty-versus-zero handling.
5. Token expiry metadata, validation, refresh/reconnect and disconnect/revocation.
6. Rate-limit headers and a simulated 429.
7. Raw fixture redaction and contract-test recording.

Any contradiction between this proof and this document is material and must update the capability map/docs before implementation proceeds.
