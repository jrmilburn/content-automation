import { createWebRequestContext, reportError } from "@studio-parallel/observability";
import { headers } from "next/headers";

import { ChatError, ChatScreen } from "../../../components/chat";
import { loadChatSnapshot } from "../../../lib/server/chat-data";
import { webErrorMonitor, webLogger } from "../../../lib/server/observability";

export default async function ChatPage() {
  try {
    const snapshot = await loadChatSnapshot();
    return <ChatScreen snapshot={snapshot} />;
  } catch (error) {
    const requestContext = createWebRequestContext(await headers());
    reportError(
      error,
      {
        correlationId: requestContext.correlationId,
        event: "chat.list.failed",
        stage: "chat",
      },
      { logger: webLogger, monitor: webErrorMonitor },
    );
    return <ChatError reference={requestContext.correlationId} />;
  }
}
