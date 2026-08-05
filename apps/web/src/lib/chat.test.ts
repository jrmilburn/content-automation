import type { ChatMessageRecord } from "@studio-parallel/db";
import { describe, expect, it } from "vitest";

import {
  chatFallbackFailureMessage,
  chatParagraphs,
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
    for (const code of [
      "NO_CANDIDATE",
      "QUOTA",
      "RESPONSE_INVALID",
      "RESPONSE_NOT_JSON",
      "SAFETY_BLOCKED",
      "TIMEOUT",
      "TRANSIENT",
    ]) {
      const described = describeChatFailure(code);
      expect(described).not.toContain(code);
      expect(described.length).toBeGreaterThan(20);
    }
  });

  it("falls back to a sentence rather than showing an unknown code", () => {
    expect(describeChatFailure("SOMETHING_NEW")).toBe(chatFallbackFailureMessage);
  });

  it("keeps a refused answer and an unreachable provider apart", () => {
    expect(describeChatFailure("SAFETY_BLOCKED")).not.toBe(describeChatFailure("TRANSIENT"));
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
