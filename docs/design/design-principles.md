# Design principles

## Evidence before theatre

Lead with observed results, the comparison basis and limitations. AI prose is secondary. Never use algorithmic or causal language for account-level associations.

## One next action per state

Queued, processing, incomplete, failed, expired and insufficient-data states each explain what happened and present the safest relevant action. Do not collapse them into “Something went wrong.”

## Progressive disclosure for analytical detail

Default views answer “what appears to matter?” A detail drawer/page exposes denominator, snapshot age, cohort, sample, uncertainty, formula version and post references without making every card dense.

## Confidence is language, not decoration

Use the canonical classifications and plain-language explanations. Pair colour with text/icon; never use a magic score without definition. Model field confidence and statistical evidence strength must look and read differently.

## Missing is a first-class value

Display “Unavailable”, “Not applicable” and “Not yet captured” distinctly from `0`. Explain the reason when known. Do not substitute a different denominator without naming a different metric.

## Keep the internal tool fast and honest

Optimise for scanability, filters, reliable tables, keyboard flow and useful operational detail. Avoid marketing surfaces, public onboarding and ornamental dashboards.

## Preserve provenance

Evidence links, post IDs/permalinks, capture times, current/previous analysis versions and configuration metadata remain easy to inspect. A user should be able to answer “why am I seeing this?” from any trend or recommendation.

## Design for asynchronous reality

Submitting work confirms queueing, not completion. Use resumable progress, last-updated times and refresh-safe state. Never imply the browser must remain open.

## Safe actions by default

Retry is idempotent. Replace keeps the old asset until the new one validates. Delete shows downstream effects. Reconnect does not expose token material. Crafted URLs never bypass workspace checks.

## Responsive, not analytics-lite

At 390px, core setup, review and recovery actions remain usable. Dense comparisons may become stacked summaries or labelled horizontal tables, preserving meaning rather than hiding key columns.

## Accessible by construction

Use semantic regions and headings, native controls, explicit labels/help/errors, logical focus after mutations, `aria-live` for async state, reduced-motion support and sufficient contrast. Charts require a textual/table equivalent.
