import { loadGeminiConfig } from "@studio-parallel/config";
import { describe, expect, it } from "vitest";

import { GeminiError } from "./contract.js";
import { createGeminiHttpAdapter, type FetchLike } from "./http-client.js";

/**
 * The transport's obligations, proved against a fetch that answers on command.
 *
 * The live proof scripts show the request the API accepts. This shows the
 * things a live proof cannot: that every failure shape classifies correctly,
 * that the key never enters a URL, and that provider text never reaches an
 * error.
 */

// The interval is the configured minimum and never actually waited: `sleep` is
// injected below so a poll test costs no wall-clock time.
const config = loadGeminiConfig({
  GEMINI_FILE_POLL_INTERVAL_MS: "250",
  GEMINI_FILE_POLL_MAX_ATTEMPTS: "3",
});
const credentials = { GEMINI_API_KEY: "test-key-never-in-a-url" } as const;

type Call = Readonly<{ init: RequestInit | undefined; url: string }>;

function createAdapter(
  responses: readonly (Response | (() => Response))[],
  calls: Call[] = [],
): ReturnType<typeof createGeminiHttpAdapter> {
  let index = 0;
  const fetchImplementation: FetchLike = async (url, init) => {
    calls.push({ init, url: String(url) });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;

    return typeof next === "function" ? next() : (next as Response);
  };

  return createGeminiHttpAdapter({
    config,
    credentials,
    fetchImplementation,
    sleep: async () => undefined,
  });
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status: 200,
    ...init,
  });
}

const activeFile = {
  name: "files/abc123",
  sizeBytes: "1024",
  state: "ACTIVE",
  uri: "https://generativelanguage.googleapis.com/v1beta/files/abc123",
};

function generation(overrides: Record<string, unknown> = {}) {
  return {
    candidates: [{ content: { parts: [{ text: '{"ok":true}' }] }, finishReason: "STOP" }],
    modelVersion: "gemini-3.6-flash",
    usageMetadata: { candidatesTokenCount: 200, promptTokenCount: 1_000, totalTokenCount: 1_200 },
    ...overrides,
  };
}

