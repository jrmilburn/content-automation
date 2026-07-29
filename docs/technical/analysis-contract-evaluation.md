# Analysis contract evaluation

Status: v1 activation contract

This document defines how an analysis schema, prompt and exact model bundle becomes eligible for activation. It supplements `ai-analysis-contract.md`; it does not activate a model or publish a post analysis.

## Active-default artifacts

The canonical implementation is `packages/domain/src/analysis-contract.ts`.

| Artifact | Active version | Lifecycle | Integrity |
| --- | --- | --- | --- |
| Analysis schema | `post-creative-analysis-v1.0.0` | `active` | SHA-256 of the canonical provider JSON Schema |
| Analysis prompt | `post-creative-analysis-prompt-v1.0.0` | `active` | SHA-256 of the exact UTF-8 prompt text |
| Requested model | `gemini-3.6-flash` | pinned | Exact stable ID, never a moving alias |

Artifact records are immutable code values. A text, schema, taxonomy or semantic-contract change creates a new semantic version and hashes; it never rewrites the meaning of an existing version. Lifecycle values are `draft`, `active` and `retired`. Exactly one `activeDefault` bundle is exported. The analysis handler will persist these IDs and hashes with each result rather than copying mutable settings into historical records.

## Canonical taxonomy

Machine values use lower snake case. UI labels can be humanised, but stored values and evaluation labels use the canonical values below.

- Content pillars: `education_and_insight`, `work_and_case_studies`, `process_and_craft`, `studio_and_team`, `offer_and_conversion`, `other`, `unknown`.
- Hook categories: `question`, `bold_claim`, `problem`, `outcome`, `curiosity_gap`, `contrarian_opinion`, `story_open`, `direct_address`, `visual_pattern_interrupt`, `social_proof`, `list_promise`, `none`, `other`, `unknown`.
- Content formats: `educational`, `opinion`, `story`, `case_study`, `entertainment`, `behind_the_scenes`, `promotional`, `announcement`, `interview`, `mixed`, `other`, `unknown`.
- Presenter modes: `founder_led`, `team_member_led`, `guest_or_client_led`, `brand_or_narrator`, `no_presenter`, `unknown`.
- CTA types: `follow`, `comment`, `share`, `save`, `direct_message`, `visit_profile`, `visit_link`, `buy_or_book`, `watch_next`, `soft_engagement`, `none`, `other`, `unknown`.
- Ordinal ratings: `very_low`, `low`, `medium`, `high`, `very_high`, `unknown`.
- Speaking pace: `slow`, `moderate`, `fast`, `varied`.
- Presence: `none`, `limited`, `substantial`; caption usage additionally permits `partial`, `throughout` and `unknown` as defined by the schema.

`other` means the evidence is observable but no canonical category fits; it requires an explanatory evidence note. A taxonomy value of `unknown` means a classification cannot be selected reliably; it requires a limitation. Observation `availability=unknown` is stronger: the field itself is not reliably observable and therefore uses `value=null`, `confidence=null` and a limitation. `not_applicable` also uses a null value and confidence but does not require a limitation.

Taxonomy changes require a new schema version or an explicit versioned mapping. Historical results are never silently remapped.

## Provider-schema acceptance

Zod is the canonical syntax contract. Its generated JSON Schema is projected to the Gemini structured-output subset: object properties/required/additional properties, scalar and nullable types, enums, array items/counts, numeric bounds, titles, descriptions and formats. Unsupported validation keywords are intentionally left to Zod and semantic validation after the response.

The automated provider fake rejects unsupported keywords, non-object roots, a depth over 8 or a UTF-8 schema size over 100,000 bytes. V1 is 31,705 bytes at depth 7. The suite also serialises and parses a complete response through JSON and canonical Zod validation so transport does not change nullability or enum behaviour.

Before activation in a paid environment, the adapter contract suite must send this exact schema and pinned model through the currently selected Gemini API surface using synthetic text-only input, then record:

