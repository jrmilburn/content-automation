import type { GeminiFileState, GeminiUsage } from "@studio-parallel/domain";

import {
  GeminiError,
  type GeminiAdapter,
  type GeminiFile,
  type GeminiGenerationRequest,
  type GeminiGenerationResult,
  type GeminiUploadRequest,
} from "./contract.js";

/**
 * An in-memory Gemini project for local mode and tests.
 *
 * It deliberately reproduces the behaviours the product depends on rather than
 * being permissive. A file starts `PROCESSING` and only becomes usable when the
 * test says so; generating against a file that is not `ACTIVE` fails, as it does
 * on the real provider; and a released file cannot be used again. A fake that
 * accepted anything would let real defects reach a paid provider unnoticed.
 *
 * It spends no money and makes no request, so `PROVIDER_MODE=fake` can exercise
 * the whole handler including the error matrix.
 */

export type FakeGeminiFailure = Readonly<{
  operation: "deleteFile" | "describeFile" | "generateStructuredText" | "uploadVideo";
  error: GeminiError;
}>;

export type FakeGeminiDependencies = Readonly<{
  /** Text every successful generation returns unless overridden. */
  defaultResponseText?: string | undefined;
}>;

export type FakeGemini = Readonly<{
  adapter: GeminiAdapter;
  /** Names released through `deleteFile`, in call order. */
  deletedFiles(): readonly string[];
  /** Files the provider still holds. */
  fileCount(): number;
  /** Makes the next call to one operation fail, once. */
  failNext(failure: FakeGeminiFailure): void;
  /** Instructions received by `generateStructuredText`, in call order. */
  instructions(): readonly string[];
  setFileState(fileName: string, state: GeminiFileState): void;
  setResponse(input: Readonly<{ finishReason?: string; text: string; usage?: GeminiUsage }>): void;
}>;

const emptyUsage: GeminiUsage = Object.freeze({
  cachedTokens: null,
  inputTokens: null,
  outputTokens: null,
  thinkingTokens: null,
  totalTokens: null,
});

export function createFakeGemini(dependencies: FakeGeminiDependencies = {}): FakeGemini {
  const files = new Map<string, GeminiFile>();
  const deleted: string[] = [];
  const seenInstructions: string[] = [];
  const pendingFailures = new Map<string, GeminiError>();

  let sequence = 0;
  let responseText = dependencies.defaultResponseText ?? '{"ok":true}';
  let responseFinishReason = "STOP";
  let responseUsage: GeminiUsage = Object.freeze({
    cachedTokens: null,
    inputTokens: 1_000,
    outputTokens: 200,
    thinkingTokens: null,
    totalTokens: 1_200,
  });

  const takeFailure = (operation: string): void => {
    const failure = pendingFailures.get(operation);
    if (failure) {
      pendingFailures.delete(operation);
      throw failure;
    }
  };

  const byUri = (uri: string): GeminiFile | undefined =>
    [...files.values()].find((file) => file.uri === uri);

  return Object.freeze({
    adapter: Object.freeze({
      async deleteFile(fileName: string): Promise<void> {
        takeFailure("deleteFile");
        // Releasing something already gone is the end state the caller wanted.
        files.delete(fileName);
        deleted.push(fileName);
      },

      async describeFile(fileName: string): Promise<GeminiFile | null> {
        takeFailure("describeFile");
        return files.get(fileName) ?? null;
      },

      async generateStructuredText(
        request: GeminiGenerationRequest,
      ): Promise<GeminiGenerationResult> {
        takeFailure("generateStructuredText");

        // A text-only request references no file, so there is nothing to resolve
        // or to be active. Requiring one here would make every strategy test
        // upload a video it never reasons about.
        if (request.fileUri !== undefined) {
          const file = byUri(request.fileUri);
          if (file === undefined) {
            throw new GeminiError({
              operation: "generateStructuredText",
              responseClass: "invalid_request",
            });
          }
          if (file.state !== "ACTIVE") {
            // The real provider refuses a file it is still processing. Accepting
            // it here would hide a missing poll.
            throw new GeminiError({
              operation: "generateStructuredText",
              responseClass: "invalid_request",
            });
          }
        }

        seenInstructions.push(request.instruction);

        return Object.freeze({
          durationMs: 0,
          finishReason: responseFinishReason,
          modelVersion: "fake-model",
          text: responseText,
          usage: responseUsage,
        });
      },

      async uploadVideo(request: GeminiUploadRequest): Promise<GeminiFile> {
        takeFailure("uploadVideo");

        sequence += 1;
        const name = `files/fake${String(sequence).padStart(6, "0")}`;
        const file = Object.freeze({
          name,
          sizeBytes: request.byteLength,
          // Processing first, so a caller that skips the poll fails here rather
          // than in staging.
          state: "PROCESSING" as GeminiFileState,
          uri: `https://fake.invalid/v1beta/${name}`,
        });

        files.set(name, file);
        return file;
      },

      async waitForActiveFile(fileName: string): Promise<GeminiFile> {
        const file = files.get(fileName);

        if (file === undefined || file.state === "FAILED") {
          throw new GeminiError({ operation: "waitForActiveFile", responseClass: "file_failed" });
        }
        if (file.state !== "ACTIVE") {
          throw new GeminiError({ operation: "waitForActiveFile", responseClass: "timeout" });
        }

        return file;
      },
    }),

    deletedFiles: () => Object.freeze([...deleted]),
    fileCount: () => files.size,

    failNext(failure: FakeGeminiFailure): void {
      pendingFailures.set(failure.operation, failure.error);
    },

    instructions: () => Object.freeze([...seenInstructions]),

    setFileState(fileName: string, state: GeminiFileState): void {
      const file = files.get(fileName);
      if (file === undefined) throw new Error(`Fake Gemini has no file ${fileName}`);
      files.set(fileName, Object.freeze({ ...file, state }));
    },

    setResponse(input): void {
      responseText = input.text;
      responseFinishReason = input.finishReason ?? "STOP";
      responseUsage = input.usage ?? emptyUsage;
    },
  });
}
