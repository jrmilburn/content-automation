import { loadDatabaseConfig } from "@studio-parallel/config";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  appendChatAnswer,
  appendChatQuestion,
  countRecentChatQuestions,
  createChatSession,
  deleteChatSession,
  listChatSessions,
  loadChatConversation,
  renameChatSession,
  type ChatAnswerRecord,
} from "../../src/chat-sessions.js";
import { createDatabaseClient, type DatabaseClient } from "../../src/client.js";
import { developmentWorkspace } from "../../src/seed-data.js";
import { createWorkspaceContext } from "../../src/workspace-context.js";

/**
 * Conversations against the constraints that actually enforce them.
 *
 * The unit tests prove what the turn command decides. These prove the parts
 * only a database can: that another workspace's conversation is invisible
 * rather than merely filtered out afterwards, that two writers cannot take the
 * same position in a conversation, and that deleting a session takes its
 * messages with it rather than being refused by a foreign key.
 */

const databaseConfig = loadDatabaseConfig();
let database: DatabaseClient;

const context = createWorkspaceContext(developmentWorkspace.id);
const otherWorkspaceId = "01900000-0000-7000-8000-0000000000ff";
const otherContext = createWorkspaceContext(otherWorkspaceId);

const answer: ChatAnswerRecord = Object.freeze({
  citedEvidenceKeys: Object.freeze(["stat_pos_0"]),
  content: "Open the next one on a direct question.",
  contextHash: "a".repeat(64),
  contextSources: Object.freeze(["strategy"]),
  contextTokenEstimate: 120,
  failureClass: null,
  failureCode: null,
  finishReason: "STOP",
  followUps: Object.freeze([]),
  inputTokens: 100,
  modelRequested: "gemini-3.6-flash",
  modelVersion: "gemini-3.6-flash",
  outputTokens: 40,
  promptVersion: "strategy-chat-prompt-v1.0.0",
  providerLatencyMs: 900,
  schemaVersion: "strategy-chat-v1.0.0",
  strategyGenerationId: null,
  totalTokens: 140,
});

async function clear(): Promise<void> {
  await database.chatMessage.deleteMany({});
  await database.chatSession.deleteMany({});
  await database.workspace.deleteMany({ where: { id: otherWorkspaceId } });
}

beforeAll(async () => {
  database = createDatabaseClient(databaseConfig.DATABASE_URL);
});

beforeEach(async () => {
  await clear();
  await database.workspace.create({
    data: {
      id: otherWorkspaceId,
      name: "Other workspace",
      slug: `other-${otherWorkspaceId.slice(-8)}`,
    },
  });
});

afterAll(async () => {
  await clear();
  await database.$disconnect();
});

function newSession(inContext = context) {
  return createChatSession(database, inContext, {
    createdByUserId: null,
    instagramAccountId: null,
    title: "New conversation",
  });
}

