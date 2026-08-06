import type { GeminiConfig } from "@studio-parallel/config";
import { createWorkspaceContext, type ChatMessageRecord } from "@studio-parallel/db";
import { createFakeGemini, GeminiError } from "@studio-parallel/integrations";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { deriveChatTitle, runChatTurn } from "./chat-turn";
import type { ChatStore } from "./chat-store";

/**
 * The turn command, against a store that behaves like the database.
 *
 * The store is a stand-in rather than a mock of every call, because what these
 * tests are about is what gets written: a question committed before the
 * provider is called, an answer committed after it either way, and a failure
 * that is recorded rather than thrown away.
 */

const context = createWorkspaceContext("01900000-0000-7000-8000-000000000001");
const sessionId = "019a0000-0000-7000-8000-000000000001";

// Required of every caller, so that a second entry point cannot be added that
// silently writes no log line when a turn fails.
const correlationId = "019a0000-0000-7000-8000-0000000000c1";

// Only the two bounds a turn reads. The rest of the schema belongs to the
// adapter, which these tests replace.
const geminiConfig = {
  GEMINI_CHAT_MAX_OUTPUT_TOKENS: 2_048,
  GEMINI_CHAT_TIMEOUT_MS: 45_000,
} as unknown as GeminiConfig;

function validReply(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    citedEvidenceIds: ["stat_pos_0"],
    followUps: [],
    reply: "Open the next video on a direct question and hold the pillar steady.",
    ...overrides,
  });
}

/**
 * The answer as it was written, not as it reads back.
 *
 * `ChatMessageRecord` carries none of the telemetry columns, so the stored
 * token counts are only visible in what the command handed the store.
 */
function appendedTelemetry(store: ChatStore): Record<string, unknown> {
  const calls = (store.appendAnswer as unknown as { mock: { calls: unknown[][] } }).mock.calls;
  const last = calls[calls.length - 1] as [unknown, { answer: Record<string, unknown> }];
  return last[1].answer;
}

function createStore(overrides: Partial<ChatStore> = {}) {
  const written: ChatMessageRecord[] = [];
  let exists = true;

  const store: ChatStore = {
    appendAnswer: vi.fn(async (_context, input) => {
      const message: ChatMessageRecord = Object.freeze({
        citedEvidenceKeys: input.answer.citedEvidenceKeys,
        content: input.answer.content,
        createdAt: "2026-08-05T00:00:01.000Z",
        failureCode: input.answer.failureCode,
        followUps: input.answer.followUps,
        id: `answer-${input.sequence}`,
        role: "assistant" as const,
        sequence: input.sequence,
        strategyGenerationId: input.answer.strategyGenerationId,
      });
      written.push(message);
      return message;
    }),
    appendQuestion: vi.fn(async (_context, input) => {
      const message: ChatMessageRecord = Object.freeze({
        citedEvidenceKeys: Object.freeze([]),
        content: input.content,
        createdAt: "2026-08-05T00:00:00.000Z",
        failureCode: null,
        followUps: Object.freeze([]),
        id: "question-0",
        role: "user" as const,
        sequence: written.length,
        strategyGenerationId: null,
      });
      written.push(message);
      return Object.freeze({ message, sequence: message.sequence });
    }),
    countRecentQuestions: vi.fn(async () => 0),
    createSession: vi.fn(),
    deleteSession: vi.fn(),
    listSessions: vi.fn(),
    loadContext: vi.fn(async () => ({
      assembly: Object.freeze({
        droppedSources: Object.freeze([]),
        evidenceIds: Object.freeze(["stat_pos_0"]),
        hash: "a".repeat(64),
        includedSources: Object.freeze(["strategy"]),
        text: "## Strategy\nQuestion hooks did well.",
        tokenEstimate: 12,
      }),
      strategyGenerationId: "019a0000-0000-7000-8000-0000000005a1",
    })),
    loadConversation: vi.fn(async () =>
      exists
        ? Object.freeze({
            messages: Object.freeze([...written]),
            session: Object.freeze({
              createdAt: "2026-08-05T00:00:00.000Z",
              id: sessionId,
              instagramAccountId: null,
              lastMessageAt: null,
              messageCount: written.length,
              title: "New conversation",
              titleSetByUser: false,
            }),
          })
        : null,
    ),
    loadEvidence: vi.fn(async () => Object.freeze([])),
    renameSession: vi.fn(),
    ...overrides,
  } as unknown as ChatStore;

  return {
    setMissing: () => {
      exists = false;
    },
    store,
    written,
  };
}

