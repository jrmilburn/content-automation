# Observability foundation

`@studio-parallel/observability` is the shared diagnostics boundary for the web and worker
processes. It deliberately exposes narrow structured contracts instead of accepting arbitrary
objects.

## Correlation

Create a web request context from request headers, then derive the domain-command and worker-event
contexts from it:

```ts
const request = createWebRequestContext(headers);
const command = createDomainCommandContext(request, { workspaceId, postId });
const workerEvent = createWorkerEventContext(command, { jobId, attempt });
```

Only a valid UUID `x-correlation-id` is accepted from a caller. Otherwise a new UUID is generated.
Resource identifiers are limited to short opaque values safe for operational output.

## Logs and monitoring

Every JSON log includes timestamp, level, service, environment, release, event, stage and a
correlation ID. Optional fields are an explicit allowlist of opaque resource IDs, bounded numeric
status/duration values and fixed operational classifications. Unknown fields are discarded at
runtime as a secondary safeguard.

Raw request/provider/model bodies, headers, cookies, URLs, tokens, prompts, transcripts, video
content and exception messages/stacks are not accepted by the logger or monitoring transport.
Provider request IDs must be opaque IDs, never URLs. Add a new field only after confirming it is
content-free and extending the redaction canary tests.

`OperationalError` carries a fixed uppercase code, class, HTTP status and retry disposition.
Validation, authorisation, not-found, conflict and rate-limit errors are expected: `reportError`
records a bounded warning and does not send them to error monitoring. Unexpected/dependency errors
are reduced to safe classifications before the configured monitoring transport receives them.
Each monitor is constructed with one service, environment and immutable release.

## Metrics and health

Metric hooks accept only the names exported in `metricNames`, a non-negative numeric sample,
fixed units and the same safe correlation/resource context. The default web and worker hooks emit
these as structured `metric.recorded` events until a dedicated metrics sink is selected.

Web and worker expose `/health/live` and `/health/ready`. The readiness endpoint currently proves
the typed process configuration skeleton; database and queue checks can be added when those
runtime adapters are wired. Responses expose only fixed check states and never environment,
release, ports, URLs, provider mode or secret/configuration values.
