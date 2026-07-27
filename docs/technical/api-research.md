# Current API research and v1 assumptions

Research date: 2026-07-28. Primary sources are Meta’s verified official Postman workspace/Meta developer documentation and Google AI for Developers. Recheck before implementation and every pinned API/model upgrade.

## Instagram/Meta

| Topic | Current finding | V1 decision/assumption |
| --- | --- | --- |
| Login/account types | Instagram API with Instagram Login supports professional Business and Creator accounts and does not require a linked Facebook Page. | Prefer this path for the owned Studio Parallel account; reject personal accounts. |
| Permissions | Insights currently documents `instagram_business_basic` and `instagram_business_manage_insights` for Instagram Login. Facebook Login has a different Page/token/permission chain. | Request only the two read/insight scopes; prove on the target account. |
| Access level/review | Standard Access is documented for accounts the app owns/manages and that are added to the app; Advanced Access is for other professional accounts. | Confirm Studio Parallel app/business ownership. App Review/business verification is a launch risk only if the real arrangement requires Advanced Access. |
| Media | Owned media is cursor-paginated. A published Reel may be `media_type=VIDEO`; `media_product_type` distinguishes REELS. | Persist provider IDs and raw/versioned metadata; classify via product type. Never use media URL as permanent source storage. |
| Media insights | Current official metric list includes reach, views/plays variants, likes, comments, shares, saved, follows, profile visits/activity, total/average Reel watch time, replay/aggregate play and skip/crosspost variants. | Maintain an API-version/media capability map and request compatible groups. Presence in the list is not a guarantee for a post. |
| Missing/limits | Meta documents empty insight data when unavailable, account-level restrictions below 100 followers for some metrics and limited account insight history. Organic/ads definitions can differ. | Record per-metric availability; never turn empty into zero or mix incompatible definitions. |
| Snapshots | Insights change after publication; webhooks do not replace repeated insight retrieval. | Poll/manual sync and immutable post-age snapshots. Webhooks are not required for v1 correctness. |
| Rate limits | No single reliable universal number applies to every endpoint/account/app. Graph responses expose usage/rate information and 429/provider errors. | Per-account/app concurrency, response-header monitoring, adaptive throttling and bounded retry. |
| Tokens | Flow, token form, expiry/refresh/revocation differ by selected login path and provider changes. | Store returned expiry/scope metadata, validate/refresh through the proven flow, alert/reconnect before expiry; contract-test rather than hard-code permanence. |

Primary references:

- [Meta official Instagram API collection](https://www.postman.com/meta/instagram/collection/6yqw8pt/instagram-api)
- [Instagram API with Instagram Login](https://www.postman.com/meta/instagram/folder/6raa77c/instagram-api-with-instagram-login)
- [Meta official Insights guide and access-level/limitation table](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api?entity=request-23987686-26e7999c-fc7e-44c8-8f71-ab2de8d35c32)
- [Meta official Media Insights request/metric list](https://www.postman.com/meta/instagram/request/23987686-0089d9e0-6141-4f69-a967-9d4c1c277ec9)
- [Meta official Reel product-type note](https://www.postman.com/meta/instagram/request/23987686-f1c081c0-be35-4ffa-84bb-2c1726860c2b)

## Gemini

| Topic | Current finding | V1 decision/assumption |
| --- | --- | --- |
| Model | `gemini-3.6-flash` is currently stable/GA, accepts video and structured output, with a 1,048,576 input/65,536 output token limit. `gemini-3.5-flash-lite` is a lower-cost stable option. | Start evaluation with 3.6 Flash; bake off Flash-Lite where quality permits; pin exact IDs, never `latest`. |
| Video processing | Default processing samples about 1 FPS and roughly 300 tokens/sec at default resolution (about 100/sec low); rapid details can be missed. Google recommends one video/request for best results. | One source video per analysis; all visual counts/times are estimated with confidence/limitations. |
| File input | Files API automatically expires files after 48 hours and supports explicit deletion. Its usage page says 2 GB/file and 20 GB/project, while the current video guide advertises a higher paid per-file limit. | Proposed product cap 1 GiB; use Files API and explicitly delete; live contract-test the paid project’s actual limits. |
| Structured output | Gemini supports a subset of JSON Schema and the JS SDK can work with Zod-derived schemas; syntactic conformance does not guarantee semantic correctness. | Provider schema plus application Zod and cross-field/domain validation. |
| Function calling | Intended when the model needs the application to take an action. | Not used; the deterministic pipeline needs only a structured final output. |
| Context/rate | Current models have a 1M context window. Rate limits are per project and evaluated over RPM, input TPM and RPD, varying by model/tier/account. | Configurable concurrency/budgets and 429 backoff; never rely on context size to send the account’s videos. |
| Batch API | Separate asynchronous quotas and lower-cost batch processing are available. | Not used for interactive v1 because the application queue already owns visibility/retry. Revisit only for measured bulk backfill. |
| Context caching | Useful when a large prefix/video is reused repeatedly; storage/token thresholds and TTL costs apply. | No explicit cache for one-analysis-per-video workflow. |
| Data handling | Paid-service prompts/files/responses are not used to improve Google products; safety/abuse processing remains. Optional developer logs can retain data and shared datasets opt into improvement use. Files expire separately. | Billing-enabled project only, no voluntary dataset sharing, developer logging disabled unless approved, minimal inputs and explicit file deletion. |
| Pricing | As reviewed, standard paid 3.6 Flash is USD $1.50/1M input and $7.50/1M output; 3.5 Flash-Lite is $0.30/$2.50. Prices change. | Store provider usage and a dated estimate; recheck at launch and budget per project. |

Primary references:

- [Gemini models](https://ai.google.dev/gemini-api/docs/models)
- [Latest stable model guide and pricing summary](https://ai.google.dev/gemini-api/docs/latest-model)
- [Video understanding](https://ai.google.dev/gemini-api/docs/video-understanding)
- [Files API](https://ai.google.dev/gemini-api/docs/files)
- [Structured outputs](https://ai.google.dev/gemini-api/docs/structured-output)
- [Rate limits](https://ai.google.dev/gemini-api/docs/rate-limits)
- [Batch API](https://ai.google.dev/gemini-api/docs/batch-api)
- [Context caching](https://ai.google.dev/gemini-api/docs/caching)
- [Data logging and sharing](https://ai.google.dev/gemini-api/docs/logs-policy)
- [Gemini API terms](https://ai.google.dev/gemini-api/terms)

## Required revalidation gates

1. Target Meta account/app ownership, login path, exact scopes, API version, token lifecycle and representative metric matrix.
2. Paid Gemini project/region/terms/logging and effective file/quota limits.
3. Gold-fixture model/prompt/schema quality and current pricing.
4. Any provider deprecation or definition change before production deploy.
