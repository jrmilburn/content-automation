# Meta contract proof

This record pins the v1 Instagram integration to Meta Graph API `v25.0` and makes the account-specific proof repeatable without committing account content or credentials. The production-path proof uses Instagram API with Instagram Login at `graph.instagram.com` with exactly:

- `instagram_business_basic` for professional-account identity and owned media;
- `instagram_business_manage_insights` for account and media insights.

No publishing, messaging, comment-management, Page or advertising permission is requested. The official Meta Instagram Postman collection and Insights guide were rechecked on 2026-07-28. They continue to document Instagram Login for Business/Creator accounts, the two scopes above, `graph.instagram.com`, cursor pagination, empty data for unavailable insights and Standard Access for accounts the app owns or manages. The repository pins `v25.0`; changing that value requires rerunning this proof and reviewing the capability map.

## Decision and ownership

V1 selects Instagram Login. The Facebook Login path remains a documented fallback only if the live target-account proof contradicts the selected path. The two credential models must not be mixed.

The intended v1 arrangement is Standard Access for one Studio Parallel-owned or -managed Business/Creator account that is explicitly added to the Meta app. The live run must confirm this; it is not inferred from documentation or a personal Graph Explorer token.

| Responsibility | Owner | Evidence or risk |
| --- | --- | --- |
| Account type, ownership and authorised test Reels | Studio Parallel account owner | Confirms Business/Creator status and rights-cleared content. |
| Meta app, Business Login settings, scopes and live proof | Engineering owner | Records the dashboard settings and runs the sanitising proof. |
| Privacy policy, deletion URL and provider terms | Product/privacy owner | Required before Live mode or any App Review submission. |
| Business verification/App Review contingency | Product owner with engineering support | Advanced Access is outside v1, but review and verification can take multiple weeks and remain a launch lead-time risk. |

If the account is not owned or managed by Studio Parallel, stop: Advanced Access and App Review become required and the v1 scope/dependencies must be updated before implementation continues.

## Meta app setup record

The development app must be a Meta Business app with Instagram API with Instagram Login configured. Record the following in the restricted engineering evidence store, not in Git:

1. Meta business and app owners, target Instagram account owner, and the account's Business/Creator classification.
2. Exact HTTPS redirect URI. The planned route is `https://<approved-development-host>/api/integrations/instagram/callback`; wildcards, loopback URLs and near-match variants are not accepted.
3. The two requested and granted scopes, Standard Access state, app mode and tester/account roles.
4. Token-exchange response field names and expiry metadata, never token values.
5. App dashboard screenshots or a short screencast showing the configuration, stored with restricted access and an evidence date.

Graph Explorer tokens are not accepted as production-path evidence because they do not prove the app's own Business Login configuration.

## Live proof runner

Run `npm run meta:contract:live` only in an authorised engineering session. Provide the values below through the session's secret mechanism; do not add a credential file to the repository or paste values into an issue/PR.

| Environment name | Required value |
| --- | --- |
| `META_CONTRACT_ACCESS_TOKEN` | Token returned through the selected app flow. |
| `META_CONTRACT_ACCESS_LEVEL` | Exactly `standard`. |
| `META_CONTRACT_ACCOUNT_OWNERSHIP` | `owned` or `managed`, confirmed by the account owner. |
| `META_CONTRACT_REDIRECT_URI` | Exact configured HTTPS callback URI. |
| `META_CONTRACT_GRANTED_SCOPES` | Exactly the two comma-separated read scopes above. |
| `META_CONTRACT_REEL_IDS` | Three distinct owned Reel IDs ordered as recent, older, and error-probe. IDs remain in memory and are never written. |
| `META_CONTRACT_TOKEN_RESPONSE_FIELDS` | Comma-separated field names observed during exchange, including `access_token`; no values. |
| `META_CONTRACT_TOKEN_EXPIRES_IN_SECONDS` | Positive expiry duration when the exchange returned one. |

The runner uses bearer authorization and versioned URLs, requests no caption, username, permalink or media URL, follows pagination by rebuilding a trusted-host URL from the opaque cursor, and caps pagination at 25 pages. It exercises three small insight groups and one deliberately unsupported metric to prove safe error classification. The real token, account/media identifiers, cursors, timestamps, metric values, raw errors, request URLs and content never enter the proof.

