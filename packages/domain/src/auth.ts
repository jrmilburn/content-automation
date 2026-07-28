export const oidcDenialReasons = ["MALFORMED_CLAIMS", "UNVERIFIED_EMAIL", "WRONG_DOMAIN"] as const;

export type OidcDenialReason = (typeof oidcDenialReasons)[number];

export type GoogleOidcIdentity = Readonly<{
  displayName?: string;
  email: string;
  subject: string;
}>;

export type GoogleOidcDecision =
  | Readonly<{ allowed: true; identity: GoogleOidcIdentity }>
  | Readonly<{ allowed: false; reason: OidcDenialReason }>;

type GoogleProfile = Readonly<{
  email?: unknown;
  email_verified?: unknown;
  hd?: unknown;
  name?: unknown;
  sub?: unknown;
}>;

const subjectPattern = /^[A-Za-z0-9._:-]{1,255}$/u;
const domainPattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u;

export function evaluateGoogleOidcProfile(
  profile: GoogleProfile | null | undefined,
  approvedDomain: string,
): GoogleOidcDecision {
  const domain = approvedDomain.trim().toLowerCase();
  const email = typeof profile?.email === "string" ? profile.email.trim().toLowerCase() : "";
  const subject = typeof profile?.sub === "string" ? profile.sub.trim() : "";
  const hostedDomain = typeof profile?.hd === "string" ? profile.hd.trim().toLowerCase() : "";
  const emailSeparator = email.indexOf("@");

  if (
    !domainPattern.test(domain) ||
    !subjectPattern.test(subject) ||
    !email ||
    email.length > 320 ||
    emailSeparator <= 0 ||
    emailSeparator !== email.lastIndexOf("@") ||
    hasUnsafeEmailCharacter(email)
  ) {
    return { allowed: false, reason: "MALFORMED_CLAIMS" };
  }

  if (email.slice(emailSeparator + 1) !== domain) {
    return { allowed: false, reason: "WRONG_DOMAIN" };
  }

  if (profile?.email_verified !== true) {
    return { allowed: false, reason: "UNVERIFIED_EMAIL" };
  }

  if (hostedDomain !== domain) {
    return { allowed: false, reason: "WRONG_DOMAIN" };
  }

  const displayName = normaliseDisplayName(profile?.name);

  return {
    allowed: true,
    identity: {
      email,
      subject,
      ...(displayName ? { displayName } : {}),
    },
  };
}

export function resolveSafeReturnUrl(candidate: string, publicOrigin: string): string {
  const base = new URL(publicOrigin);

  try {
    if (candidate.startsWith("//") || candidate.includes("\\")) return base.origin;

    const target = new URL(candidate, base);
    if (
      target.origin !== base.origin ||
      (target.protocol !== "https:" && target.protocol !== "http:") ||
      target.username ||
      target.password
    ) {
      return base.origin;
    }

    return target.toString();
  } catch {
    return base.origin;
  }
}

export function isAllowedRequestOrigin(origin: string | null, publicOrigin: string): boolean {
  if (!origin) return false;

  try {
    return new URL(origin).origin === new URL(publicOrigin).origin;
  } catch {
    return false;
  }
}

function normaliseDisplayName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;

  const candidate = value.trim();
  if (!candidate || candidate.length > 160) return undefined;

  for (const character of candidate) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) return undefined;
  }

  return candidate;
}

function hasUnsafeEmailCharacter(email: string): boolean {
  for (const character of email) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || codePoint <= 32 || codePoint === 127) return true;
  }

  return false;
}
