import type { PrismaClient } from "./generated/prisma/client.js";
import type { WorkspaceContext } from "./workspace-context.js";

export type WorkspaceDashboardFoundation = Readonly<{
  checkedAt: Date;
  workspaceId: string;
  workspaceUpdatedAt: Date;
}>;

export async function loadWorkspaceDashboardFoundation(
  database: PrismaClient,
  context: WorkspaceContext,
  checkedAt: Date = new Date(),
): Promise<WorkspaceDashboardFoundation | null> {
  const workspace = await database.workspace.findFirst({
    select: { id: true, updatedAt: true },
    where: { id: context.workspaceId, status: "ACTIVE" },
  });

  return workspace
    ? Object.freeze({
        checkedAt,
        workspaceId: workspace.id,
        workspaceUpdatedAt: workspace.updatedAt,
      })
    : null;
}
