import "server-only";

import { loadAuthConfig } from "@studio-parallel/config";
import {
  appendChatAnswer,
  appendChatQuestion,
  countRecentChatQuestions,
  createChatSession,
  deleteChatSession,
  listChatSessions,
  loadChatContext,
  loadChatConversation,
  loadCurrentStrategy,
  renameChatSession,
  type AppendedChatMessage,
  type ChatAnswerRecord,
  type ChatContextResult,
  type ChatContextScope,
  type ChatConversation,
  type ChatMessageRecord,
  type ChatSessionSummary,
  type StrategyEvidenceEntry,
  type WorkspaceContext,
} from "@studio-parallel/db";
import { assembleChatContext } from "@studio-parallel/domain";

import { getDatabase } from "./database";

/**
 * The one seam between the assistant and where conversations are kept.
 *
 * Every other module in this feature is written against this interface, so the
 * `APP_ENV === "test"` branch exists here and nowhere else. The alternative —
 * a fixture check inside each read and each command, as the read-only screens
 * do — does not survive a feature that writes: a browser run has to create a
 * conversation, send a question, receive an answer and delete it again, and
 * eight separate test branches would be eight places for the fixture and the
 * real path to drift apart.
 *
 * The in-memory store is deliberately not a stub. It enforces the same rules
 * the database does — workspace scoping, sequence ordering, the message cap,
 * indistinguishable answers for a missing and a foreign id — so a browser run
 * exercises the behaviour rather than a permissive imitation of it.
 */

export type ChatStore = Readonly<{
  appendAnswer: (
    context: WorkspaceContext,
    input: Readonly<{ answer: ChatAnswerRecord; sequence: number; sessionId: string }>,
  ) => Promise<ChatMessageRecord | null>;
  appendQuestion: (
    context: WorkspaceContext,
    input: Readonly<{ content: string; sessionId: string; title: string }>,
  ) => Promise<AppendedChatMessage | null>;
  /** Questions asked across the whole workspace since a moment, for the spend bound. */
  countRecentQuestions: (context: WorkspaceContext, since: Date) => Promise<number>;
  createSession: (
    context: WorkspaceContext,
    input: Readonly<{
      createdByUserId: string | null;
      instagramAccountId: string | null;
      title: string;
    }>,
  ) => Promise<ChatSessionSummary>;
  deleteSession: (context: WorkspaceContext, sessionId: string) => Promise<boolean>;
  /**
   * The frozen manifest a conversation's citations resolve against.
   *
   * Separate from `loadContext` because the two are read at different moments:
   * the context is assembled when a question is asked, and the manifest is read
   * again whenever the conversation is displayed. An answer stored last week
   * cites ids from the strategy that was current last week, so an id that no
   * longer resolves is rendered as a citation without a link rather than as a
   * broken one — the same tombstone the strategy screen shows.
   */
  loadEvidence: (
    context: WorkspaceContext,
    scope: ChatContextScope,
  ) => Promise<readonly StrategyEvidenceEntry[]>;
  listSessions: (context: WorkspaceContext) => Promise<readonly ChatSessionSummary[]>;
  loadContext: (context: WorkspaceContext, scope: ChatContextScope) => Promise<ChatContextResult>;
  loadConversation: (
    context: WorkspaceContext,
    sessionId: string,
  ) => Promise<ChatConversation | null>;
  renameSession: (context: WorkspaceContext, sessionId: string, title: string) => Promise<boolean>;
}>;

const databaseStore: ChatStore = Object.freeze({
  appendAnswer: (context, input) => appendChatAnswer(getDatabase(), context, input),
  appendQuestion: (context, input) => appendChatQuestion(getDatabase(), context, input),
  countRecentQuestions: (context, since) => countRecentChatQuestions(getDatabase(), context, since),
  createSession: (context, input) => createChatSession(getDatabase(), context, input),
  deleteSession: (context, sessionId) => deleteChatSession(getDatabase(), context, sessionId),
  listSessions: (context) => listChatSessions(getDatabase(), context),
  loadContext: (context, scope) => loadChatContext(getDatabase(), context, scope),
  loadEvidence: async (context, scope) => {
    const strategy = await loadCurrentStrategy(getDatabase(), context, scope.instagramAccountId);
    return strategy?.evidence ?? Object.freeze([]);
  },
  loadConversation: (context, sessionId) => loadChatConversation(getDatabase(), context, sessionId),
  renameSession: (context, sessionId, title) =>
    renameChatSession(getDatabase(), context, sessionId, title),
});

export function getChatStore(): ChatStore {
  return loadAuthConfig().APP_ENV === "test" ? memoryStore : databaseStore;
}

type MemorySession = { messages: ChatMessageRecord[]; summary: ChatSessionSummary };

const memorySessions = new Map<string, Map<string, MemorySession>>();

