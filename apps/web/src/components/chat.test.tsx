// @vitest-environment jsdom
import type { ChatMessageRecord, StrategyEvidenceEntry } from "@studio-parallel/db";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ChatScreen, ChatSessionScreen } from "./chat";
import type { ChatSessionDetail, ChatSnapshot } from "../lib/server/chat-data";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("../app/(authenticated)/chat/actions", () => ({
  deleteChatSessionAction: vi.fn(),
  renameChatSessionAction: vi.fn(),
  sendChatMessageAction: vi.fn(),
  startChatSessionAction: vi.fn(),
}));

const evidence: readonly StrategyEvidenceEntry[] = Object.freeze([
  Object.freeze({
    category: "positive_statistic",
    evidenceKey: "stat_pos_0",
    evidenceType: "feature_statistic",
    referenceId: "019a0000-0000-7000-8000-000000000901",
    summaryText: "Question hooks against other hook types, twelve posts to eight.",
  }),
]);

function message(overrides: Partial<ChatMessageRecord> = {}): ChatMessageRecord {
  return Object.freeze({
    citedEvidenceKeys: Object.freeze([]),
    content: "",
    createdAt: "2026-08-05T02:00:00.000Z",
    failureCode: null,
    followUps: Object.freeze([]),
    id: "message-0",
    role: "assistant",
    sequence: 0,
    strategyGenerationId: null,
    ...overrides,
  }) as ChatMessageRecord;
}

function snapshot(overrides: Partial<ChatSnapshot> = {}): ChatSnapshot {
  return Object.freeze({
    accounts: Object.freeze([Object.freeze({ id: "account-1", label: "@studioparallel" })]),
    hasAccount: true,
    hasStrategy: true,
    selectedAccountId: "account-1",
    sessions: Object.freeze([]),
    ...overrides,
  }) as ChatSnapshot;
}

function detail(messages: readonly ChatMessageRecord[]): ChatSessionDetail {
  return Object.freeze({
    evidence,
    messages,
    session: Object.freeze({
      createdAt: "2026-08-05T01:00:00.000Z",
      id: "019a0000-0000-7000-8000-000000000001",
      instagramAccountId: "account-1",
      lastMessageAt: "2026-08-05T02:00:00.000Z",
      messageCount: messages.length,
      title: "What to make next",
      titleSetByUser: false,
    }),
  }) as ChatSessionDetail;
}

describe("ChatScreen", () => {
  it("asks for an account before it offers a conversation", () => {
    render(<ChatScreen snapshot={snapshot({ hasAccount: false, accounts: [] })} />);

    expect(screen.getByText("No Instagram account connected")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start a conversation" })).not.toBeInTheDocument();
  });

  it("still offers a conversation when no strategy exists, and names what is missing", () => {
    render(<ChatScreen snapshot={snapshot({ hasStrategy: false })} />);

    expect(screen.getByText("No strategy behind this account yet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Generate a strategy" })).toHaveAttribute(
      "href",
      "/strategy",
    );
    // Refusing here would leave a workspace with posts and no strategy holding a
    // screen that does nothing.
    expect(screen.getByRole("button", { name: "Start a conversation" })).toBeInTheDocument();
  });

  it("keeps an empty workspace and an empty conversation list apart", () => {
    render(<ChatScreen snapshot={snapshot()} />);

    expect(screen.getByText("No conversations yet")).toBeInTheDocument();
    expect(screen.queryByText("No Instagram account connected")).not.toBeInTheDocument();
  });

  it("lists conversations with their message counts", () => {
    render(
      <ChatScreen
        snapshot={snapshot({
          sessions: Object.freeze([
            Object.freeze({
              createdAt: "2026-08-05T01:00:00.000Z",
              id: "019a0000-0000-7000-8000-000000000001",
              instagramAccountId: "account-1",
              lastMessageAt: "2026-08-05T02:00:00.000Z",
              messageCount: 2,
              title: "What to make next",
              titleSetByUser: false,
            }),
          ]),
        })}
      />,
    );

    const link = screen.getByRole("link", { name: "What to make next" });
    expect(link).toHaveAttribute("href", "/chat/019a0000-0000-7000-8000-000000000001");
    expect(screen.getByText(/2 messages/u)).toBeInTheDocument();
  });
});

