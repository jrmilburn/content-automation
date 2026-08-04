// @vitest-environment jsdom

import type {
  JobDiagnosticDetail,
  JobDiagnosticList,
  JobDiagnosticListItem,
} from "@studio-parallel/db";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cancel: vi.fn(async () => ({ message: "Cancelled", status: "success" as const })),
  refresh: vi.fn(),
  retry: vi.fn(async () => ({ message: "Retry queued", status: "success" as const })),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("../app/(authenticated)/operations/actions", () => ({
  cancelJobAction: mocks.cancel,
  retryJobAction: mocks.retry,
}));

import { JobActionControls } from "./job-action-controls";
import { JobDetail, OperationsError, OperationsList } from "./job-diagnostics";
import { JobLiveRefresh } from "./job-live-refresh";

describe("job diagnostics", () => {
  beforeEach(() => {
    mocks.cancel.mockClear();
    mocks.refresh.mockClear();
    mocks.retry.mockClear();
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.setAttribute("open", "");
      },
    });
    Object.defineProperty(HTMLDialogElement.prototype, "close", {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.removeAttribute("open");
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders distinct queued, processing, retry, failed, completed and cancelled states", () => {
    render(
      <OperationsList
        snapshot={snapshot([
          job("QUEUED"),
          job("PROCESSING"),
          job("RETRY_SCHEDULED"),
          job("FAILED_ATTENTION"),
          job("SUCCEEDED"),
          job("CANCELLED"),
        ])}
        values={{ attention: "all", queueName: "all", resource: "", state: "all" }}
      />,
    );

    expect(
      screen.getByText("Waiting for an available worker. No processing has started yet."),
    ).toBeVisible();
    expect(
      screen.getByText("A worker is active. The current safe stage is shown below."),
    ).toBeVisible();
    expect(screen.getByText(/bounded automatic retry is scheduled/)).toBeVisible();
    expect(screen.getByText(/Automatic attempts stopped/)).toBeVisible();
    expect(screen.getByText(/committed result is available/)).toBeVisible();
    expect(screen.getByText(/No further attempt will start/)).toBeVisible();
    expect(screen.getAllByRole("link", { name: "View detail" })).toHaveLength(6);
    expect(screen.getByLabelText("Account or resource ID")).toBeInTheDocument();
    expect(screen.getByLabelText("Manual attention")).toBeInTheDocument();
  });

  it("shows a truthful filtered empty state and an isolated safe error state", () => {
    const { rerender } = render(
      <OperationsList
        snapshot={snapshot([])}
        values={{ attention: "required", queueName: "all", resource: "", state: "all" }}
      />,
    );
    expect(screen.getByRole("heading", { name: "No jobs match these filters" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Clear filters" })).toHaveAttribute(
      "href",
      "/operations",
    );

    rerender(<OperationsError reference="019c0000-0000-7000-8000-000000000090" />);
    expect(screen.getByRole("heading", { name: "Operations did not load" })).toBeVisible();
    expect(screen.getByText(/Existing workspace data is unchanged and remains safe/)).toBeVisible();
  });

  it("leads detail with state and safe action, then shows only bounded diagnostic fields", () => {
    const detail: JobDiagnosticDetail = {
      ...job("FAILED_ATTENTION"),
      attempts: [
        {
          attemptNumber: 2,
          completedAt: "2026-07-28T05:10:00.000Z",
          errorClass: "INVALID_INPUT",
          errorCode: "SOURCE_VIDEO_REQUIRED",
          handlerVersion: 1,
          heartbeatAt: "2026-07-28T05:10:00.000Z",
          nextAction: "REPLACE_INPUT",
          nextAttemptAt: null,
          stage: "failed_attention",
          startedAt: "2026-07-28T05:09:00.000Z",
          state: "FAILED_ATTENTION",
        },
      ],
      inputVersion: "input.v2",
      lastErrorClass: "INVALID_INPUT",
      lastErrorCode: "SOURCE_VIDEO_REQUIRED",
      nextAction: "REPLACE_INPUT",
      retry: { allowed: true },
      safeErrorDetail:
        "The recorded input did not pass validation. Existing completed data remains safe.",
      validationIssues: ["COUNT_IMPLAUSIBLE at content.majorSectionCount.value"],
      usage: {
        estimatedCostMicros: null,
        inputTokens: null,
        outputTokens: null,
        providerRequests: null,
      },
    };
    render(<JobDetail generatedAt={new Date().toISOString()} job={detail} />);

    expect(screen.getByText("Needs attention", { exact: true })).toBeVisible();
    expect(screen.getByRole("button", { name: "Retry once" })).toBeEnabled();
    expect(screen.getByText(/Existing completed data remains safe/)).toBeVisible();
    expect(screen.getByText(/No provider usage was recorded for this job/)).toBeVisible();
    expect(screen.getByText(detail.correlationId)).toBeVisible();
    expect(screen.getByRole("link", { name: "Open owned resource" })).toHaveAttribute(
      "href",
      `/posts/${detail.resourceId}`,
    );
    expect(document.body.textContent).not.toContain("SECRET_TOKEN");
    expect(document.body.textContent).not.toContain("signed.example.invalid");
    expect(document.body.textContent).not.toContain("verbatim raw prompt content");
  });

  it("disables a retry while the first request is pending", async () => {
    let resolveRetry: ((value: { message: string; status: "success" }) => void) | undefined;
    mocks.retry.mockImplementationOnce(
      async () =>
        new Promise((resolve) => {
          resolveRetry = resolve;
        }),
    );
    render(
      <JobActionControls
        cancel={{ allowed: false, reason: "STATE_NOT_CANCELLABLE" }}
        jobId="019c0000-0000-7000-8000-000000000101"
        retry={{ allowed: true }}
      />,
    );

    const retry = screen.getByRole("button", { name: "Retry once" });
    fireEvent.click(retry);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Queueing retry…" })).toBeDisabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Queueing retry…" }));
    expect(mocks.retry).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveRetry?.({ message: "Retry queued", status: "success" });
    });
    expect(await screen.findByText("Retry queued")).toBeVisible();
  });

  it("closes confirmation and disables cancellation while the request is pending", async () => {
    let resolveCancel: ((value: { message: string; status: "success" }) => void) | undefined;
    mocks.cancel.mockImplementationOnce(
      async () =>
        new Promise((resolve) => {
          resolveCancel = resolve;
        }),
    );
    render(
      <JobActionControls
        cancel={{ allowed: true }}
        jobId="019c0000-0000-7000-8000-000000000101"
        retry={{ allowed: false, reason: "STATE_NOT_RETRYABLE" }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel job" }));
    const dialog = screen.getByRole("dialog", { name: "Cancel this job?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel job" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancelling…" })).toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "Cancelling…" }));
    expect(mocks.cancel).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveCancel?.({ message: "Cancelled", status: "success" });
    });
    expect(await screen.findByText("Cancelled")).toBeVisible();
  });

  it("polls without moving focus and announces only a changed fingerprint", () => {
    vi.useFakeTimers();
    const generatedAt = new Date().toISOString();
    const { rerender } = render(
      <>
        <button type="button">Keep focus</button>
        <JobLiveRefresh fingerprint="job:1" generatedAt={generatedAt} />
      </>,
    );
    screen.getByRole("button", { name: "Keep focus" }).focus();

    act(() => vi.advanceTimersByTime(15_000));
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Keep focus" })).toHaveFocus();
    expect(screen.queryByText("Job information changed after refresh.")).not.toBeInTheDocument();

    rerender(
      <>
        <button type="button">Keep focus</button>
        <JobLiveRefresh fingerprint="job:2" generatedAt={generatedAt} />
      </>,
    );
    expect(screen.getByText("Job information changed after refresh.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Keep focus" })).toHaveFocus();
  });
});