let memorySequence = 0;

function workspaceSessions(context: WorkspaceContext): Map<string, MemorySession> {
  const existing = memorySessions.get(context.workspaceId);
  if (existing !== undefined) return existing;

  const created = new Map<string, MemorySession>();
  memorySessions.set(context.workspaceId, created);
  return created;
}

/**
 * Ids that look like the real thing.
 *
 * `loadChatConversation` refuses anything that is not a UUIDv7 before it
 * queries, so a fixture handing out `session-1` would exercise a path the
 * database never reaches and hide the refusal that protects it.
 */
function memoryId(): string {
  memorySequence += 1;
  return `019a0000-0000-7000-8000-${String(memorySequence).padStart(12, "0")}`;
}

const memoryStore: ChatStore = Object.freeze({
  async appendAnswer(context, input) {
    const session = workspaceSessions(context).get(input.sessionId);
    if (session === undefined) return null;

    const message: ChatMessageRecord = Object.freeze({
      citedEvidenceKeys: Object.freeze([...input.answer.citedEvidenceKeys]),
      content: input.answer.content,
      createdAt: new Date().toISOString(),
      failureCode: input.answer.failureCode,
      followUps: Object.freeze([...input.answer.followUps]),
      id: memoryId(),
      role: "assistant",
      sequence: input.sequence,
      strategyGenerationId: input.answer.strategyGenerationId,
    });

    session.messages.push(message);
    session.summary = Object.freeze({
      ...session.summary,
      lastMessageAt: message.createdAt,
      messageCount: session.messages.length,
    });

    return message;
  },

  async appendQuestion(context, input) {
    const session = workspaceSessions(context).get(input.sessionId);
    if (session === undefined) return null;

    const sequence = session.messages.length;
    const message: ChatMessageRecord = Object.freeze({
      citedEvidenceKeys: Object.freeze([]),
      content: input.content,
      createdAt: new Date().toISOString(),
      failureCode: null,
      followUps: Object.freeze([]),
      id: memoryId(),
      role: "user",
      sequence,
      strategyGenerationId: null,
    });

    session.messages.push(message);
    session.summary = Object.freeze({
      ...session.summary,
      lastMessageAt: message.createdAt,
      messageCount: session.messages.length,
      ...(session.summary.titleSetByUser || sequence > 0 ? {} : { title: input.title }),
    });

    return Object.freeze({ message, sequence });
  },

  async countRecentQuestions(context, since) {
    return [...workspaceSessions(context).values()]
      .flatMap((session) => session.messages)
      .filter((message) => message.role === "user" && new Date(message.createdAt) >= since).length;
  },

  async createSession(context, input) {
    const summary: ChatSessionSummary = Object.freeze({
      createdAt: new Date().toISOString(),
      id: memoryId(),
      instagramAccountId: input.instagramAccountId,
      lastMessageAt: null,
      messageCount: 0,
      title: input.title,
      titleSetByUser: false,
    });

    workspaceSessions(context).set(summary.id, { messages: [], summary });
    return summary;
  },

  async deleteSession(context, sessionId) {
    return workspaceSessions(context).delete(sessionId);
  },

  async listSessions(context) {
    return Object.freeze(
      [...workspaceSessions(context).values()]
        .map((session) => session.summary)
        .sort((left, right) =>
          (right.lastMessageAt ?? right.createdAt).localeCompare(
            left.lastMessageAt ?? left.createdAt,
          ),
        ),
    );
  },

  async loadContext() {
    return Object.freeze({
      assembly: assembleChatContext([
        Object.freeze({
          body: "Title: Lead with the question, keep the build visible\nEvidence available to cite, by id:\n  - stat_pos_0: Question hooks against other hook types, twelve posts to eight.",
          evidenceIds: Object.freeze(["stat_pos_0"]),
          source: "strategy",
          title: "The account's current content strategy",
        }),
      ]),
      strategyGenerationId: "019a0000-0000-7000-8000-0000000005a1",
    });
  },

  async loadEvidence() {
    return Object.freeze([
      Object.freeze({
        category: "positive_statistic",
        evidenceKey: "stat_pos_0",
        evidenceType: "feature_statistic",
        referenceId: "019a0000-0000-7000-8000-000000000901",
        summaryText: "Question hooks against other hook types, twelve posts to eight.",
      }),
    ]);
  },

  async loadConversation(context, sessionId) {
    const session = workspaceSessions(context).get(sessionId);
    if (session === undefined) return null;

    return Object.freeze({
      messages: Object.freeze([...session.messages]),
      session: session.summary,
    });
  },

  async renameSession(context, sessionId, title) {
    const session = workspaceSessions(context).get(sessionId);
    if (session === undefined) return false;

    session.summary = Object.freeze({ ...session.summary, title, titleSetByUser: true });
    return true;
  },
});
