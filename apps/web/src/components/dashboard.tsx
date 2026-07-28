import {
  orderDashboardAttentionItems,
  type DashboardAction,
  type DashboardAttentionPriority,
  type DashboardAttentionSummary,
  type DashboardCoverageSummary,
  type DashboardIntegrationSummary,
  type DashboardMetric,
  type DashboardProcessingSummary,
  type DashboardSection,
  type DashboardStrategySummary,
  type DashboardSummary,
} from "@studio-parallel/domain";
import Link from "next/link";
import type { ReactNode } from "react";

import { PageHeader } from "./page-header";
import { StatusBadge, type StatusTone } from "./status-badge";

const sectionLabels = {
  attention: "02 / Manual attention",
  coverage: "04 / Coverage and performance",
  processing: "05 / Processing activity",
  strategy: "03 / Strategy and next videos",
} as const;

const priorityLabels: Record<DashboardAttentionPriority, string> = {
  blocking: "Blocking",
  information: "Information",
  manual_action: "Manual action",
  security: "Security",
};

const priorityTones: Record<DashboardAttentionPriority, StatusTone> = {
  blocking: "danger",
  information: "information",
  manual_action: "warning",
  security: "danger",
};

export function Dashboard({ summary }: Readonly<{ summary: DashboardSummary }>) {
  return (
    <div className="page-stack dashboard">
      <PageHeader
        action={
          <p className="dashboard-checked">
            Summary checked{" "}
            <time dateTime={summary.generatedAt}>{formatDashboardTime(summary.generatedAt)}</time>
          </p>
        }
        description="Workspace readiness, required attention and the safest next action."
        title="Dashboard"
      />

      <IntegrationDispatch section={summary.integration} />

      <div className="dashboard-ledger">
        <DashboardRegion
          label={sectionLabels.attention}
          section={summary.attention}
          title="Work requiring attention"
        >
          {(data) => <AttentionContent data={data} />}
        </DashboardRegion>
        <DashboardRegion
          label={sectionLabels.strategy}
          section={summary.strategy}
          title="Current strategy"
        >
          {(data) => <StrategyContent data={data} />}
        </DashboardRegion>
        <DashboardRegion
          label={sectionLabels.coverage}
          section={summary.coverage}
          title="Evidence coverage"
        >
          {(data) => <CoverageContent data={data} />}
        </DashboardRegion>
        <DashboardRegion
          label={sectionLabels.processing}
          section={summary.processing}
          title="Recent processing"
        >
          {(data) => <ProcessingContent data={data} />}
        </DashboardRegion>
      </div>
    </div>
  );
}

function IntegrationDispatch({
  section,
}: Readonly<{ section: DashboardSection<DashboardIntegrationSummary> }>) {
  if (section.state !== "available") {
    return (
      <section aria-labelledby="integration-heading" className="dashboard-dispatch">
        <p className="dashboard-sequence">01 / Integration health</p>
        <h2 id="integration-heading">Instagram account</h2>
        <SectionState section={section} />
      </section>
    );
  }

  const tone = section.data.status === "healthy" ? "success" : "warning";
  const heading =
    section.data.status === "not_connected"
      ? "Connect an Instagram account"
      : (section.data.accountName ?? "Instagram account");

  return (
    <section
      aria-labelledby="integration-heading"
      className={`dashboard-dispatch dashboard-dispatch--${section.data.status}`}
    >
      <div className="dashboard-dispatch__body">
        <p className="dashboard-sequence">01 / Integration health</p>
        <StatusBadge tone={tone}>{section.data.statusLabel}</StatusBadge>
        <h2 id="integration-heading">{heading}</h2>
        <p>{section.data.description}</p>
        <ActionLink action={section.data.action} primary />
      </div>
      <Freshness section={section} />
    </section>
  );
}

function DashboardRegion<T>({
  children,
  label,
  section,
  title,
}: Readonly<{
  children: (data: T) => ReactNode;
  label: string;
  section: DashboardSection<T>;
  title: string;
}>) {
  const headingId = `dashboard-${label.slice(0, 2)}-heading`;

  return (
    <section aria-labelledby={headingId} className="dashboard-region">
      <header className="dashboard-region__header">
        <div>
          <p className="dashboard-sequence">{label}</p>
          <h2 id={headingId}>{title}</h2>
        </div>
        {section.state === "available" ? <Freshness section={section} /> : null}
      </header>
      {section.state === "available" ? children(section.data) : <SectionState section={section} />}
    </section>
  );
}

