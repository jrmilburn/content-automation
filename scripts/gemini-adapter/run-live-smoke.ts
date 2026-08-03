import { readFile } from "node:fs/promises";
import { argv, exit } from "node:process";

import { loadGeminiConfig, loadGeminiCredentials } from "@studio-parallel/config";
import { createAnalysisInstruction } from "@studio-parallel/domain";
import { createGeminiHttpAdapter, GeminiError } from "@studio-parallel/integrations";

/**
 * Proves the adapter's file lifecycle against the real Gemini API.
 *
 * `analysis:contract:live` proves the request shape the contract needs. This
 * proves the transport around it: header authentication rather than a key in the
 * URL, the resumable upload, the ACTIVE poll, a model call, and — the part a
 * unit test cannot check — that the provider actually released the file.
 *
 * It is deliberately not part of `npm run check` or CI: it uploads a video and
 * spends tokens. Run it when the adapter, the model or the host changes.
 *
 *   GEMINI_API_KEY=... npm run gemini:adapter:live -- <path-to-video>
 */

function required(value: string | undefined, message: string): string {
  if (!value) {
    console.error(message);
    exit(1);
  }

  return value;
}

const videoPath = required(argv[2], "usage: npm run gemini:adapter:live -- <path-to-video>");

async function main(): Promise<void> {
  const config = loadGeminiConfig();
  const adapter = createGeminiHttpAdapter({ config, credentials: loadGeminiCredentials() });
  const body = new Uint8Array(await readFile(videoPath));

  console.log(`model: ${config.GEMINI_MODEL}`);
  console.log(`bytes: ${body.byteLength}`);

  const uploaded = await adapter.uploadVideo({
    body,
    byteLength: body.byteLength,
    displayName: "gemini-adapter-live-smoke",
    mimeType: "video/mp4",
  });

  console.log(`uploaded: ${uploaded.name} (${uploaded.state})`);

  try {
    const active = await adapter.waitForActiveFile(uploaded.name);
    console.log(`active:   ${active.name}`);

    const result = await adapter.generateStructuredText({
      fileUri: active.uri,
      instruction: createAnalysisInstruction(),
      mimeType: "video/mp4",
    });

    console.log(`answered in ${(result.durationMs / 1000).toFixed(1)}s`);
    console.log(`modelVersion: ${result.modelVersion ?? "unreported"}`);
    console.log(`finishReason: ${result.finishReason ?? "unreported"}`);
    console.log(`usage: ${JSON.stringify(result.usage)}`);
    console.log(`responseBytes: ${result.text.length}`);
  } finally {
    // The whole point of the smoke: uploaded bytes cost money and linger for 48
    // hours, so release runs on every path including a rejected request.
    await adapter.deleteFile(uploaded.name);
    console.log(`deleted:  ${uploaded.name}`);

    const remaining = await adapter.describeFile(uploaded.name);
    console.log(`released: ${remaining === null ? "confirmed" : "STILL PRESENT"}`);

    if (remaining !== null) exit(1);
  }
}

main().catch((error: unknown) => {
  if (error instanceof GeminiError) {
    console.error(`\nFAILED ${error.operation}: ${error.responseClass}`);
    exit(1);
  }

  console.error(error);
  exit(1);
});
