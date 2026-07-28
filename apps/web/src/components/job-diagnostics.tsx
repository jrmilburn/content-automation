import type {
  JobDiagnosticDetail,
  JobDiagnosticList,
  JobDiagnosticListItem,
} from "@studio-parallel/db";
import Link from "next/link";

import {
  formatIdentifier,
  formatJobDate,
  presentJobState,
  queueFilterOptions,
  queueLabel,
  resolveJobResourceHref,
  stateFilterOptions,
  type OperationsFilterValues,
} from "../lib/job-diagnostics";
import { JobActionControls } from "./job-action-controls";
import { JobLiveRefresh } from "./job-live-refresh";
import { PageHeader } from "./page-header";
import { EmptyState, ErrorSummary } from "./states";
import { StatusBadge } from "./status-badge";

export function OperationsList({
  snapshot,
  values,
}: Readonly<{ snapshot: JobDiagnosticList; values: OperationsFilterValues }>) {
  const hasFilters =
    values.attention !== "all" ||
    values.queueName !== "all" ||
    values.resource !== "" ||
    values.state !== "all";

  return (
    <div className="page-stack operations-page">
      <PageHeader
        action={
          <JobLiveRefresh fingerprint={snapshot.fingerprint} generatedAt={snapshot.generatedAt} />
        }
        description="Find active work, inspect safe diagnostic evidence and take the available bounded action."
        title="Operations"
      />

      <OperationsFilters values={values} />

      {snapshot.jobs.length ? (
        <section aria-labelledby="operations-jobs-heading" className="operations-results">
          <header className="operations-results__header">
            <div>
              <p className="operations-sequence">Processing ledger</p>
              <h2 id="operations-jobs-heading">Current jobs</h2>
            </div>
            <p aria-live="polite">
              {snapshot.totalCount} {snapshot.totalCount === 1 ? "job" : "jobs"}
              {snapshot.isTruncated ? "; showing the 100 most recent" : ""}
            </p>
          </header>
          <ol className="job-ledger">
            {snapshot.jobs.map((job) => (
              <JobLedgerItem job={job} key={job.id} />
            ))}
          </ol>
        </section>
      ) : (
        <EmptyState
          {...(hasFilters ? { action: { href: "/operations", label: "Clear filters" } } : {})}
          description={
            hasFilters
              ? "Try a broader state, job type, attention status or resource identifier."
              : "Queued, active, retried and completed work will appear here when processing begins."
          }
          title={hasFilters ? "No jobs match these filters" : "No background work yet"}
        />
      )}
    </div>
  );
}

export function OperationsError({ reference }: Readonly<{ reference: string }>) {
  return (
    <div className="page-stack operations-page">
      <PageHeader
        description="Find active work, inspect safe diagnostic evidence and take the available bounded action."
        title="Operations"
      />
      <ErrorSummary
        action={{ href: "/operations", label: "Try again" }}
        correlationId={reference}
        description="Job information could not be loaded. Existing workspace data is unchanged and remains safe."
        title="Operations did not load"
      />
    </div>
  );
}

