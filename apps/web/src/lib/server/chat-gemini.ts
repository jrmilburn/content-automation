import "server-only";

import {
  loadGeminiConfig,
  loadGeminiCredentials,
  loadRuntimeConfig,
} from "@studio-parallel/config";
import {
  createFakeGemini,
  createGeminiHttpAdapter,
  type GeminiAdapter,
} from "@studio-parallel/integrations";

/**
 * The Gemini transport the assistant uses, and the only one the web app has.
 *
 * `docs/technical/architecture.md` gives model calls to the worker, and that
 * still holds for everything the worker does: a video upload is minutes of
 * transfer, a strategy is a job somebody starts and comes back to, and neither
 * may die with an HTTP request. A chat turn is none of those. It is seconds of
 * text, it is worthless to the reader if it arrives after they have left, and
 * queueing it would deliver a conversation one poll interval at a time. So it
 * runs here, under a timeout sized for someone waiting rather than for a job.
 *
 * Credentials load inside the live branch only, and inside the function rather
 * than at module scope. `next.config.ts` evaluates configuration at build time,
 * and a credential that fails closed at import would turn a missing key into a
 * failed build of every page rather than a failed assistant.
 */
export function createWebGeminiAdapter(): GeminiAdapter {
  const config = loadRuntimeConfig();
  const geminiConfig = loadGeminiConfig();

  if (config.PROVIDER_MODE === "fake") {
    // The default fake reply is `{"ok":true}`, which is not a chat reply and
    // would fail validation. A browser run needs the whole path to work, so the
    // fake answers in the contract's own shape.
    return createFakeGemini({ defaultResponseText: fakeChatReply }).adapter;
  }

  return createGeminiHttpAdapter({
    // The shared request timeout is sized for a strategy call. A conversation
    // gets its own, so one slow turn cannot hold a request open for minutes.
    config: Object.freeze({
      ...geminiConfig,
      GEMINI_REQUEST_TIMEOUT_MS: geminiConfig.GEMINI_CHAT_TIMEOUT_MS,
    }),
    credentials: loadGeminiCredentials(),
  });
}

const fakeChatReply = JSON.stringify({
  citedEvidenceIds: ["stat_pos_0"],
  followUps: ["Which pillar has the least evidence behind it?"],
  reply:
    "Make the next video in the process and craft pillar, opening on a direct question. Question hooks show a higher median engagement rate on reach than other hook types in this period, across twelve posts against eight, which is a moderate association rather than a settled result.\n\nHold the pillar and the duration band steady so the hook is the only thing that changed, and judge it against the account median over six posts.",
});
