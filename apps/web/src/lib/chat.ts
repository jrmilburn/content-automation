import type { ChatMessageRecord } from "@studio-parallel/db";
import { geminiResponseClasses } from "@studio-parallel/domain";

/**
 * Turning stored conversation records into what a reader sees.
 *
 * Presentation only: no database, no session, nothing that could not run in a
 * test with a literal. The rule this file exists to keep is that a failure has
 * a sentence rather than a code, and that the sentence says what happened and
 * what to do — a reader who asked a question and got `RESPONSE_INVALID` has
 * been told nothing.
 */

export const newChatTitle = "New conversation";

export const chatTitleMaxLength = 120;

/**
 * What each recorded failure means, in the reader's terms.
 *
 * Every one of them ends the same way, because the recovery genuinely is the
 * same: ask again. They are kept apart anyway, because "the model refused this"
 * and "we could not reach the model" are different facts about the product, and
 * collapsing them into "something went wrong" is what leaves somebody retrying
 * a question that will never work.
 */
const failureMessages: Readonly<Record<string, string>> = Object.freeze({
  // Every provider response class has an entry, because a class with none fell
  // through to the fallback and told a reader "this could not be produced" for
  // a failure the product knew the name of. The set is `geminiResponseClasses`
  // uppercased, and `chat.test.ts` holds this map to it.
  AUTHORISATION:
    "The assistant is not authorised to reach the model. Asking again will not help until GEMINI_API_KEY is corrected.",
  FILE_FAILED: "The model could not read something this question needed. Ask again.",
  INVALID_REQUEST: "This question could not be sent in a form the model accepts. Try rewording it.",
  NO_CANDIDATE: "The model returned nothing at all. Ask again.",
  RATE_LIMIT: "The assistant has reached its usage limit for now. Try again in a few minutes.",
  // Not a provider class: what a turn records when something other than a
  // GeminiError escapes the call. Rare, and the recovery is genuinely the same
  // as a transient one — but it is a different fact about the product, and
  // collapsing it into the fallback loses that a request was made at all.
  TURN_FAILED: "Something went wrong before the answer could be read. Ask again.",
  // A rule this product holds itself to refused the answer, and which rule is
  // worth saying: a reader who knows the question invited a claim about
  // causation can ask it a way the assistant is allowed to answer, and a reader
  // told only "the rules" cannot.
  RESPONSE_CAUSAL_CLAIM:
    "The answer claimed a creative choice causes reach or engagement, which this product does not publish, so it was discarded. Asking about what the measured comparisons show will get an answer.",
  RESPONSE_CONTROL_CHARACTER:
    "The answer contained characters this screen cannot render, so it was discarded. Ask again.",
  RESPONSE_INVALID:
    "The answer did not follow the rules this product holds itself to, so it was discarded. Ask again.",
  RESPONSE_NOT_JSON: "The answer arrived in a shape this screen cannot read. Ask again.",
  RESPONSE_SCHEMA_INVALID:
    "The answer did not have the shape this screen reads, so it was discarded. Ask again.",
  SAFETY_BLOCKED: "The model declined to answer this one. Try asking it a different way.",
  TIMEOUT: "The answer took longer than the assistant waits. Ask again.",
  TRANSIENT: "The assistant could not be reached. Ask again in a moment.",
  // The one failure here that asking again cannot fix: the same request meets
  // the same ceiling every time. Saying "ask again" would send a reader round a
  // loop that has no exit, so this one names the setting instead.
  TRUNCATED:
    "The answer ran out of room before it was written. Asking again will hit the same limit — GEMINI_CHAT_MAX_OUTPUT_TOKENS needs raising.",
});

export const chatFallbackFailureMessage =
  "This answer could not be produced. Nothing else in the conversation was affected — ask again.";

/**
 * Every failure code a turn can actually store.
 *
 * Derived from the provider's own response classes rather than listed beside
 * them, so a class added to `geminiResponseClasses` has no message and fails the
 * test rather than quietly rendering the fallback. That is not hypothetical:
 * `truncated` was added and went unnoticed, and `rate_limit` and `authorisation`
 * had never had a sentence at all while `QUOTA`, which nothing produces, did.
 */
export const chatProducedFailureCodes: readonly string[] = Object.freeze([
  ...geminiResponseClasses.map((responseClass) => responseClass.toUpperCase()),
  "RESPONSE_CAUSAL_CLAIM",
  "RESPONSE_CONTROL_CHARACTER",
  "RESPONSE_INVALID",
  "RESPONSE_NOT_JSON",
  "RESPONSE_SCHEMA_INVALID",
]);

export function describeChatFailure(failureCode: string): string {
  return failureMessages[failureCode] ?? chatFallbackFailureMessage;
}

export const chatRefusalMessages: Readonly<Record<string, string>> = Object.freeze({
  empty_question: "Type a question first.",
  question_too_long: "That question is too long to send. Shorten it and try again.",
  session_full: "This conversation has reached its length. Start a new one to keep going.",
  session_not_found: "This conversation is no longer available.",
  workspace_rate_limited:
    "The workspace has asked the assistant a lot in the last hour. Wait a few minutes and ask again — nothing was recorded.",
});

export function describeChatRefusal(reason: string): string {
  return chatRefusalMessages[reason] ?? "That question could not be sent.";
}

/**
 * Splits a reply into paragraphs.
 *
 * The model is told to write plain prose and forbidden markdown, because there
 * is no renderer for it here and a stray `##` would be shown literally. Blank
 * lines are the one structure it may use, so they are the one structure this
 * turns into elements.
 */
export function chatParagraphs(content: string): readonly string[] {
  return Object.freeze(
    content
      .split(/\n\s*\n/u)
      .map((paragraph) => paragraph.trim())
      .filter((paragraph) => paragraph.length > 0),
  );
}

/** An answer that carries a reason code instead of an answer. */
export function isFailedAnswer(message: ChatMessageRecord): boolean {
  return message.role === "assistant" && message.failureCode !== null;
}

/**
 * The question an answer belongs to, for the retry control.
 *
 * A failed answer is followed by nothing, so the thing to send again is the
 * message immediately before it. Returns null when there is no such question,
 * which cannot happen through the command but can through a hand-edited row.
 */
export function questionBefore(
  messages: readonly ChatMessageRecord[],
  sequence: number,
): string | null {
  const previous = messages.find((message) => message.sequence === sequence - 1);
  return previous?.role === "user" ? previous.content : null;
}
