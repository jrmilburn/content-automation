# Analytics and metric definitions

## Principles

1. Provider facts and application calculations are separate from Gemini observations.
2. A canonical metric never changes denominator silently.
3. Empty/unavailable is not zero; divide-by-zero and missing denominators return unavailable.
4. Only identical provider definitions, units and comparable post-age snapshots share a cohort.
5. Use medians, ratios of medians, bootstrap uncertainty and leave-one-out sensitivity because post performance is skewed and v1 samples are small.
6. Report associations, not causation or Instagram algorithm behaviour.
7. Formula/cohort logic is versioned as `analytics_version`.

## Canonical provider values

Keep these independent even when Meta changes/deprecates names:

- `views`: provider-defined starts/views for the media and API version.
- `plays`: provider-defined plays; never backfilled from views.
- `reach`: unique accounts reached, currently described by Meta as estimated/in development in some surfaces.
- `likes`, `comments`, `shares`, `saves`: organic media interactions from the same insight source/snapshot.
- `profile_visits`: profile visits attributed to media when returned.
- `follows`: follows attributed to media when returned.
- `total_watch_time_ms`, `average_watch_time_ms`: convert provider units at the adapter boundary and preserve original unit/name.
- replay, aggregate-play, skip-rate, Facebook/crosspost fields: separate experimental canonical values until comparison eligibility is documented.

Store metadata counts and insight metrics under different source keys when both exist; reconciliation may flag differences but must not merge them.

## Rate formulas

For post `p` and one snapshot `s`, all components must be from `s` unless explicitly stated.

| Metric | Formula | Availability/notes |
| --- | --- | --- |
| Engagement count | `likes + comments + shares + saves` | Available only when all four are available under compatible definitions. Do not call a partial sum engagement. |
| Engagement rate (reach) | `engagement_count / reach` | `reach > 0`; display as percent and label denominator as reach. |
| Like rate (reach) | `likes / reach` | `reach > 0`. |
| Comment rate (reach) | `comments / reach` | `reach > 0`. |
| Share rate (reach) | `shares / reach` | `reach > 0`. |
| Save rate (reach) | `saves / reach` | `reach > 0`. |
| Profile visit rate (reach) | `profile_visits / reach` | Only when both are media-attributed/compatible. |
| Follow conversion rate | `follows / profile_visits` | `profile_visits > 0`; this is conversion after a profile visit, not follows per reach. |
| Follow rate (reach) | `follows / reach` | Separate optional metric so the denominator is explicit. |
| Average watch percentage | `(average_watch_time_ms / 1000) / duration_seconds` | Duration uses validated source video if it matches the post; otherwise documented provider duration. May exceed 100% because of replay/provider definitions; do not clamp the stored value. |
| Completion proxy | `min(1, average_watch_time_ms / (duration_seconds * 1000))` | A coarse bounded proxy, not actual completions; always shown with the unbounded average-watch percentage and limitation. |

Do not derive average watch time from total watch time divided by `views` unless Meta documents that exact denominator for the returned metric. Meta’s user-facing definition currently uses initial views, which may not equal API `views`/`plays`.

## Relative performance

All relative results are per canonical metric, not a hidden cross-metric score.

Given focal value `x` and a comparison cohort excluding the focal post where possible:

- `baseline = median(comparison values)`
- `relative_index = x / baseline` when baseline is positive
- `difference_from_baseline = x - baseline`
- `percent_difference = (x - baseline) / baseline * 100`

Definitions:

- **Reach relative to account baseline:** focal reach vs median comparable reach for the account.
- **Views relative to account baseline:** focal `views` vs median comparable `views`; never combine with plays.
- **Performance relative to recent posts:** a named metric’s focal value/index vs the previous 20 eligible posts within 90 days (minimum sample applies).
- **Performance relative to category:** named metric vs other eligible posts with the same versioned category value and account, with the broader account cohort shown as context.

If a product view needs a summary, present a vector (Reach 1.3×, Share rate 0.8×, Average watch 1.1×). V1 does not create an opaque weighted performance score.

## Comparable snapshot selection

Posts mature over time. Cohort selection follows this order:

1. Same account, media product/type, organic/paid inclusion policy, API metric definition/version compatibility and requested metric.
2. Same target post-age bucket: proposed windows are import/unknown, 1h (0.5–2h), 24h (18–36h), 3d (60–96h), 7d (6–9d), 30d (25–40d), and mature (>40d).
3. For a requested bucket, choose each post’s snapshot closest to the target inside its tolerance; never use a later observation as if captured earlier.
4. If the requested cohort is too small, show insufficient data; do not silently mix ages. The user may intentionally choose a broader/mature view.
5. Apply the date filter to publication time and display the snapshot capture window.

The input fingerprint includes post, snapshot, current analysis, feature taxonomy and analytics versions.

Selection windows are not the storage buckets. `instagramSnapshotBuckets` partitions every possible age so each observation has one home, which means it assigns by upper edge alone: a snapshot taken ten hours after publication is stored as `day_1` because ten hours is under thirty-six. `snapshotAgeWindows` carries both edges, so `day_1` means 18–36h and that ten-hour observation is not comparable. Selection therefore reads `post_age_seconds` and never the stored bucket; trusting the label would compare an immature post against settled ones. The two overlap at exactly forty days, where a snapshot is both within the `30d` tolerance and mature — a tolerance may answer yes twice where a partition must choose once.

