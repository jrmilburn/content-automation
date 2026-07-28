// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { DashboardSummary } from "@studio-parallel/domain";

const setupSummary: DashboardSummary = {
  attention: {
    reason: "Manual attention will appear after an Instagram account is available.",
    state: "unavailable",
  },
  coverage: {
    reason: "Coverage requires imported posts.",
    state: "unavailable",
  },
  generatedAt: "2026-07-28T02:00:00.000Z",
  integration: {
    data: {
      action: { href: "/accounts", label: "Connect Instagram account" },
      description: "Connect an approved professional account before posts can populate.",
      status: "not_connected",
      statusLabel: "Not connected",
    },
    isStale: false,
    state: "available",
    updatedAt: "2026-07-28T02:00:00.000Z",
  },
  processing: {
    reason: "Processing requires a sync or analysis job.",
    state: "unavailable",
  },
  strategy: {
    reason: "Strategy requires analysed posts.",
    state: "unavailable",
  },
};

vi.mock("../../lib/server/dashboard-summary", () => ({
  loadDashboardSummary: vi.fn(async () => setupSummary),
}));

import DashboardPage from "./page";

describe("DashboardPage", () => {
  it("loads the authorised summary into the canonical dashboard", async () => {
    render(await DashboardPage());

    expect(screen.getByRole("heading", { level: 1, name: "Dashboard" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Connect Instagram account" })).toHaveAttribute(
      "href",
      "/accounts",
    );
  });
});
