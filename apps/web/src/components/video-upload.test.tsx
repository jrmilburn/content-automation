// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UploadSnapshot } from "../lib/upload-client";

const cancel = vi.fn();
const pause = vi.fn();
const resume = vi.fn();
const start = vi.fn();

let emit: ((snapshot: UploadSnapshot) => void) | undefined;

vi.mock("../lib/upload-client", () => ({
  createUploadSession: (options: { onChange: (snapshot: UploadSnapshot) => void }) => {
    emit = options.onChange;

    return { cancel, pause, resume, snapshot: () => baseSnapshot, start };
  },
}));

const baseSnapshot: UploadSnapshot = Object.freeze({
  bytesUploaded: 0,
  error: null,
  intentId: null,
  partsCompleted: 0,
  partsTotal: 0,
  phase: "selecting",
  totalBytes: 0,
});

const { VideoUpload } = await import("./video-upload");

function snapshot(overrides: Partial<UploadSnapshot> = {}): UploadSnapshot {
  return Object.freeze({ ...baseSnapshot, ...overrides });
}

async function selectFile() {
  const file = new File([new Uint8Array(12)], "holiday clip.mp4", { type: "video/mp4" });

  fireEvent.change(screen.getByLabelText("Choose a video"), { target: { files: [file] } });

  return file;
}

beforeEach(() => {
  vi.clearAllMocks();
  emit = undefined;
  cancel.mockResolvedValue(undefined);
  resume.mockResolvedValue(undefined);
  start.mockResolvedValue(undefined);
});

describe("VideoUpload before selection", () => {
  it("states the accepted formats and the maximum before anything is chosen", () => {
    render(<VideoUpload postId="019a0000-0000-7000-8000-000000000401" />);

    expect(screen.getByText(/MP4, MOV or WebM, up to 1 GB/u)).toBeVisible();
    expect(screen.getByText("No video selected")).toBeVisible();
  });

  it("restricts the picker to the accepted containers", () => {
    render(<VideoUpload postId="019a0000-0000-7000-8000-000000000401" />);

    const accept = screen.getByLabelText("Choose a video").getAttribute("accept") ?? "";

    expect(accept).toContain("video/mp4");
    expect(accept).toContain("video/quicktime");
    expect(accept).toContain("video/webm");
    expect(accept).not.toContain("video/x-msvideo");
  });

  it("names upload and validation as separate stages from the start", () => {
    render(<VideoUpload postId="019a0000-0000-7000-8000-000000000401" />);

    expect(screen.getByText("1. Upload")).toBeVisible();
    expect(screen.getByText("2. Validation")).toBeVisible();
  });
});

describe("VideoUpload during an upload", () => {
  it("starts a session and shows the chosen filename", async () => {
    render(<VideoUpload postId="019a0000-0000-7000-8000-000000000401" />);

    await selectFile();

    expect(start).toHaveBeenCalledTimes(1);
    expect(screen.getByText("holiday clip.mp4")).toBeVisible();
  });

  it("reports progress from stored bytes with an accessible value", async () => {
    render(<VideoUpload postId="019a0000-0000-7000-8000-000000000401" />);
    await selectFile();

    emit?.(
      snapshot({
        bytesUploaded: 3,
        partsCompleted: 1,
        partsTotal: 4,
        phase: "uploading",
        totalBytes: 12,
      }),
    );

    const bar = await screen.findByRole("progressbar", { name: "Upload progress" });

    expect(bar).toHaveAttribute("aria-valuenow", "25");
    expect(screen.getByText(/part 2 of 4/u)).toBeVisible();
  });

  it("offers pause while uploading and resume once paused", async () => {
    render(<VideoUpload postId="019a0000-0000-7000-8000-000000000401" />);
    await selectFile();

    emit?.(snapshot({ partsTotal: 2, phase: "uploading", totalBytes: 12 }));

    fireEvent.click(await screen.findByRole("button", { name: "Pause" }));
    expect(pause).toHaveBeenCalledTimes(1);

    emit?.(snapshot({ partsCompleted: 1, partsTotal: 2, phase: "paused", totalBytes: 12 }));

    fireEvent.click(await screen.findByRole("button", { name: "Resume upload" }));
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it("offers resume rather than a restart after a dropped connection", async () => {
    render(<VideoUpload postId="019a0000-0000-7000-8000-000000000401" />);
    await selectFile();

    emit?.(
      snapshot({
        error: "The connection dropped. You can resume this upload.",
        partsCompleted: 1,
        partsTotal: 4,
        phase: "error",
        totalBytes: 12,
      }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("You can resume this upload.");
    expect(screen.getByRole("button", { name: "Resume upload" })).toBeVisible();
  });

  it("cancels and clears the selection", async () => {
    render(<VideoUpload postId="019a0000-0000-7000-8000-000000000401" />);
    await selectFile();

    emit?.(snapshot({ partsTotal: 2, phase: "uploading", totalBytes: 12 }));

    fireEvent.click(await screen.findByRole("button", { name: "Cancel upload" }));

    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

describe("VideoUpload after upload", () => {
  it("does not imply the video is ready when only the upload finished", async () => {
    render(<VideoUpload postId="019a0000-0000-7000-8000-000000000401" />);
    await selectFile();

    emit?.(
      snapshot({
        bytesUploaded: 12,
        partsCompleted: 2,
        partsTotal: 2,
        phase: "completed",
        totalBytes: 12,
      }),
    );

    const status = await screen.findByRole("status");

    expect(status).toHaveTextContent("Checking the video before it can be analysed.");
    expect(status.textContent ?? "").not.toMatch(/\bready\b/iu);
  });

  it("shows a refusal without offering a resume that cannot work", async () => {
    render(<VideoUpload postId="019a0000-0000-7000-8000-000000000401" />);
    await selectFile();

    emit?.(
      snapshot({
        bytesUploaded: 12,
        partsCompleted: 2,
        partsTotal: 2,
        phase: "completed",
        totalBytes: 12,
      }),
    );

    expect(screen.queryByRole("button", { name: "Resume upload" })).toBeNull();
  });
});
