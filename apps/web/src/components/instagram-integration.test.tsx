// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { IntegrationAccountView } from "../lib/instagram-integration";
import type { IntegrationsSnapshot } from "../lib/server/integrations-data";
import { InstagramIntegrations } from "./instagram-integration";

vi.mock("./instagram-disconnect-control", () => ({
  InstagramDisconnectControl: ({ accountId }: Readonly<{ accountId: string }>) => (
    <button data-account={accountId} type="button">
      Disconnect account
    </button>
  ),
}));

function account(overrides: Partial<IntegrationAccountView> = {}): IntegrationAccountView {
  return {
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
    ...overrides,
  };
}

function snapshot(
  accounts: readonly IntegrationAccountView[],
  canManage = true,
): IntegrationsSnapshot {
  return { accounts, canManage };
}

describe("InstagramIntegrations", () => {
  it("offers a POST connect form when no account is connected", () => {
    render(<InstagramIntegrations outcome={null} snapshot={snapshot([])} />);

    expect(screen.getByRole("heading", { name: "No Instagram account connected" })).toBeVisible();
    const button = screen.getByRole("button", { name: "Connect Instagram account" });
    const form = button.closest("form");
    // A GET link would let a cross-site image start a provider redirect.
    expect(form).toHaveAttribute("method", "post");
    expect(form).toHaveAttribute("action", "/api/integrations/instagram/connect");
  });

  it("tells a non-admin who to ask instead of showing a control they cannot use", () => {
    render(<InstagramIntegrations outcome={null} snapshot={snapshot([], false)} />);

    expect(screen.getByText(/An administrator can connect one/u)).toBeVisible();
    expect(screen.queryByRole("button", { name: /Connect/u })).toBeNull();
  });

  it("renders identity, professional type, API version and sync context for a connection", () => {
    render(<InstagramIntegrations outcome={null} snapshot={snapshot([account()])} />);

    expect(screen.getByRole("heading", { name: "@studioparallel" })).toBeVisible();
    expect(screen.getByText(/Business account/u)).toBeVisible();
    expect(screen.getByText(/v25\.0/u)).toBeVisible();
    expect(screen.getByText("Last successful sync")).toBeVisible();
  });

  it("gives each connection state a distinct label and shows reconnect only when needed", () => {
    render(
      <InstagramIntegrations
        outcome={null}
        snapshot={snapshot([
          account({ accountId: "019a0000-0000-7000-8000-000000000301" }),
          account({
            accountId: "019a0000-0000-7000-8000-000000000302",
            healthState: "EXPIRING",
            username: "degraded",
          }),
          account({
            accountId: "019a0000-0000-7000-8000-000000000303",
            connectionStatus: "REAUTHORISATION_REQUIRED",
            healthState: "REAUTHORISATION_REQUIRED",
            username: "blocked",
          }),
          account({
            accountId: "019a0000-0000-7000-8000-000000000304",
            connectionStatus: "DISCONNECTED",
            healthState: "REVOKED",
            username: "gone",
          }),
        ])}
      />,
    );

    expect(screen.getByText("Connected")).toBeVisible();
    expect(screen.getByText("Attention needed")).toBeVisible();
    expect(screen.getByText("Reconnect required")).toBeVisible();
    expect(screen.getByText("Disconnected")).toBeVisible();

    // Only the two unhealthy live accounts offer a reconnect.
    expect(screen.getAllByRole("button", { name: "Reconnect account" })).toHaveLength(2);
  });

  it("links an expired connection straight to reconnect from within its own card", () => {
    render(
      <InstagramIntegrations
        outcome={null}
        snapshot={snapshot([account({ healthState: "EXPIRED" })])}
      />,
    );

    const card = screen.getByRole("region", { name: "@studioparallel" });
    const reconnect = within(card).getByRole("button", { name: "Reconnect account" });
    expect(reconnect.closest("form")).toHaveAttribute(
      "action",
      "/api/integrations/instagram/connect",
    );
  });

  it("names a downgraded permission instead of silently omitting it", () => {
    render(
      <InstagramIntegrations
        outcome={null}
        snapshot={snapshot([account({ grantedScopes: ["instagram_business_basic"] })])}
      />,
    );

    expect(screen.getByRole("heading", { name: "Required permissions are missing" })).toBeVisible();
    expect(screen.getByText("Missing")).toBeVisible();
  });

  it("shows the disconnect control only to an admin and never on a disconnected account", () => {
    const live = account();
    const disconnected = account({
      accountId: "019a0000-0000-7000-8000-000000000304",
      connectionStatus: "DISCONNECTED",
      username: "gone",
    });

    const { rerender } = render(
      <InstagramIntegrations outcome={null} snapshot={snapshot([live, disconnected])} />,
    );
    expect(screen.getAllByRole("button", { name: "Disconnect account" })).toHaveLength(1);

    rerender(
      <InstagramIntegrations outcome={null} snapshot={snapshot([live, disconnected], false)} />,
    );
    expect(screen.queryByRole("button", { name: "Disconnect account" })).toBeNull();
  });

  it("reports the callback outcome politely without provider detail", () => {
    const { rerender } = render(
      <InstagramIntegrations outcome="connected" snapshot={snapshot([account()])} />,
    );
    expect(screen.getByText("Instagram account connected")).toBeVisible();

    rerender(<InstagramIntegrations outcome="failed" snapshot={snapshot([account()])} />);
    const failure = screen.getByText("Instagram account was not connected");
    expect(failure).toBeVisible();
    expect(failure.closest("section")).toHaveAttribute("aria-live", "polite");
  });

  it("renders no credential material anywhere on the page", () => {
    const { container } = render(
      <InstagramIntegrations
        outcome="failed"
        snapshot={snapshot([
          account(),
          account({
            accountId: "019a0000-0000-7000-8000-000000000303",
            connectionStatus: "REAUTHORISATION_REQUIRED",
            healthState: "REAUTHORISATION_REQUIRED",
            username: "blocked",
          }),
        ])}
      />,
    );

    expect(container.textContent).not.toMatch(/ciphertext|access_token|bearer|IGQ[A-Za-z0-9]/u);
  });
});
