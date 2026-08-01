import { loadMediaValidationConfig } from "@studio-parallel/config";
import { describe, expect, it } from "vitest";

import type { ProbedMedia } from "./media-probe.js";
import {
  evaluateProbedMedia,
  resolveDeclaredFamily,
  resolveProbedFamily,
  type ValidationEvidence,
} from "./validation-policy.js";

const config = loadMediaValidationConfig({});

// A 9:16 Reel-shaped H.264 clip: the shape the product expects to see most.
const acceptableMedia: ProbedMedia = Object.freeze({
  audioCodec: "aac",
  containerFormats: Object.freeze(["mov", "mp4", "m4a", "3gp", "3g2", "mj2"]),
  durationMs: 18_000,
  heightPx: 1920,
  videoCodec: "h264",
  widthPx: 1080,
});

function evidence(overrides: Partial<ValidationEvidence> = {}): ValidationEvidence {
  return Object.freeze({
    declaredContentType: "video/mp4",
    headerFamily: "ISO_BMFF",
    media: acceptableMedia,
    ...overrides,
  });
}

function withMedia(overrides: Partial<ProbedMedia>): ValidationEvidence {
  return evidence({ media: Object.freeze({ ...acceptableMedia, ...overrides }) });
}

describe("resolveDeclaredFamily", () => {
  it("maps every accepted upload content type to a container family", () => {
    expect(resolveDeclaredFamily("video/mp4")).toBe("ISO_BMFF");
    expect(resolveDeclaredFamily("video/quicktime")).toBe("ISO_BMFF");
    expect(resolveDeclaredFamily("video/webm")).toBe("MATROSKA");
  });

  it("ignores case and surrounding whitespace", () => {
    expect(resolveDeclaredFamily("  VIDEO/MP4 ")).toBe("ISO_BMFF");
  });

  it("refuses a type outside the accepted set", () => {
    expect(resolveDeclaredFamily("video/x-msvideo")).toBeNull();
    expect(resolveDeclaredFamily("application/octet-stream")).toBeNull();
  });
});

describe("resolveProbedFamily", () => {
  it("reads a family from ffprobe's comma-separated demuxer list", () => {
    // ffprobe never reports a single name for these containers, so matching the
    // whole string against "mp4" would classify every real upload as unknown.
    expect(resolveProbedFamily(["mov", "mp4", "m4a", "3gp", "3g2", "mj2"])).toBe("ISO_BMFF");
    expect(resolveProbedFamily(["matroska", "webm"])).toBe("MATROSKA");
  });

  it("refuses a list with no accepted container in it", () => {
    expect(resolveProbedFamily(["avi"])).toBeNull();
    expect(resolveProbedFamily([])).toBeNull();
  });
});

describe("evaluateProbedMedia", () => {
  it("accepts a supported clip and reports its detected shape", () => {
    const verdict = evaluateProbedMedia(evidence(), config);

    expect(verdict.accepted).toBe(true);
    expect(verdict.accepted && verdict.media.durationMs).toBe(18_000);
  });

  it("accepts a clip with no audio track", () => {
    expect(evaluateProbedMedia(withMedia({ audioCodec: null }), config).accepted).toBe(true);
  });

  it("rejects a declared type the upload policy never accepts", () => {
    const verdict = evaluateProbedMedia(
      evidence({ declaredContentType: "video/x-matroska" }),
      config,
    );

    expect(verdict).toEqual({ accepted: false, code: "CONTAINER_UNSUPPORTED" });
  });

  it("rejects an object whose own header identifies no accepted container", () => {
    const verdict = evaluateProbedMedia(evidence({ headerFamily: null }), config);

    expect(verdict).toEqual({ accepted: false, code: "CONTAINER_UNSUPPORTED" });
  });

  it("rejects a WebM renamed to look like MP4", () => {
    // The declared type says ISO BMFF; the bytes say Matroska. This is the
    // extension/container mismatch case, and the header alone catches it.
    const verdict = evaluateProbedMedia(evidence({ headerFamily: "MATROSKA" }), config);

    expect(verdict).toEqual({ accepted: false, code: "CONTAINER_MISMATCH" });
  });

  it("rejects a file whose header and probe disagree with each other", () => {
    // A polyglot can satisfy the magic-byte check while demuxing as something
    // else. Both signals must agree with the declared type, not just one.
    const verdict = evaluateProbedMedia(
      withMedia({ containerFormats: ["matroska", "webm"] }),
      config,
    );

    expect(verdict).toEqual({ accepted: false, code: "CONTAINER_MISMATCH" });
  });

  it("rejects a container the probe could not name", () => {
    const verdict = evaluateProbedMedia(withMedia({ containerFormats: [] }), config);

    expect(verdict).toEqual({ accepted: false, code: "CONTAINER_UNSUPPORTED" });
  });

  it("rejects a video codec outside the configured set", () => {
    const verdict = evaluateProbedMedia(withMedia({ videoCodec: "mpeg4" }), config);

    expect(verdict).toEqual({ accepted: false, code: "VIDEO_CODEC_UNSUPPORTED" });
  });

  it("rejects an audio codec outside the configured set", () => {
    const verdict = evaluateProbedMedia(withMedia({ audioCodec: "mp3" }), config);

    expect(verdict).toEqual({ accepted: false, code: "AUDIO_CODEC_UNSUPPORTED" });
  });

  it("rejects a clip shorter than the floor or longer than the ceiling", () => {
    expect(evaluateProbedMedia(withMedia({ durationMs: 400 }), config)).toEqual({
      accepted: false,
      code: "DURATION_OUT_OF_RANGE",
    });
    expect(
      evaluateProbedMedia(
        withMedia({ durationMs: (config.MEDIA_MAX_DURATION_SECONDS + 1) * 1000 }),
        config,
      ),
    ).toEqual({ accepted: false, code: "DURATION_OUT_OF_RANGE" });
  });

  it("applies dimension bounds to both axes regardless of orientation", () => {
    // Landscape source footage and vertical Reels are judged by the same rule,
    // so a wide clip must not be rejected merely for being wide.
    expect(evaluateProbedMedia(withMedia({ heightPx: 1080, widthPx: 1920 }), config).accepted).toBe(
      true,
    );

    expect(evaluateProbedMedia(withMedia({ heightPx: 64, widthPx: 64 }), config)).toEqual({
      accepted: false,
      code: "DIMENSIONS_OUT_OF_RANGE",
    });
    expect(evaluateProbedMedia(withMedia({ heightPx: 100_00, widthPx: 100 }), config)).toEqual({
      accepted: false,
      code: "DIMENSIONS_OUT_OF_RANGE",
    });
  });

  it("honours a widened codec set from configuration rather than hard-coding it", () => {
    // The policy is deployment configuration, so proving it is read is what
    // stops the allowed set drifting into the code.
    const widened = loadMediaValidationConfig({ MEDIA_ALLOWED_VIDEO_CODECS: "mpeg4" });

    expect(evaluateProbedMedia(withMedia({ videoCodec: "mpeg4" }), widened).accepted).toBe(true);
    expect(evaluateProbedMedia(withMedia({ videoCodec: "h264" }), widened)).toEqual({
      accepted: false,
      code: "VIDEO_CODEC_UNSUPPORTED",
    });
  });
});
