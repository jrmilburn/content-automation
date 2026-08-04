import { describe, expect, it } from "vitest";

import {
  instagramMediaImportFields,
  instagramMediaImportKey,
  isAllowedInstagramMediaUrl,
  isImportableInstagramMediaKind,
} from "./instagram-media-import.js";

describe("importable media", () => {
  it("accepts the two kinds that carry a video file", () => {
    expect(isImportableInstagramMediaKind("REEL")).toBe(true);
    expect(isImportableInstagramMediaKind("VIDEO")).toBe(true);
  });

  it("refuses kinds that have no single video to import", () => {
    // Answered before anything is fetched, so an image is a refusal the user
    // reads rather than a job that fails at the provider.
    for (const kind of ["IMAGE", "CAROUSEL_ALBUM", "UNSUPPORTED", "reel", ""]) {
      expect(isImportableInstagramMediaKind(kind)).toBe(false);
    }
  });

  it("requests only fields the pinned media contract already includes", () => {
    // Adding a field to the provider contract obliges a rerun of the sanitised
    // proof, so the import deliberately reuses documented ones.
    expect([...instagramMediaImportFields]).toEqual([
      "id",
      "media_type",
      "media_product_type",
      "media_url",
    ]);
  });
});

describe("media download host allowlist", () => {
  it("accepts Meta's own media CDN hosts over HTTPS", () => {
    for (const candidate of [
      "https://scontent.cdninstagram.com/v/reel.mp4?oe=SIGNATURE",
      "https://scontent-syd2-1.xx.fbcdn.net/v/t66/reel.mp4",
      "https://video.cdninstagram.com/o1/v/reel.mp4",
    ]) {
      expect(isAllowedInstagramMediaUrl(candidate)).toBe(true);
    }
  });

  it("refuses any other host, so a redirect cannot move the read", () => {
    for (const candidate of [
      "https://evil.example/reel.mp4",
      // A suffix that merely contains the allowed one is a different host.
      "https://cdninstagram.com.evil.example/reel.mp4",
      "https://notfbcdn.net.example/reel.mp4",
      "http://scontent.cdninstagram.com/v/reel.mp4",
      "ftp://scontent.cdninstagram.com/v/reel.mp4",
      "https://user:pass@scontent.cdninstagram.com/v/reel.mp4",
      "not-a-url",
      "",
    ]) {
      expect(isAllowedInstagramMediaUrl(candidate)).toBe(false);
    }
  });

  it("is not confused by case or by a port", () => {
    expect(isAllowedInstagramMediaUrl("https://SCONTENT.CDNINSTAGRAM.COM/v/reel.mp4")).toBe(true);
  });
});

describe("import idempotency key", () => {
  it("is anchored on the post and carries no time bucket", () => {
    const postId = "019a0000-0000-7000-8000-000000000401";

    // A second press while the first import is queued must be recognised as the
    // same work rather than starting a second download.
    expect(instagramMediaImportKey(postId)).toBe(instagramMediaImportKey(postId));
    expect(instagramMediaImportKey(postId)).toBe(`instagram-media-import-${postId}`);
  });

  it("contains no dot, which the run pattern would reject", () => {
    expect(instagramMediaImportKey("019a0000-0000-7000-8000-000000000401")).not.toContain(".");
  });
});
