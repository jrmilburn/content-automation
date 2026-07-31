import { describe, expect, it } from "vitest";

import {
  completeUploadRequestSchema,
  evaluateUploadAdmission,
  hasUniquePartNumbers,
  isAcceptedVideoContentType,
} from "./video-upload.js";

const baseRequest = {
  declaredBytes: 10_000_000,
  declaredContentType: "video/mp4",
  maxBytes: 1_073_741_824,
  partSizeBytes: 8_388_608,
} as const;

describe("evaluateUploadAdmission", () => {
  it("admits an accepted type within the byte ceiling and reports the part count", () => {
    expect(evaluateUploadAdmission(baseRequest)).toEqual({
      admitted: true,
      partCount: 2,
      partSizeBytes: 8_388_608,
    });
  });

  it("counts a file smaller than one part as a single part", () => {
    expect(evaluateUploadAdmission({ ...baseRequest, declaredBytes: 12 })).toMatchObject({
      admitted: true,
      partCount: 1,
    });
  });

  it("admits a file exactly at the ceiling but refuses one byte more", () => {
    expect(
      evaluateUploadAdmission({ ...baseRequest, declaredBytes: baseRequest.maxBytes }).admitted,
    ).toBe(true);
    expect(
      evaluateUploadAdmission({ ...baseRequest, declaredBytes: baseRequest.maxBytes + 1 }),
    ).toEqual({ admitted: false, reason: "TOO_LARGE" });
  });

  it("refuses an empty, negative or non-integer byte count", () => {
    for (const declaredBytes of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
      expect(evaluateUploadAdmission({ ...baseRequest, declaredBytes })).toEqual({
        admitted: false,
        reason: "EMPTY_FILE",
      });
    }
  });

  it("refuses a container the browser path does not support even though Gemini decodes it", () => {
    for (const declaredContentType of [
      "video/x-msvideo",
      "video/x-flv",
      "video/3gpp",
      "application/octet-stream",
      "video/mp4; codecs=avc1",
    ]) {
      expect(evaluateUploadAdmission({ ...baseRequest, declaredContentType })).toEqual({
        admitted: false,
        reason: "CONTENT_TYPE_NOT_ACCEPTED",
      });
    }
  });

  it("checks size before type so a huge unsupported file is refused for its size", () => {
    expect(
      evaluateUploadAdmission({
        ...baseRequest,
        declaredBytes: baseRequest.maxBytes + 1,
        declaredContentType: "video/x-msvideo",
      }),
    ).toEqual({ admitted: false, reason: "TOO_LARGE" });
  });
});

describe("isAcceptedVideoContentType", () => {
  it("accepts exactly mp4, quicktime and webm", () => {
    expect(["video/mp4", "video/quicktime", "video/webm"].every(isAcceptedVideoContentType)).toBe(
      true,
    );
    expect(isAcceptedVideoContentType("video/mpeg")).toBe(false);
  });
});

describe("completeUploadRequestSchema", () => {
  it("accepts provider-reported parts and an optional checksum", () => {
    const parsed = completeUploadRequestSchema.parse({
      checksumSha256: "a".repeat(64),
      parts: [{ etag: "etag-1", partNumber: 1 }],
    });

    expect(parsed.parts).toHaveLength(1);
  });

  it("rejects an empty part list", () => {
    expect(completeUploadRequestSchema.safeParse({ parts: [] }).success).toBe(false);
  });

  it("rejects part numbers outside the S3 range", () => {
    for (const partNumber of [0, -1, 10_001]) {
      expect(
        completeUploadRequestSchema.safeParse({ parts: [{ etag: "e", partNumber }] }).success,
      ).toBe(false);
    }
  });

  it("rejects a checksum that is not lowercase hex sha256", () => {
    for (const checksumSha256 of ["A".repeat(64), "a".repeat(63), "z".repeat(64)]) {
      expect(
        completeUploadRequestSchema.safeParse({
          checksumSha256,
          parts: [{ etag: "e", partNumber: 1 }],
        }).success,
      ).toBe(false);
    }
  });
});

describe("hasUniquePartNumbers", () => {
  it("accepts distinct part numbers in any order", () => {
    expect(
      hasUniquePartNumbers([
        { etag: "b", partNumber: 2 },
        { etag: "a", partNumber: 1 },
      ]),
    ).toBe(true);
  });

  it("rejects a resumed upload that lists the same part twice", () => {
    expect(
      hasUniquePartNumbers([
        { etag: "first-copy", partNumber: 1 },
        { etag: "second-copy", partNumber: 1 },
      ]),
    ).toBe(false);
  });
});
