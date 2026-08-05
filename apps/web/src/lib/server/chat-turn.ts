import "server-only";

import { loadGeminiConfig, type GeminiConfig } from "@studio-parallel/config";
import {
  chatWorkspaceHourlyTurnLimit,
  toChatHistory,
  type ChatMessageRecord,
  type WorkspaceContext,
} from "@studio-parallel/db";
import {
  chatModelRequested,
  chatPromptVersion,
  chatQuestionMaxLength,
  chatSchemaVersion,
  createChatInstruction,
  validateChatReplyV1,
} from "@studio-parallel/domain";
import { GeminiError, type GeminiAdapter } from "@studio-parallel/integrations";

import { createWebGeminiAdapter } from "./chat-gemini";
import { getChatStore, type ChatStore } from "./chat-store";

/**
 * One turn of a conversation, from a question to a stored answer.
 *
 * The question is committed before the provider is called and the answer after,
 * so nothing a reader typed is lost to a failed call and no turn is silently
 * missing from the record. A failed call still writes an answer row carrying a
 * reason code, which is what the screen turns into "this one did not work, ask
 * again" rather than a conversation that appears to have ignored someone.
 *
 * There is no repair attempt. Strategy generation makes one, because a rejected
 * strategy costs a job, a manifest and a wait; here the same recovery is the
 * reader pressing send again, and a silent second call would double what a turn
 * costs to rescue a case `responseMimeType: application/json` makes rare.
 *
 * Nothing here reaches a log. The instruction contains captions, transcripts
 * and the reader's own words, and the provider's error text routinely quotes
 * the request back, so failures are reduced to a class and a code before they
 * leave this function.
 */

export const chatRefusalReasons = [
  "empty_question",
  "question_too_long",
  "session_full",
  "session_not_found",
  "workspace_rate_limited",
] as const;

const oneHourMs = 60 * 60 * 1_000;

export type ChatRefusalReason = (typeof chatRefusalReasons)[number];

export type ChatTurnResult =
  | Readonly<{ answer: ChatMessageRecord; answered: true }>
  | Readonly<{ answered: false; reason: ChatRefusalReason }>;

export type ChatTurnDependencies = Readonly<{
  gemini?: GeminiAdapter;
  geminiConfig?: GeminiConfig;
  now?: () => number;
  store?: ChatStore;
}>;

/**
 * Reads a title out of the first thing somebody asked.
 *
 * A list of conversations all called "New conversation" is a list nobody can
 * use, and asking for a title before the first question is a form standing
 * between a reader and the thing they came to do.
 */
export function deriveChatTitle(question: string): string {
  const flattened = question.replace(/\s+/gu, " ").trim();
  if (flattened.length <= 60) return flattened;

  const clipped = flattened.slice(0, 60);
  const lastSpace = clipped.lastIndexOf(" ");
  return `${(lastSpace > 24 ? clipped.slice(0, lastSpace) : clipped).trimEnd()}…`;
}

function failureOf(error: unknown): Readonly<{ failureClass: string; failureCode: string }> {
  if (error instanceof GeminiError) {
    return Object.freeze({
      failureClass: "provider",
      // The provider's own classification, which is already a code rather than
      // prose, and is what decides whether asking again is worth trying.
      failureCode: error.responseClass.toUpperCase(),
    });
  }

  return Object.freeze({ failureClass: "internal", failureCode: "TURN_FAILED" });
}

