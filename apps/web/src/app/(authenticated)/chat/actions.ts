"use server";

import { createWorkspaceContext } from "@studio-parallel/db";
import {
  classifyError,
  createWebRequestContext,
  reportError,
} from "@studio-parallel/observability";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { chatTitleMaxLength, describeChatRefusal, newChatTitle } from "../../../lib/chat";
import { getChatStore } from "../../../lib/server/chat-store";
import { loadChatSnapshot } from "../../../lib/server/chat-data";
import { runChatTurn } from "../../../lib/server/chat-turn";
import { requireShellActor } from "../../../lib/server/shell-session";
import { webErrorMonitor, webLogger } from "../../../lib/server/observability";

/**
 * Everything a reader can do to a conversation.
 *
 * The session id arrives in the form and is never trusted. The workspace comes
 * from the session, every command resolves the conversation inside it, and a
 * conversation belonging to another workspace produces the same "no longer
 * available" a deleted one does — so a crafted id in a form field cannot be
 * used to find out whether it exists somewhere else.
 *
 * The account a new conversation is about is not in the form either. A caller
 * able to name it could open a conversation against an account the screen never
 * offered, so it is re-derived from the same snapshot the screen was rendered
 * from.
 *
 * Each action ends with the expired-session redirect outside its own `try`,
 * for the reason `strategy/actions.ts` records: `redirect` reports itself by
 * throwing, and inside the try the action would catch its own redirect and
 * report it as a failed request.
 */

export type ChatActionState = Readonly<{
  message: string;
  reference?: string;
  status: "error" | "idle" | "success";
}>;

function failed(reference: string, message: string): ChatActionState {
  return Object.freeze({ message, reference, status: "error" as const });
}

export async function startChatSessionAction(): Promise<void> {
  const requestContext = createWebRequestContext(await headers());
  let destination: string | null = null;

  try {
    const actor = await requireShellActor();
    const snapshot = await loadChatSnapshot();

    const session = await getChatStore().createSession(createWorkspaceContext(actor.workspaceId), {
      createdByUserId: actor.internalUserId,
      instagramAccountId: snapshot.selectedAccountId,
      title: newChatTitle,
    });

    revalidatePath("/chat");
    destination = `/chat/${session.id}`;
  } catch (error) {
    reportError(
      error,
      {
        correlationId: requestContext.correlationId,
        event: "chat.session.create_failed",
        stage: "chat",
      },
      { logger: webLogger, monitor: webErrorMonitor },
    );

    if (classifyError(error).errorCode !== "ACCESS_DENIED") {
      // A conversation that could not be created has nothing to navigate to, so
      // the reader stays on the list, where the error belongs to the page
      // rather than to a conversation that does not exist.
      redirect("/chat?error=create");
    }

    redirect("/login?reason=session_expired&returnTo=%2Fchat");
  }

  // Outside the try, because `redirect` reports itself by throwing and would
  // otherwise be caught and reported as a failed creation.
  redirect(destination ?? "/chat");
}

export async function renameChatSessionAction(
  _previous: ChatActionState,
  formData: FormData,
): Promise<ChatActionState> {
  const requestContext = createWebRequestContext(await headers());
  const sessionId = String(formData.get("sessionId") ?? "");
  const title = String(formData.get("title") ?? "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, chatTitleMaxLength);

  if (title.length === 0) {
    return Object.freeze({ message: "Give the conversation a name.", status: "error" as const });
  }

  try {
    const actor = await requireShellActor();
    const renamed = await getChatStore().renameSession(
      createWorkspaceContext(actor.workspaceId),
      sessionId,
      title,
    );

    if (!renamed) {
      return Object.freeze({
        message: describeChatRefusal("session_not_found"),
        status: "error" as const,
      });
    }

    revalidatePath("/chat");
    revalidatePath(`/chat/${sessionId}`);

    return Object.freeze({ message: "Renamed.", status: "success" as const });
  } catch (error) {
    reportError(
      error,
      {
        correlationId: requestContext.correlationId,
        event: "chat.session.rename_failed",
        stage: "chat",
      },
      { logger: webLogger, monitor: webErrorMonitor },
    );

    if (classifyError(error).errorCode !== "ACCESS_DENIED") {
      return failed(requestContext.correlationId, "The conversation could not be renamed.");
    }
  }

  redirect(`/login?reason=session_expired&returnTo=%2Fchat`);
}

export async function deleteChatSessionAction(formData: FormData): Promise<void> {
  const requestContext = createWebRequestContext(await headers());
  const sessionId = String(formData.get("sessionId") ?? "");

  try {
    const actor = await requireShellActor();
    await getChatStore().deleteSession(createWorkspaceContext(actor.workspaceId), sessionId);
    revalidatePath("/chat");
  } catch (error) {
    reportError(
      error,
      {
        correlationId: requestContext.correlationId,
        event: "chat.session.delete_failed",
        stage: "chat",
      },
      { logger: webLogger, monitor: webErrorMonitor },
    );

    if (classifyError(error).errorCode !== "ACCESS_DENIED") {
      redirect("/chat?error=delete");
    }

    redirect("/login?reason=session_expired&returnTo=%2Fchat");
  }

  // A deleted conversation cannot be the page the reader is left on, and a
  // refusal is not reported: whether it was deleted here or was never this
  // workspace's, the list is now the truth about what exists.
  redirect("/chat");
}

export async function sendChatMessageAction(
  _previous: ChatActionState,
  formData: FormData,
): Promise<ChatActionState> {
  const requestContext = createWebRequestContext(await headers());
  const sessionId = String(formData.get("sessionId") ?? "");
  const question = String(formData.get("question") ?? "");

  try {
    const actor = await requireShellActor();
    const outcome = await runChatTurn(createWorkspaceContext(actor.workspaceId), {
      question,
      sessionId,
    });

    revalidatePath(`/chat/${sessionId}`);
    revalidatePath("/chat");

    if (!outcome.answered) {
      return Object.freeze({
        message: describeChatRefusal(outcome.reason),
        status: "error" as const,
      });
    }

    // A recorded failure is not an action failure. The turn is in the
    // conversation, where the screen explains it beside the question that
    // produced it, so the form says only that the exchange completed.
    return Object.freeze({ message: "", status: "success" as const });
  } catch (error) {
    reportError(
      error,
      {
        correlationId: requestContext.correlationId,
        event: "chat.turn.failed",
        stage: "chat",
      },
      { logger: webLogger, monitor: webErrorMonitor },
    );

    if (classifyError(error).errorCode !== "ACCESS_DENIED") {
      return failed(
        requestContext.correlationId,
        "The question could not be sent. Nothing was recorded.",
      );
    }
  }

  redirect(`/login?reason=session_expired&returnTo=%2Fchat%2F${sessionId}`);
}
