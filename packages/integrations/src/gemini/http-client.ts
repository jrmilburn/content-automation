import type { GeminiConfig, GeminiCredentials } from "@studio-parallel/config";
import {
  classifyGeminiCandidate,
  classifyGeminiFileState,
  classifyGeminiResponse,
  isGeminiFileName,
  parseGeminiRetryAfterMs,
  readGeminiUsage,
  type GeminiFileState,
} from "@studio-parallel/domain";

import {
  GeminiError,
  type GeminiAdapter,
  type GeminiFile,
  type GeminiGenerationRequest,
  type GeminiGenerationResult,
  type GeminiUploadRequest,
} from "./contract.js";

/**
 * The real Gemini transport.
 *
 * Every request shape here was proved against the live API by
 * `scripts/analysis-contract/run-live-proof.ts`; nothing is inferred from
 * documentation. Two things are deliberately done differently from that proof,
 * which was a throwaway:
 *
 * - The key travels in `x-goog-api-key`, not `?key=`. A URL reaches proxies,
 *   redirect targets and access logs; a header does not.
 * - Every call carries a timeout and refuses redirects, so a redirect off the
 *   pinned host cannot take the credential somewhere unaudited.
 *
 * No `responseSchema` is sent. `gemini-3.6-flash` rejects the analysis contract
 * on every provider-schema path, which #122 measured and #126 confirmed for
 * strategy; the shape is described in the instruction instead.
 */

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type GeminiHttpDependencies = Readonly<{
  config: GeminiConfig;
  credentials: GeminiCredentials;
  fetchImplementation?: FetchLike | undefined;
  now?: (() => number) | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJsonBody(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    // A gateway can answer HTML. An unparseable body is not a protocol error on
    // its own; the status still classifies the outcome.
    return null;
  }
}

function readFile(source: unknown, operation: string): GeminiFile {
  const record = isRecord(source) && isRecord(source["file"]) ? source["file"] : source;

  if (!isRecord(record) || !isGeminiFileName(record["name"])) {
    throw new GeminiError({ operation, responseClass: "invalid_request" });
  }

  const uri = record["uri"];
  const sizeBytes = Number(record["sizeBytes"]);

  return Object.freeze({
    name: record["name"],
    sizeBytes: Number.isSafeInteger(sizeBytes) && sizeBytes >= 0 ? sizeBytes : null,
    state: (typeof record["state"] === "string"
      ? record["state"]
      : "STATE_UNSPECIFIED") as GeminiFileState,
    uri: typeof uri === "string" ? uri : "",
  });
}