describe("chat sessions", () => {
  it("keeps another workspace's conversation invisible rather than merely unlisted", async () => {
    const mine = await newSession();
    const theirs = await newSession(otherContext);

    expect((await listChatSessions(database, context)).map((s) => s.id)).toEqual([mine.id]);

    // Every one of these must answer as though the conversation does not exist,
    // so a crafted id cannot be told apart from a wrong guess.
    expect(await loadChatConversation(database, context, theirs.id)).toBeNull();
    expect(await renameChatSession(database, context, theirs.id, "Taken")).toBe(false);
    expect(await deleteChatSession(database, context, theirs.id)).toBe(false);
    expect(
      await appendChatQuestion(database, context, {
        content: "Whose conversation is this?",
        sessionId: theirs.id,
        title: "Whose conversation is this?",
      }),
    ).toBeNull();

    // And it is untouched, not merely unreported.
    const still = await loadChatConversation(database, otherContext, theirs.id);
    expect(still?.session.title).toBe("New conversation");
    expect(still?.messages).toHaveLength(0);
  });

  it("answers a malformed id the same way as a missing one, without querying", async () => {
    expect(await loadChatConversation(database, context, "not-a-uuid")).toBeNull();
    expect(await renameChatSession(database, context, "not-a-uuid", "Taken")).toBe(false);
    expect(await deleteChatSession(database, context, "not-a-uuid")).toBe(false);
  });

  it("takes the next position in the conversation, and refuses a duplicate", async () => {
    const session = await newSession();

    const first = await appendChatQuestion(database, context, {
      content: "What next?",
      sessionId: session.id,
      title: "What next?",
    });
    expect(first?.sequence).toBe(0);

    await appendChatAnswer(database, context, {
      answer,
      sequence: 1,
      sessionId: session.id,
    });

    const second = await appendChatQuestion(database, context, {
      content: "And why?",
      sessionId: session.id,
      title: "And why?",
    });
    expect(second?.sequence).toBe(2);

    // The unique index is what makes a racing writer a refusal rather than a
    // conversation that reordered itself.
    await expect(
      appendChatAnswer(database, context, { answer, sequence: 0, sessionId: session.id }),
    ).rejects.toThrow();
  });

  it("names a conversation from its first question, and never overwrites a chosen name", async () => {
    const session = await newSession();

    await appendChatQuestion(database, context, {
      content: "What video should I make next?",
      sessionId: session.id,
      title: "What video should I make next?",
    });

    let conversation = await loadChatConversation(database, context, session.id);
    expect(conversation?.session.title).toBe("What video should I make next?");
    expect(conversation?.session.titleSetByUser).toBe(false);

    expect(await renameChatSession(database, context, session.id, "Winter pillars")).toBe(true);

    await appendChatAnswer(database, context, { answer, sequence: 1, sessionId: session.id });
    await appendChatQuestion(database, context, {
      content: "A later question that must not rename anything",
      sessionId: session.id,
      title: "A later question that must not rename anything",
    });

    conversation = await loadChatConversation(database, context, session.id);
    expect(conversation?.session.title).toBe("Winter pillars");
    expect(conversation?.session.titleSetByUser).toBe(true);
  });

  it("deletes the messages with the conversation rather than being refused by them", async () => {
    const session = await newSession();
    await appendChatQuestion(database, context, {
      content: "What next?",
      sessionId: session.id,
      title: "What next?",
    });
    await appendChatAnswer(database, context, { answer, sequence: 1, sessionId: session.id });

    expect(await deleteChatSession(database, context, session.id)).toBe(true);
    expect(await loadChatConversation(database, context, session.id)).toBeNull();
    expect(await database.chatMessage.count({ where: { chatSessionId: session.id } })).toBe(0);
  });

  it("counts questions for the spend bound within the window and this workspace only", async () => {
    const mine = await newSession();
    const theirs = await newSession(otherContext);

    await appendChatQuestion(database, context, {
      content: "Mine",
      sessionId: mine.id,
      title: "Mine",
    });
    await appendChatQuestion(database, otherContext, {
      content: "Theirs",
      sessionId: theirs.id,
      title: "Theirs",
    });
    await appendChatAnswer(database, context, { answer, sequence: 1, sessionId: mine.id });

    const hourAgo = new Date(Date.now() - 60 * 60 * 1_000);

    // Answers are not questions, and another workspace's spend is not this
    // workspace's.
    expect(await countRecentChatQuestions(database, context, hourAgo)).toBe(1);
    expect(await countRecentChatQuestions(database, context, new Date(Date.now() + 1_000))).toBe(0);
  });

  it("orders conversations by activity, keeping an unused one visible", async () => {
    const older = await newSession();
    const unused = await newSession();

    await appendChatQuestion(database, context, {
      content: "What next?",
      sessionId: older.id,
      title: "What next?",
    });

    const listed = await listChatSessions(database, context);

    // The used conversation sorts first on its message, and the unused one is
    // still in the list rather than sinking out of it.
    expect(listed.map((session) => session.id)).toEqual([older.id, unused.id]);
    expect(listed[1]?.lastMessageAt).toBeNull();
  });
});
