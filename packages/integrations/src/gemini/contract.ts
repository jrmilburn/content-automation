import type { GeminiFileState, GeminiResponseClass, GeminiUsage } from "@studio-parallel/domain";

/**
 * The boundary between this product and the paid Gemini project.
 *
 * The adapter carries one video and one instruction to a pinned model and brings
 * back text, usage and a finish reason. It knows nothing about analyses,
 * taxonomies or validation: the response is a string, and what that string has
 * to mean belongs to the handler that asked for it. That separation is what lets
 * the analysis contract change version without touching transport, and what lets
 * a second caller — strategy generation — reuse the same primitive.
 *
 * Three invariants hold across every implementation:
 *
 * - **The API key never leaves the server and never enters a URL.** It travels
 *   as a header, so it cannot reach a proxy log, a redirect target or an error
 *   string.
 * - **A provider file is always released.** Uploaded bytes cost money and are
 *   retained for 48 hours, so deletion is a `finally`, not a happy path.
 * - **Failures reduce to a reason code.** Provider text is untrusted, unbounded
 *   and often echoes the input, so it never reaches an error, a log or a stored
 *   record.
 */

export type GeminiFile = Readonly<{
  /** Provider-assigned name, of the form `files/xxxx`. The idempotency handle. */
  name: string;
  sizeBytes: number | null;
  state: GeminiFileState;
  /** Fully qualified URI the model request references. */
  uri: string;
}>;

export type GeminiUploadRequest = Readonly<{
  body: Uint8Array;
  /** Recorded by the provider only as a label; never used to address the file. */
  displayName: string;
  mimeType: string;
}>;

export type GeminiGenerationRequest = Readonly<{
  fileUri: string;
  /** The single text part. Its shape contract belongs to the caller. */
  instruction: string;
  maxOutputTokens?: number | undefined;
  mimeType: string;
}>;

export type GeminiGenerationResult = Readonly<{
  durationMs: number;
  finishReason: string | null;
  /** The model the provider says it actually ran, which is not always the one asked for. */
  modelVersion: string | null;
  usage: GeminiUsage;
  /** Raw response text. Parsing and validation belong to the caller. */
  text: string;
}>;

export type GeminiAdapter = Readonly<{
  /** Resolves when the file is gone, including when it never existed. */
  deleteFile(fileName: string): Promise<void>;
  /** Null when the provider has no such file, rather than a throw. */
  describeFile(fileName: string): Promise<GeminiFile | null>;
  generateStructuredText(request: GeminiGenerationRequest): Promise<GeminiGenerationResult>;
  uploadVideo(request: GeminiUploadRequest): Promise<GeminiFile>;
  /** Polls until ACTIVE, or throws with `file_failed` or `timeout`. */
  waitForActiveFile(fileName: string): Promise<GeminiFile>;
}>;

/**
 * A failed Gemini operation, carrying only what a job policy can act on.
 *
 * The provider's message is deliberately absent. It is untrusted text that
 * routinely quotes the request back, so including it would put prompt content
 * into an error that a log or an alert would then carry.
 */
export class GeminiError extends Error {
  readonly operation: string;
  readonly responseClass: GeminiResponseClass;
  readonly retryAfterMs: number | null;

  constructor(
    input: Readonly<{
      cause?: unknown;
      operation: string;
      responseClass: GeminiResponseClass;
      retryAfterMs?: number | null;
    }>,
  ) {
    super(`Gemini operation failed: ${input.operation} (${input.responseClass})`);
    this.name = "GeminiError";
    this.operation = input.operation;
    this.responseClass = input.responseClass;
    this.retryAfterMs = input.retryAfterMs ?? null;
    if (input.cause !== undefined) this.cause = input.cause;
  }
}
