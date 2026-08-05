import { chatHistoryTurnLimit, type ChatTurn } from "@studio-parallel/domain";

import type { PrismaClient } from "./generated/prisma/client.js";
import { createId, isUuidV7 } from "./id.js";
import type { WorkspaceContext } from "./workspace-context.js";

/**
 * Conversations, and the messages that make them up.
 *
 * Every function here is scoped by workspace in its `where` rather than
 * filtered afterwards, so a crafted session id returns nothing rather than
 * someone else's conversation, and a missing session and another workspace's
 * are indistinguishable to the caller.
 *
 * Order is by stored sequence, never by timestamp. Two messages written inside
 * the same millisecond are ordinary here — a question and its answer are
 * written moments apart — and a conversation that reordered itself under load
 * would be worse than one that failed to append.
 *
 * A turn is written in two steps rather than one, which is deliberate. The
 * question is committed before the provider is called, so a reader who asked
 * something and then lost the tab still has what they asked. The answer is
 * committed after, and a failed call still writes an answer row carrying a
 * reason code: a conversation that silently skips a turn is a conversation a
 * reader cannot trust.
 */

type Executor = Pick<PrismaClient, "chatMessage" | "chatSession">;

export const chatSessionMessageLimit = 200;

/**
 * How many questions one workspace may ask in an hour.
 *
 * The per-session cap bounds one conversation and nothing else: a caller who
 * has a session can make another, so without this the only limit on what the
 * assistant can be made to spend is how fast a form can be submitted. Sixty an
 * hour is far above what reading and thinking between answers allows and far
 * below what an unattended loop would reach in a minute.
 *
 * Counted rather than tracked in its own table, because a count over an indexed
 * window is exact, needs no reset and cannot drift from what was actually sent.
 */
export const chatWorkspaceHourlyTurnLimit = 60;

export async function countRecentChatQuestions(
  executor: Executor,
  context: WorkspaceContext,
  since: Date,
): Promise<number> {
  return executor.chatMessage.count({
    where: { createdAt: { gte: since }, role: "USER", workspaceId: context.workspaceId },
  });
}

export type ChatSessionSummary = Readonly<{
  createdAt: string;
  id: string;
  /** Null when the conversation asks about the pooled scope across every linked account. */
  instagramAccountId: string | null;
  lastMessageAt: string | null;
  messageCount: number;
  title: string;
  titleSetByUser: boolean;
}>;

export type ChatMessageRecord = Readonly<{
  citedEvidenceKeys: readonly string[];
  content: string;
  createdAt: string;
  /** Present only on an answer that could not be produced, and a code rather than a message. */
  failureCode: string | null;
  followUps: readonly string[];
  id: string;
  role: "assistant" | "user";
  sequence: number;
  strategyGenerationId: string | null;
}>;

export type ChatConversation = Readonly<{
  messages: readonly ChatMessageRecord[];
  session: ChatSessionSummary;
}>;

type SessionRow = Readonly<{
  createdAt: Date;
  id: string;
  instagramAccountId: string | null;
  lastMessageAt: Date | null;
  messageCount: number;
  title: string;
  titleSetByUser: boolean;
}>;

type MessageRow = Readonly<{
  citedEvidenceKeys: string[];
  content: string;
  createdAt: Date;
  failureCode: string | null;
  followUps: string[];
  id: string;
  role: string;
  sequence: number;
  strategyGenerationId: string | null;
}>;

const sessionSelect = {
  createdAt: true,
  id: true,
  instagramAccountId: true,
  lastMessageAt: true,
  messageCount: true,
  title: true,
  titleSetByUser: true,
} as const;

const messageSelect = {
  citedEvidenceKeys: true,
  content: true,
  createdAt: true,
  failureCode: true,
  followUps: true,
  id: true,
  role: true,
  sequence: true,
  strategyGenerationId: true,
} as const;

function toSummary(row: SessionRow): ChatSessionSummary {
  return Object.freeze({
    createdAt: row.createdAt.toISOString(),
    id: row.id,
    instagramAccountId: row.instagramAccountId,
    lastMessageAt: row.lastMessageAt?.toISOString() ?? null,
    messageCount: row.messageCount,
    title: row.title,
    titleSetByUser: row.titleSetByUser,
  });
}

function toMessage(row: MessageRow): ChatMessageRecord {
  return Object.freeze({
    citedEvidenceKeys: Object.freeze([...row.citedEvidenceKeys]),
    content: row.content,
    createdAt: row.createdAt.toISOString(),
    failureCode: row.failureCode,
    followUps: Object.freeze([...row.followUps]),
    id: row.id,
    role: row.role === "USER" ? "user" : "assistant",
    sequence: row.sequence,
    strategyGenerationId: row.strategyGenerationId,
  });
}

