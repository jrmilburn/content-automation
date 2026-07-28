const callbackReadiness = {
  integration: "instagram",
  purpose: "redirect_verification",
  status: "ready",
} as const;

const callbackHeaders = {
  "Cache-Control": "no-store, max-age=0",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
} as const;

export const dynamic = "force-dynamic";

/**
 * Verification-only landing route for Meta's configured Business Login redirect.
 *
 * Query parameters are intentionally ignored. Issue #29 owns state validation,
 * code exchange, account verification, and encrypted credential persistence.
 */
export function GET(): Response {
  return Response.json(callbackReadiness, {
    headers: callbackHeaders,
    status: 200,
  });
}