export function JobDetail({
  generatedAt,
  job,
}: Readonly<{ generatedAt: string; job: JobDiagnosticDetail }>) {
  const presentation = presentJobState(job);
  const resourceHref = resolveJobResourceHref(job.resourceType, job.resourceId);
  const fingerprint = `${job.id}:${job.version}:${job.state}`;

  return (
    <div className="page-stack job-detail-page">
      <PageHeader
        action={
          <Link className="button button--secondary" href="/operations">
            Back to jobs
          </Link>
        }
        description={`${queueLabel(job.queueName)} · safe diagnostic record`}
        title="Job detail"
      />

      <div className="job-detail-refresh">
        <JobLiveRefresh fingerprint={fingerprint} generatedAt={generatedAt} />
      </div>

      <section
        aria-labelledby="job-state-heading"
        className={`job-state-panel job-state-panel--${presentation.tone}`}
      >
        <div className="job-state-panel__summary">
          <p className="operations-sequence">Current state</p>
          <StatusBadge tone={presentation.tone}>{presentation.label}</StatusBadge>
          <h2 id="job-state-heading">{queueLabel(job.queueName)}</h2>
          <p>{presentation.description}</p>
          {job.nextAttemptAt ? (
            <p>
              Next retry{" "}
              <time dateTime={job.nextAttemptAt}>{formatJobDate(job.nextAttemptAt)}</time>
            </p>
          ) : null}
        </div>
        <div className="job-state-panel__action">
          <JobActionControls cancel={job.cancel} jobId={job.id} retry={job.retry} />
        </div>
      </section>

      {job.safeErrorDetail || job.reconciliationCode ? (
        <section aria-labelledby="job-safe-detail-heading" className="job-safe-detail">
          <p className="operations-sequence">Safe technical detail</p>
          <h2 id="job-safe-detail-heading">What needs attention</h2>
          {job.safeErrorDetail ? <p>{job.safeErrorDetail}</p> : null}
          <dl className="job-inline-facts">
            <Fact
              label="Error class"
              value={job.lastErrorClass ? formatIdentifier(job.lastErrorClass) : "Not recorded"}
            />
            <Fact code label="Stable error code" value={job.lastErrorCode ?? "Not recorded"} />
            <Fact
              label="Next action"
              value={job.nextAction ? formatIdentifier(job.nextAction) : "Review with an operator"}
            />
            {job.reconciliationCode ? (
              <Fact code label="Consistency flag" value={job.reconciliationCode} />
            ) : null}
          </dl>
        </section>
      ) : null}

      <section aria-labelledby="job-progress-heading" className="job-detail-section">
        <header>
          <p className="operations-sequence">01 / Progress and timing</p>
          <h2 id="job-progress-heading">Execution record</h2>
        </header>
        <dl className="job-detail-grid">
          <Fact label="Stage" value={formatIdentifier(job.stage)} />
          <Fact label="Attempts" value={`${job.attemptCount} of ${job.maxAttempts}`} />
          <Fact date label="Queued" value={job.queuedAt} />
          <Fact date label="Started" value={job.startedAt} />
          <Fact date label="Next retry" value={job.nextAttemptAt} />
          <Fact date label="Completed" value={job.completedAt} />
        </dl>
      </section>

      <section aria-labelledby="job-evidence-heading" className="job-detail-section">
        <header>
          <p className="operations-sequence">02 / Resource and versions</p>
          <h2 id="job-evidence-heading">Owned evidence</h2>
        </header>
        <dl className="job-detail-grid">
          <Fact
            label="Resource type"
            value={job.resourceType ? formatIdentifier(job.resourceType) : "No resource recorded"}
          />
          <Fact code label="Resource ID" value={job.resourceId ?? "No resource recorded"} />
          <Fact label="Handler version" value={`v${job.handlerVersion}`} />
          <Fact label="Input version" value={job.inputVersion ?? "Not recorded"} />
          <Fact label="Record version" value={`v${job.version}`} />
          <Fact code label="Correlation ID" value={job.correlationId} />
        </dl>
        {resourceHref ? (
          <Link className="job-resource-link" href={resourceHref}>
            Open owned resource
          </Link>
        ) : (
          <p className="job-detail-note">
            No safe owned-resource route is registered for this job.
          </p>
        )}
      </section>

      <section aria-labelledby="job-usage-heading" className="job-detail-section">
        <header>
          <p className="operations-sequence">03 / Provider usage</p>
          <h2 id="job-usage-heading">Usage summary</h2>
        </header>
        {Object.values(job.usage).every((value) => value === null) ? (
          <p className="job-detail-note">
            No provider usage was recorded for this job. This does not expose provider requests or
            payloads.
          </p>
        ) : (
          <dl className="job-detail-grid">
            <Fact label="Provider requests" value={String(job.usage.providerRequests ?? 0)} />
            <Fact label="Input tokens" value={String(job.usage.inputTokens ?? 0)} />
            <Fact label="Output tokens" value={String(job.usage.outputTokens ?? 0)} />
            <Fact
              label="Estimated cost"
              value={formatEstimatedCost(job.usage.estimatedCostMicros)}
            />
          </dl>
        )}
      </section>

      <section aria-labelledby="job-attempts-heading" className="job-detail-section">
        <header>
          <p className="operations-sequence">04 / Attempts</p>
          <h2 id="job-attempts-heading">Attempt history</h2>
        </header>
        {job.attempts.length ? (
          <ol className="job-attempts">
            {job.attempts.map((attempt) => (
              <li key={attempt.attemptNumber}>
                <div className="job-attempts__heading">
                  <h3>Attempt {attempt.attemptNumber}</h3>
                  <StatusBadge tone={attempt.state === "SUCCEEDED" ? "success" : "neutral"}>
                    {formatIdentifier(attempt.state)}
                  </StatusBadge>
                </div>
                <dl className="job-inline-facts">
                  <Fact label="Stage" value={formatIdentifier(attempt.stage)} />
                  <Fact date label="Started" value={attempt.startedAt} />
                  <Fact date label="Completed" value={attempt.completedAt} />
                  <Fact code label="Safe error" value={attempt.errorCode ?? "No error recorded"} />
                </dl>
              </li>
            ))}
          </ol>
        ) : (
          <p className="job-detail-note">No worker attempt has started.</p>
        )}
      </section>
    </div>
  );
}