export async function createChatSession(
  executor: Executor,
  context: WorkspaceContext,
  input: Readonly<{
    createdByUserId: string | null;
    instagramAccountId: string | null;
    title: string;
  }>,
): Promise<ChatSessionSummary> {
  const row = await executor.chatSession.create({
    data: {
      createdByUserId: input.createdByUserId,
      id: createId(),
      instagramAccountId: input.instagramAccountId,
      title: input.title,
      workspaceId: context.workspaceId,
    },
    select: sessionSelect,
  });

  return toSummary(row);
}

export async function listChatSessions(
  executor: Executor,
  context: WorkspaceContext,
  options: Readonly<{ limit?: number }> = {},
): Promise<readonly ChatSessionSummary[]> {
  const rows = await executor.chatSession.findMany({
    // A session that has never been used has no last message, so it orders by
    // when it was made rather than sinking below every conversation that has.
    orderBy: [{ lastMessageAt: { nulls: "last", sort: "desc" } }, { createdAt: "desc" }],
    select: sessionSelect,
    take: options.limit ?? 50,
    where: { workspaceId: context.workspaceId },
  });

  return Object.freeze(rows.map(toSummary));
}

/**
 * One conversation and its messages, or null.
 *
 * Null covers a session that does not exist and one belonging to another
 * workspace alike, so a crafted id cannot be told apart from a wrong guess.
 */
export async function loadChatConversation(
  executor: Executor,
  context: WorkspaceContext,
  sessionId: string,
): Promise<ChatConversation | null> {
  if (!isUuidV7(sessionId)) return null;

  const session = await executor.chatSession.findFirst({
    select: sessionSelect,
    where: { id: sessionId, workspaceId: context.workspaceId },
  });

  if (session === null) return null;

  const messages = await executor.chatMessage.findMany({
    orderBy: { sequence: "asc" },
    select: messageSelect,
    take: chatSessionMessageLimit,
    where: { chatSessionId: sessionId, workspaceId: context.workspaceId },
  });

  return Object.freeze({
    messages: Object.freeze(messages.map(toMessage)),
    session: toSummary(session),
  });
}

/**
 * Renames a conversation, and records that a person chose the name.
 *
 * Returns false for a session this workspace does not have, which is the same
 * answer a nonexistent one gets.
 */
export async function renameChatSession(
  executor: Executor,
  context: WorkspaceContext,
  sessionId: string,
  title: string,
): Promise<boolean> {
  if (!isUuidV7(sessionId)) return false;

  const result = await executor.chatSession.updateMany({
    data: { title, titleSetByUser: true },
    where: { id: sessionId, workspaceId: context.workspaceId },
  });

  return result.count === 1;
}

/**
 * Deletes a conversation and everything in it.
 *
 * The messages are removed explicitly inside the same transaction as the
 * session. The relation cascades, so the database would do it either way, but
 * doing it here means the delete cannot depend on which cascade a future
 * migration leaves in place.
 */
export async function deleteChatSession(
  database: PrismaClient,
  context: WorkspaceContext,
  sessionId: string,
): Promise<boolean> {
  if (!isUuidV7(sessionId)) return false;

  return database.$transaction(async (transaction) => {
    const owned = await transaction.chatSession.findFirst({
      select: { id: true },
      where: { id: sessionId, workspaceId: context.workspaceId },
    });

    if (owned === null) return false;

    await transaction.chatMessage.deleteMany({
      where: { chatSessionId: sessionId, workspaceId: context.workspaceId },
    });
    await transaction.chatSession.deleteMany({
      where: { id: sessionId, workspaceId: context.workspaceId },
    });

    return true;
  });
}

export type AppendedChatMessage = Readonly<{ message: ChatMessageRecord; sequence: number }>;

export type ChatAnswerRecord = Readonly<{
  citedEvidenceKeys: readonly string[];
  content: string;
  contextHash: string | null;
  contextSources: readonly string[];
  contextTokenEstimate: number | null;
  failureClass: string | null;
  failureCode: string | null;
  finishReason: string | null;
  followUps: readonly string[];
  inputTokens: number | null;
  modelRequested: string | null;
  modelVersion: string | null;
  outputTokens: number | null;
  promptVersion: string | null;
  providerLatencyMs: number | null;
  schemaVersion: string | null;
  strategyGenerationId: string | null;
  totalTokens: number | null;
}>;

