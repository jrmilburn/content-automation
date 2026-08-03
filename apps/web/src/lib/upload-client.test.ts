import { describe, expect, it, vi } from "vitest";

import {
  createUploadSession,
  describeRefusal,
  describeStorageRejection,
  isRetryableStorageStatus,
  type UploadSnapshot,
} from "./upload-client";

const postId = "019a0000-0000-7000-8000-000000000401";
const intentId = "019a0000-0000-7000-8000-000000000501";
const partSizeBytes = 8;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

function partResponse(etag: string, status = 200): Response {
  return new Response(null, { headers: { ETag: `"${etag}"` }, status });
}

/**
 * Routes the three server calls and the direct-to-storage PUT, so a test only
 * has to describe the interesting deviation.
 */
function createFetchStub(
  overrides: Readonly<{
    completeStatus?: number;
    completeReason?: string;
    initiate?: Response;
    partCount?: number;
    onPut?: (partNumber: number, attempt: number) => Response | null;
  }> = {},
) {
  const attempts = new Map<number, number>();
  const calls: string[] = [];

  const stub = vi.fn(async (input: string, init?: RequestInit): Promise<Response> => {
    calls.push(`${init?.method ?? "GET"} ${input}`);

    if (input === "/api/uploads") {
      return (
        overrides.initiate ??
        jsonResponse({
          expiresAt: "2026-08-02T00:00:00.000Z",
          intentId,
          partCount: overrides.partCount ?? 2,
          partSizeBytes,
        })
      );
    }

    if (input.endsWith("/complete")) {
      return overrides.completeStatus !== undefined && overrides.completeStatus >= 400
        ? jsonResponse({ reason: overrides.completeReason }, overrides.completeStatus)
        : jsonResponse({ alreadyCompleted: false, assetId: "asset-1", bytes: 12 }, 201);
    }

    if (input.endsWith("/abort")) {
      return jsonResponse({ alreadyClosed: false });
    }

    const partNumber = Number(/\/parts\/(?<n>\d+)/u.exec(input)?.groups?.n ?? 0);

    // The stub points the signed URL back at the same path, so only the method
    // distinguishes asking for a signature from storing the slice.
    if (init?.method !== "PUT") {
      return jsonResponse({ partNumber, url: input });
    }

    const attempt = (attempts.get(partNumber) ?? 0) + 1;
    attempts.set(partNumber, attempt);

    return overrides.onPut?.(partNumber, attempt) ?? partResponse(`etag-${partNumber}`);
  });

  return { attempts, calls, stub };
}

function createSession(
  stub: ReturnType<typeof createFetchStub>["stub"],
  size = 12,
  extra: Record<string, unknown> = {},
) {
  const snapshots: UploadSnapshot[] = [];
  const session = createUploadSession({
    fetchImplementation: stub as unknown as typeof fetch,
    file: new Blob([new Uint8Array(size)]),
    fileType: "video/mp4",
    onChange: (snapshot) => snapshots.push(snapshot),
    postId,
    ...extra,
  });

  return { session, snapshots };
}

describe("upload session happy path", () => {
  it("reserves, uploads every part and completes", async () => {
    const { calls, stub } = createFetchStub();
    const { session, snapshots } = createSession(stub);

    await session.start();

    expect(session.snapshot().phase).toBe("completed");
    expect(session.snapshot().partsCompleted).toBe(2);
    expect(calls).toEqual([
      "POST /api/uploads",
      `POST /api/uploads/${intentId}/parts/1`,
      `PUT /api/uploads/${intentId}/parts/1`,
      `POST /api/uploads/${intentId}/parts/2`,
      `PUT /api/uploads/${intentId}/parts/2`,
      `POST /api/uploads/${intentId}/complete`,
    ]);
    expect(snapshots.map((snapshot) => snapshot.phase)).toContain("uploading");
  });

  it("reports progress from stored bytes, counting the short final part", async () => {
    const { stub } = createFetchStub();
    const { session } = createSession(stub, 12);

    await session.start();

    // 12 bytes over an 8-byte part size: one full part plus a 4-byte tail.
    expect(session.snapshot().bytesUploaded).toBe(12);
    expect(session.snapshot().totalBytes).toBe(12);
  });

  it("never sends the file to the application server", async () => {
    const { stub } = createFetchStub();
    const { session } = createSession(stub);

    await session.start();

    const bodiedServerCalls = stub.mock.calls.filter(
      ([input, init]) => !String(input).includes("/parts/") && init?.body !== undefined,
    );

    for (const [, init] of bodiedServerCalls) {
      expect(typeof init?.body).toBe("string");
    }
  });
});

