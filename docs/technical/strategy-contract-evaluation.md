# Strategy contract evaluation

Status: v1 activation contract

This document defines the provider, semantic and human gates for the structured account-strategy bundle. It supplements `strategy-generation.md`; evidence retrieval, model calls, persistence and activation remain separate implementation concerns.

## Active-default artifacts

The canonical implementation is `packages/domain/src/strategy-contract.ts`.

| Artifact | Active version | Lifecycle | Integrity |
| --- | --- | --- | --- |
| Strategy schema | `account-content-strategy-v1.0.0` | `active` | SHA-256 of the JSON Schema the request carries |
| Strategy prompt | `account-content-strategy-prompt-v1.0.0` | `active` | SHA-256 of the exact UTF-8 prompt text |
| Requested model | `gemini-3.6-flash` | pinned | Exact stable ID, never `latest` |

A schema, prompt, taxonomy, evidence rule or fingerprint change creates a new semantic version and hashes. Existing artifact meanings never change. Lifecycle values are `draft`, `active` and `retired`, with one explicit `activeDefault` bundle.

The schema integrity value hashes `strategyModelResponseJsonSchema`, the shape the request actually carries. It previously hashed a Gemini-subset projection the API rejects and that nothing sends, so it certified a request nobody could make. The contract itself did not change, so `v1.0.0` still means `v1.0.0`.

## How the request is made

The response shape is described inside the prompt and enforced afterwards by `validateStrategyV1`. It is not supplied as a provider response schema, because `gemini-3.6-flash` rejects this contract on every provider-schema path:

- `responseSchema` refuses `additionalProperties` and array-valued `type`. The projection emitted them 17 and 5 times, and the API named the array-valued `type` explicitly.
- `responseSchema` and `responseJsonSchema` then both refuse it for complexity, at 91 properties and depth 11. `responseJsonSchema` tolerates the first two constructs and still refuses the schema, which isolates complexity as an independent cause.

These are the same three failures #122 measured for post analysis, inherited from the same `createGeminiStructuredOutputSchema` helper. That helper and `assertGeminiStructuredOutputSchema` are removed: they asserted this repository's assumptions about Gemini rather than Gemini, and passed on a request the API rejects.

Two fields are never requested from the model and are stamped by the worker instead:

- `schemaVersion` is a `z.literal`. Asked for the equivalent block, the analysis model reported `gemini-2.5-flash` while `gemini-3.6-flash` was being called, failing every response on provenance the caller already held.
- `mode` is the frozen request mode. The worker chose it before the call and `validateStrategyV1` rejects any other value as `MODE_MISMATCH`, so echoing it can only agree or destroy the response. `createStrategyInstruction` states the mode so it still shapes the output.

`npm run strategy:contract:live -- [evidence_led|exploratory]` proves the request against the real API using a synthetic manifest. It is excluded from `npm run check` and from CI because it spends money and needs a reachable provider; run it whenever the prompt, schema or model changes. Local assumptions are not evidence here.

A validation failure on an otherwise structurally sound response is a retryable outcome, not a defect in the contract; #56 owns that retry policy.

## Frozen-manifest validation context

The model receives bounded representations, but semantic validation uses server-created metadata for every manifest-local evidence ID:

- immutable evidence ID and evidence type;
- allowed citation roles;
- stored evidence classification and statistic sample size where applicable;
- affected claim dimensions;
- exact numeric tokens permitted in citation explanations;
- whether data-quality evidence must appear in the strategy limitations.

The validator rejects IDs outside the manifest, incompatible roles, duplicate references, invented numeric values/sample sizes and evidence-class upgrades. Evidence-led empirical claims require both a feature statistic and relevant post evidence. Retrieved counterexamples that affect a claim dimension cannot be omitted, and required data-quality limitations must be cited explicitly.

Working patterns allow statistically supported, moderate or weak associations. Weak patterns allow weak signals, single-post outliers or insufficient evidence. Unsupported and creative classifications cannot be presented as empirical findings. Every recommendation remains `creative_recommendation` even when its rationale cites strong historical evidence.

## Provider acceptance

Zod is the canonical syntax contract. Its generated JSON Schema is what the instruction describes; unsupported validation keywords are intentionally left to Zod and to semantic validation after the response. The described response shape is 89 properties at depth 7 and 10,532 UTF-8 bytes.

Before activation in the paid environment, the live proof must send this exact instruction and pinned model with synthetic text-only evidence, then record provider acceptance, returned model ID, JSON/Zod/semantic success and artifact/configuration hashes. The live request is an explicit release gate and is not part of the default unit suite.

## Synthetic fixture matrix

Fixtures contain no production account content or identifiers.

| Fixture | Required coverage |
| --- | --- |
| Evidence-led strategy | working/weak patterns, statistics plus posts, counterexample and limitation |
| Exploratory strategy | insufficiency first, no working patterns, experimental pillar plan, tests first |
| Evidence-class ceiling | every canonical class and attempted confidence upgrade |
| Manifest boundary | unknown ID, disallowed role, duplicate ID and omitted counterevidence |
| Pillar plan | unique canonical pillars and exact integer total of 100 |
| Recommendation brief | 3–5 distinct hooks, structure, filming/editing/CTA and experiment |
| Recent recommendation | stable semantic fingerprint, repetition with/without iteration reason |
| Creative leap | recommendation with post context but no supporting statistic |
| Experiment | every canonical metric/window and changed-versus-stable variable conflict |
| Unsafe evidence | prompt injection, HTML/control text, invented number and causal/algorithm language |

Exact semantic fingerprints use canonical pillar, format, topic, audience and an order-independent set of normalised hooks. Retitling or reordering hooks therefore does not evade duplicate detection. Iteration is allowed only with a bounded explicit reason.

## Activation thresholds

A strategy schema/prompt/model bundle remains `draft` until all gates pass:

- 100% provider-schema acceptance and JSON/Zod/semantic success across the gold set after at most the documented single repair; at least 98% must pass on the first response.
- 100% rejection of the invalid manifest, confidence, allocation, duplicate, prompt-injection and prohibited-language matrix.
- Zero citations outside the manifest, invented numeric values, evidence-class upgrades, omitted required counterevidence or omitted required limitations.
- Exact 100% pillar allocation and valid exploratory labels in every response.
- At least 95% claim-to-evidence agreement under two human reviewers, with every disagreement adjudicated.
- At least 90% non-duplicate recommendation usefulness at 4/5 or higher; no accepted recommendation below 3/5.
- At least 90% categorical/evidence-reference repeatability across three identical requests.
- No new critical grounding, privacy, prompt-following, algorithm or causal-performance failure versus the active bundle.

Cost is considered only after quality, evidence and safety thresholds pass. Retired versions remain available to reproduce historical strategy generations.