function SectionState<T>({
  section,
}: Readonly<{ section: Exclude<DashboardSection<T>, { state: "available" }> }>) {
  if (section.state === "loading") {
    return (
      <div aria-busy="true" aria-live="polite" className="dashboard-region__state">
        <StatusBadge tone="information">Loading</StatusBadge>
        <p>{section.label}</p>
        <span aria-hidden="true" className="dashboard-loading-rule" />
      </div>
    );
  }

  if (section.state === "error") {
    return (
      <div aria-live="polite" className="dashboard-region__state dashboard-region__state--error">
        <StatusBadge tone="danger">Section unavailable</StatusBadge>
        <p>{section.message}</p>
        {section.reference ? (
          <p className="dashboard-reference">
            Reference <code>{section.reference}</code>
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="dashboard-region__state">
      <StatusBadge>Unavailable</StatusBadge>
      <p>{section.reason}</p>
    </div>
  );
}

function Freshness<T>({
  section,
}: Readonly<{ section: Extract<DashboardSection<T>, { state: "available" }> }>) {
  return (
    <div className="dashboard-freshness">
      <StatusBadge tone={section.isStale ? "warning" : "neutral"}>
        {section.isStale ? "Stale" : "Current"}
      </StatusBadge>
      <time dateTime={section.updatedAt}>{formatDashboardTime(section.updatedAt)}</time>
    </div>
  );
}

function AttentionContent({ data }: Readonly<{ data: DashboardAttentionSummary }>) {
  const items = orderDashboardAttentionItems(data.items);

  return items.length ? (
    <ol className="attention-list">
      {items.map((item) => (
        <li className="attention-item" key={item.id}>
          <div>
            <StatusBadge tone={priorityTones[item.priority]}>
              {priorityLabels[item.priority]}
            </StatusBadge>
            <h3>{item.title}</h3>
            <p>{item.detail}</p>
          </div>
          {item.action ? <ActionLink action={item.action} /> : null}
        </li>
      ))}
    </ol>
  ) : (
    <p className="dashboard-region__quiet">No manual attention is required.</p>
  );
}

function StrategyContent({ data }: Readonly<{ data: DashboardStrategySummary }>) {
  return (
    <div className="dashboard-summary-copy">
      <div>
        <p className="dashboard-kicker">{data.recommendationCount} next-video recommendations</p>
        <h3>{data.headline}</h3>
        <p>{data.description}</p>
      </div>
      {data.action ? <ActionLink action={data.action} /> : null}
    </div>
  );
}

function CoverageContent({ data }: Readonly<{ data: DashboardCoverageSummary }>) {
  return (
    <div className="dashboard-measure-block">
      <MetricList metrics={data.metrics} />
      <p className="dashboard-region__quiet">{data.performanceSummary}</p>
    </div>
  );
}

function ProcessingContent({ data }: Readonly<{ data: DashboardProcessingSummary }>) {
  return (
    <div className="dashboard-measure-block">
      <MetricList metrics={data.metrics} />
      <p className="dashboard-region__quiet">{data.activitySummary}</p>
    </div>
  );
}

function MetricList({ metrics }: Readonly<{ metrics: ReadonlyArray<DashboardMetric> }>) {
  return (
    <dl className="dashboard-metrics">
      {metrics.map((metric) => (
        <div key={metric.label}>
          <dt>{metric.label}</dt>
          <dd>
            {metric.action ? (
              <Link href={metric.action.href}>
                {metric.value} <span>{metric.action.label}</span>
              </Link>
            ) : (
              metric.value
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function ActionLink({
  action,
  primary = false,
}: Readonly<{ action: DashboardAction; primary?: boolean }>) {
  return (
    <Link className={`button button--${primary ? "primary" : "secondary"}`} href={action.href}>
      {action.label}
    </Link>
  );
}

function formatDashboardTime(value: string): string {
  return new Intl.DateTimeFormat("en-AU", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Australia/Sydney",
  }).format(new Date(value));
}
