import {
  instagramTokenHealthStates,
  type InstagramTokenHealthState,
} from "@studio-parallel/domain";
import { describe, expect, it } from "vitest";

import {
  formatAccountType,
  formatDateTime,
  formatScopeName,
  formatUsername,
  parseCallbackOutcome,
  presentCallbackOutcome,
  presentConnection,
  presentDashboardIntegration,
  presentRequiredScopes,
} from "./instagram-integration";

const allScopes = ["instagram_business_basic", "instagram_business_manage_insights"];

function dashboardAccount(
  overrides: Partial<{
    connectionStatus: string;
    grantedScopes: readonly string[];
    healthState: InstagramTokenHealthState;
    username: string | null;
  }> = {},
) {
  return {
    connectionStatus: "ACTIVE",
    grantedScopes: allScopes,
    healthState: "HEALTHY" as InstagramTokenHealthState,
    username: "studioparallel",
    ...overrides,
  };
}

function connection(
  connectionStatus: string,
  healthState: InstagramTokenHealthState,
): ReturnType<typeof presentConnection> {
  return presentConnection({ connectionStatus, healthState });
}

describe("presentConnection", () => {
  it("reports a healthy connection with no action to take", () => {
    const presented = connection("ACTIVE", "HEALTHY");

    expect(presented).toMatchObject({ action: null, label: "Connected", state: "CONNECTED" });
    expect(presented.tone).toBe("success");
  });

  it("keeps a refresh-due connection in the connected state", () => {
    // Automatic renewal is the worker's job; surfacing it as a problem would
    // train an operator to reconnect when nothing is wrong.
    expect(connection("ACTIVE", "REFRESH_DUE")).toMatchObject({
      action: null,
      state: "CONNECTED",
    });
  });

  it.each([
    ["EXPIRING", "expires soon"],
    ["EXPIRY_UNKNOWN", "not recorded"],
  ] as const)("treats %s as degraded rather than connected or blocked", (healthState, phrase) => {
    const presented = connection("ACTIVE", healthState);

    expect(presented).toMatchObject({ action: "RECONNECT", state: "DEGRADED", tone: "warning" });
    expect(presented.description).toContain(phrase);
  });

  it.each(["EXPIRED", "REAUTHORISATION_REQUIRED", "REVOKED"] as const)(
    "requires a reconnect when the credential is %s",
    (healthState) => {
      expect(connection("ACTIVE", healthState)).toMatchObject({
        action: "RECONNECT",
        state: "RECONNECT_REQUIRED",
        tone: "danger",
      });
    },
  );

  it("requires a reconnect when the account is flagged even if the token still looks healthy", () => {
    expect(connection("REAUTHORISATION_REQUIRED", "HEALTHY")).toMatchObject({
      state: "RECONNECT_REQUIRED",
    });
  });

  it("treats an explicit disconnect as final and offers a fresh connection", () => {
    const presented = connection("DISCONNECTED", "REVOKED");

    expect(presented).toMatchObject({ action: "CONNECT", state: "DISCONNECTED", tone: "neutral" });
    expect(presented.description).toContain("Previously imported posts");
  });

  it("takes the explicit disconnect over any credential health", () => {
    // An operator decision outranks a derived signal.
    for (const healthState of instagramTokenHealthStates) {
      expect(connection("DISCONNECTED", healthState).state).toBe("DISCONNECTED");
    }
  });

  it("produces a distinct label for every reachable state", () => {
    const labels = new Set(
      [
        connection("ACTIVE", "HEALTHY"),
        connection("ACTIVE", "EXPIRING"),
        connection("ACTIVE", "REVOKED"),
        connection("DISCONNECTED", "REVOKED"),
      ].map((presented) => presented.label),
    );

    expect(labels.size).toBe(4);
  });

  it("never renders a credential value or provider text in its copy", () => {
    for (const healthState of instagramTokenHealthStates) {
      for (const status of ["ACTIVE", "REAUTHORISATION_REQUIRED", "DISCONNECTED"]) {
        const presented = connection(status, healthState);
        expect(presented.description).not.toMatch(/token|ciphertext|bearer|access_token/iu);
      }
    }
  });
});

describe("presentRequiredScopes", () => {
  it("lists every required scope as granted when all are present", () => {
    expect(
      presentRequiredScopes(["instagram_business_basic", "instagram_business_manage_insights"]),
    ).toEqual([
      { granted: true, scope: "instagram_business_basic" },
      { granted: true, scope: "instagram_business_manage_insights" },
    ]);
  });

  it("still lists a downgraded scope so the gap is visible", () => {
    const scopes = presentRequiredScopes(["instagram_business_basic"]);

    expect(scopes).toHaveLength(2);
    expect(scopes.find((scope) => !scope.granted)?.scope).toBe(
      "instagram_business_manage_insights",
    );
  });

  it("ignores scopes the product never requested", () => {
    const scopes = presentRequiredScopes(["instagram_business_basic", "instagram_manage_messages"]);

    expect(scopes.map((scope) => scope.scope)).not.toContain("instagram_manage_messages");
  });
});

describe("parseCallbackOutcome", () => {
  it.each([
    ["connected", "connected"],
    ["failed", "failed"],
  ] as const)("accepts the %s outcome", (value, expected) => {
    expect(parseCallbackOutcome(value)).toBe(expected);
  });

  it.each([undefined, "", "anything-else", "CONNECTED"])(
    "rejects %p rather than reflecting it",
    (value) => {
      expect(parseCallbackOutcome(value)).toBeNull();
    },
  );

  it("reads only the first value of a repeated parameter", () => {
    expect(parseCallbackOutcome(["failed", "connected"])).toBe("failed");
  });
});