export function createGeminiHttpAdapter(dependencies: GeminiHttpDependencies): GeminiAdapter {
  const { config, credentials } = dependencies;
  const call = dependencies.fetchImplementation ?? fetch;
  const now = dependencies.now ?? (() => Date.now());
  const sleep =
    dependencies.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const host = config.GEMINI_API_HOST.replace(/\/+$/u, "");

  const authHeaders = (extra: Record<string, string> = {}): Record<string, string> => ({
    "x-goog-api-key": credentials.GEMINI_API_KEY,
    ...extra,
  });

  const send = async (
    url: string,
    init: RequestInit,
    operation: string,
    timeoutMs: number,
  ): Promise<Response> => {
    try {
      return await call(url, {
        ...init,
        // A redirect off the pinned host would carry the credential somewhere
        // unaudited, so it is a failure rather than something to follow.
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const aborted = error instanceof Error && error.name === "TimeoutError";
      throw new GeminiError({
        cause: error,
        operation,
        responseClass: aborted ? "timeout" : "transient",
      });
    }
  };

  const rejectFailure = async (
    response: Response,
    body: unknown,
    operation: string,
  ): Promise<never> => {
    throw new GeminiError({
      operation,
      responseClass: classifyGeminiResponse({ body, status: response.status }),
      retryAfterMs: parseGeminiRetryAfterMs(response.headers.get("retry-after")),
    });
  };

  const fileUrl = (fileName: string, operation: string): string => {
    // The name came from the provider and is about to choose an endpoint, so it
    // is validated rather than trusted.
    if (!isGeminiFileName(fileName)) {
      throw new GeminiError({ operation, responseClass: "invalid_request" });
    }

    return `${host}/v1beta/${fileName}`;
  };

  const describeFile = async (fileName: string): Promise<GeminiFile | null> => {
    const response = await send(
      fileUrl(fileName, "describeFile"),
      { headers: authHeaders(), method: "GET" },
      "describeFile",
      config.GEMINI_REQUEST_TIMEOUT_MS,
    );

    if (response.status === 404) return null;

    const body = await readJsonBody(response);
    if (!response.ok) await rejectFailure(response, body, "describeFile");

    return readFile(body, "describeFile");
  };

  return Object.freeze({
    async deleteFile(fileName: string): Promise<void> {
      const response = await send(
        fileUrl(fileName, "deleteFile"),
        { headers: authHeaders(), method: "DELETE" },
        "deleteFile",
        config.GEMINI_REQUEST_TIMEOUT_MS,
      );

      // An already-released file is the end state the caller wanted. Treating
      // 404 as an error would make cleanup fail exactly when it succeeded.
      if (response.ok || response.status === 404) return;

      await rejectFailure(response, await readJsonBody(response), "deleteFile");
    },

    describeFile,

    async generateStructuredText(
      request: GeminiGenerationRequest,
    ): Promise<GeminiGenerationResult> {
      const startedAt = now();
      const response = await send(
        `${host}/v1beta/models/${config.GEMINI_MODEL}:generateContent`,
        {
          body: JSON.stringify({
            contents: [
              {
                parts: [
                  { file_data: { file_uri: request.fileUri, mime_type: request.mimeType } },
                  { text: request.instruction },
                ],
                role: "user",
              },
            ],
            generationConfig: {
              maxOutputTokens: request.maxOutputTokens ?? config.GEMINI_MAX_OUTPUT_TOKENS,
              responseMimeType: "application/json",
            },
          }),
          headers: authHeaders({ "Content-Type": "application/json" }),
          method: "POST",
        },
        "generateStructuredText",
        config.GEMINI_REQUEST_TIMEOUT_MS,
      );

      const body = await readJsonBody(response);
      if (!response.ok) await rejectFailure(response, body, "generateStructuredText");

      const candidate = classifyGeminiCandidate(body);

      if (candidate.outcome !== "ok" || candidate.text === null) {
        throw new GeminiError({
          operation: "generateStructuredText",
          responseClass:
            candidate.outcome === "safety_blocked"
              ? "safety_blocked"
              : // A truncated answer is a fragment, not an answer. It is reported
                // as absent so no caller parses half a JSON object.
                "no_candidate",
        });
      }

      const modelVersion = isRecord(body) ? body["modelVersion"] : undefined;

      return Object.freeze({
        durationMs: Math.max(0, now() - startedAt),
        finishReason: candidate.finishReason,
        modelVersion: typeof modelVersion === "string" ? modelVersion : null,
        text: candidate.text,
        usage: readGeminiUsage(body),
      });
    },

    async uploadVideo(request: GeminiUploadRequest): Promise<GeminiFile> {
      const started = await send(
        `${host}/upload/v1beta/files`,
        {
          body: JSON.stringify({ file: { display_name: request.displayName } }),
          headers: authHeaders({
            "Content-Type": "application/json",
            "X-Goog-Upload-Command": "start",
            "X-Goog-Upload-Header-Content-Length": String(request.byteLength),
            "X-Goog-Upload-Header-Content-Type": request.mimeType,
            "X-Goog-Upload-Protocol": "resumable",
          }),
          method: "POST",
        },
        "uploadVideo",
        config.GEMINI_REQUEST_TIMEOUT_MS,
      );

      const uploadUrl = started.headers.get("x-goog-upload-url");

      if (!started.ok || !uploadUrl) {
        await rejectFailure(started, await readJsonBody(started), "uploadVideo");
      }

      const finished = await send(
        uploadUrl as string,
        {
          body: request.body,
          // `duplex` is required by fetch before it will send a stream body.
          ...(request.body instanceof Uint8Array ? {} : { duplex: "half" }),
          headers: {
            "Content-Length": String(request.byteLength),
            "X-Goog-Upload-Command": "upload, finalize",
            "X-Goog-Upload-Offset": "0",
          },
          method: "POST",
        } as RequestInit,
        "uploadVideo",
        config.GEMINI_UPLOAD_TIMEOUT_MS,
      );

      const body = await readJsonBody(finished);
      if (!finished.ok) await rejectFailure(finished, body, "uploadVideo");

      return readFile(body, "uploadVideo");
    },

    async waitForActiveFile(fileName: string): Promise<GeminiFile> {
      for (let attempt = 0; attempt < config.GEMINI_FILE_POLL_MAX_ATTEMPTS; attempt += 1) {
        const file = await describeFile(fileName);

        if (file === null) {
          throw new GeminiError({ operation: "waitForActiveFile", responseClass: "file_failed" });
        }

        const state = classifyGeminiFileState(file.state);
        if (state === "active") return file;
        if (state === "failed") {
          throw new GeminiError({ operation: "waitForActiveFile", responseClass: "file_failed" });
        }

        await sleep(config.GEMINI_FILE_POLL_INTERVAL_MS);
      }

      // A file that never became usable is not a failed file: the provider may
      // still be working on it, and the distinction changes the retry answer.
      throw new GeminiError({ operation: "waitForActiveFile", responseClass: "timeout" });
    },
  });
}
