import { createWebRequestContext, reportError } from "@studio-parallel/observability";
import { headers } from "next/headers";
import { notFound } from "next/navigation";

import { ChatError, ChatSessionScreen } from "../../../../components/chat";
import { loadChatSessionDetail } from "../../../../lib/server/chat-data";
import { webErrorMonitor, webLogger } from "../../../../lib/server/observability";

/**
 * A turn calls the provider inside the request that asked for it, so this route
 * needs longer than a page that only reads. The provider timeout is set below
 * this ceiling deliberately: a timeout this product raises writes a failed turn
 * the reader can see, and one the platform raises writes nothing.
 */
export const maxDuration = 60;

export default async function ChatSessionPage({
  params,
}: Readonly<{ params: Promise<{ sessionId: string }> }>) {
  const { sessionId } = await params;
  let detail: Awaited<ReturnType<typeof loadChatSessionDetail>>;

  try {
    detail = await loadChatSessionDetail(sessionId);
  } catch (error) {
    const requestContext = createWebRequestContext(await headers());
    reportError(
      error,
      {
        correlationId: requestContext.correlationId,
        event: "chat.conversation.failed",
        stage: "chat",
      },
      { logger: webLogger, monitor: webErrorMonitor },
    );
    return <ChatError reference={requestContext.correlationId} />;
  }

  // A conversation this workspace does not have and one that never existed get
  // the same answer, so a crafted id cannot be told apart from a wrong guess.
  // Called outside the try, because `notFound` reports itself by throwing.
  if (!detail) notFound();
  return <ChatSessionScreen detail={detail} />;
}
