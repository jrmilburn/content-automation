import { validate as validateUuid } from "uuid";

import type { SessionPrincipal } from "./auth.js";

export class WorkspaceResourceNotFoundError extends Error {
  readonly code = "RESOURCE_NOT_FOUND";

  constructor() {
    super("Resource not found");
    this.name = "WorkspaceResourceNotFoundError";
  }
}

export async function requireWorkspaceResource<T>(
  principal: SessionPrincipal,
  resourceId: string,
  load: (scope: Readonly<{ id: string; workspaceId: string }>) => Promise<T | null>,
): Promise<T> {
  if (!validateUuid(resourceId)) {
    throw new WorkspaceResourceNotFoundError();
  }

  const resource = await load({ id: resourceId, workspaceId: principal.workspaceId });

  if (!resource) {
    throw new WorkspaceResourceNotFoundError();
  }

  return resource;
}
