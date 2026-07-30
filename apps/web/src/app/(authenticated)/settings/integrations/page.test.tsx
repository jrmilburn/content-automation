// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { IntegrationsSnapshot } from "../../../../lib/server/integrations-data";

const loadInstagramIntegrations = vi.fn();
const reportError = vi.fn();

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("../../../../lib/server/integrations-data", () => ({
  loadInstagramIntegrations: () => loadInstagramIntegrations(),
}));
// The disconnect control is a client component whose server action reaches the
// auth stack; this page test is about the page, not that chain.
vi.mock("../../../../components/instagram-disconnect-control", () => ({
  InstagramDisconnectControl: () => <button type="button">Disconnect account</button>,
}));
vi.mock("../../../../lib/server/observability", () => ({
  webErrorMonitor: { captureException: vi.fn() },
  webLogger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));
vi.mock("@studio-parallel/observability", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  reportError: (...args: unknown[]) => reportError(...args),
}));

const IntegrationsPage = (await import("./page")).default;

const snapshot: IntegrationsSnapshot = {
  accounts: [
    {
      accountId: "019a0000-0000-7000-8000-000000000301",
      accountType: "BUSINESS",
      apiVersion: "v25.0",
      connectionStatus: "ACTIVE",
      expiresAt: new Date("2026-09-20T00:00:00.000Z"),
      grantedScopes: ["instagram_business_basic", "instagram_business_manage_insights"],
      healthState: "HEALTHY",
      lastSuccessfulSyncAt: new Date("2026-07-31T02:00:00.000Z"),
      lastValidatedAt: new Date("2026-07-31T02:00:00.000Z"),
      username: "studioparallel",
    },
  ],
  canManage: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  loadInstagramIntegrations.mockResolvedValue(snapshot);
});

describe("IntegrationsPage", () => {
  it("renders the connection snapshot", async () => {
    render(await IntegrationsPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByRole("heading", { level: 1, name: "Instagram integration" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "@studioparallel" })).toBeVisible();
  });

  it("passes the callback outcome through to the banner", async () => {
    render(await IntegrationsPage({ searchParams: Promise.resolve({ instagram: "connected" }) }));

    expect(screen.getByText("Instagram account connected")).toBeVisible();
  });

  it("ignores an unrecognised outcome rather than reflecting it", async () => {
    render(
      await IntegrationsPage({
        searchParams: Promise.resolve({ instagram: "<script>alert(1)</script>" }),
      }),
    );

    expect(screen.queryByText(/script/u)).toBeNull();
  });

  it("reports a load failure with a correlation reference and no provider detail", async () => {
    loadInstagramIntegrations.mockRejectedValue(new Error("connection pool exhausted"));

    render(await IntegrationsPage({ searchParams: Promise.resolve({}) }));

    expect(
      screen.getByRole("heading", { name: "Integration status is unavailable" }),
    ).toBeVisible();
    expect(screen.getByText(/No account was changed/u)).toBeVisible();
    expect(screen.getByText("Reference")).toBeVisible();
    expect(screen.queryByText(/connection pool exhausted/u)).toBeNull();
    expect(reportError).toHaveBeenCalled();
  });
});