`import` and `mature` name no moment, so closeness to a target is undefined for them and the most mature observation inside the window is selected instead. Where two observations are equidistant from a target, the less mature one wins: it never credits a post with time it had not yet accumulated.

## Baselines and feature comparisons

For feature path/value `f=v` and metric `m`:

- Group: eligible posts whose current analysis has `f=v` with at least medium field confidence unless the feature is deterministic/user-supplied.
- Primary comparison: eligible posts with another known value for `f`; unknown/unavailable is excluded and counted in limitations.
- Optional matched comparison: same account, snapshot-age bucket, publication period and content category/format where sample permits.
- Group and comparison medians are primary; interquartile ranges are shown.
- Effect is ratio/difference of medians. Bootstrap the difference/ratio with a seeded deterministic routine and store the interval/configuration.
- Run leave-one-out sensitivity and a “remove best and worst” sensitivity when the sample allows.

Continuous features such as duration are displayed in predefined versioned bands for explainability (example: `<15s`, `15–29s`, `30–44s`, `45–59s`, `60–89s`, `90s+`) and may also use rank correlation as a secondary statistic. Do not search arbitrary cut points and present the best one without multiple-testing correction.

## Minimum samples and confidence classification

Rules apply per feature value, metric, account, period and snapshot-age cohort. They are conservative defaults subject to validation with real volume.

### Insufficient evidence

- Group `n < 3`, comparison `n < 5`, fewer than three distinct publication dates, or more than 40% of otherwise eligible posts lack the metric/feature.
- Display descriptive individual posts only; strategy language says evidence is insufficient.

### Single high-performing outlier

- Group has one eligible post, or a top post contributes more than 50% of the group total for count metrics, or effect direction/magnitude collapses when the top post is removed.
- Show in an outlier section. Never convert it into a general pattern.

### Weak directional signal

- At least group `n >= 3` and comparison `n >= 5`.
- Median direction is observable and practically non-trivial (default absolute median difference >=10% for relative metrics), but uncertainty includes no difference, sample is below stronger thresholds, or sensitivity changes materiality while keeping direction.
- Language: “A weak directional signal in this account; test further.”

### Moderate association

- Group `n >= 8`, comparison `n >= 12`, total `n >= 20`.
- Absolute median difference >=10%; seeded 80% bootstrap interval excludes no difference; leave-one-out keeps direction; missingness/outlier checks pass.
- Language: “A moderate observed association,” not “statistically significant” or causal.

### Statistically supported association

- Group `n >= 12`, comparison `n >= 24`, at least six distinct publication weeks and no single content campaign dominates the group.
- Absolute median difference >=10%; 95% bootstrap interval excludes no difference.
- Benjamini–Hochberg false-discovery control at `q < 0.10` within the generated comparison family when many features are tested.
- Leave-one-out and remove-best/worst checks preserve direction and at least half the effect threshold.
- Language: “Statistically supported association in the selected Studio Parallel history; this does not establish causation.”

“Strong” UI badges map only to the statistically supported class. Model field confidence never upgrades statistical evidence.

## Time period and recency

- Default proposed view: previous 180 publication days using the most mature comparable bucket with adequate coverage.
- Also show previous 90 days for recent context; never compare overlapping windows as independent evidence.
- Changes in posting cadence, audience size, campaigns and account context are limitations. Store follower count at/near snapshot when available, but do not divide by current followers for historical rates.
- Recency weighting is not used in inferential statistics. Strategy retrieval can deliberately include recent posts as context and label them.

## Outlier and data-quality treatment

- Do not automatically delete viral/weak posts. Show full results plus sensitivity results.
- Flag impossible negatives, decreasing cumulative metrics, provider definition changes, missing units, source-video duration mismatch and suspicious duplicate snapshots.
- A cumulative count may fall after provider correction; retain both observations and flag rather than rewriting history.
- Exclude boosted/paid-derived metrics when the provider definition cannot separate them; document that exclusion/incompatibility.
- Exclude analyses with low overall quality or unknown target feature from that feature comparison, while counting the exclusion.

## Trend record and display contract

Every `AccountFeatureStatistic`/trend exposes:

- feature path and human label;
- feature value;
- canonical metric and exact formula/denominator;
- group and comparison sample sizes;
- comparison group definition;
- group and baseline medians/IQR;
- absolute and relative difference;
- publication and snapshot-age periods;
- confidence classification and reason;
- uncertainty and multiple-test method where applicable;
- outlier/sensitivity/missingness notes;
- relevant post, snapshot and analysis identifiers;
- analytics version and calculation time.

Charts require a table/text equivalent and distinguish unavailable from zero.

## Recalculation

Trigger account-scoped recalculation after a current analysis change, new/revised comparable snapshot, feature taxonomy mapping change or analytics version activation. Debounce bursts into one job. Build results into a new calculation run, validate counts/fingerprints, then atomically publish the run so the UI never sees half-recalculated statistics.

Historical statistics referenced by a stored strategy remain immutable. New analytics versions do not retroactively rewrite old strategy evidence.

## Fixed-dataset tests

Fixtures must cover missing/zero denominators, views-versus-plays separation, snapshot-age selection, median/ratio math, all rate formulas, >100% watch, outliers, tied values, tiny samples, category comparison, deterministic bootstrap, multiple testing, missingness thresholds, source-duration mismatch and atomic version publication. Expected values are reviewed by a second person before launch.