describe("credential handling", () => {
  it("sends the key as a header and never in a URL", async () => {
    const calls: Call[] = [];
    const adapter = createAdapter([json(activeFile)], calls);

    await adapter.describeFile("files/abc123");

    expect(calls[0]?.url).not.toContain(credentials.GEMINI_API_KEY);
    expect(calls[0]?.url).not.toContain("key=");
    expect((calls[0]?.init?.headers as Record<string, string>)["x-goog-api-key"]).toBe(
      credentials.GEMINI_API_KEY,
    );
  });

  it("refuses a redirect rather than following the credential off the pinned host", async () => {
    const calls: Call[] = [];
    const adapter = createAdapter([json(activeFile)], calls);

    await adapter.describeFile("files/abc123");

    expect(calls[0]?.init?.redirect).toBe("error");
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("failure classification", () => {
  it.each([
    [429, "rate_limit"],
    [401, "authorisation"],
    [500, "transient"],
    [400, "invalid_request"],
  ] as const)("maps status %d to %s", async (status, responseClass) => {
    const adapter = createAdapter([json({ error: { message: "leak me" } }, { status })]);

    await expect(adapter.describeFile("files/abc123")).rejects.toMatchObject({
      name: "GeminiError",
      responseClass,
    });
  });

  it("never carries provider text into the error", async () => {
    const secret = "PROVIDER SAID SOMETHING WITH THE PROMPT IN IT";
    const adapter = createAdapter([json({ error: { message: secret } }, { status: 400 })]);

    const error = await adapter.describeFile("files/abc123").catch((value: unknown) => value);

    expect(error).toBeInstanceOf(GeminiError);
    expect((error as Error).message).not.toContain(secret);
    expect((error as Error).message).toBe(
      "Gemini operation failed: describeFile (invalid_request)",
    );
  });

  it("reads a retry-after hint for the job policy", async () => {
    const adapter = createAdapter([json({}, { headers: { "retry-after": "30" }, status: 429 })]);

    await expect(adapter.describeFile("files/abc123")).rejects.toMatchObject({
      retryAfterMs: 30_000,
    });
  });

  it("classifies an aborted request as a timeout rather than a transient fault", async () => {
    const adapter = createGeminiHttpAdapter({
      config,
      credentials,
      fetchImplementation: async () => {
        const error = new Error("aborted");
        error.name = "TimeoutError";
        throw error;
      },
    });

    await expect(adapter.describeFile("files/abc123")).rejects.toMatchObject({
      responseClass: "timeout",
    });
  });

  it("rejects a file name that could choose the endpoint", async () => {
    const calls: Call[] = [];
    const adapter = createAdapter([json(activeFile)], calls);

    await expect(adapter.describeFile("files/../models/evil")).rejects.toMatchObject({
      responseClass: "invalid_request",
    });
    expect(calls).toHaveLength(0);
  });
});

describe("describeFile", () => {
  it("reports an absent file as null rather than throwing", async () => {
    const adapter = createAdapter([json({}, { status: 404 })]);

    await expect(adapter.describeFile("files/abc123")).resolves.toBeNull();
  });
});

describe("deleteFile", () => {
  it("treats an already-released file as the end state the caller wanted", async () => {
    const adapter = createAdapter([json({}, { status: 404 })]);

    await expect(adapter.deleteFile("files/abc123")).resolves.toBeUndefined();
  });

  it("reports a real failure", async () => {
    const adapter = createAdapter([json({}, { status: 500 })]);

    await expect(adapter.deleteFile("files/abc123")).rejects.toMatchObject({
      responseClass: "transient",
    });
  });
});

describe("uploadVideo", () => {
  it("starts a resumable upload and finalises it", async () => {
    const calls: Call[] = [];
    const adapter = createAdapter(
      [
        new Response(null, {
          headers: { "x-goog-upload-url": "https://upload.invalid/session" },
          status: 200,
        }),
        json({ file: activeFile }),
      ],
      calls,
    );

    const file = await adapter.uploadVideo({
      body: new Uint8Array([1, 2, 3]),
      byteLength: 3,
      displayName: "probe",
      mimeType: "video/mp4",
    });

    expect(file).toMatchObject({ name: "files/abc123", sizeBytes: 1_024, state: "ACTIVE" });
    expect(calls[0]?.url).toContain("/upload/v1beta/files");
    expect((calls[0]?.init?.headers as Record<string, string>)["X-Goog-Upload-Protocol"]).toBe(
      "resumable",
    );
    expect(calls[1]?.url).toBe("https://upload.invalid/session");
    expect((calls[1]?.init?.headers as Record<string, string>)["X-Goog-Upload-Command"]).toBe(
      "upload, finalize",
    );
  });

  it("fails when the provider returns no upload session", async () => {
    const adapter = createAdapter([new Response(null, { status: 200 })]);

    await expect(
      adapter.uploadVideo({
        body: new Uint8Array([1]),
        byteLength: 1,
        displayName: "probe",
        mimeType: "video/mp4",
      }),
    ).rejects.toBeInstanceOf(GeminiError);
  });
});

describe("waitForActiveFile", () => {
  it("returns once the provider finishes processing", async () => {
    let call = 0;
    const adapter = createAdapter([
      () => {
        call += 1;
        return json(call < 2 ? { ...activeFile, state: "PROCESSING" } : activeFile);
      },
    ]);

    await expect(adapter.waitForActiveFile("files/abc123")).resolves.toMatchObject({
      state: "ACTIVE",
    });
  });

  it("reports a provider-side failure apart from a slow one", async () => {
    // They need different answers: a failed file will never become usable, a
    // slow one may already be usable by the next attempt.
    await expect(
      createAdapter([json({ ...activeFile, state: "FAILED" })]).waitForActiveFile("files/abc123"),
    ).rejects.toMatchObject({ responseClass: "file_failed" });

    // A fresh Response per poll: a body can only be read once, and a reused one
    // would fail as a malformed payload rather than as the timeout under test.
    await expect(
      createAdapter([() => json({ ...activeFile, state: "PROCESSING" })]).waitForActiveFile(
        "files/abc123",
      ),
    ).rejects.toMatchObject({ responseClass: "timeout" });
  });

  it("treats a vanished file as failed", async () => {
    await expect(
      createAdapter([json({}, { status: 404 })]).waitForActiveFile("files/abc123"),
    ).rejects.toMatchObject({ responseClass: "file_failed" });
  });
});

describe("generateStructuredText", () => {
  it("returns text, usage and the model the provider actually ran", async () => {
    const calls: Call[] = [];
    const adapter = createAdapter([json(generation())], calls);

    const result = await adapter.generateStructuredText({
      fileUri: activeFile.uri,
      instruction: "describe the shape",
      mimeType: "video/mp4",
    });

    expect(result).toMatchObject({
      finishReason: "STOP",
      modelVersion: "gemini-3.6-flash",
      text: '{"ok":true}',
    });
    expect(result.usage).toMatchObject({ inputTokens: 1_000, outputTokens: 200 });
  });

  it("sends no provider response schema, because the contract is rejected on every such path", async () => {
    const calls: Call[] = [];
    const adapter = createAdapter([json(generation())], calls);

    await adapter.generateStructuredText({
      fileUri: activeFile.uri,
      instruction: "describe the shape",
      mimeType: "video/mp4",
    });

    const body = JSON.parse(String(calls[0]?.init?.body)) as {
      generationConfig: Record<string, unknown>;
    };

    expect(body.generationConfig).not.toHaveProperty("responseSchema");
    expect(body.generationConfig).not.toHaveProperty("responseJsonSchema");
    expect(body.generationConfig["responseMimeType"]).toBe("application/json");
  });

  it("reports a safety block distinctly from an empty answer", async () => {
    await expect(
      createAdapter([
        json(generation({ candidates: [{ finishReason: "SAFETY" }] })),
      ]).generateStructuredText({
        fileUri: activeFile.uri,
        instruction: "x",
        mimeType: "video/mp4",
      }),
    ).rejects.toMatchObject({ responseClass: "safety_blocked" });

    await expect(
      createAdapter([json(generation({ candidates: [] }))]).generateStructuredText({
        fileUri: activeFile.uri,
        instruction: "x",
        mimeType: "video/mp4",
      }),
    ).rejects.toMatchObject({ responseClass: "no_candidate" });
  });

  it("refuses a truncated response rather than handing back half an object", async () => {
    await expect(
      createAdapter([
        json(
          generation({
            candidates: [{ content: { parts: [{ text: '{"ok":' }] }, finishReason: "MAX_TOKENS" }],
          }),
        ),
      ]).generateStructuredText({
        fileUri: activeFile.uri,
        instruction: "x",
        mimeType: "video/mp4",
      }),
    ).rejects.toMatchObject({ responseClass: "no_candidate" });
  });
});
