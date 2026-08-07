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
  type ChatReplyV1,
} from "@studio-parallel/domain";
import { GeminiError, type GeminiAdapter } from "@studio-parallel/integrations";
import { parseCorrelationId, type JsonLogger } from "@studio-parallel/observability";

import { createWebGeminiAdapter } from "./chat-gemini";
import { getChatStore, type ChatStore } from "./chat-store";
import { webLogger } from "./observability";

/**
 * One turn of a conversation, from a question to a stored answer.
 *
 * The question is committed before the provider is called and the answer after,
 * so nothing a reader typed is lost to a failed call and no turn is silently
 * missing from the record. A failed call still writes an answer row carrying a
 * reason code, which is what the screen turns into "this one did not work, ask
 * again" rather than a conversation that appears to have ignored someone.
 *
 * One repair attempt, and only for a reply this product refused rather than one
 * the provider mangled. The distinction is why the attempt exists at all: a
 * malformed response is rare, because `responseMimeType: application/json`
 * makes it rare, and asking again is a fair recovery for something that
 * happens by accident. A reply refused for its language is not an accident —
 * the model wrote a complete, well-cited answer and phrased one sentence in a
 * way the product will not publish, and asking the same question again re-rolls
 * the same dice. So the second attempt is told exactly which rule it broke,
 * which is information the reader pressing send again does not have.
 *
 * The allowance is a local flag rather than a stored column, unlike strategy
 * generation's. A turn is one request and is never redelivered, so there is no
 * second delivery that could spend it twice.
 *
 * Only reason codes reach a log. The instruction contains captions, transcripts
 * and the reader's own words, and the provider's error text routinely quotes
 * the request back, so failures are reduced to a class and a code before they
 * leave this function. Recording the code is what makes a discarded answer
 * diagnosable at all: for want of one, establishing why a reply was refused
 * meant re-running the turn against the live provider.
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
  logger?: JsonLogger;
  now?: () => number;
  store?: ChatStore;
}>;

/**
 * What a refused reply is told about its own refusal.
 *
 * One line per rule, naming the rule rather than quoting the sentence back:
 * the offending text is the model's own output and repeating it into the next
 * instruction would put untrusted prose above the rules that govern it.
 *
 * Kept beside the codes they answer so that adding a validation rule without a
 * repair note is a visibly incomplete change.
 */
const repairNotes: Readonly<Record<string, string>> = Object.freeze({
  CONTROL_CHARACTER:
    "Your previous answer was rejected because it contained control characters. Write it again using ordinary text and blank lines only.",
  SCHEMA:
    "Your previous answer did not match the required JSON shape. Write it again, emitting every required property and nothing else.",
});

/** The stored code for a refused reply, so the row says which rule fired. */
const refusalCodes: Readonly<Record<string, string>> = Object.freeze({
  CONTROL_CHARACTER: "RESPONSE_CONTROL_CHARACTER",
  SCHEMA: "RESPONSE_SCHEMA_INVALID",
});

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

type CheckedReply =
  | Readonly<{ data: ChatReplyV1; valid: true }>
  | Readonly<{ failureCode: string; issueCode: string; valid: false }>;

/**
 * Parses one response and holds it to the contract.
 *
 * Returns the rule that refused it rather than the fact that something did.
 * Both callers need it: the repair has to name the rule to the model, and the
 * stored row has to name it to whoever reads the record afterwards. Collapsing
 * every rejection into `RESPONSE_INVALID` is what made a refused answer
 * impossible to explain without re-running the turn.
 */
function check(text: string, evidenceIds: readonly string[]): CheckedReply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Distinguished from a rule violation: the provider's own response mime
    // type was asked to guarantee this much, so it is the request shape failing
    // rather than the answer.
    return Object.freeze({
      failureCode: "RESPONSE_NOT_JSON",
      issueCode: "NOT_JSON",
      valid: false as const,
    });
  }

  const validated = validateChatReplyV1(parsed, { evidenceIds });
  if (validated.valid) return Object.freeze({ data: validated.data, valid: true as const });

  const issueCode = validated.issues[0]?.code ?? "UNKNOWN";

  return Object.freeze({
    failureCode: refusalCodes[issueCode] ?? "RESPONSE_INVALID",
    issueCode,
    valid: false as const,
  });
}

/**
 * The one line a failed turn leaves behind.
 *
 * A code and a correlation id, and nothing else. The reader is told a sentence
 * on screen; this is what makes the same event findable afterwards, which it
 * previously was not — no failed turn reached a log at all, so a recorded
 * failure could only be studied by asking the question again and hoping.
 */
/**
 * What the calls a turn made cost, added up.
 *
 * Null only when every call reported null, so an absent figure stays absent
 * rather than becoming a zero that reads as "this turn was free".
 */
function sumUsage(
  calls: readonly Awaited<ReturnType<GeminiAdapter["generateStructuredText"]>>[],
  field: "inputTokens" | "outputTokens" | "totalTokens",
): number | null {
  const reported = calls
    .map((call) => call.usage[field])
    .filter((value): value is number => value !== null);

  return reported.length === 0 ? null : reported.reduce((total, value) => total + value, 0);
}

