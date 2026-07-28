// @vitest-environment jsdom

import type { DashboardSummary } from "@studio-parallel/domain";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Dashboard } from "./dashboard";

describe("Dashboard", () => {
  it("leads the truthful no-account state with the setup action and names every unavailable section", () => {
    render(<Dashboard summary={setupSummary()} />);

    expect(
      screen.getByRole("heading", { level: 2, name: "Connect an Instagram account" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Connect Instagram account" })).toHaveAttribute(
      "href",
      "/accounts",
    );
    expect(screen.getByText(/Manual attention will appear/)).toBeInTheDocument();
    expect(screen.getByText(/Post performance and analysis coverage require/)).toBeInTheDocument();
    expect(screen.getByText(/A current strategy requires/)).toBeInTheDocument();
    expect(screen.getByText(/Processing activity will appear/)).toBeInTheDocument();
  });

  it("renders available partial data, ordered attention, staleness and an isolated section error", () => {
    const summary = setupSummary();
    render(
      <Dashboard
        summary={{
          ...summary,
          attention: {
            data: {
              items: [
                {
                  detail: "The latest sync completed.",
                  id: "sync-complete",
                  priority: "information",
                  title: "Sync completed",
                },
                {
                  action: { href: "/posts?source=missing", label: "Review posts" },
                  detail: "Three posts need their source video.",
                  id: "missing-source",
                  priority: "manual_action",
                  title: "Upload source videos",
                },
                {
                  action: { href: "/accounts", label: "Reconnect account" },
                  detail: "Import cannot continue until access is restored.",
                  id: "reconnect",
                  priority: "blocking",
                  title: "Reconnect Instagram account",
                },
                {
                  detail: "Confirm the requested read-only scope.",
                  id: "permission",
                  priority: "security",
                  title: "Review account permission",
                },
              ],
            },
            isStale: false,
            state: "available",
            updatedAt: "2026-07-28T02:00:00.000Z",
          },
          coverage: {
            data: {
              metrics: [
                { label: "Imported posts", value: 18 },
                {
                  action: { href: "/posts?source=missing", label: "Review missing source" },
                  label: "Missing source",
                  value: 3,
                },
                { label: "Analysed posts", value: 9 },
              ],
              performanceSummary: "Comparable performance is available for eight posts.",
            },
            isStale: true,
            state: "available",
            updatedAt: "2026-07-27T00:00:00.000Z",
          },
          integration: {
            data: {
              accountName: "Studio Parallel",
              action: { href: "/accounts", label: "Review account" },
              description: "Account access and the latest sync are healthy.",
              status: "healthy",
              statusLabel: "Healthy",
            },
            isStale: false,
            state: "available",
            updatedAt: "2026-07-28T02:00:00.000Z",
          },
          processing: {
            message:
              "This summary could not be loaded. Other dashboard information remains available.",
            reference: "019873d5-31e6-7c59-a531-1f2f4cbce231",
            state: "error",
          },
        }}
      />,
    );

    const attentionSection = screen
      .getByRole("heading", { name: "Work requiring attention" })
      .closest("section");
    expect(attentionSection).not.toBeNull();
    expect(
      within(attentionSection!)
        .getAllByRole("heading", { level: 3 })
        .map(({ textContent }) => textContent),
    ).toEqual([
      "Reconnect Instagram account",
      "Review account permission",
      "Upload source videos",
      "Sync completed",
    ]);
    expect(screen.getByText("Comparable performance is available for eight posts.")).toBeVisible();
    expect(screen.getByRole("link", { name: /3 Review missing source/ })).toHaveAttribute(
      "href",
      "/posts?source=missing",
    );
    expect(screen.getByText("Stale")).toBeInTheDocument();
    expect(screen.getByText(/This summary could not be loaded/)).toBeVisible();
    expect(screen.getByText(/019873d5-31e6-7c59-a531-1f2f4cbce231/)).toBeVisible();
    expect(screen.getByText(/A current strategy requires/)).toBeVisible();
  });

  it("keeps a loading region isolated from available setup information", () => {
    const summary = setupSummary();
    render(
      <Dashboard
        summary={{
          ...summary,
          attention: { label: "Loading work requiring attention", state: "loading" },
        }}
      />,
    );

    expect(screen.getByText("Loading work requiring attention")).toBeVisible();
    expect(screen.getByRole("link", { name: "Connect Instagram account" })).toBeVisible();
    expect(screen.getByText(/A current strategy requires/)).toBeVisible();
  });
});

function setupSummary(): DashboardSummary {
  return {
    attention: {
      reason:
        "Manual attention will appear after an Instagram account and imported posts are available.",
      state: "unavailable",
    },
    coverage: {
      reason:
        "Post performance and analysis coverage require imported posts and completed analyses.",
      state: "unavailable",
    },
    generatedAt: "2026-07-28T02:00:00.000Z",
    integration: {
      data: {
        action: { href: "/accounts", label: "Connect Instagram account" },
        description:
          "Connect an approved professional account before posts, trends and strategy can populate.",
        status: "not_connected",
        statusLabel: "Not connected",
      },
      isStale: false,
      state: "available",
      updatedAt: "2026-07-28T02:00:00.000Z",
    },
    processing: {
      reason:
        "Processing activity will appear after the first account sync or analysis job starts.",
      state: "unavailable",
    },
    strategy: {
      reason: "A current strategy requires enough imported, analysed and comparable posts.",
      state: "unavailable",
    },
  };
}