function snapshot(jobs: ReadonlyArray<JobDiagnosticListItem>): JobDiagnosticList {
  return {
    filters: {},
    fingerprint: jobs.map(({ id, state, version }) => `${id}:${version}:${state}`).join("|"),
    generatedAt: new Date().toISOString(),
    isTruncated: false,
    jobs,
    totalCount: jobs.length,
  };
}

function job(state: JobDiagnosticListItem["state"]): JobDiagnosticListItem {
  const suffix = {
    CANCELLED: "106",
    FAILED_ATTENTION: "104",
    PROCESSING: "102",
    QUEUED: "101",
    RETRY_SCHEDULED: "103",
    SUCCEEDED: "105",
  }[state];
  return {
    attemptCount: state === "QUEUED" ? 0 : 2,
    cancel:
      state === "QUEUED" || state === "PROCESSING" || state === "RETRY_SCHEDULED"
        ? { allowed: true }
        : { allowed: false, reason: "STATE_NOT_CANCELLABLE" },
    cancellationRequestedAt: null,
    completedAt:
      state === "FAILED_ATTENTION" || state === "SUCCEEDED" || state === "CANCELLED"
        ? "2026-07-28T05:10:00.000Z"
        : null,
    correlationId: `019c0000-0000-7000-8000-000000000${suffix}`,
    handlerVersion: 1,
    id: `019c0000-0000-7000-8000-000000000${suffix}`,
    inputVersion: "input.v1",
    lastErrorClass: null,
    lastErrorCode: null,
    maxAttempts: 8,
    nextAction: null,
    nextAttemptAt: state === "RETRY_SCHEDULED" ? "2026-07-28T05:20:00.000Z" : null,
    queueName: "analysis.run",
    queuedAt: "2026-07-28T05:00:00.000Z",
    reconciliationCode: null,
    requiresManualAttention: state === "FAILED_ATTENTION",
    resourceId: "019c0000-0000-7000-8000-000000000201",
    resourceType: "instagram_post",
    retry:
      state === "FAILED_ATTENTION"
        ? { allowed: true }
        : { allowed: false, reason: "STATE_NOT_RETRYABLE" },
    stage: state.toLowerCase(),
    startedAt: state === "QUEUED" ? null : "2026-07-28T05:01:00.000Z",
    state,
    updatedAt: "2026-07-28T05:10:00.000Z",
    version: 2,
  };
}