function OperationsFilters({ values }: Readonly<{ values: OperationsFilterValues }>) {
  return (
    <section aria-labelledby="operations-filters-heading" className="operations-filters">
      <div className="operations-filters__heading">
        <div>
          <p className="operations-sequence">Filter the ledger</p>
          <h2 id="operations-filters-heading">Find work</h2>
        </div>
        <Link href="/operations">Clear all</Link>
      </div>
      <form action="/operations" className="operations-filter-form" method="get">
        <label>
          <span>State</span>
          <select defaultValue={values.state} name="state">
            <option value="all">All states</option>
            {stateFilterOptions.map(({ label, value }) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Job type</span>
          <select defaultValue={values.queueName} name="type">
            <option value="all">All job types</option>
            {queueFilterOptions.map(({ label, value }) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Manual attention</span>
          <select defaultValue={values.attention} name="attention">
            <option value="all">All jobs</option>
            <option value="required">Needs attention</option>
            <option value="clear">No attention needed</option>
          </select>
        </label>
        <label className="operations-filter-form__resource">
          <span>Account or resource ID</span>
          <input
            autoComplete="off"
            defaultValue={values.resource}
            inputMode="text"
            name="resource"
            placeholder="UUID"
          />
        </label>
        <button className="button button--primary" type="submit">
          Apply filters
        </button>
      </form>
    </section>
  );
}

function JobLedgerItem({ job }: Readonly<{ job: JobDiagnosticListItem }>) {
  const presentation = presentJobState(job);
  return (
    <li>
      <article className="job-ledger-item">
        <div className="job-ledger-item__lead">
          <StatusBadge tone={presentation.tone}>{presentation.label}</StatusBadge>
          <h3>
            <Link href={`/operations/jobs/${job.id}`}>{queueLabel(job.queueName)}</Link>
          </h3>
          <p>{presentation.description}</p>
        </div>
        <dl className="job-ledger-item__facts">
          <Fact label="Stage" value={formatIdentifier(job.stage)} />
          <Fact label="Attempts" value={`${job.attemptCount} / ${job.maxAttempts}`} />
          <Fact
            label={job.nextAttemptAt ? "Next retry" : "Updated"}
            value={formatJobDate(job.nextAttemptAt ?? job.updatedAt)}
          />
          <Fact label="Resource" value={compactResource(job)} />
        </dl>
        <Link
          className="button button--secondary job-ledger-item__open"
          href={`/operations/jobs/${job.id}`}
        >
          View detail
        </Link>
      </article>
    </li>
  );
}

function Fact({
  code = false,
  date = false,
  label,
  value,
}: Readonly<{
  code?: boolean;
  date?: boolean;
  label: string;
  value: string | null;
}>) {
  const display = date ? formatJobDate(value) : (value ?? "Not recorded");
  return (
    <div>
      <dt>{label}</dt>
      <dd className={code ? "job-identifier" : undefined}>
        {date && value ? (
          <time dateTime={value}>{display}</time>
        ) : code && value ? (
          <code>{display}</code>
        ) : (
          display
        )}
      </dd>
    </div>
  );
}

function formatEstimatedCost(micros: number | null): string {
  if (micros === null) return "Not recorded";
  return new Intl.NumberFormat("en-AU", {
    currency: "USD",
    style: "currency",
  }).format(micros / 1_000_000);
}

function compactResource(job: JobDiagnosticListItem): string {
  if (!job.resourceId) return "No resource recorded";
  const type = job.resourceType ? formatIdentifier(job.resourceType) : "Resource";
  return `${type} · …${job.resourceId.slice(-8)}`;
}
