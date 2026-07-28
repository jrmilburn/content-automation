export const dashboardAttentionPriorities = [
  "blocking",
  "security",
  "manual_action",
  "information",
] as const;

export type DashboardAttentionPriority = (typeof dashboardAttentionPriorities)[number];

export type DashboardAction = Readonly<{
  href: string;
  label: string;
}>;

export type DashboardSection<T> =
  | Readonly<{
      data: T;
      isStale: boolean;
      state: "available";
      updatedAt: string;
    }>
  | Readonly<{
      label: string;
      state: "loading";
    }>
  | Readonly<{
      message: string;
      reference?: string;
      state: "error";
    }>
  | Readonly<{
      reason: string;
      state: "unavailable";
    }>;

export type DashboardIntegrationSummary = Readonly<{
  accountName?: string;
  action: DashboardAction;
  description: string;
  status: "not_connected" | "healthy" | "action_required";
  statusLabel: string;
}>;

export type DashboardAttentionItem = Readonly<{
  action?: DashboardAction;
  detail: string;
  id: string;
  priority: DashboardAttentionPriority;
  title: string;
}>;

export type DashboardAttentionSummary = Readonly<{
  items: ReadonlyArray<DashboardAttentionItem>;
}>;

export type DashboardStrategySummary = Readonly<{
  action?: DashboardAction;
  description: string;
  headline: string;
  recommendationCount: number;
}>;

export type DashboardMetric = Readonly<{
  action?: DashboardAction;
  label: string;
  value: number;
}>;

export type DashboardCoverageSummary = Readonly<{
  metrics: ReadonlyArray<DashboardMetric>;
  performanceSummary: string;
}>;

export type DashboardProcessingSummary = Readonly<{
  activitySummary: string;
  metrics: ReadonlyArray<DashboardMetric>;
}>;

export type DashboardSummary = Readonly<{
  attention: DashboardSection<DashboardAttentionSummary>;
  coverage: DashboardSection<DashboardCoverageSummary>;
  generatedAt: string;
  integration: DashboardSection<DashboardIntegrationSummary>;
  processing: DashboardSection<DashboardProcessingSummary>;
  strategy: DashboardSection<DashboardStrategySummary>;
}>;

const attentionPriorityRank = new Map(
  dashboardAttentionPriorities.map((priority, index) => [priority, index] as const),
);

export function orderDashboardAttentionItems(
  items: ReadonlyArray<DashboardAttentionItem>,
): ReadonlyArray<DashboardAttentionItem> {
  return items
    .map((item, originalIndex) => ({ item, originalIndex }))
    .sort((left, right) => {
      const priorityDifference =
        (attentionPriorityRank.get(left.item.priority) ?? Number.MAX_SAFE_INTEGER) -
        (attentionPriorityRank.get(right.item.priority) ?? Number.MAX_SAFE_INTEGER);

      return priorityDifference || left.originalIndex - right.originalIndex;
    })
    .map(({ item }) => item);
}

export function createAvailableDashboardSection<T>(
  data: T,
  updatedAt: Date,
  now: Date,
  staleAfterMilliseconds = 60 * 60 * 1000,
): DashboardSection<T> {
  if (!Number.isFinite(staleAfterMilliseconds) || staleAfterMilliseconds < 0) {
    throw new TypeError("staleAfterMilliseconds must be a non-negative finite number");
  }

  return Object.freeze({
    data,
    isStale: now.getTime() - updatedAt.getTime() > staleAfterMilliseconds,
    state: "available",
    updatedAt: updatedAt.toISOString(),
  });
}
