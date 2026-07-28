import "server-only";

import { loadAuthConfig } from "@studio-parallel/config";
import {
  createWorkspaceContext,
  loadWorkspaceDashboardFoundation,
  type SessionPrincipal,
  type WorkspaceContext,
} from "@studio-parallel/db";
import {
  createAvailableDashboardSection,
  type DashboardAttentionSummary,
  type DashboardCoverageSummary,
  type DashboardIntegrationSummary,
  type DashboardProcessingSummary,
  type DashboardSection,
  type DashboardStrategySummary,
  type DashboardSummary,
} from "@studio-parallel/domain";
import { createWebRequestContext, reportError } from "@studio-parallel/observability";
import { headers } from "next/headers";

import { getDatabase } from "./database";
import { webErrorMonitor, webLogger } from "./observability";
import { requireShellActor } from "./shell-session";

type DashboardSource<T> = (context: WorkspaceContext, now: Date) => Promise<DashboardSection<T>>;

type DashboardSources = Readonly<{
  attention: DashboardSource<DashboardAttentionSummary>;
  coverage: DashboardSource<DashboardCoverageSummary>;
  integration: DashboardSource<DashboardIntegrationSummary>;
  processing: DashboardSource<DashboardProcessingSummary>;
  strategy: DashboardSource<DashboardStrategySummary>;
}>;

const unavailableSources = {
  attention: unavailable<DashboardAttentionSummary>(
    "Manual attention will appear after an Instagram account and imported posts are available.",
  ),
  coverage: unavailable<DashboardCoverageSummary>(
    "Post performance and analysis coverage require imported posts and completed analyses.",
  ),
  processing: unavailable<DashboardProcessingSummary>(
    "Processing activity will appear after the first account sync or analysis job starts.",
  ),
  strategy: unavailable<DashboardStrategySummary>(
    "A current strategy requires enough imported, analysed and comparable posts.",
  ),
} as const;

export async function loadDashboardSummary(): Promise<DashboardSummary> {
  const principal = await requireShellActor();
  const config = loadAuthConfig();
  const now = new Date();
  const requestContext = createWebRequestContext(await headers());
  const sources =
    config.APP_ENV === "test" ? createTestDashboardSources() : createProductionDashboardSources();

  return assembleDashboardSummary(principal, sources, now, requestContext.correlationId);
}

async function assembleDashboardSummary(
  principal: SessionPrincipal,
  sources: DashboardSources,
  now: Date,
  correlationId: ReturnType<typeof createWebRequestContext>["correlationId"],
): Promise<DashboardSummary> {
  const context = createWorkspaceContext(principal.workspaceId);
  const [integration, attention, strategy, coverage, processing] = await Promise.all([
    resolveSection("integration", sources.integration, context, now, correlationId),
    resolveSection("attention", sources.attention, context, now, correlationId),
    resolveSection("strategy", sources.strategy, context, now, correlationId),
    resolveSection("coverage", sources.coverage, context, now, correlationId),
    resolveSection("processing", sources.processing, context, now, correlationId),
  ]);

  return Object.freeze({
    attention,
    coverage,
    generatedAt: now.toISOString(),
    integration,
    processing,
    strategy,
  });
}

function createProductionDashboardSources(): DashboardSources {
  return {
    ...unavailableSources,
    integration: async (context, now) => {
      const foundation = await loadWorkspaceDashboardFoundation(getDatabase(), context, now);
      if (!foundation) throw new Error("Active dashboard workspace was not found");

      return createAvailableDashboardSection(
        {
          action: { href: "/accounts", label: "Connect Instagram account" },
          description:
            "Connect an approved professional account before posts, trends and strategy can populate.",
          status: "not_connected",
          statusLabel: "Not connected",
        },
        foundation.checkedAt,
        now,
      );
    },
  };
}

function createTestDashboardSources(): DashboardSources {
  return {
    ...unavailableSources,
    integration: async (_context, now) =>
      createAvailableDashboardSection(
        {
          action: { href: "/accounts", label: "Connect Instagram account" },
          description:
            "Connect an approved professional account before posts, trends and strategy can populate.",
          status: "not_connected",
          statusLabel: "Not connected",
        },
        now,
        now,
      ),
  };
}

async function resolveSection<T>(
  name: keyof DashboardSources,
  source: DashboardSource<T>,
  context: WorkspaceContext,
  now: Date,
  correlationId: ReturnType<typeof createWebRequestContext>["correlationId"],
): Promise<DashboardSection<T>> {
  try {
    return await source(context, now);
  } catch (error) {
    reportError(
      error,
      {
        correlationId,
        event: `dashboard.${name}.failed`,
        stage: "summary",
        workspaceId: context.workspaceId,
      },
      { logger: webLogger, monitor: webErrorMonitor },
    );

    return Object.freeze({
      message: "This summary could not be loaded. Other dashboard information remains available.",
      reference: correlationId,
      state: "error",
    });
  }
}

function unavailable<T>(reason: string): DashboardSource<T> {
  return async () => Object.freeze({ reason, state: "unavailable" });
}
