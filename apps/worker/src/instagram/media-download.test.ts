import { describe, expect, it, vi } from "vitest";

import {
  InstagramMediaDownloadError,
  limitStream,
  openInstagramMediaDownload,
} from "./media-download.js";

/**
 * The download is the one outbound call in the product that reads bytes from a
 * host other than the pinned Graph endpoint, so the tests are about what it
 * refuses rather than what it fetches.
 */

const allowedUrl = "https://scontent.cdninstagram.com/v/reel.mp4?oe=SIGNATURE";

function streamOf(...chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function respond(
  body: ReadableStream<Uint8Array> | null,
  init: Readonly<{ headers?: Record<string, string>; status?: number }> = {},
): Response {
  return new Response(body, {
    headers: init.headers ?? { "content-type": "video/mp4" },
    status: init.status ?? 200,
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<number> {
  const reader = stream.getReader();
  let bytes = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
  }

  return bytes;
}

describe("opening a media download", () => {
  it("reads an allowlisted host and reports what the provider claimed", async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(
      respond(streamOf(new Uint8Array(8)), {
        headers: { "content-length": "8", "content-type": "video/mp4; codecs=avc1" },
      }),
    );

    const download = await openInstagramMediaDownload({
      fetchImplementation,
      mediaUrl: allowedUrl,
    });

    expect(download.contentType).toBe("video/mp4");
    expect(download.declaredBytes).toBe(8);
    await expect(collect(download.body)).resolves.toBe(8);
  });

  it("never sends a credential to the CDN", async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(respond(streamOf(new Uint8Array(4))));

    await openInstagramMediaDownload({ fetchImplementation, mediaUrl: allowedUrl });

    // The URL is already signed. An Authorization header would hand the bearer
    // token to a host that has no business seeing it.
    const [, init] = fetchImplementation.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.has("authorization")).toBe(false);
    expect(JSON.stringify(init.headers)).not.toMatch(/bearer/iu);
  });

  it("refuses a host outside the allowlist without fetching it", async () => {
    const fetchImplementation = vi.fn();

    await expect(
      openInstagramMediaDownload({
        fetchImplementation,
        mediaUrl: "https://evil.example/reel.mp4",
      }),
    ).rejects.toMatchObject({ reasonCode: "MEDIA_URL_NOT_ALLOWED", retryable: false });

    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("re-checks the allowlist after a redirect, so a hop cannot move the read", async () => {
    const fetchImplementation = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, { headers: { location: "https://evil.example/reel.mp4" }, status: 302 }),
      );

    await expect(
      openInstagramMediaDownload({ fetchImplementation, mediaUrl: allowedUrl }),
    ).rejects.toMatchObject({ reasonCode: "MEDIA_URL_NOT_ALLOWED" });

    // The second hop is never requested.
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it("follows a redirect that stays inside the allowlist", async () => {
    const fetchImplementation = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          headers: { location: "https://video.cdninstagram.com/o1/v/reel.mp4" },
          status: 302,
        }),
      )
      .mockResolvedValueOnce(respond(streamOf(new Uint8Array(6))));

    const download = await openInstagramMediaDownload({
      fetchImplementation,
      mediaUrl: allowedUrl,
    });

    await expect(collect(download.body)).resolves.toBe(6);
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it("treats an expired signature as worth another attempt", async () => {
    // A 403 here means the signed URL aged out. The retry asks the Graph API
    // for a fresh one, so it is a different request rather than the same one.
    const fetchImplementation = vi.fn().mockResolvedValue(respond(null, { status: 403 }));

    await expect(
      openInstagramMediaDownload({ fetchImplementation, mediaUrl: allowedUrl }),
    ).rejects.toMatchObject({ retryable: true });
  });

  it("does not retry a refusal the provider will repeat", async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(respond(null, { status: 400 }));

    await expect(
      openInstagramMediaDownload({ fetchImplementation, mediaUrl: allowedUrl }),
    ).rejects.toMatchObject({ retryable: false });
  });

  it("stops rather than following redirects for ever", async () => {
    const fetchImplementation = vi
      .fn()
      .mockResolvedValue(new Response(null, { headers: { location: allowedUrl }, status: 302 }));

    await expect(
      openInstagramMediaDownload({ fetchImplementation, mediaUrl: allowedUrl }),
    ).rejects.toBeInstanceOf(InstagramMediaDownloadError);
  });
});

describe("the byte ceiling", () => {
  it("passes a stream that stays inside the ceiling through unchanged", async () => {
    const limited = limitStream(streamOf(new Uint8Array(4), new Uint8Array(4)), 16);

    await expect(collect(limited)).resolves.toBe(8);
  });

  it("fails mid-stream rather than storing more than the ceiling", async () => {
    // The provider's declared length is a claim; this is what happens when the
    // claim was wrong, or absent.
    const limited = limitStream(streamOf(new Uint8Array(8), new Uint8Array(8)), 10);

    await expect(collect(limited)).rejects.toMatchObject({ reasonCode: "MEDIA_TOO_LARGE" });
  });
});
