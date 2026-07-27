# V1 user journeys

## 1. First internal access

**Start:** An approved Studio Parallel teammate visits the tool.

1. They authenticate with Google Workspace.
2. The server confirms the email/domain allowlist and active user record.
3. They enter the dashboard and see a setup state if no Instagram account exists.

**Failure paths:** denied identity, inactive user, OIDC error and expired session each produce a safe message and no workspace data. The return URL is validated to prevent open redirects.

## 2. Connect an Instagram account

1. From Instagram account configuration, the user reviews the requested read-only scopes.
2. They start Meta authorisation; state and PKCE values bind the callback to the session.
3. The server exchanges the code, verifies the returned professional account and scopes, encrypts credential material, and records token expiry/status.
4. A bootstrap sync is queued and the user lands on account health/sync progress.

**Failure paths:** cancellation, non-professional account, missing insight scope, mismatched state, account already connected, expired code, provider outage and account ownership mismatch. Partial credentials are not retained as active.

## 3. Import and refresh posts

1. The user requests a manual sync or a scheduled run starts.
2. The worker paginates owned media, upserts posts, identifies Reels, requests supported insights and records availability per metric.
3. Every retrieval creates or deduplicates a metric snapshot and updates sync counters.
4. The post list progressively shows imported posts and attention states.

**Failure paths:** rate limits reschedule safely; expired/revoked tokens require reconnect; one bad media item is isolated; a cursor can resume; empty insight results remain unavailable rather than zero; a run summary shows partial completion.

## 4. Upload and associate source content

1. From an imported post, the user selects a source video.
2. The server authorises the post and returns a short-lived multipart-upload instruction for a private object key.
3. The browser uploads with progress and can resume supported multipart failures.
4. The server verifies object metadata, detects type, probes duration/decodability and marks the asset ready or rejected.
5. The user adds transcript, original script, audience, objective, notes and tags, then saves.

**Failure paths:** unsupported/oversized/corrupt file, lost network, expired signed URL, post already has a pending replacement and crafted post/object identifiers. A failed replacement does not remove the current asset.

## 5. Analyse one post

1. The post becomes eligible when it has a validated source video and an active schema/prompt/model configuration.
2. The user selects **Analyse video** and sees the exact source inputs that will be used.
3. The server creates one deduplicated job and returns immediately.
4. The worker uploads or registers the video with Gemini, waits for readiness, sends one video plus prompt/context, validates structured output, stores an immutable analysis and activates it transactionally.
5. The post detail updates from queued to processing to complete.

**Failure paths:** duplicate clicks return the same active job; provider 429/5xx retries; invalid output receives a bounded repair retry; safety/unsupported/corrupt-video failures become manual-attention states; the previous current analysis remains active.

## 6. Review a post analysis

1. The user sees post metadata and a comparable metric snapshot first.
2. They review hook, content, delivery, visual/editing, CTA, strengths, weaknesses and improvements.
3. Estimated fields and field-level confidence are visible; transcript/source provenance can be compared.
4. They can inspect older analysis versions or request reanalysis against the current contract.

**Failure paths:** no upload, pending job, failed job, no comparable metrics and stale analysis each have a distinct next action.

## 7. Explore account trends

1. The user selects account, date range, metric and optional feature/category filters.
2. The application selects comparable snapshots, calculates medians/ratios/uncertainty and reads materialised feature statistics.
3. The page leads with supported associations, then directional signals, outliers and limitations.
4. Opening a trend reveals all relevant posts, baseline details and sensitivity result.

**Failure paths:** no analysed posts, insufficient sample, incompatible snapshot ages, missing denominator and stale statistics. The UI explains what data or experiment would improve the result.

## 8. Generate an evidence-linked strategy

1. The user chooses an account, period and optional emphasis.
2. A preview shows evidence eligibility and warns if the sample is insufficient.
3. The system freezes a bounded evidence manifest, queues generation, validates the returned strategy and stores it immutably.
4. The strategy leads with what appears to work, what does not, what to test, next videos, evidence/confidence and limitations.
5. Every claim and recommendation opens its historical evidence.

**Failure paths:** insufficient evidence produces an explicitly exploratory plan; a provider/model failure is retryable; invalid output is not published; regeneration keeps history and avoids recent duplicate ideas.

## 9. Act on a recommendation

1. The user opens a recommendation and reviews pillar, hook options, structure, filming, editing, CTA, rationale, evidence and proposed experiment.
2. They select, dismiss or later mark it completed.
3. A completed recommendation can be linked to an imported resulting post, closing the learning loop without claiming causality.

## 10. Recover failed or incomplete work

1. An operator opens **Operations** and filters syncs/jobs/posts by required attention.
2. They inspect redacted cause, attempts, timestamps and correlation ID.
3. They retry an eligible operation, reconnect a credential, upload a missing asset or resolve an association.
4. The audit trail records actor and outcome.

Bulk destructive retry/delete is excluded from v1; high-impact deletion requires explicit confirmation.
