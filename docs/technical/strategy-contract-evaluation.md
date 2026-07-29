# Strategy contract evaluation

Status: v1 activation contract

This document defines the provider, semantic and human gates for the structured account-strategy bundle. It supplements `strategy-generation.md`; evidence retrieval, model calls, persistence and activation remain separate implementation concerns.

## Active-default artifacts

The canonical implementation is `packages/domain/src/strategy-contract.ts`.

| Artifact | Active version | Lifecycle | Integrity |
| --- | --- | --- | --- |
| Strategy schema | `account-content-strategy-v1.0.0` | `active` | SHA-256 of the canonical provider JSON Schema |
| Strategy prompt | `account-content-strategy-prompt-v1.0.0` | `active` | SHA-256 of the exact UTF-8 prompt text |
| Requested model | `gemini-3.6-flash` | pinned | Exact stable ID, never `latest` |

A schema, prompt, taxonomy, evidence rule or fingerprint change creates a new semantic version and hashes. Existing artifact meanings never change. Lifecycle values are `draft`, `active` and `retired`, with one explicit `activeDefault` bundle.

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

## Provider-schema acceptance

Zod is canonical. The generated schema is projected into the same Gemini structured-output subset used by post analysis. The automated provider fake rejects unsupported keywords, roots other than object, depth over 8 and schema size over 100,000 UTF-8 bytes. Strategy v1 is 9,084 bytes at depth 7.

Before activation in the paid environment, the adapter contract suite must send this exact schema with the pinned model and synthetic text-only evidence, then record provider acceptance, returned model ID, JSON/Zod/semantic success and artifact/configuration hashes. The live request is an explicit release gate and is not part of the default unit suite.

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