describe("ChatSessionScreen", () => {
  it("renders an answer as paragraphs and links the evidence it cited", () => {
    render(
      <ChatSessionScreen
        detail={detail([
          message({ content: "What next?", id: "q", role: "user", sequence: 0 }),
          message({
            citedEvidenceKeys: Object.freeze(["stat_pos_0"]),
            content: "Open on a question.\n\nHold the pillar steady.",
            id: "a",
            sequence: 1,
          }),
        ])}
      />,
    );

    expect(screen.getByText("Open on a question.")).toBeInTheDocument();
    expect(screen.getByText("Hold the pillar steady.")).toBeInTheDocument();
    expect(
      screen.getByRole("link", {
        name: "Question hooks against other hook types, twelve posts to eight.",
      }),
    ).toHaveAttribute("href", "/trends/019a0000-0000-7000-8000-000000000901");
  });

  it("tombstones a citation the current manifest no longer holds", () => {
    render(
      <ChatSessionScreen
        detail={detail([
          message({
            citedEvidenceKeys: Object.freeze(["stat_pos_9"]),
            content: "An answer that leaned on something since removed.",
            sequence: 0,
          }),
        ])}
      />,
    );

    expect(screen.getByText(/no longer available/u)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Question hooks/u })).not.toBeInTheDocument();
  });

  it("shows a failed turn in sequence, explained, rather than omitting it", () => {
    render(
      <ChatSessionScreen
        detail={detail([
          message({ content: "What next?", id: "q", role: "user", sequence: 0 }),
          message({ failureCode: "TIMEOUT", id: "a", sequence: 1 }),
        ])}
      />,
    );

    const failed = screen.getByText(/took longer than the assistant waits/u);
    expect(failed).toBeInTheDocument();
    expect(screen.getByText("No answer")).toBeInTheDocument();
    // The question that produced it is still readable above the failure, and
    // the retry is that same question already typed rather than a blank form
    // the reader has to reconstruct it in.
    expect(screen.getAllByText("What next?").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByLabelText(/Ask about this account/u)).toHaveValue("What next?");
  });

  it("offers the question again only on the newest failure, never on an older one", () => {
    render(
      <ChatSessionScreen
        detail={detail([
          message({ content: "First try", id: "q1", role: "user", sequence: 0 }),
          message({ failureCode: "TIMEOUT", id: "a1", sequence: 1 }),
          message({ content: "Second try", id: "q2", role: "user", sequence: 2 }),
          message({ failureCode: "TRANSIENT", id: "a2", sequence: 3 }),
        ])}
      />,
    );

    // Two composers would put two identically labelled fields on the page and
    // duplicate the id that labels them.
    expect(screen.getAllByLabelText(/Ask about this account/u)).toHaveLength(1);
    expect(screen.getByLabelText(/Ask about this account/u)).toHaveValue("Second try");
  });

  it("offers what to ask next only when the last answer suggested something", () => {
    const { rerender } = render(
      <ChatSessionScreen detail={detail([message({ content: "An answer.", sequence: 0 })])} />,
    );
    expect(screen.queryByText("You could ask next")).not.toBeInTheDocument();

    rerender(
      <ChatSessionScreen
        detail={detail([
          message({
            content: "An answer.",
            followUps: Object.freeze(["Which pillar is least tested?"]),
            sequence: 0,
          }),
        ])}
      />,
    );

    const suggestions = screen.getByRole("region", { name: "You could ask next" });
    expect(within(suggestions).getByText("Which pillar is least tested?")).toBeInTheDocument();
  });

  it("invites a first question when the conversation is empty", () => {
    render(<ChatSessionScreen detail={detail([])} />);

    expect(screen.getByText(/What video should I make next\?/u)).toBeInTheDocument();
    expect(screen.getByLabelText(/Ask about this account/u)).toBeInTheDocument();
  });
});
