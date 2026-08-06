import type { ChatMessageRecord } from "@studio-parallel/db";
import { describe, expect, it } from "vitest";

import {
  chatFailureMessages,
  chatFallbackFailureMessage,
  chatParagraphs,
  chatProducedFailureCodes,
  describeChatFailure,
  describeChatRefusal,
  isFailedAnswer,
  questionBefore,
} from "./chat";

function message(overrides: Partial<ChatMessageRecord> = {}): ChatMessageRecord {
  return Object.freeze({
    citedEvidenceKeys: Object.freeze([]),
    content: "",
    createdAt: "2026-08-05T00:00:00.000Z",
    failureCode: null,
    followUps: Object.freeze([]),
    id: "message-0",
    role: "assistant",
    sequence: 0,
    strategyGenerationId: null,
    ...overrides,
  }) as ChatMessageRecord;
}

describe("describeChatFailure", () => {
  it("explains each recorded failure in the reader's terms, never as a code", () => {
    // Derived from the producers rather than listed, which is the whole point:
    // a hand-written list passes while a newly added response class renders the
    // generic fallback, and that is exactly the regression this test claims to
    // prevent. `truncated` was added once and went unnoticed; `rate_limit` and
    // `authorisation` had never had a sentence at all.
    for (const code of [
      ...chatProducedFailureCodes,
      // Not a provider class: what `runChatTurn` records when something other
      // than a GeminiError escapes the call.
      "TURN_FAILED",
    ]) {
      const described = describeChatFailure(code);
      expect(described).not.toContain(code);
      expect(described.length).toBeGreaterThan(20);
      expect(described).not.toBe(chatFallbackFailureMessage);
    }
  });

  it("has no message for a code nothing can produce", () => {
    // A message for a dead code is a message nobody will ever read, and it
    // reads as coverage the map does not have. `QUOTA` was one: the adapter
    // classifies a 429 as `rate_limit`, so the sentence written for it was
    // unreachable while the class that did occur fell through to the fallback.
    //
    // Checked over every key rather than against that one name. Naming `QUOTA`
    // proved exactly one dead code dead and let the next one through:
    // `RESPONSE_CAUSAL_CLAIM` outlived the rule that produced it and this test
    // passed anyway. The invariant is that the map and the produced-code list
    // describe the same set, so state that instead of an example of it.
    expect(describeChatFailure("QUOTA")).toBe(chatFallbackFailureMessage);
    expect(Object.keys(chatFailureMessages).sort()).toEqual([...chatProducedFailureCodes].sort());
  });

  it("falls back to a sentence rather than showing an unknown code", () => {
    expect(describeChatFailure("SOMETHING_NEW")).toBe(chatFallbackFailureMessage);
  });

  it("keeps a refused answer and an unreachable provider apart", () => {
    expect(describeChatFailure("SAFETY_BLOCKED")).not.toBe(describeChatFailure("TRANSIENT"));
  });

  it("does not tell a reader to ask again when asking again cannot work", () => {
    const truncated = describeChatFailure("TRUNCATED");

    // The same request meets the same ceiling every time, so this is the one
    // failure where "ask again" is a loop with no exit. It names the setting a
    // person has to change instead.
    expect(truncated).not.toMatch(/ask again/iu);
    expect(truncated).toContain("GEMINI_CHAT_MAX_OUTPUT_TOKENS");
    expect(truncated).not.toBe(describeChatFailure("NO_CANDIDATE"));
  });
});

describe("describeChatRefusal", () => {
  it("names what to do about each refusal", () => {
    expect(describeChatRefusal("empty_question")).toContain("Type a question");
    expect(describeChatRefusal("session_full")).toContain("Start a new one");
    expect(describeChatRefusal("unknown_reason")).toContain("could not be sent");
  });
});

describe("chatParagraphs", () => {
  it("splits on blank lines and drops the empties", () => {
    expect(chatParagraphs("One.\n\nTwo.\n\n\n Three. ")).toEqual(["One.", "Two.", "Three."]);
  });

  it("returns nothing for an empty answer, so no empty paragraph is rendered", () => {
    expect(chatParagraphs("")).toEqual([]);
    expect(chatParagraphs("   \n\n  ")).toEqual([]);
  });

  it("keeps a single newline inside one paragraph", () => {
    expect(chatParagraphs("One.\nStill one.")).toEqual(["One.\nStill one."]);
  });
});

describe("isFailedAnswer", () => {
  it("is true only for an assistant message carrying a reason code", () => {
    expect(isFailedAnswer(message({ failureCode: "TIMEOUT" }))).toBe(true);
    expect(isFailedAnswer(message({ content: "An answer." }))).toBe(false);
    expect(isFailedAnswer(message({ failureCode: "TIMEOUT", role: "user" }))).toBe(false);
  });
});

describe("questionBefore", () => {
  it("finds the question a failed answer belongs to", () => {
    const messages = [
      message({ content: "What next?", id: "q", role: "user", sequence: 0 }),
      message({ failureCode: "TIMEOUT", id: "a", sequence: 1 }),
    ];

    expect(questionBefore(messages, 1)).toBe("What next?");
  });

  it("returns null when nothing precedes it, rather than guessing", () => {
    expect(questionBefore([message({ failureCode: "TIMEOUT", sequence: 0 })], 0)).toBeNull();
  });
});
