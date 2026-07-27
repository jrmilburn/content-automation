import { validate as validateUuid } from "uuid";

export type WorkspaceContext = Readonly<{
  workspaceId: string;
}>;

export function createWorkspaceContext(workspaceId: string): WorkspaceContext {
  if (!validateUuid(workspaceId)) {
    throw new TypeError("workspaceId must be a valid UUID");
  }

  return Object.freeze({ workspaceId });
}
