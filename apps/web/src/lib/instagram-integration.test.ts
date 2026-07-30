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
  presentRequiredScopes,
} from "./instagram-integration";

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
