import "server-only";

import { loadAuthConfig } from "@studio-parallel/config";
import {
  createWorkspaceContext,
  findActiveAdminPrincipal,
  listInstagramAccountSummaries,
} from "@studio-parallel/db";

import type { IntegrationAccountView } from "../instagram-integration";
import { getDatabase } from "./database";
import { requireShellActor } from "./shell-session";

/**
 * Loads the safe integration snapshot for the settings screen.
 *
 * `canManage` decides whether the connect and disconnect controls render. It is
 * a presentation convenience only — every action re-authorises server-side, so
 * a caller who forges their way past a hidden control is still refused.
 */

export type IntegrationsSnapshot = Readonly<{
  accounts: readonly IntegrationAccountView[];
  canManage: boolean;
}>;

export async function loadInstagramIntegrations(now = new Date()): Promise<IntegrationsSnapshot> {
  const principal = await requireShellActor();
  if (loadAuthConfig().APP_ENV === "test") return testSnapshot();

  const database = getDatabase();
  const context = createWorkspaceContext(principal.workspaceId);

  const [summaries, admin] = await Promise.all([
    listInstagramAccountSummaries(database, context, { now }),
    findActiveAdminPrincipal(database, principal),
  ]);

  return Object.freeze({
    accounts: Object.freeze(
      summaries.map((summary) =>
        Object.freeze({
          accountId: summary.accountId,
          accountType: summary.accountType,
          apiVersion: summary.apiVersion,
          connectionStatus: summary.connectionStatus,
          expiresAt: summary.expiresAt,
          grantedScopes: summary.grantedScopes,
          healthState: summary.health.state,
          lastSuccessfulSyncAt: summary.lastSuccessfulSyncAt,
          lastValidatedAt: summary.lastValidatedAt,
          username: summary.username,
        }),
      ),
    ),
    canManage: admin !== null,
  });
}

/**
 * Browser tests run without a database, so they render a fixed snapshot that
 * deliberately puts a healthy, a degraded and a blocked account on the page at
 * once. That is what makes "the states are visually distinct" testable.
 */
function testSnapshot(): IntegrationsSnapshot {
  return Object.freeze({
    accounts: Object.freeze([
      Object.freeze({
        accountId: "019a0000-0000-7000-8000-000000000301",
        accountType: "BUSINESS",
        apiVersion: "v25.0",
        connectionStatus: "ACTIVE",
        expiresAt: new Date("2026-09-20T00:00:00.000Z"),
        grantedScopes: Object.freeze([
          "instagram_business_basic",
          "instagram_business_manage_insights",
        ]),
        healthState: "HEALTHY" as const,
        lastSuccessfulSyncAt: new Date("2026-07-31T02:00:00.000Z"),
        lastValidatedAt: new Date("2026-07-31T02:00:00.000Z"),
        username: "studioparallel",
      }),
      Object.freeze({
        accountId: "019a0000-0000-7000-8000-000000000302",
        accountType: "CREATOR",
        apiVersion: "v25.0",
        connectionStatus: "ACTIVE",
        expiresAt: new Date("2026-08-03T00:00:00.000Z"),
        grantedScopes: Object.freeze([
          "instagram_business_basic",
          "instagram_business_manage_insights",
        ]),
        healthState: "EXPIRING" as const,
        lastSuccessfulSyncAt: new Date("2026-07-30T21:30:00.000Z"),
        lastValidatedAt: new Date("2026-07-30T21:30:00.000Z"),
        username: "parallelstudio",
      }),
      Object.freeze({
        accountId: "019a0000-0000-7000-8000-000000000303",
        accountType: "BUSINESS",
        apiVersion: "v25.0",
        connectionStatus: "REAUTHORISATION_REQUIRED",
        expiresAt: null,
        grantedScopes: Object.freeze(["instagram_business_basic"]),
        healthState: "REAUTHORISATION_REQUIRED" as const,
        lastSuccessfulSyncAt: new Date("2026-07-24T09:15:00.000Z"),
        lastValidatedAt: new Date("2026-07-29T11:00:00.000Z"),
        username: "parallel.archive",
      }),
    ]),
    canManage: true,
  });
}
