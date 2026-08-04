// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { SourceVideoAsset } from "../lib/server/source-video-data";

// The control reaches the server action, and through it next-auth, which does
// not load under jsdom. Its own behaviour is tested separately.
vi.mock("./analysis-request-control", () => ({
  AnalysisRequestControl: ({ postId }: Readonly<{ postId: string }>) => (
    <button data-post={postId} type="button">
      Analyse this video
    </button>
  ),
}));

const { SourceVideoStatus } = await import("./source-video-status");

/**
 * What an uploader can learn about their video.
 *
 * These exist because a 168 MB upload once stored successfully, failed
 * validation, and showed nothing at all — the only way to find out was to query
 * the database.
 */

function asset(overrides: Partial<SourceVideoAsset> = {}): SourceVideoAsset {
  return Object.freeze({
    bytes: 168_242_657,
    contentType: "video/mp4",
    durationMs: null,
    heightPx: null,
    id: "019fc538-493b-71f8-9c49-b9dfa1803503",
    instagramPostId: "019fb5f6-1ad8-75f9-9320-59b589b45581",
    origin: "USER_UPLOAD",
    rejectionCode: null,
    state: "PENDING_VALIDATION",
    uploadedAt: "2026-08-03T01:23:48.157Z",
    validatedAt: null,
    widthPx: null,
    ...overrides,
  });
}

describe("SourceVideoStatus", () => {
  it("says a pending video is being checked and will not update on its own", () => {
    // A spinner that never resolves is a worse lie than an instruction to
    // reload, because the upload may in fact have failed.
    render(<SourceVideoStatus asset={asset()} />);

    const state = screen.getByRole("status");

    expect(state).toHaveTextContent("being checked");
    expect(state).toHaveTextContent("does not update on its own");
  });

  it("confirms a ready video with its measured details", () => {
    render(
      <SourceVideoStatus
        asset={asset({
          durationMs: 95_400,
          heightPx: 1920,
          state: "READY",
          validatedAt: "2026-08-03T01:25:00.000Z",
          widthPx: 1080,
        })}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("ready to analyse");
    expect(screen.getByText(/160\.4 MB/u)).toBeVisible();
    expect(screen.getByText(/1:35/u)).toBeVisible();
    expect(screen.getByText(/1080×1920/u)).toBeVisible();
  });

  it.each([
    ["UNDECODABLE", "could not be decoded"],
    ["NO_VIDEO_STREAM", "no video track"],
    ["DURATION_OUT_OF_RANGE", "too short or too long"],
    ["VIDEO_CODEC_UNSUPPORTED", "codec that cannot be analysed"],
  ])("explains rejection %s in plain language", (rejectionCode, expected) => {
    render(<SourceVideoStatus asset={asset({ rejectionCode, state: "REJECTED" })} />);

    const alert = screen.getByRole("alert");

    expect(alert).toHaveTextContent(expected);
    expect(alert).toHaveTextContent("Upload a different file");
  });

  it("still explains a rejection with no stored code", () => {
    render(<SourceVideoStatus asset={asset({ rejectionCode: null, state: "REJECTED" })} />);

    expect(screen.getByRole("alert")).toHaveTextContent("could not be validated");
  });

  it("shows an unrecognised rejection code without leaking it", () => {
    render(
      <SourceVideoStatus asset={asset({ rejectionCode: "SOMETHING_NEW", state: "REJECTED" })} />,
    );

    const alert = screen.getByRole("alert");

    expect(alert).toHaveTextContent("could not be validated");
    expect(alert.textContent ?? "").not.toContain("SOMETHING_NEW");
  });

  it("omits measurements that were never taken rather than showing zeroes", () => {
    render(<SourceVideoStatus asset={asset()} />);

    const text = document.body.textContent ?? "";

    expect(text).not.toContain("0:00");
    expect(text).not.toContain("×");
  });

  it("exposes no storage provenance", () => {
    render(<SourceVideoStatus asset={asset({ state: "READY" })} />);

    const text = document.body.textContent ?? "";

    for (const secret of ["objectKey", "bucket", "etag", "checksum", "source-video/"]) {
      expect(text).not.toContain(secret);
    }
  });
});

describe("analyse control placement", () => {
  it("offers analysis only once the video has been checked", () => {
    // Asking to analyse a file that failed its probe would spend money on a
    // video the product already knows it cannot read.
    render(<SourceVideoStatus asset={asset({ state: "READY" })} />);
    expect(screen.getByRole("button", { name: "Analyse this video" })).toBeVisible();
  });

  it.each(["PENDING_VALIDATION", "REJECTED"] as const)(
    "does not offer analysis for a %s asset",
    (state) => {
      render(<SourceVideoStatus asset={asset({ rejectionCode: "UNDECODABLE", state })} />);
      expect(screen.queryByRole("button", { name: "Analyse this video" })).toBeNull();
    },
  );

  it("names the post the analysis is for", () => {
    render(<SourceVideoStatus asset={asset({ state: "READY" })} />);
    expect(screen.getByRole("button", { name: "Analyse this video" })).toHaveAttribute(
      "data-post",
      "019fb5f6-1ad8-75f9-9320-59b589b45581",
    );
  });
});

describe("where the video came from", () => {
  it("says a video was uploaded from the user's own file", () => {
    render(<SourceVideoStatus asset={asset({ origin: "USER_UPLOAD", state: "READY" })} />);

    expect(screen.getByText("Source")).toBeVisible();
    expect(screen.getByText(/Uploaded from your own file/u)).toBeVisible();
  });

  it("says a video was copied from Instagram, and that it is a re-encode", () => {
    // The imported copy is not the master the account owner filmed. A reader
    // comparing quality later has to be able to tell which one this is.
    render(<SourceVideoStatus asset={asset({ origin: "PROVIDER_IMPORT", state: "READY" })} />);

    expect(screen.getByText(/Copied from Instagram/u)).toBeVisible();
    expect(screen.getByText(/re-encoded for playback/u)).toBeVisible();
  });

  it("describes an import that is still being checked as copied, not uploaded", () => {
    render(
      <SourceVideoStatus
        asset={asset({ origin: "PROVIDER_IMPORT", state: "PENDING_VALIDATION" })}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      /Copied from Instagram and being checked/u,
    );
  });

  it("offers a different next step when an imported video was refused", () => {
    // Uploading a different file is the useful advice for a rejected upload. For
    // a rejected import there is no other file to choose, so it says so.
    render(
      <SourceVideoStatus
        asset={asset({
          origin: "PROVIDER_IMPORT",
          rejectionCode: "UNDECODABLE",
          state: "REJECTED",
        })}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(/Upload your own file instead/u);
  });
});
