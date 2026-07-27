# Terminology

Use these terms consistently in UI, code, documentation and issues.

| Term | Definition | Avoid |
| --- | --- | --- |
| Workspace | The Studio Parallel data boundary. V1 has one workspace but records retain a workspace key. | Tenant, customer |
| Instagram account | An authorised Instagram Business or Creator account connected to the workspace. | Profile when referring to the integration |
| Post | An imported Instagram media object. V1 product workflows focus on Reels. | Video when referring to the provider record |
| Source video | The private, durable original file uploaded by Studio Parallel and associated with a post. | Instagram URL, CDN video |
| Transcript | Editable spoken-content text associated with a post/source video, with source and revision metadata. | Captions (ambiguous) |
| Original script | Optional pre-production copy supplied by the user; not assumed to match speech. | Transcript |
| Post analysis | One immutable, validated Gemini analysis of one source video under one schema/prompt/model combination. | Agent, final truth |
| Current analysis | The successfully validated post analysis selected for current analytics. Older analyses remain available. | Latest attempt |
| Analysis schema version | Immutable definition of the structured output and semantic validation rules. | Model version |
| Prompt version | Immutable identifier and hash for instructions used for an AI request. | Schema version |
| Analysis job | Durable queued work that attempts one post analysis. | Agent |
| Metric snapshot | Values and availability states observed for one post at one retrieval time. | Final metrics |
| Comparable snapshot | A snapshot whose metric definition, source and post-age window are compatible with the comparison cohort. | Latest metrics (unless genuinely comparable) |
| Feature statistic | Application-calculated comparison of a creative feature/value against a defined metric and baseline. | AI statistic |
| Trend | A user-facing feature statistic with sample, period, baseline, uncertainty and post references. | Algorithm insight |
| Evidence item | A stored reference to a post analysis, metric snapshot or feature statistic used in a strategy claim or recommendation. | Citation when no source is stored |
| Strategy generation | One immutable, validated account-level strategy and its frozen evidence set. | Strategy agent |
| Content recommendation | A proposed future video or experiment within a strategy. | Finding (it is generative) |
| Confidence | Classification based on documented evidence rules, or a field-level model confidence for creative observations. The two are kept separate. | Certainty, probability of causation |
| Statistically supported association | A non-causal relationship meeting the documented sample, uncertainty, effect and sensitivity rules. | Proven winner, algorithm rule |
| Weak directional signal | A relationship worth testing whose sample or uncertainty is not strong enough for statistical-support language. | Fact |
| Outlier | A post that disproportionately affects a result; analysed but not generalised. | Viral formula |
| Unavailable metric | A value the provider did not return or the app could not lawfully retrieve. It is not zero. | No performance |
| Processing state | Explicit lifecycle state for sync, upload, job, analysis or strategy work. | Status without a defined state machine |

Metric names and exact formulas are defined only in `docs/technical/analytics-and-metrics.md`.
