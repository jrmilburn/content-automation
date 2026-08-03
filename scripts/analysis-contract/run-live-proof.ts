import { readFile } from "node:fs/promises";
import { argv, env, exit } from "node:process";

import {
  analysisModelRequested,
  completePostCreativeAnalysisV1,
  createAnalysisInstruction,
  validatePostCreativeAnalysisV1,
} from "@studio-parallel/domain";

/**
 * Proves the analysis request against the real Gemini API.
 *
 * This exists because the repository previously asserted Gemini's behaviour
 * from local assumptions. `assertGeminiStructuredOutputSchema` passed on a
 * request the API rejects three different ways, so the contract looked correct
 * for as long as nobody sent it anywhere.
 *
 * It is deliberately not part of `npm run check` or CI: it spends money and
 * depends on a provider being reachable. Run it when the prompt, the schema or
 * the model changes.
 *
 *   npm run analysis:contract:live -- <path-to-video>
 *
 * GEMINI_API_KEY is read from .env.worker, .env.vercel or the environment.
 */

const host = "https://generativelanguage.googleapis.com";

function required(value: string | undefined, message: string): string {
  if (!value) {
    console.error(message);
    exit(1);
  }

  return value;
}

const apiKey = required(env["GEMINI_API_KEY"], "GEMINI_API_KEY is required.");
const videoPath = required(argv[2], "usage: npm run analysis:contract:live -- <path-to-video>");

/**
 * Reads duration from the MP4 movie header.
 *
 * The proof needs the same measured duration the validation worker would
 * supply. Parsing `mvhd` keeps this script independent of whether ffprobe is
 * installed on the machine running it.
 */
function readMp4DurationSeconds(bytes: Buffer): number {
  const marker = bytes.indexOf("mvhd", 0, "latin1");

  if (marker < 0) {
    throw new Error("The proof video must be an MP4 with an mvhd box");
  }

  // Offsets are from the start of the box type. After it come one version byte
  // and three flag bytes, then creation and modification times, whose width is
  // what the version selects.
  if (bytes.readUInt8(marker + 4) === 1) {
    return Number(bytes.readBigUInt64BE(marker + 28)) / bytes.readUInt32BE(marker + 24);
  }

  return bytes.readUInt32BE(marker + 20) / bytes.readUInt32BE(marker + 16);
}

async function uploadVideo(bytes: Buffer): Promise<Readonly<{ name: string; uri: string }>> {
  const started = await fetch(`${host}/upload/v1beta/files?key=${apiKey}`, {
    body: JSON.stringify({ file: { display_name: "analysis-contract-proof" } }),
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(bytes.byteLength),
      "X-Goog-Upload-Header-Content-Type": "video/mp4",
      "X-Goog-Upload-Protocol": "resumable",
    },
    method: "POST",
  });

  const uploadUrl = started.headers.get("x-goog-upload-url");

  if (!uploadUrl) {
    throw new Error(`Upload could not start (${started.status}): ${await started.text()}`);
  }

  const finished = await fetch(uploadUrl, {
    body: new Uint8Array(bytes),
    headers: {
      "Content-Length": String(bytes.byteLength),
      "X-Goog-Upload-Command": "upload, finalize",
      "X-Goog-Upload-Offset": "0",
    },
    method: "POST",
  });

  let file = ((await finished.json()) as { file?: { name?: string; state?: string; uri?: string } })
    .file;

  if (!file?.name) {
    throw new Error("The provider accepted no file");
  }

  // A file is not usable until the provider finishes processing it.
  for (let attempt = 0; attempt < 60 && file.state !== "ACTIVE"; attempt += 1) {
    if (file.state === "FAILED") {
      throw new Error("The provider failed to process the file");
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));
    file = (await (await fetch(`${host}/v1beta/${file.name}?key=${apiKey}`)).json()) as typeof file;
  }

  if (file?.state !== "ACTIVE" || !file.uri || !file.name) {
    throw new Error("The uploaded file never became active");
  }

  return Object.freeze({ name: file.name, uri: file.uri });
}

async function main(): Promise<void> {
  const bytes = await readFile(videoPath);
  const probedDurationSeconds = readMp4DurationSeconds(bytes);

  console.log(`model:    ${analysisModelRequested}`);
  console.log(`duration: ${probedDurationSeconds.toFixed(3)}s`);

  const file = await uploadVideo(bytes);
  const startedAt = Date.now();

  const response = await fetch(
    `${host}/v1beta/models/${analysisModelRequested}:generateContent?key=${apiKey}`,
    {
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { file_data: { file_uri: file.uri, mime_type: "video/mp4" } },
              { text: createAnalysisInstruction() },
            ],
            role: "user",
          },
        ],
        generationConfig: { maxOutputTokens: 32_000, responseMimeType: "application/json" },
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    },
  );

  const body = (await response.json()) as {
    candidates?: readonly {
      content?: { parts?: readonly { text?: string }[] };
      finishReason?: string;
    }[];
    error?: { message?: string; status?: string };
    usageMetadata?: Record<string, unknown>;
  };

  // Always release the provider copy, including on a rejected request.
  const release = fetch(`${host}/v1beta/${file.name}?key=${apiKey}`, { method: "DELETE" }).catch(
    () => undefined,
  );

  if (body.error) {
    console.error(`\nREJECTED ${body.error.status ?? ""}: ${body.error.message ?? ""}`);
    await release;
    exit(1);
  }

  const candidate = body.candidates?.[0];
  console.log(`accepted in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  console.log(`finishReason: ${candidate?.finishReason ?? "unknown"}`);
  console.log(`usage: ${JSON.stringify(body.usageMetadata)}`);

  let parsed: unknown;

  try {
    parsed = JSON.parse(candidate?.content?.parts?.[0]?.text ?? "");
  } catch {
    console.error("\nThe response was not JSON.");
    await release;
    exit(1);
  }

  const stamped = completePostCreativeAnalysisV1(parsed, { probedDurationSeconds });
  const verdict = validatePostCreativeAnalysisV1(stamped, { probedDurationSeconds });

  console.log(`\ncontract valid: ${verdict.valid}`);

  if (!verdict.valid) {
    for (const issue of verdict.issues) {
      console.error(`  ${issue.code} ${issue.path}`);
    }

    await release;
    exit(1);
  }

  await release;
}

main().catch((error: unknown) => {
  console.error(error);
  exit(1);
});