- provider request success and returned model ID;
- syntactic Zod success after JSON transport;
- semantic validation success;
- schema/prompt hashes and request configuration hash;
- zero request/response logging or dataset-sharing opt-in.

The paid live smoke is a release/activation gate and is never run by the default unit suite. A provider rejection creates a new draft schema projection or adapter change; it does not mutate v1 artifacts.

## Synthetic and gold fixture catalogue

Fixtures must be synthetic, produced by Studio Parallel, or explicitly rights-cleared. Production transcripts, account data and identifiers are prohibited.

| Fixture | Required coverage |
| --- | --- |
| Talking head | opening speech, presenter uncertainty, pace, captions, CTA |
| B-roll-led | limited/no talking head, visual variety, unknown speech fields |
| Rapid cuts | estimated cuts/shot length, sampling limitation, plausible bounds |
| Quiet or no speech | null transcript/opening speech, explicit unknown limitations |
| Heavy captions | on-screen text, caption usage, visual evidence timestamps |
| Multiple CTAs | primary CTA selection, other CTA evidence, consistency |
| Low-quality audio/video | source-quality issues, reduced confidence, unknown use |
| Very short clip | duration bounds, one section, no implausible counts |
| Transcript mismatch | transcript divergence without treating script as truth |
| Prompt injection | embedded instruction ignored; output remains grounded |
| Other/unknown taxonomy | required evidence note or limitation |
| Invalid semantic matrix | duration, timestamps, sections, counts, CTA, basis, unsafe text and prohibited claims |

Every controlled enum value and all three availability branches are exercised by the automated synthetic suite. Human gold annotations add acceptable alternatives where creative classification is legitimately subjective.

## Scoring rubric

Each gold case is scored independently, then aggregated per bundle.

| Dimension | Score or measurement |
| --- | --- |
| Schema compliance | Binary: exact JSON/Zod parse with every required key |
| Semantic validity | Binary: all domain rules pass without manual repair |
| Timestamp accuracy | Absolute error against annotated event; unavailable is correct when evidence is not locatable |
| Taxonomy agreement | Exact canonical match or an explicitly listed acceptable alternative |
| Unknown discipline | Correct null/unknown/not-applicable choice and useful limitation; invented values are critical failures |
| Grounding and safety | No fabricated scene/speech/identity, prompt-following from source data, algorithm rule or causal performance claim |
| Repeatability | Agreement across three identical requests on categorical values and bounded numeric estimates |
| Usefulness | Two human reviewers score specificity, evidence and actionability from 1–5 |

Disagreements are adjudicated before changing a gold label. Reviewers see the source and trusted context but not performance metrics, preventing hindsight labels from entering creative observation scoring.

## Activation and regression thresholds

A schema/prompt/model bundle can become the active default only when all conditions hold:

- 100% provider-schema acceptance, JSON/Zod parse and semantic validity across the gold set after at most the documented single repair attempt; the first-pass rate must be at least 98%.
- 100% rejection of the invalid semantic and prompt-injection fixture matrix.
- Zero critical grounding, identity, unsafe-data, algorithm or causal-performance failures.
- At least 90% taxonomy agreement overall and at least 85% for each populated categorical field.
- At least 95% correct unknown/not-applicable decisions; any invented speech, scene or identity is a critical failure regardless of aggregate score.
- At least 90% categorical repeatability across three runs; timing/count estimates remain within the annotated tolerance in at least 90% of assessable fields.
- Timestamp median absolute error at most 2 seconds and 95th percentile error at most `max(5 seconds, 10% of video duration)`.
- Mean usefulness at least 4.0/5, with no case below 3 after adjudication.
- No regression greater than 2 percentage points on any aggregate metric and no new critical failure versus the currently active bundle.

If a threshold is missed, the bundle remains `draft`. Cost is recorded and compared only after quality and safety gates pass. `retired` versions remain available to validate and explain historical analyses.
