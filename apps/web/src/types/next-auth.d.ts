import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user?: DefaultSession["user"] & {
      id: string;
      internalUserId: string;
      sessionVersion: number;
      workspaceId: string;
    };
  }

  interface User {
    internalUserId?: string;
    sessionVersion?: number;
    workspaceId?: string;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    internalUserId?: string;
    sessionStartedAt?: number;
    sessionVersion?: number;
    workspaceId?: string;
  }
}
