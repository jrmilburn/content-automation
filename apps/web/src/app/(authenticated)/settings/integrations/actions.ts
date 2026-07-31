"use server";

import { createWebRequestContext, reportError } from "@studio-parallel/observability";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";

import {
  disconnectInstagramAccount,
  type DisconnectResult,
} from "../../../../lib/server/instagram-disconnection";
import {
  requestInstagramSync,
  type SyncRequestResult,
} from "../../../../lib/server/instagram-sync-request";
import { webErrorMonitor, webLogger } from "../../../../lib/server/observability";
import { requireShellActor } from "../../../../lib/server/shell-session";

export type DisconnectActionState = Readonly<{
  message: string;
  reference?: string;
  status: "error" | "idle" | "success";
}>;

/**
 * Disconnects an Instagram account on behalf of an administrator.
 *
 * The action reports outcomes in product language and never surfaces a provider
 * message. A failure it cannot classify returns a correlation reference so the
 * operator has something to quote, which is the only identifier the copy
 * exposes.
 */
export async function disconnectAccountAction(
  _previous: DisconnectActionState,
  formData: FormData,
): Promise<DisconnectActionState> {
  const requestContext = createWebRequestContext(await headers());
  const rawAccountId = formData.get("accountId");
  const accountId = typeof rawAccountId === "string" ? rawAccountId : "";

  try {
    const actor = await requireShellActor();
    const result = await disconnectInstagramAccount({
      accountId,
      actor,
      correlationId: requestContext.correlationId,
    });

    revalidatePath("/settings/integrations");
    return actionResult(result);
  } catch (error) {
    reportError(
      error,
      {
        correlationId: requestContext.correlationId,
        event: "instagram.connection.disconnect_failed",
        stage: "disconnect",
      },
      { logger: webLogger, monitor: webErrorMonitor },
    );

    return Object.freeze({
      message:
        "The account could not be disconnected. Nothing was changed. Try again, and contact an administrator if it keeps failing.",
      reference: requestContext.correlationId,
      status: "error" as const,
    });
  }
}

/**
 * Requests an immediate import for one account.
 *
 * The action only enqueues; the worker owns the import, so the reply says what
 * was scheduled rather than claiming anything has been fetched.
 */
export async function syncAccountAction(
  _previous: DisconnectActionState,
  formData: FormData,
): Promise<DisconnectActionState> {
  const requestContext = createWebRequestContext(await headers());
  const rawAccountId = formData.get("accountId");
  const accountId = typeof rawAccountId === "string" ? rawAccountId : "";

  try {
    const actor = await requireShellActor();
    const result = await requestInstagramSync({
      accountId,
      actor,
      correlationId: requestContext.correlationId,
    });

    revalidatePath("/settings/integrations");
    return syncActionResult(result);
  } catch (error) {
    reportError(
      error,
      {
        correlationId: requestContext.correlationId,
        event: "instagram.sync.request_failed",
        stage: "manual_sync",
      },
      { logger: webLogger, monitor: webErrorMonitor },
    );

    return Object.freeze({
      message:
        "The sync could not be started. Nothing was changed. Try again, and contact an administrator if it keeps failing.",
      reference: requestContext.correlationId,
      status: "error" as const,
    });
  }
}

function syncActionResult(result: SyncRequestResult): DisconnectActionState {
  if (!result.queued) {
    const messages: Readonly<Record<string, string>> = {
      ACCOUNT_NOT_CONNECTED:
        "This account is not connected, so there is nothing to sync. Reconnect it first.",
      ACCOUNT_NOT_FOUND: "This account is unavailable in the current workspace.",
      ADMIN_REQUIRED: "Administrator access is required to start a sync.",
      RATE_LIMITED: "Too many recent sync requests. Try again shortly.",
    };
    return Object.freeze({
      message: messages[result.reason] ?? "This action could not be completed.",
      status: "error" as const,
    });
  }

  if (result.alreadyRunning) {
    return Object.freeze({
      message:
        "A sync is already running for this account. Its results will appear when it finishes.",
      status: "success" as const,
    });
  }

  return Object.freeze({
    message: "Sync queued. New posts appear on the posts screen once it completes.",
    status: "success" as const,
  });
}

function actionResult(result: DisconnectResult): DisconnectActionState {
  if (!result.disconnected) {
    const messages: Readonly<Record<string, string>> = {
      ACCOUNT_NOT_FOUND: "This account is unavailable in the current workspace.",
      ADMIN_REQUIRED: "Administrator access is required to disconnect an account.",
      RATE_LIMITED: "Too many recent connection changes. Try again shortly.",
    };
    return Object.freeze({
      message: messages[result.reason] ?? "This action could not be completed.",
      status: "error" as const,
    });
  }

  if (!result.changed) {
    return Object.freeze({
      message: "This account was already disconnected. Imported posts and analyses are unchanged.",
      status: "success" as const,
    });
  }

  // A failed revocation is still a successful disconnect locally: the stored
  // credential is gone. Saying so plainly is what lets an operator decide
  // whether to also remove the app inside Instagram.
  if (result.revocation === "FAILED") {
    return Object.freeze({
      message:
        "The account is disconnected and the stored connection was removed. Instagram did not confirm the permission removal, so also remove this app from the account in Instagram settings.",
      status: "success" as const,
    });
  }

  return Object.freeze({
    message:
      "The account is disconnected and the stored connection was removed. Imported posts and analyses are unchanged.",
    status: "success" as const,
  });
}
