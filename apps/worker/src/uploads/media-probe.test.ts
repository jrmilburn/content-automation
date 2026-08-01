import { describe, expect, it } from "vitest";

import { interpretProbeOutput } from "./media-probe.js";

// Shaped like real `ffprobe -print_format json -show_format -show_streams`
// output, including the string-typed numerics ffprobe actually emits.
function ffprobeJson(
  overrides: Readonly<{ format?: unknown; streams?: readonly unknown[] }> = {},
): string {
  return JSON.stringify({
    format: overrides.format ?? {
      duration: "18.033000",
      format_name: "mov,mp4,m4a,3gp,3g2,mj2",
    },
    streams: overrides.streams ?? [
      { codec_name: "h264", codec_type: "video", height: 1920, width: 1080 },
      { codec_name: "aac", codec_type: "audio" },
    ],
  });
}

describe("interpretProbeOutput", () => {
  it("reads codecs, dimensions and duration from a supported clip", () => {
    const result = interpretProbeOutput(ffprobeJson());

    expect(result).toEqual({
      media: {
        audioCodec: "aac",
        containerFormats: ["mov", "mp4", "m4a", "3gp", "3g2", "mj2"],
        durationMs: 18_033,
        heightPx: 1920,
        videoCodec: "h264",
        widthPx: 1080,
      },
      ok: true,
    });
  });

  it("reports no audio codec when the file carries no audio track", () => {
    const result = interpretProbeOutput(
      ffprobeJson({
        streams: [{ codec_name: "vp9", codec_type: "video", height: 720, width: 1280 }],
      }),
    );

    expect(result.ok && result.media.audioCodec).toBeNull();
  });

  it("falls back to the stream duration when the container omits one", () => {
    const result = interpretProbeOutput(
      ffprobeJson({
        format: { format_name: "matroska,webm" },
        streams: [
          { codec_name: "vp9", codec_type: "video", duration: "5.5", height: 720, width: 1280 },
        ],
      }),
    );

    expect(result.ok && result.media.durationMs).toBe(5_500);
  });

  it("treats output that is not JSON as undecodable", () => {
    expect(interpretProbeOutput("")).toEqual({ ok: false, reason: "UNDECODABLE" });
    expect(interpretProbeOutput("not json at all")).toEqual({ ok: false, reason: "UNDECODABLE" });
    expect(interpretProbeOutput("null")).toEqual({ ok: false, reason: "UNDECODABLE" });
  });

  it("distinguishes a file with no video stream from one that will not parse", () => {
    // An audio-only file demuxes perfectly well. Reporting it as undecodable
    // would tell the user to re-export a file that is not corrupt.
    const result = interpretProbeOutput(
      ffprobeJson({ streams: [{ codec_name: "aac", codec_type: "audio" }] }),
    );

    expect(result).toEqual({ ok: false, reason: "NO_VIDEO_STREAM" });
    expect(interpretProbeOutput(ffprobeJson({ streams: [] }))).toEqual({
      ok: false,
      reason: "NO_VIDEO_STREAM",
    });
  });

  it("refuses a video stream it cannot fully describe rather than guessing", () => {
    for (const stream of [
      { codec_type: "video", height: 1920, width: 1080 },
      { codec_name: "h264", codec_type: "video", height: 1920 },
      { codec_name: "h264", codec_type: "video", width: 1080 },
    ]) {
      expect(interpretProbeOutput(ffprobeJson({ streams: [stream] }))).toEqual({
        ok: false,
        reason: "UNDECODABLE",
      });
    }
  });

  it("refuses a file that reports no duration at all", () => {
    const result = interpretProbeOutput(
      ffprobeJson({
        format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2" },
        streams: [{ codec_name: "h264", codec_type: "video", height: 1920, width: 1080 }],
      }),
    );

    expect(result).toEqual({ ok: false, reason: "UNDECODABLE" });
  });

  it("refuses non-finite durations a crafted container can report", () => {
    for (const duration of ["N/A", "inf", "nan", ""]) {
      expect(
        interpretProbeOutput(
          ffprobeJson({ format: { duration, format_name: "mov,mp4,m4a,3gp,3g2,mj2" } }),
        ),
      ).toEqual({ ok: false, reason: "UNDECODABLE" });
    }
  });

  it("ignores a codec name that is not a plain identifier", () => {
    // The name is stored and displayed, so a probe reporting something
    // unexpected must not become a value this product persists.
    const result = interpretProbeOutput(
      ffprobeJson({
        streams: [
          { codec_name: "h264", codec_type: "video", height: 1920, width: 1080 },
          { codec_name: "<script>alert(1)</script>", codec_type: "audio" },
        ],
      }),
    );

    expect(result.ok && result.media.audioCodec).toBeNull();
  });

  it("drops container tokens that are not plain identifiers", () => {
    const result = interpretProbeOutput(
      ffprobeJson({ format: { duration: "3.0", format_name: "mp4,../../etc,web m" } }),
    );

    expect(result.ok && result.media.containerFormats).toEqual(["mp4"]);
  });
});