export async function runChatTurn(
  context: WorkspaceContext,
  input: Readonly<{ question: string; sessionId: string }>,
  dependencies: ChatTurnDependencies = {},
): Promise<ChatTurnResult> {
  const store = dependencies.store ?? getChatStore();
  const question = input.question.trim();

  if (question.length === 0) {
    return Object.freeze({ answered: false, reason: "empty_question" as const });
  }
  if (question.length > chatQuestionMaxLength) {
    return Object.freeze({ answered: false, reason: "question_too_long" as const });
  }

  const conversation = await store.loadConversation(context, input.sessionId);
  if (conversation === null) {
    return Object.freeze({ answered: false, reason: "session_not_found" as const });
  }

  // Checked before the question is written, so a refused turn costs a count
  // rather than a row: the reader is told to wait, not shown a question that
  // will never be answered. The per-session cap does not cover this, because a
  // caller who has one conversation can always make another.
  const recentQuestions = await store.countRecentQuestions(
    context,
    new Date((dependencies.now?.() ?? Date.now()) - oneHourMs),
  );
  if (recentQuestions >= chatWorkspaceHourlyTurnLimit) {
    return Object.freeze({ answered: false, reason: "workspace_rate_limited" as const });
  }

  const asked = await store.appendQuestion(context, {
    content: question,
    sessionId: input.sessionId,
    title: deriveChatTitle(question),
  });

  // The session was there a moment ago, so the only remaining refusals are a
  // full conversation and one deleted in between. Both mean the same thing to
  // the reader: this question was not recorded.
  if (asked === null) {
    return Object.freeze({ answered: false, reason: "session_full" as const });
  }

  const { assembly, strategyGenerationId } = await store.loadContext(context, {
    instagramAccountId: conversation.session.instagramAccountId,
  });

  const turns = toChatHistory([...conversation.messages, asked.message]);
  const instruction = createChatInstruction({ context: assembly.text, turns });
  const geminiConfig = dependencies.geminiConfig ?? loadGeminiConfig();
  const gemini = dependencies.gemini ?? createWebGeminiAdapter();

  const provenance = {
    contextHash: assembly.hash,
    contextSources: assembly.includedSources,
    contextTokenEstimate: assembly.tokenEstimate,
    modelRequested: chatModelRequested,
    promptVersion: chatPromptVersion,
    schemaVersion: chatSchemaVersion,
    strategyGenerationId,
  } as const;

  const empty = {
    citedEvidenceKeys: Object.freeze([]),
    followUps: Object.freeze([]),
  } as const;

  let result;
  try {
    result = await gemini.generateStructuredText({
      instruction,
      maxOutputTokens: geminiConfig.GEMINI_CHAT_MAX_OUTPUT_TOKENS,
    });
  } catch (error) {
    const failure = failureOf(error);
    const answer = await store.appendAnswer(context, {
      answer: {
        ...empty,
        ...provenance,
        content: "",
        failureClass: failure.failureClass,
        failureCode: failure.failureCode,
        finishReason: null,
        inputTokens: null,
        modelVersion: null,
        outputTokens: null,
        providerLatencyMs: null,
        totalTokens: null,
      },
      sequence: asked.sequence + 1,
      sessionId: input.sessionId,
    });

    return answer === null
      ? Object.freeze({ answered: false, reason: "session_not_found" as const })
      : Object.freeze({ answer, answered: true as const });
  }

  const telemetry = {
    finishReason: result.finishReason,
    inputTokens: result.usage.inputTokens,
    modelVersion: result.modelVersion,
    outputTokens: result.usage.outputTokens,
    providerLatencyMs: result.durationMs,
    totalTokens: result.usage.totalTokens,
  } as const;

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.text);
  } catch {
    parsed = null;
  }

  const validated =
    parsed === null ? null : validateChatReplyV1(parsed, { evidenceIds: assembly.evidenceIds });

  if (validated === null || !validated.valid) {
    const answer = await store.appendAnswer(context, {
      answer: {
        ...empty,
        ...provenance,
        ...telemetry,
        content: "",
        failureClass: "response",
        failureCode: validated === null ? "RESPONSE_NOT_JSON" : "RESPONSE_INVALID",
      },
      sequence: asked.sequence + 1,
      sessionId: input.sessionId,
    });

    return answer === null
      ? Object.freeze({ answered: false, reason: "session_not_found" as const })
      : Object.freeze({ answer, answered: true as const });
  }

  const answer = await store.appendAnswer(context, {
    answer: {
      ...provenance,
      ...telemetry,
      citedEvidenceKeys: validated.data.citedEvidenceIds,
      content: validated.data.reply,
      failureClass: null,
      failureCode: null,
      followUps: validated.data.followUps,
    },
    sequence: asked.sequence + 1,
    sessionId: input.sessionId,
  });

  return answer === null
    ? Object.freeze({ answered: false, reason: "session_not_found" as const })
    : Object.freeze({ answer, answered: true as const });
}
