# Instagram integration

Verified against Meta’s official Instagram documentation/Postman workspace on 2026-07-28. Meta capabilities are versioned and account-dependent; implementation must rerun the capability fixture against the chosen Graph API version before launch and on version upgrades.

## Selected v1 path

Prefer **Instagram API with Instagram Login** (`graph.instagram.com`) because it supports professional Business and Creator accounts without requiring a linked Facebook Page. Request only:

- `instagram_business_basic` for the authorised account/profile and owned media.
- `instagram_business_manage_insights` for account/media insights.

Do not request publish, message or comment-management scopes. Meta’s [official Instagram API collection](https://www.postman.com/meta/instagram/collection/6yqw8pt/instagram-api) and [Insights guide](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api?entity=request-23987686-26e7999c-fc7e-44c8-8f71-ab2de8d35c32) are the implementation baseline.

The repository pins this path to Graph API `v25.0`. The sanitised, account-specific proof procedure and current evidence status are recorded in [Meta contract proof](meta-contract-proof.md). A version change is material: update the capability map and rerun that proof before dependent implementation proceeds.

Fallback: Instagram API with Facebook Login is only selected if a proof against the target account shows the Instagram Login path cannot return required insights. It requires a linked Page and a different token/permission chain (`instagram_basic`, `instagram_manage_insights`, `pages_read_engagement`, with additional permissions in some Business Manager arrangements). The two paths must not be mixed in one credential.

## Account and access eligibility

- Only Instagram professional **Business** and **Creator** accounts are eligible; personal/consumer accounts are rejected.
- Standard Access is sufficient when the app serves accounts Studio Parallel owns/manages and those accounts/users are added appropriately to the Meta app.
- Advanced Access and Meta App Review are required if the app later serves professional accounts Studio Parallel does not own/manage. That is outside v1, but the production ownership arrangement must be confirmed.
- The app must be configured in the relevant Meta business/app dashboard with exact HTTPS redirect URIs, privacy/deletion information and requested use-case permissions.
- App-review or business-verification timelines are an external launch risk. A recorded end-to-end screencast, reviewer instructions and successful API calls should be prepared even if Standard Access is expected.

## OAuth and credential lifecycle

The deployed web application exposes two endpoints:

- `POST /api/integrations/instagram/connect` starts Business Login. It is POST-only so the provider
  redirect cannot be triggered by a cross-site link or image, is restricted to an admin whose role is
  re-read from the database, and is bounded to five attempts per admin per five minutes. The limit is
  derived from the audit trail rather than a separate counter, because every attempt is audited
  before the redirect. It responds `303` to the provider with the pending state in an httpOnly,
  `SameSite=Lax`, host-locked cookie, and `429` with `Retry-After` once the limit is reached.
- `GET /api/integrations/instagram/callback` completes the connection.

The state cookie carries an HMAC over the state value, the initiating user and the expiry, so a state
issued to one admin cannot be completed by another session and a tampered cookie is rejected rather
than trusted. The `__Host-` prefix and `Secure` attribute apply only when `PUBLIC_ORIGIN` is HTTPS,
because browsers refuse that prefix over plain HTTP. The callback clears the cookie on every path,
including authorisation failure and unexpected errors, which is what makes a captured state
single-use.

The callback never reflects a provider-supplied value. It redirects to a fixed internal location
carrying only a coarse `connected` or `failed` outcome; the specific denial reason is audited but
never returned, so a crafted callback cannot probe which check failed.

Because the redirect URI must be an exact HTTPS value, the connection flow cannot run against
`http://localhost`. Exercise it through an approved HTTPS development host or a tunnel whose exact
callback URI is registered in Business login settings.

1. An authenticated internal user starts the connection.
2. The server creates a high-entropy `state`, requested-scope hash and a short expiry; values are bound to the initiating user. No PKCE challenge is sent: Meta's Business Login documentation does not describe PKCE support for the Instagram Login path, and advertising a challenge the provider ignores would imply a protection that is not in force. Revisit only against official documentation, never by assumption.
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

The `unavailable` state must stay implemented, but a live `v25.0` run against an authorised owned Business account did not reproduce it: every supported metric returned a value at every sampled media age and every unsupported name was rejected with provider error code 100 instead of empty data. The observed capability map, including one supported Reel metric the current groups do not request, is recorded in [Meta contract proof](meta-contract-proof.md).

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

Meta configuration uses two distinct endpoints:

- Instagram Business Login redirects to
  `${PUBLIC_ORIGIN}/api/integrations/instagram/callback`.
- Webhook verification calls `${PUBLIC_ORIGIN}/api/integrations/instagram/webhook` with
  `hub.mode`, `hub.verify_token` and `hub.challenge` query parameters.

The webhook verify token is a deployment-managed, URL-safe secret of 32–128 characters stored as
`META_WEBHOOK_VERIFY_TOKEN`; the identical value is entered in Meta's **Verify Token** field. The
server returns only a valid numeric challenge after a constant-time token comparison. It returns
empty, non-cacheable failures for mismatches or missing configuration and never logs request query
values. Event-delivery `POST` requests are refused until a selected event use case implements raw
body `X-Hub-Signature-256` validation, replay/deduplication controls and bounded processing. Do not
subscribe to webhook fields before that handler is delivered.

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
