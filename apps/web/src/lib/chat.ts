import type { ChatMessageRecord } from "@studio-parallel/db";

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
  INVALID_REQUEST: "This question could not be sent in a form the model accepts. Try rewording it.",
  NO_CANDIDATE: "The answer came back incomplete, so none of it is shown. Ask again.",
  QUOTA: "The assistant has reached its usage limit for now. Try again later.",
  RESPONSE_INVALID:
    "The answer did not follow the rules this product holds itself to, so it was discarded. Ask again.",
  RESPONSE_NOT_JSON: "The answer arrived in a shape this screen cannot read. Ask again.",
  SAFETY_BLOCKED: "The model declined to answer this one. Try asking it a different way.",
  TIMEOUT: "The answer took longer than the assistant waits. Ask again.",
  TRANSIENT: "The assistant could not be reached. Ask again in a moment.",
});

export const chatFallbackFailureMessage =
  "This answer could not be produced. Nothing else in the conversation was affected — ask again.";

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
