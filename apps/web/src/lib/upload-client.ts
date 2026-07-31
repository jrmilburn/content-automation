/**
 * Browser-side multipart upload driver.
 *
 * This module is deliberately free of React and of any direct storage SDK. It
 * asks the server to reserve an upload, asks for one short-lived signature at a
 * time, and PUTs each slice straight to the returned URL — so video bytes never
 * pass through the application server, and the browser never holds a credential
 * that outlives one part.
 *
 * Resume is the reason part state is kept here rather than recomputed. A part
 * that already succeeded keeps its provider ETag, so pausing and resuming
 * re-sends only what is missing. The server's unique constraint on the upload
 * intent is what actually prevents a duplicate asset; this only prevents the
 * pointless re-upload.
 */

export type UploadPhase =
  "selecting" | "reserving" | "uploading" | "paused" | "completing" | "completed" | "error";

export type UploadSnapshot = Readonly<{
  /** Bytes confirmed stored by the provider, not bytes handed to fetch. */
  bytesUploaded: number;
  error: string | null;
  intentId: string | null;
  partsCompleted: number;
  partsTotal: number;
  phase: UploadPhase;
  totalBytes: number;
}>;

type CompletedPart = Readonly<{ etag: string; partNumber: number }>;

export type UploadSessionOptions = Readonly<{
  file: Blob;
  fileType: string;
  fetchImplementation?: typeof fetch | undefined;
  onChange: (snapshot: UploadSnapshot) => void;
  postId: string;
  /** Attempts per part before the upload stops and offers a retry. */
  retriesPerPart?: number | undefined;
}>;

export type UploadSession = Readonly<{
  cancel(): Promise<void>;
  pause(): void;
  resume(): Promise<void>;
  snapshot(): UploadSnapshot;
  start(): Promise<void>;
}>;

const defaultRetriesPerPart = 3;

/** Message shown for any refusal we have no more specific copy for. */
const genericFailure = "The upload could not be completed.";

const refusalMessages: Readonly<Record<string, string>> = Object.freeze({
  CONTENT_TYPE_NOT_ACCEPTED: "That file type is not supported. Use MP4, MOV or WebM.",
  DUPLICATE_PART: genericFailure,
  EMPTY_FILE: "That file is empty.",
  INTENT_NOT_FOUND: "This upload is no longer available. Start a new one.",
  INTENT_NOT_PENDING: "This upload has already finished.",
  PART_NUMBER_OUT_OF_RANGE: genericFailure,
  POST_NOT_FOUND: "This post is no longer available.",
  SIZE_MISMATCH: "The uploaded file did not match the size that was reserved. Try again.",
  STORAGE_UNAVAILABLE: "Storage is temporarily unavailable. Try again shortly.",
  TOO_LARGE: "That file is larger than the 1 GB limit.",
  UPLOAD_ALREADY_PENDING: "Another upload for this post is already in progress.",
  UPLOAD_EXPIRED: "This upload took too long and expired. Start a new one.",
});

export function describeRefusal(reason: unknown): string {
  return typeof reason === "string" ? (refusalMessages[reason] ?? genericFailure) : genericFailure;
}

