import { PageHeader } from "../../../../components/page-header";
import { ErrorSummary } from "../../../../components/states";

/**
 * Says nothing about whether the conversation exists elsewhere.
 *
 * A deleted conversation and another workspace's read identically here, on
 * purpose: distinguishing them would let a crafted identifier confirm that
 * something is there to find.
 */
export default function ChatSessionNotFound() {
  return (
    <div className="page-stack">
      <PageHeader description="Assistant" title="Conversation not found" />
      <ErrorSummary
        action={{ href: "/chat", label: "Back to conversations" }}
        description="No conversation is available at this address. It may never have existed, it may have been deleted, or it may belong to another workspace."
        title="Conversation not found"
      />
    </div>
  );
}