describe("deriveChatTitle", () => {
  it("uses the question when it is short enough to be a name", () => {
    expect(deriveChatTitle("  What video should I make next?  ")).toBe(
      "What video should I make next?",
    );
  });

  it("clips a long question on a word boundary rather than mid-word", () => {
    const title = deriveChatTitle(
      "What video should I make next given the pillars we have been testing across the winter period",
    );

    expect(title.length).toBeLessThanOrEqual(61);
    expect(title.endsWith("…")).toBe(true);
    expect(title).not.toContain("  ");
  });

  it("flattens newlines, so a pasted question does not become a multi-line title", () => {
    expect(deriveChatTitle("What next?\n\nAnd why?")).toBe("What next? And why?");
  });
});

describe("runChatTurn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("records the question, then the answer, in that order", async () => {
    const { store, written } = createStore();
    const fake = createFakeGemini({ defaultResponseText: validReply() });

    const result = await runChatTurn(
      context,
      { correlationId, question: "What should I make next?", sessionId },
      { gemini: fake.adapter, geminiConfig, store },
    );

    expect(result.answered).toBe(true);
    expect(written.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(written[1]?.sequence).toBe(1);
    expect(written[1]?.content).toContain("direct question");
    expect(written[1]?.citedEvidenceKeys).toEqual(["stat_pos_0"]);
  });

  it("sends the context and the conversation, and never the reader's question alone", async () => {
    const { store } = createStore();
    const fake = createFakeGemini({ defaultResponseText: validReply() });

    await runChatTurn(
      context,
      { correlationId, question: "What should I make next?", sessionId },
      { gemini: fake.adapter, geminiConfig, store },
    );

    const instruction = fake.instructions()[0] ?? "";
    expect(instruction).toContain("Question hooks did well.");
    expect(instruction).toContain("<<<READER>>>");
    expect(instruction).toContain("What should I make next?");
    expect(instruction).toContain("UNTRUSTED DATA");
  });

  it("records a provider failure as an answer, so the turn is not silently missing", async () => {
    const { store, written } = createStore();
    const fake = createFakeGemini({ defaultResponseText: validReply() });
    fake.failNext({
      error: new GeminiError({ operation: "generateStructuredText", responseClass: "timeout" }),
      operation: "generateStructuredText",
    });

    const result = await runChatTurn(
      context,
      { correlationId, question: "What should I make next?", sessionId },
      { gemini: fake.adapter, geminiConfig, store },
    );

    expect(result.answered).toBe(true);
    expect(written).toHaveLength(2);
    expect(written[1]?.failureCode).toBe("TIMEOUT");
    expect(written[1]?.content).toBe("");
  });

  it("records a reply that is not JSON as a failure rather than showing it", async () => {
    const { store, written } = createStore();
    const fake = createFakeGemini({ defaultResponseText: "I am not JSON at all" });

    await runChatTurn(
      context,
      { correlationId, question: "What should I make next?", sessionId },
      { gemini: fake.adapter, geminiConfig, store },
    );

    expect(written[1]?.failureCode).toBe("RESPONSE_NOT_JSON");
  });

  it("records a reply making a causal claim as a failure rather than publishing it", async () => {
    const { store, written } = createStore();
    const fake = createFakeGemini({
      defaultResponseText: validReply({
        reply: "A question hook will increase reach on every post.",
      }),
    });

    await runChatTurn(
      context,
      { correlationId, question: "What should I make next?", sessionId },
      { gemini: fake.adapter, geminiConfig, store },
    );

    // The rule that refused it, not merely that one did. Every rejection used
    // to store `RESPONSE_INVALID`, which is why establishing why a live answer
    // was discarded meant re-running the turn against the real provider.
    expect(written[1]?.failureCode).toBe("RESPONSE_CAUSAL_CLAIM");
    expect(written[1]?.content).toBe("");
  });

  it("asks once more when a rule refused the answer, and names the rule", async () => {
    const { store, written } = createStore();
    const fake = createFakeGemini({
      defaultResponseText: validReply({
        reply: "A question hook will increase reach on every post.",
      }),
    });

    // Refused first, acceptable second — the case the repair exists for. A
    // model that wrote a whole answer and phrased one sentence as a promise is
    // not making a random mistake, so being told which rule it broke is the
    // only thing that changes the outcome.
    const gemini = {
      ...fake.adapter,
      generateStructuredText: async (
        request: Parameters<typeof fake.adapter.generateStructuredText>[0],
      ) => {
        const result = await fake.adapter.generateStructuredText(request);
        fake.setResponse({ text: validReply() });
        return result;
      },
    };

    const outcome = await runChatTurn(
      context,
      { correlationId, question: "What should I make next?", sessionId },
      { gemini, geminiConfig, store },
    );

    expect(outcome.answered).toBe(true);
    expect(written).toHaveLength(2);
    expect(written[1]?.failureCode).toBeNull();
    expect(written[1]?.content).toContain("Open the next video on a direct question");

    const instructions = fake.instructions();
    expect(instructions).toHaveLength(2);
    const repair = instructions[1] ?? "";
    expect(repair).toContain("causes, drives, guarantees or leads to");
    // The refused sentence is the model's own output. Quoting it back would put
    // untrusted prose after the rules that govern it.
    expect(repair).not.toContain("will increase reach on every post");

    // The note goes before the closing task, not after it. Appended on the end
    // it displaced "Return only a single JSON object", and the repaired turn
    // answered in prose — which came back as RESPONSE_NOT_JSON and lost the
    // specific refusal that prompted the repair in the first place.
    expect(repair.indexOf("causes, drives, guarantees or leads to")).toBeLessThan(
      repair.indexOf("Return only a single JSON object"),
    );
    expect(repair.trimEnd().endsWith("}")).toBe(true);
  });

  it("does not ask again when the provider itself failed", async () => {
    const { store, written } = createStore();
    const fake = createFakeGemini({ defaultResponseText: validReply() });
    fake.failNext({
      error: new GeminiError({ operation: "generateStructuredText", responseClass: "timeout" }),
      operation: "generateStructuredText",
    });

    await runChatTurn(
      context,
      { correlationId, question: "What should I make next?", sessionId },
      { gemini: fake.adapter, geminiConfig, store },
    );

    // A request that never reached a model has nothing to repair, and a second
    // identical call would spend another one to meet the same wall.
    expect(fake.instructions()).toHaveLength(0);
    expect(written[1]?.failureCode).toBe("TIMEOUT");
  });

  it("records the provider failure that stopped a repair, alongside the reason the answer was refused", async () => {
    const { store, written } = createStore();
    const fake = createFakeGemini({
      defaultResponseText: validReply({
        reply: "A question hook will increase reach on every post.",
      }),
    });

    const warnings: string[] = [];
    const logger = {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn((_event: string, attributes: { reasonCode?: string }) => {
        if (attributes.reasonCode) warnings.push(attributes.reasonCode);
      }),
    };

    // First call refused by a rule, second call refused by the provider.
    const gemini = {
      ...fake.adapter,
      generateStructuredText: async (
        request: Parameters<typeof fake.adapter.generateStructuredText>[0],
      ) => {
        const result = await fake.adapter.generateStructuredText(request);
        fake.failNext({
          error: new GeminiError({
            operation: "generateStructuredText",
            responseClass: "rate_limit",
          }),
          operation: "generateStructuredText",
        });
        return result;
      },
    };

    await runChatTurn(
      context,
      { correlationId, question: "What should I make next?", sessionId },
      { gemini, geminiConfig, logger: logger as never, store },
    );

    // The reader is told why the answer was refused, because that is what
    // happened to their question. The quota that decided there would be no
    // second answer is a different fact about the product, and losing it would
    // make a rate-limited workspace look like a badly behaved model.
    expect(written[1]?.failureCode).toBe("RESPONSE_CAUSAL_CLAIM");
    expect(warnings).toContain("REPAIR_RATE_LIMIT");
    expect(warnings).toContain("RESPONSE_CAUSAL_CLAIM");
  });

  it("counts what a repaired turn spent, not what its last call spent", async () => {
    const { store, written } = createStore();
    const fake = createFakeGemini({
      defaultResponseText: validReply({
        reply: "A question hook will increase reach on every post.",
      }),
    });
    const usage = {
      cachedTokens: null,
      inputTokens: 100,
      outputTokens: 20,
      thinkingTokens: null,
      totalTokens: 120,
    };
    fake.setResponse({
      text: validReply({ reply: "A question hook will increase reach on every post." }),
      usage,
    });

    const gemini = {
      ...fake.adapter,
      generateStructuredText: async (
        request: Parameters<typeof fake.adapter.generateStructuredText>[0],
      ) => {
        const result = await fake.adapter.generateStructuredText(request);
        fake.setResponse({ text: validReply(), usage });
        return result;
      },
    };

    await runChatTurn(
      context,
      { correlationId, question: "What should I make next?", sessionId },
      { gemini, geminiConfig, store },
    );

    // Two calls were made and these columns are the only record of what a
    // conversation costs. Reporting the second alone under-counts every
    // repaired turn by half, silently.
    expect(written[1]?.failureCode).toBeNull();
    expect(appendedTelemetry(store).totalTokens).toBe(240);
    expect(appendedTelemetry(store).inputTokens).toBe(200);
  });

  it("stops after one repair rather than asking until it gives up", async () => {
    const { store, written } = createStore();
    const fake = createFakeGemini({
      defaultResponseText: validReply({
        reply: "A question hook will increase reach on every post.",
      }),
    });

    await runChatTurn(
      context,
      { correlationId, question: "What should I make next?", sessionId },
      { gemini: fake.adapter, geminiConfig, store },
    );

    expect(fake.instructions()).toHaveLength(2);
    expect(written[1]?.failureCode).toBe("RESPONSE_CAUSAL_CLAIM");
  });

  it("drops a citation the context never offered, and keeps the answer", async () => {
    const { store, written } = createStore();
    const fake = createFakeGemini({
      defaultResponseText: validReply({ citedEvidenceIds: ["stat_pos_0", "invented_9"] }),
    });

    await runChatTurn(
      context,
      { correlationId, question: "What should I make next?", sessionId },
      { gemini: fake.adapter, geminiConfig, store },
    );

    expect(written[1]?.failureCode).toBeNull();
    expect(written[1]?.citedEvidenceKeys).toEqual(["stat_pos_0"]);
  });

  it("refuses an empty question without calling the provider", async () => {
    const { store, written } = createStore();
    const fake = createFakeGemini({ defaultResponseText: validReply() });

    const result = await runChatTurn(
      context,
      { correlationId, question: "   ", sessionId },
      { gemini: fake.adapter, geminiConfig, store },
    );

    expect(result).toEqual({ answered: false, reason: "empty_question" });
    expect(fake.instructions()).toHaveLength(0);
    expect(written).toHaveLength(0);
  });

  it("refuses a question longer than one turn may carry", async () => {
    const { store } = createStore();
    const fake = createFakeGemini({ defaultResponseText: validReply() });

    const result = await runChatTurn(
      context,
      { correlationId, question: "a".repeat(2_001), sessionId },
      { gemini: fake.adapter, geminiConfig, store },
    );

    expect(result).toEqual({ answered: false, reason: "question_too_long" });
    expect(fake.instructions()).toHaveLength(0);
  });

  it("refuses a conversation this workspace does not have, without calling the provider", async () => {
    const { setMissing, store, written } = createStore();
    setMissing();
    const fake = createFakeGemini({ defaultResponseText: validReply() });

    const result = await runChatTurn(
      context,
      { correlationId, question: "What should I make next?", sessionId },
      { gemini: fake.adapter, geminiConfig, store },
    );

    // The same answer a deleted conversation gets, so a crafted id cannot be
    // told apart from one that never existed.
    expect(result).toEqual({ answered: false, reason: "session_not_found" });
    expect(fake.instructions()).toHaveLength(0);
    expect(written).toHaveLength(0);
  });

  it("refuses a workspace already at its hourly limit, before writing or spending", async () => {
    const { store, written } = createStore({
      countRecentQuestions: vi.fn(async () => 60),
    });
    const fake = createFakeGemini({ defaultResponseText: validReply() });

    const result = await runChatTurn(
      context,
      { correlationId, question: "What should I make next?", sessionId },
      { gemini: fake.adapter, geminiConfig, store },
    );

    // Refused before the question is committed, so the reader is told to wait
    // rather than shown a question that will never be answered.
    expect(result).toEqual({ answered: false, reason: "workspace_rate_limited" });
    expect(written).toHaveLength(0);
    expect(fake.instructions()).toHaveLength(0);
  });

  it("counts the limit against the last hour, not against all time", async () => {
    const countRecentQuestions = vi.fn(async () => 0);
    const { store } = createStore({ countRecentQuestions });
    const fake = createFakeGemini({ defaultResponseText: validReply() });

    await runChatTurn(
      context,
      { correlationId, question: "What should I make next?", sessionId },
      {
        gemini: fake.adapter,
        geminiConfig,
        now: () => Date.parse("2026-08-05T12:00:00.000Z"),
        store,
      },
    );

    expect(countRecentQuestions).toHaveBeenCalledWith(
      context,
      new Date("2026-08-05T11:00:00.000Z"),
    );
  });

  it("bounds what one turn may cost by passing the chat output ceiling", async () => {
    const { store } = createStore();
    const generateStructuredText = vi.fn(async () => ({
      durationMs: 5,
      finishReason: "STOP",
      modelVersion: "fake-model",
      text: validReply(),
      usage: {
        cachedTokens: null,
        inputTokens: 10,
        outputTokens: 20,
        thinkingTokens: null,
        totalTokens: 30,
      },
    }));

    await runChatTurn(
      context,
      { correlationId, question: "What should I make next?", sessionId },
      {
        gemini: { generateStructuredText } as never,
        geminiConfig,
        store,
      },
    );

    expect(generateStructuredText).toHaveBeenCalledWith(
      expect.objectContaining({ maxOutputTokens: 2_048 }),
    );
  });
});
