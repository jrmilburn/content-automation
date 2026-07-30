import {
  instagramConnectionBlocked,
  instagramRequiredScopes,
  type InstagramTokenHealthState,
} from "@studio-parallel/domain";

import type { StatusTone } from "../components/status-badge";

/**
 * Pure presentation logic for the Instagram integration screen.
 *
 * Nothing here touches the database, the network or credential material — it
 * maps an already-safe projection onto copy, so every rendered state can be
 * asserted exhaustively without a provider or a database.
 *
 * The connection state is derived from two independent facts: the account's
 * connection status, which an operator or the token maintainer sets, and the
 * credential's health, which is derived from its expiry. Account status wins
 * when it says disconnected, because that is an explicit human decision.
 */

export const instagramConnectionStates = [
  "NOT_CONNECTED",
  "CONNECTED",
  "DEGRADED",
  "RECONNECT_REQUIRED",
  "DISCONNECTED",
] as const;

export type InstagramConnectionState = (typeof instagramConnectionStates)[number];

export type ConnectionPresentation = Readonly<{
  /** Copy for the primary control, or null when no action is offered. */
  action: "CONNECT" | "RECONNECT" | null;
  description: string;
  label: string;
  state: InstagramConnectionState;
  tone: StatusTone;
}>;

export type IntegrationAccountView = Readonly<{
  accountId: string;
  accountType: string;
  apiVersion: string;
  connectionStatus: string;
  expiresAt: Date | null;
  grantedScopes: readonly string[];
  healthState: InstagramTokenHealthState;
  lastSuccessfulSyncAt: Date | null;
  lastValidatedAt: Date | null;
  username: string | null;
}>;

/** The coarse outcome the connection callback redirects back with. */
export type CallbackOutcome = "connected" | "failed" | null;

export function parseCallbackOutcome(value: string | string[] | undefined): CallbackOutcome {
  const first = Array.isArray(value) ? value[0] : value;
  return first === "connected" || first === "failed" ? first : null;
}

/**
 * Derives the single state that drives the badge, the copy and the action.
 *
 * `EXPIRY_UNKNOWN` is degraded rather than healthy: an unrecorded expiry means
 * the token has not been proven usable, and presenting that as connected would
 * overstate what is known.
 */
export function presentConnection(
  account: Readonly<{ connectionStatus: string; healthState: InstagramTokenHealthState }>,
): ConnectionPresentation {
  if (account.connectionStatus === "DISCONNECTED") {
    return Object.freeze({
      action: "CONNECT" as const,
      description:
        "This account is disconnected. Syncing is stopped and no new posts are imported. Previously imported posts and their analyses are unchanged.",
      label: "Disconnected",
      state: "DISCONNECTED" as const,
      tone: "neutral" as const,
    });
  }

  if (
    account.connectionStatus === "REAUTHORISATION_REQUIRED" ||
    instagramConnectionBlocked(account.healthState)
  ) {
    return Object.freeze({
      action: "RECONNECT" as const,
      description:
        "Instagram will not accept this connection any more, so syncing has stopped. Reconnect the account to resume importing posts. Nothing already imported is affected.",
      label: "Reconnect required",
      state: "RECONNECT_REQUIRED" as const,
      tone: "danger" as const,
    });
  }

  if (account.healthState === "EXPIRING" || account.healthState === "EXPIRY_UNKNOWN") {
    return Object.freeze({
      action: "RECONNECT" as const,
      description:
        account.healthState === "EXPIRING"
          ? "This connection expires soon. It renews automatically, but reconnect the account if the expiry date does not move."
          : "The expiry of this connection is not recorded, so it is being checked. Reconnect the account if it does not return to connected.",
      label: "Attention needed",
      state: "DEGRADED" as const,
      tone: "warning" as const,
    });
  }

  return Object.freeze({
    action: null,
    description:
      account.healthState === "REFRESH_DUE"
        ? "Connected and syncing. The connection is due for its automatic renewal."
        : "Connected and syncing normally.",
    label: "Connected",
    state: "CONNECTED" as const,
    tone: "success" as const,
  });
}

export type ScopeStatus = Readonly<{ granted: boolean; scope: string }>;

/**
 * Reports each required scope against what was actually granted.
 *
 * Required scopes are listed even when absent, so a downgraded permission set
 * shows as a missing row rather than simply not appearing.
 */
export function presentRequiredScopes(granted: readonly string[]): readonly ScopeStatus[] {
  const grantedSet = new Set(granted);
  return Object.freeze(
    instagramRequiredScopes.map((scope) =>
      Object.freeze({ granted: grantedSet.has(scope), scope }),
    ),
  );
}

export function formatScopeName(scope: string): string {
  return scope
    .split("_")
    .filter(Boolean)
    .map((part) => (part === "instagram" ? "Instagram" : part))
    .join(" ")
    .replace(/^./u, (character) => character.toUpperCase());
}

export function formatAccountType(accountType: string): string {
  const normalised = accountType.toLowerCase();
  return `${normalised.charAt(0).toUpperCase()}${normalised.slice(1)}`;
}

export function formatDateTime(value: Date | null): string {
  if (!value) return "Not recorded";
  return new Intl.DateTimeFormat("en-AU", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Australia/Sydney",
  }).format(value);
}

export function formatUsername(username: string | null): string {
  return username ? `@${username}` : "Username unavailable";
}

/** Copy for the coarse outcome the provider callback redirects back with. */
export function presentCallbackOutcome(
  outcome: CallbackOutcome,
): Readonly<{ description: string; title: string; tone: StatusTone }> | null {
  if (outcome === "connected") {
    return Object.freeze({
      description: "The account is connected. Importing starts automatically in the background.",
      title: "Instagram account connected",
      tone: "success" as const,
    });
  }
  if (outcome === "failed") {
    // Deliberately coarse. The callback never reflects provider text, so this
    // cannot name a cause without inventing one.
    return Object.freeze({
      description:
        "The connection was not completed. No account was changed. Try connecting again, and check that you approved both requested permissions for a professional account.",
      title: "Instagram account was not connected",
      tone: "danger" as const,
    });
  }
  return null;
}
