import { isAllowedInstagramMediaUrl } from "@studio-parallel/domain";

/**
 * Reads media bytes from Meta's CDN.
 *
 * Deliberately not part of the Graph client. That client pins one host and
 * carries a bearer token; this one talks to a different host and must carry no
 * credential at all — the URL is already signed, and attaching the token would
 * hand it to a host that has no business seeing it.
 *
 * The URL is not user-supplied. It comes from a Graph response for a media id
 * the workspace already owns, and it is checked against the host allowlist
 * before the request and again after any redirect, so neither a crafted record
 * nor a redirecting provider can move the read somewhere else.
 */

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export class InstagramMediaDownloadError extends Error {
  readonly reasonCode: string;
  readonly retryable: boolean;

  constructor(reasonCode: string, retryable: boolean) {
    super(`Instagram media download failed: ${reasonCode}`);
    this.name = "InstagramMediaDownloadError";
    this.reasonCode = reasonCode;
    this.retryable = retryable;
  }
}

export type InstagramMediaDownload = Readonly<{
  body: ReadableStream<Uint8Array>;
  contentType: string;
  /** What the provider claimed, for an early refusal only. Never stored. */
  declaredBytes: number | null;
}>;

const defaultTimeoutMs = 30_000;
const maximumRedirects = 3;

/**
 * Opens the media for reading, following redirects by hand.
 *
 * `redirect: "follow"` would let the provider move the read to any host it
 * liked; `redirect: "error"` would break a CDN that legitimately redirects.
 * Following each hop explicitly is the only option that keeps the allowlist in
 * force for every URL actually requested.
 */
export async function openInstagramMediaDownload(input: {
  fetchImplementation?: FetchLike | undefined;
  mediaUrl: string;
  timeoutMs?: number | undefined;
}): Promise<InstagramMediaDownload> {
  const { fetchImplementation = fetch, mediaUrl, timeoutMs = defaultTimeoutMs } = input;

  let target = mediaUrl;

  for (let hop = 0; hop <= maximumRedirects; hop += 1) {
    if (!isAllowedInstagramMediaUrl(target)) {
      throw new InstagramMediaDownloadError("MEDIA_URL_NOT_ALLOWED", false);
    }

    let response: Response;
    try {
      response = await fetchImplementation(target, {
        headers: { Accept: "video/*,*/*;q=0.8" },
        method: "GET",
        // Handled below so every hop is re-checked against the allowlist.
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new InstagramMediaDownloadError("MEDIA_DOWNLOAD_FAILED", true);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      // Release the redirect response before following it.
      await response.body?.cancel().catch(() => undefined);

      if (!location) {
        throw new InstagramMediaDownloadError("MEDIA_DOWNLOAD_FAILED", false);
      }

      target = new URL(location, target).toString();
      continue;
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      // A signed URL that has already expired reads as 403. It is worth another
      // attempt, because the next one asks the Graph API for a fresh one.
      throw new InstagramMediaDownloadError(
        "MEDIA_DOWNLOAD_FAILED",
        response.status === 403 || response.status === 404 || response.status >= 500,
      );
    }

    if (!response.body) {
      throw new InstagramMediaDownloadError("MEDIA_DOWNLOAD_FAILED", true);
    }

    return Object.freeze({
      body: response.body,
      // The provider's claim, used only to pick a container. The probe decides
      // what the bytes actually are.
      contentType: normaliseContentType(response.headers.get("content-type")),
      declaredBytes: readContentLength(response.headers.get("content-length")),
    });
  }

  throw new InstagramMediaDownloadError("MEDIA_DOWNLOAD_FAILED", false);
}

/**
 * Wraps a stream so it fails rather than exceeding the ceiling.
 *
 * The ceiling is enforced here rather than in the storage adapter because it is
 * policy, and because failing mid-stream is what stops a response that lies
 * about its length from being written in full before anyone checks.
 */
export function limitStream(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): ReadableStream<Uint8Array> {
  let seen = 0;

  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;

        if (seen > maxBytes) {
          throw new InstagramMediaDownloadError("MEDIA_TOO_LARGE", false);
        }

        controller.enqueue(chunk);
      },
    }),
  );
}

function normaliseContentType(header: string | null): string {
  if (!header) return "application/octet-stream";

  const [type] = header.split(";");

  return type?.trim().toLowerCase() || "application/octet-stream";
}

function readContentLength(header: string | null): number | null {
  if (!header) return null;

  const parsed = Number.parseInt(header, 10);

  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}