export function createUploadSession(options: UploadSessionOptions): UploadSession {
  const doFetch = options.fetchImplementation ?? globalThis.fetch.bind(globalThis);
  const retries = options.retriesPerPart ?? defaultRetriesPerPart;
  const parts = new Map<number, CompletedPart>();

  let phase: UploadPhase = "selecting";
  let error: string | null = null;
  let intentId: string | null = null;
  let partSizeBytes = 0;
  let partsTotal = 0;
  let pauseRequested = false;
  let cancelled = false;

  function snapshot(): UploadSnapshot {
    let bytesUploaded = 0;

    for (const part of parts.keys()) {
      // The final part is short; every other part is exactly one part size.
      bytesUploaded +=
        part === partsTotal ? options.file.size - partSizeBytes * (partsTotal - 1) : partSizeBytes;
    }

    return Object.freeze({
      bytesUploaded,
      error,
      intentId,
      partsCompleted: parts.size,
      partsTotal,
      phase,
      totalBytes: options.file.size,
    });
  }

  function transition(next: UploadPhase, message: string | null = null): void {
    phase = next;
    error = message;
    options.onChange(snapshot());
  }

  async function reserve(): Promise<boolean> {
    transition("reserving");

    const response = await doFetch("/api/uploads", {
      body: JSON.stringify({
        contentType: options.fileType,
        postId: options.postId,
        sizeBytes: options.file.size,
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });

    const body = (await response.json().catch(() => ({}))) as Readonly<{
      intentId?: string;
      partCount?: number;
      partSizeBytes?: number;
      reason?: string;
    }>;

    if (!response.ok || typeof body.intentId !== "string") {
      transition("error", describeRefusal(body.reason));
      return false;
    }

    intentId = body.intentId;
    partsTotal = body.partCount ?? 0;
    partSizeBytes = body.partSizeBytes ?? 0;

    return true;
  }

  async function uploadPart(partNumber: number): Promise<boolean> {
    const start = (partNumber - 1) * partSizeBytes;
    const slice = options.file.slice(start, Math.min(start + partSizeBytes, options.file.size));

    for (let attempt = 1; attempt <= retries; attempt += 1) {
      if (pauseRequested || cancelled) return false;

      try {
        // A signature is requested per attempt rather than reused, so a retry
        // after a long stall cannot fail against an expired URL.
        const signed = await doFetch(`/api/uploads/${intentId}/parts/${partNumber}`, {
          method: "POST",
        });
        const instruction = (await signed.json().catch(() => ({}))) as Readonly<{
          reason?: string;
          url?: string;
        }>;

        if (!signed.ok || typeof instruction.url !== "string") {
          // A refused signature is not a transport blip; retrying will not fix
          // an expired or closed upload.
          transition("error", describeRefusal(instruction.reason));
          return false;
        }

        const stored = await doFetch(instruction.url, { body: slice, method: "PUT" });

        if (!stored.ok) {
          continue;
        }

        const etag = stored.headers.get("ETag")?.replaceAll('"', "");

        if (!etag) {
          continue;
        }

        parts.set(partNumber, Object.freeze({ etag, partNumber }));
        options.onChange(snapshot());

        return true;
      } catch {
        // Network failure. Fall through to the next attempt.
      }
    }

    transition("error", "The connection dropped. You can resume this upload.");

    return false;
  }

  async function complete(): Promise<void> {
    transition("completing");

    const response = await doFetch(`/api/uploads/${intentId}/complete`, {
      body: JSON.stringify({
        parts: [...parts.values()].sort((left, right) => left.partNumber - right.partNumber),
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });

    const body = (await response.json().catch(() => ({}))) as Readonly<{ reason?: string }>;

    if (!response.ok) {
      transition("error", describeRefusal(body.reason));
      return;
    }

    transition("completed");
  }

  async function run(): Promise<void> {
    transition("uploading");

    for (let partNumber = 1; partNumber <= partsTotal; partNumber += 1) {
      if (cancelled) return;

      if (pauseRequested) {
        transition("paused");
        return;
      }

      // Skip what a previous run already stored. This is what makes resume
      // cheap rather than a restart.
      if (parts.has(partNumber)) continue;

      if (!(await uploadPart(partNumber))) {
        if (pauseRequested) transition("paused");
        return;
      }
    }

    await complete();
  }

  async function start(): Promise<void> {
    cancelled = false;
    pauseRequested = false;

    if (!(await reserve())) return;

    await run();
  }

  async function resume(): Promise<void> {
    pauseRequested = false;
    error = null;

    // Nothing was ever reserved, so resuming is just starting.
    if (intentId === null) {
      await start();
      return;
    }

    await run();
  }

  async function cancel(): Promise<void> {
    cancelled = true;

    if (intentId !== null) {
      // Best effort. If the abort never reaches the server the scheduled sweep
      // releases the upload, so the user is never blocked from starting again.
      await doFetch(`/api/uploads/${intentId}/abort`, { method: "POST" }).catch(() => undefined);
    }

    intentId = null;
    parts.clear();
    transition("selecting");
  }

  function pause(): void {
    pauseRequested = true;
  }

  return Object.freeze({ cancel, pause, resume, snapshot, start });
}