function recordFailure(logger: JsonLogger, correlationId: string, failureCode: string): void {
  const parsed = parseCorrelationId(correlationId);

  // A correlation id is required of every caller, so reaching here with an
  // unparseable one means the id was forged rather than forgotten. Writing the
  // line under an invented id would join it to the wrong incident, and writing
  // it under the forged one would let a caller interleave their failures with
  // somebody else's.
  if (parsed === undefined) return;

  logger.warn("chat.turn.not_answered", {
    correlationId: parsed,
    reasonCode: failureCode,
    stage: "chat",
  });
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
  // The correlation id is required rather than optional, so a caller cannot add
  // a second entry point and silently lose every log line a failed turn leaves
  // — which is the blind spot this function was changed to remove.
  input: Readonly<{ correlationId: string; question: string; sessionId: string }>,
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
  const logger = dependencies.logger ?? webLogger;

  const provenance = {
    contextHash: assembly.hash,
    contextSources: assembly.includedSources,
    contextTokenEstimate: assembly.tokenEstimate,
    // What this turn actually asked for, which is the override when one is
    // set. The contract constant is the default rather than the answer: a row
    // recording a model the request never named would make the one column that
    // says what produced an answer the one column that cannot be trusted.
    modelRequested: geminiConfig.GEMINI_CHAT_MODEL ?? chatModelRequested,
    promptVersion: chatPromptVersion,
    schemaVersion: chatSchemaVersion,
    strategyGenerationId,
  } as const;

  const empty = {
    citedEvidenceKeys: Object.freeze([]),
    followUps: Object.freeze([]),
  } as const;

  const ask = async (
    text: string,
  ): Promise<
    | Readonly<{ ok: true; result: Awaited<ReturnType<GeminiAdapter["generateStructuredText"]>> }>
    | Readonly<{ failure: ReturnType<typeof failureOf>; ok: false }>
  > => {
    try {
      return Object.freeze({
        ok: true as const,
        result: await gemini.generateStructuredText({
          instruction: text,
          maxOutputTokens: geminiConfig.GEMINI_CHAT_MAX_OUTPUT_TOKENS,
        }),
      });
    } catch (error) {
      return Object.freeze({ failure: failureOf(error), ok: false as const });
    }
  };

  const first = await ask(instruction);

  if (!first.ok) {
    // A provider failure is not repaired. The request never reached a model
    // that could have written anything different, so a second identical call
    // would spend a second one to meet the same wall.
    recordFailure(logger, input.correlationId, first.failure.failureCode);

    const answer = await store.appendAnswer(context, {
      answer: {
        ...empty,
        ...provenance,
        content: "",
        failureClass: first.failure.failureClass,
        failureCode: first.failure.failureCode,
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

  let result = first.result;
  let checked = check(result.text, assembly.evidenceIds);
  let spent = [first.result] as Awaited<ReturnType<GeminiAdapter["generateStructuredText"]>>[];

  // The one repair. Attempted only when the reply is a whole response this
  // product declined to publish, and told which rule declined it — a second
  // identical request would only re-run the same coin toss.
  const repairNote = checked.valid ? null : (repairNotes[checked.issueCode] ?? null);

  if (repairNote !== null) {
    const repaired = await ask(
      createChatInstruction({ context: assembly.text, repairNote, turns }),
    );

    if (repaired.ok) {
      result = repaired.result;
      checked = check(result.text, assembly.evidenceIds);
      spent = [...spent, repaired.result];
    } else {
      // The repair reached the provider and the provider refused. The stored
      // row keeps the reason the answer was rejected, because that is what the
      // reader is told — but the quota or timeout that decided there would be
      // no second answer is a different fact about the product, and losing it
      // would make a rate-limited workspace look like a badly behaved model.
      recordFailure(logger, input.correlationId, `REPAIR_${repaired.failure.failureCode}`);
    }
  }

  // Usage is summed across the calls the turn actually made, and the rest of the
  // telemetry describes the response that was stored. A repaired turn costs two
  // calls, and these columns are the only record of what a conversation spends:
  // reporting the second call alone would under-count the bill by half on every
  // repair, silently.
  const telemetry = {
    finishReason: result.finishReason,
    inputTokens: sumUsage(spent, "inputTokens"),
    modelVersion: result.modelVersion,
    outputTokens: sumUsage(spent, "outputTokens"),
    providerLatencyMs: spent.reduce((total, call) => total + call.durationMs, 0),
    totalTokens: sumUsage(spent, "totalTokens"),
  } as const;

  if (!checked.valid) {
    // The code only. The reply is untrusted text that routinely quotes the
    // question and the context back, so it never reaches a log or a stored row.
    recordFailure(logger, input.correlationId, checked.failureCode);

    const answer = await store.appendAnswer(context, {
      answer: {
        ...empty,
        ...provenance,
        ...telemetry,
        content: "",
        failureClass: "response",
        failureCode: checked.failureCode,
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
      citedEvidenceKeys: checked.data.citedEvidenceIds,
      content: checked.data.reply,
      failureClass: null,
      failureCode: null,
      followUps: checked.data.followUps,
    },
    sequence: asked.sequence + 1,
    sessionId: input.sessionId,
  });

  return answer === null
    ? Object.freeze({ answered: false, reason: "session_not_found" as const })
    : Object.freeze({ answer, answered: true as const });
}