describe("upload session resume", () => {
  it("re-sends only the parts that never stored", async () => {
    const { attempts, stub } = createFetchStub({
      partCount: 3,
      onPut: (partNumber) =>
        partNumber === 2 ? new Response(null, { status: 500 }) : partResponse(`etag-${partNumber}`),
    });
    const { session } = createSession(stub, 20, { retriesPerPart: 1 });

    await session.start();

    expect(session.snapshot().phase).toBe("error");
    expect(session.snapshot().partsCompleted).toBe(1);

    // Part two now succeeds; part one must not be uploaded a second time.
    const firstPartAttempts = attempts.get(1) ?? 0;
    stub.mockImplementation(async (input: string, init?: RequestInit) => {
      if (input.endsWith("/complete")) {
        return jsonResponse({ alreadyCompleted: false, assetId: "asset-1", bytes: 20 }, 201);
      }

      const partNumber = Number(/\/parts\/(?<n>\d+)/u.exec(input)?.groups?.n ?? 0);

      if (init?.method !== "PUT") {
        return jsonResponse({ partNumber, url: input });
      }

      attempts.set(partNumber, (attempts.get(partNumber) ?? 0) + 1);

      return partResponse(`etag-${partNumber}`);
    });

    await session.resume();

    expect(session.snapshot().phase).toBe("completed");
    expect(attempts.get(1)).toBe(firstPartAttempts);
  });

  it("stops at the current part when paused and resumes from there", async () => {
    const { stub } = createFetchStub({ partCount: 3 });
    const { session } = createSession(stub, 20);

    const original = stub.getMockImplementation();
    stub.mockImplementation(async (input: string, init?: RequestInit) => {
      if (String(input).includes("/parts/") && init?.method === "PUT") {
        session.pause();
      }

      return original!(input, init);
    });

    await session.start();

    expect(session.snapshot().phase).toBe("paused");
    expect(session.snapshot().partsCompleted).toBe(1);

    stub.mockImplementation(original!);
    await session.resume();

    expect(session.snapshot().phase).toBe("completed");
    expect(session.snapshot().partsCompleted).toBe(3);
  });

  it("retries a dropped part before giving up", async () => {
    const { attempts, stub } = createFetchStub({
      onPut: (partNumber, attempt) =>
        partNumber === 1 && attempt < 3 ? new Response(null, { status: 503 }) : null,
    });
    const { session } = createSession(stub, 12, { retriesPerPart: 3 });

    await session.start();

    expect(session.snapshot().phase).toBe("completed");
    expect(attempts.get(1)).toBe(3);
  });
});

describe("upload session refusals", () => {
  it("stops without uploading when the server refuses the reservation", async () => {
    const { calls, stub } = createFetchStub({
      initiate: jsonResponse({ reason: "TOO_LARGE" }, 413),
    });
    const { session } = createSession(stub);

    await session.start();

    expect(session.snapshot()).toMatchObject({
      error: "That file is larger than this workspace's upload limit.",
      phase: "error",
    });
    expect(calls).toEqual(["POST /api/uploads"]);
  });

  it("does not retry a refused signature", async () => {
    const { stub } = createFetchStub();
    stub.mockImplementation(async (input: string) => {
      if (input === "/api/uploads") {
        return jsonResponse({ intentId, partCount: 2, partSizeBytes });
      }

      return jsonResponse({ reason: "UPLOAD_EXPIRED" }, 410);
    });

    const { session } = createSession(stub);

    await session.start();

    expect(session.snapshot()).toMatchObject({
      error: "This upload took too long and expired. Start a new one.",
      phase: "error",
    });
  });

  it("surfaces a size mismatch from completion", async () => {
    const { stub } = createFetchStub({ completeReason: "SIZE_MISMATCH", completeStatus: 422 });
    const { session } = createSession(stub);

    await session.start();

    expect(session.snapshot()).toMatchObject({
      error: "The uploaded file did not match the size that was reserved. Try again.",
      phase: "error",
    });
  });

  it("clears local part state on cancel so a restart is clean", async () => {
    const { stub } = createFetchStub();
    const { session } = createSession(stub);

    await session.start();
    await session.cancel();

    expect(session.snapshot()).toMatchObject({
      intentId: null,
      partsCompleted: 0,
      phase: "selecting",
    });
  });
});