/**
 * Commits one question, taking the next position in the conversation.
 *
 * The position comes from the session's own counter inside the transaction, and
 * the unique index on `(chatSessionId, sequence)` is what makes that safe: two
 * requests appending at once cannot both take the same position, and the loser
 * fails rather than silently reordering the conversation.
 *
 * A session still carrying its automatic title takes one from the first
 * question, because a list of conversations all called "New conversation" is a
 * list a reader cannot use. A title someone chose is never replaced.
 */
export async function appendChatQuestion(
  database: PrismaClient,
  context: WorkspaceContext,
  input: Readonly<{ content: string; sessionId: string; title: string }>,
): Promise<AppendedChatMessage | null> {
  if (!isUuidV7(input.sessionId)) return null;

  return database.$transaction(async (transaction) => {
    const session = await transaction.chatSession.findFirst({
      select: { messageCount: true, titleSetByUser: true },
      where: { id: input.sessionId, workspaceId: context.workspaceId },
    });

    if (session === null || session.messageCount >= chatSessionMessageLimit) return null;

    const row = await transaction.chatMessage.create({
      data: {
        chatSessionId: input.sessionId,
        content: input.content,
        id: createId(),
        role: "USER",
        sequence: session.messageCount,
        workspaceId: context.workspaceId,
      },
      select: messageSelect,
    });

    await transaction.chatSession.updateMany({
      data: {
        lastMessageAt: row.createdAt,
        messageCount: { increment: 1 },
        ...(session.titleSetByUser || session.messageCount > 0 ? {} : { title: input.title }),
      },
      where: { id: input.sessionId, workspaceId: context.workspaceId },
    });

    return Object.freeze({ message: toMessage(row), sequence: row.sequence });
  });
}

/** Commits the answer to a question, whether the provider produced one or not. */
export async function appendChatAnswer(
  database: PrismaClient,
  context: WorkspaceContext,
  input: Readonly<{ answer: ChatAnswerRecord; sequence: number; sessionId: string }>,
): Promise<ChatMessageRecord | null> {
  if (!isUuidV7(input.sessionId)) return null;

  return database.$transaction(async (transaction) => {
    const session = await transaction.chatSession.findFirst({
      select: { id: true },
      where: { id: input.sessionId, workspaceId: context.workspaceId },
    });

    if (session === null) return null;

    const row = await transaction.chatMessage.create({
      data: {
        chatSessionId: input.sessionId,
        citedEvidenceKeys: [...input.answer.citedEvidenceKeys],
        content: input.answer.content,
        contextHash: input.answer.contextHash,
        contextSources: [...input.answer.contextSources],
        contextTokenEstimate: input.answer.contextTokenEstimate,
        failureClass: input.answer.failureClass,
        failureCode: input.answer.failureCode,
        finishReason: input.answer.finishReason,
        followUps: [...input.answer.followUps],
        id: createId(),
        inputTokens: input.answer.inputTokens,
        modelRequested: input.answer.modelRequested,
        modelVersion: input.answer.modelVersion,
        outputTokens: input.answer.outputTokens,
        promptVersion: input.answer.promptVersion,
        providerLatencyMs: input.answer.providerLatencyMs,
        role: "ASSISTANT",
        schemaVersion: input.answer.schemaVersion,
        sequence: input.sequence,
        strategyGenerationId: input.answer.strategyGenerationId,
        totalTokens: input.answer.totalTokens,
        workspaceId: context.workspaceId,
      },
      select: messageSelect,
    });

    await transaction.chatSession.updateMany({
      data: { lastMessageAt: row.createdAt, messageCount: { increment: 1 } },
      where: { id: input.sessionId, workspaceId: context.workspaceId },
    });

    return toMessage(row);
  });
}

/**
 * The recent turns a question travels with.
 *
 * Failed answers are left out. They carry no content, and sending "the
 * assistant said nothing" as conversational history teaches the model that an
 * empty answer is an acceptable turn. The question that failed is kept, so a
 * reader who asks "why not?" after a failure is still understood.
 */
export function toChatHistory(
  messages: readonly ChatMessageRecord[],
  limit = chatHistoryTurnLimit,
): readonly ChatTurn[] {
  const usable = messages.filter(
    (message) => message.role === "user" || message.failureCode === null,
  );

  return Object.freeze(
    usable.slice(-limit).map((message) =>
      Object.freeze({
        content: message.content,
        role: message.role,
      }),
    ),
  );
}