Output is written with restricted file permissions to the ignored path `artifacts/meta-contract/live-proof.json`. A passing proof requires:

- a returned Business/Creator account, all three selected owned Reels classified by `media_product_type=REELS`, and a recent Reel timestamp later than the older representative without retaining either timestamp;
- at least two media pages, a supported insight, a measured availability determination for every representative, and a redacted unsupported-metric error;
- an observed safe aggregate usage header (`x-app-usage` or `x-business-use-case-usage`);
- exact least-privilege scopes, HTTPS redirect state and observed token response field names.

The committed `tests/fixtures/meta/instagram-v25/sanitized-proof.json` is synthetic contract-test data, not a claim that the target account passed. `rate-limit.json` proves deterministic 429 classification without intentionally exhausting the live app's quota.

## Observed capability map (v25.0)

A live run against the authorised owned Business account probed documented media-insight metric names individually against one owned Reel. Names are recorded; no metric value, media identifier or account identifier is retained.

| Result | Metric names |
| --- | --- |
| Returned a numeric value | `views`, `reach`, `likes`, `comments`, `shares`, `saved`, `total_interactions`, `ig_reels_video_view_total_time`, `ig_reels_avg_watch_time`, `reels_skip_rate` |
| Returned HTTP 200 with empty data | none observed |
| Rejected with provider error code 100 | `plays`, `replays`, `clips_replays_count`, `ig_reels_aggregated_all_plays_count`, `follows`, `profile_visits`, `profile_activity`, `navigation`, `impressions`, `video_views`, `engagement`, `taps_forward`, `taps_back`, `exits`, `peak_concurrent_viewers`, `thread_replies` |

Two findings follow, and both are recorded rather than worked around:

1. **The empty-data insight state is documented but not reproducible on demand.** Meta documents an unavailable insight as empty data rather than a zero, and the adapter must handle that. On this account every supported metric returned a value at every sampled age, and every unsupported name produced error code 100 instead of empty data. The live proof therefore asserts that availability was *measured* for each representative (`insight_availability_measured`) and records whether the empty-data contract was actually seen (`negativeCases.liveEmptyInsightDataObserved`). It does not require an observation the provider will not produce. The adapter's handling of empty data remains covered deterministically by `tests/fixtures/meta/instagram-v25/sanitized-proof.json`. Treat any future run that records `liveEmptyInsightDataObserved: true` as new contract information, not as a regression.
2. **`reels_skip_rate` is available but not requested.** It is absent from `META_CONTRACT.insightGroups`, so the capability map currently under-requests one supported Reel metric. Adding it is a deliberate contract change and belongs with the insights implementation, not this proof.

The pagination cap is a related constraint. `maximumMediaPages` is 25 at `mediaPageSize` 2, so the runner can reach roughly the fifty most recent media items. Selecting the account's oldest Reel as the `older` representative consumed most of that budget. Choose a clearly older but not maximally old representative, or raise the cap, before relying on this run being reproducible on an account with more media.

## Current live-evidence status

The live production-path proof **passed** against an authorised Studio Parallel-owned Instagram Business account under Standard Access on Graph API `v25.0`. All twelve recorded checks passed, including professional-account type, least-privilege scopes, HTTPS redirect state, owned-Reel membership and `media_product_type=REELS` classification, cursor pagination across multiple pages, representative age ordering, a supported insight, a measured availability determination per representative, a redacted unsupported-metric error, a safe aggregate usage header and an `instagram-api-version:v25.0` response header.

The token used was generated from the App Dashboard, which issues a long-lived sixty-day token. That proves the app's own Instagram configuration and account connection, but it does **not** exercise the redirect and code-exchange leg; `authorization.tokenResponseFields` records Meta's documented exchange field names rather than a locally observed exchange. Proving the exchange end to end is #29's responsibility, and the sanitised proof should be rerun once that flow exists.

The sanitised artifact is written to the ignored path `artifacts/meta-contract/live-proof.json`. The dashboard configuration record, ownership confirmation and evidence date belong in the restricted engineering evidence store, not in Git.