describe("describeRefusal", () => {
  it("maps known reasons to specific copy", () => {
    expect(describeRefusal("CONTENT_TYPE_NOT_ACCEPTED")).toContain("MP4, MOV or WebM");
  });

  it("falls back safely for an unknown or absent reason", () => {
    for (const reason of ["SOMETHING_NEW", undefined, null, 42]) {
      expect(describeRefusal(reason)).toBe("The upload could not be completed.");
    }
  });
});

describe("storage rejection", () => {
  it("stops immediately on a refused object instead of reporting a dropped connection", async () => {
    // Reproduces the live failure: Supabase answers 413 EntityTooLarge on the
    // part that would take the object past the project's size limit.
    const { attempts, stub } = createFetchStub({
      partCount: 3,
      onPut: (partNumber) =>
        partNumber === 2 ? new Response(null, { status: 413 }) : partResponse(`etag-${partNumber}`),
    });
    const { session } = createSession(stub, 20, { retriesPerPart: 3 });

    await session.start();

    const snapshot = session.snapshot();

    expect(snapshot.phase).toBe("error");
    expect(snapshot.error).toContain("larger than the storage limit");
    expect(snapshot.error).not.toContain("connection dropped");
    expect(snapshot.resumable).toBe(false);
    // One attempt, not three: asking again cannot make the object acceptable.
    expect(attempts.get(2)).toBe(1);
  });

  it.each([401, 403, 400, 404])("stops without retrying on status %d", async (status) => {
    const { attempts, stub } = createFetchStub({
      partCount: 2,
      onPut: (partNumber) =>
        partNumber === 1 ? new Response(null, { status }) : partResponse("etag-2"),
    });
    const { session } = createSession(stub, 12, { retriesPerPart: 3 });

    await session.start();

    expect(session.snapshot().resumable).toBe(false);
    expect(attempts.get(1)).toBe(1);
  });

  it.each([408, 429, 500, 503])(
    "keeps retrying status %d and then offers resume",
    async (status) => {
      const { attempts, stub } = createFetchStub({
        partCount: 2,
        onPut: (partNumber) =>
          partNumber === 1 ? new Response(null, { status }) : partResponse("etag-2"),
      });
      const { session } = createSession(stub, 12, { retriesPerPart: 3 });

      await session.start();

      const snapshot = session.snapshot();

      expect(snapshot.phase).toBe("error");
      expect(snapshot.error).toContain("connection dropped");
      expect(snapshot.resumable).toBe(true);
      expect(attempts.get(1)).toBe(3);
    },
  );

  it("reports a paused upload as resumable", async () => {
    const { stub } = createFetchStub({ partCount: 3 });
    const { session } = createSession(stub, 20);

    const original = stub.getMockImplementation();
    stub.mockImplementation(async (input: string, init?: RequestInit) => {
      if (String(input).includes("/parts/") && init?.method === "PUT") session.pause();

      return original!(input, init);
    });

    await session.start();

    expect(session.snapshot()).toMatchObject({ phase: "paused", resumable: true });
  });
});

describe("isRetryableStorageStatus", () => {
  it.each([408, 429, 500, 502, 503, 504])("retries %d", (status) => {
    expect(isRetryableStorageStatus(status)).toBe(true);
  });

  it.each([400, 401, 403, 404, 409, 413])("refuses to retry %d", (status) => {
    expect(isRetryableStorageStatus(status)).toBe(false);
  });
});

describe("describeStorageRejection", () => {
  it("names the size limit for 413, which is the one a user can act on", () => {
    expect(describeStorageRejection(413)).toContain("larger than the storage limit");
  });

  it("distinguishes an authorisation refusal", () => {
    expect(describeStorageRejection(403)).toContain("not authorised");
  });

  it("falls back without claiming a cause it does not know", () => {
    expect(describeStorageRejection(400)).toBe("Storage refused this upload. Start a new one.");
  });
});