describe("presentCallbackOutcome", () => {
  it("renders nothing when there is no outcome to report", () => {
    expect(presentCallbackOutcome(null)).toBeNull();
  });

  it("describes a failure without naming a provider cause it cannot know", () => {
    const presented = presentCallbackOutcome("failed");

    expect(presented?.tone).toBe("danger");
    expect(presented?.description).toContain("No account was changed");
  });

  it("confirms a success and says importing starts on its own", () => {
    expect(presentCallbackOutcome("connected")).toMatchObject({ tone: "success" });
  });
});

describe("presentDashboardIntegration", () => {
  it("reports not connected when the workspace has no account", () => {
    expect(presentDashboardIntegration([])).toMatchObject({
      action: { href: "/settings/integrations", label: "Connect Instagram account" },
      status: "not_connected",
    });
  });

  it("reports a healthy connection and names the account", () => {
    // The defect this replaced was a hardcoded not_connected that no data
    // could ever change, so this is the assertion that actually mattered.
    expect(presentDashboardIntegration([dashboardAccount()])).toMatchObject({
      accountName: "@studioparallel",
      status: "healthy",
      statusLabel: "Connected",
    });
  });

  it.each(["EXPIRED", "REAUTHORISATION_REQUIRED", "REVOKED"] as const)(
    "requires action when the credential is %s",
    (healthState) => {
      expect(presentDashboardIntegration([dashboardAccount({ healthState })])).toMatchObject({
        action: { href: "/settings/integrations", label: "Reconnect account" },
        status: "action_required",
      });
    },
  );

  it("requires action when the account itself is flagged", () => {
    expect(
      presentDashboardIntegration([
        dashboardAccount({ connectionStatus: "REAUTHORISATION_REQUIRED" }),
      ]),
    ).toMatchObject({ status: "action_required" });
  });

  it("requires action on a degraded connection", () => {
    expect(
      presentDashboardIntegration([dashboardAccount({ healthState: "EXPIRING" })]),
    ).toMatchObject({ status: "action_required" });
  });

  it("requires action when a required scope was downgraded", () => {
    expect(
      presentDashboardIntegration([
        dashboardAccount({ grantedScopes: ["instagram_business_basic"] }),
      ]),
    ).toMatchObject({ status: "action_required" });
  });

  it("treats an all-disconnected workspace as not connected, not as an action", () => {
    expect(
      presentDashboardIntegration([
        dashboardAccount({ connectionStatus: "DISCONNECTED", healthState: "REVOKED" }),
      ]),
    ).toMatchObject({ status: "not_connected" });
  });

  it("ignores a disconnected account beside a healthy one", () => {
    expect(
      presentDashboardIntegration([
        dashboardAccount({ connectionStatus: "DISCONNECTED", healthState: "REVOKED" }),
        dashboardAccount({ username: "second" }),
      ]),
    ).toMatchObject({ accountName: "@second", status: "healthy" });
  });

  it("summarises several healthy accounts without naming one", () => {
    const presented = presentDashboardIntegration([
      dashboardAccount(),
      dashboardAccount({ username: "second" }),
    ]);

    expect(presented).toMatchObject({ status: "healthy" });
    expect(presented.accountName).toBeUndefined();
    expect(presented.description).toContain("2 accounts");
  });

  it("distinguishes one failing account from all of them failing", () => {
    expect(
      presentDashboardIntegration([
        dashboardAccount(),
        dashboardAccount({ healthState: "REVOKED", username: "second" }),
      ]).statusLabel,
    ).toBe("Attention on one account");

    expect(
      presentDashboardIntegration([
        dashboardAccount({ healthState: "REVOKED" }),
        dashboardAccount({ healthState: "EXPIRED", username: "second" }),
      ]).statusLabel,
    ).toBe("Action needed");
  });

  it("never links to the retired /accounts route", () => {
    for (const accounts of [
      [],
      [dashboardAccount()],
      [dashboardAccount({ healthState: "REVOKED" })],
    ]) {
      expect(presentDashboardIntegration(accounts).action.href).toBe("/settings/integrations");
    }
  });

  it("renders no credential material in its copy", () => {
    const presented = presentDashboardIntegration([dashboardAccount({ healthState: "REVOKED" })]);
    expect(JSON.stringify(presented)).not.toMatch(/token|ciphertext|bearer/iu);
  });
});

describe("formatting", () => {
  it("formats a username as a handle and names the gap when absent", () => {
    expect(formatUsername("studioparallel")).toBe("@studioparallel");
    expect(formatUsername(null)).toBe("Username unavailable");
  });

  it("formats the professional type in sentence case", () => {
    expect(formatAccountType("BUSINESS")).toBe("Business");
    expect(formatAccountType("CREATOR")).toBe("Creator");
  });

  it("formats scope identifiers into readable permission names", () => {
    expect(formatScopeName("instagram_business_manage_insights")).toBe(
      "Instagram business manage insights",
    );
  });

  it("formats timestamps in the workspace timezone and names a missing one", () => {
    expect(formatDateTime(null)).toBe("Not recorded");
    expect(formatDateTime(new Date("2026-07-31T02:00:00.000Z"))).toContain("2026");
  });
});
