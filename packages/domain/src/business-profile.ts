import { analysisArtifactLifecycles, type AnalysisArtifactLifecycle } from "./analysis-contract.js";

/**
 * What the business is, for the models that reason about its content.
 *
 * Analysis and analytics never needed this: they classify and compare what was
 * actually published, and a video's hook is its hook whoever made it. Strategy
 * and the assistant do need it, because both are asked what to make next, and
 * without it the only available answer is whatever the taxonomy and the
 * evidence happen to imply. A studio that sells operational software to
 * established service businesses and one that sells swimwear produce the same
 * recommendation from the same statistics, which is the wrong answer for at
 * least one of them.
 *
 * It is a versioned artifact rather than a setting, and that is the whole point
 * of writing it here. A strategy is reproducible: every version that shaped it
 * is recorded against it, and a reader asking "why did it recommend that" can
 * be given the exact inputs. A description edited in a form would answer that
 * question differently on different days.
 *
 * It is trusted, unlike almost everything else that reaches these prompts. It
 * is a reviewed constant, not a caption or a transcript, so it travels in the
 * instruction rather than inside an untrusted region — and that is exactly why
 * the last paragraph of the text below exists. Trusted background is the one
 * place a model would accept an invented category or an unearned claim from,
 * so the text closes that door itself.
 *
 * Deliberately absent: the ABN, the contact address and the legal suffix. They
 * are facts about the company and not inputs to a content decision, they are
 * paid for on every strategy and every conversation turn, and the failure they
 * invite — a recommended hook quoting a company number — is one worth not
 * having available.
 */

export const businessProfileVersion = "studio-parallel-business-profile-v1.0.0" as const;

export const businessProfileText =
  `Studio Parallel is a two-person custom software studio: engineers Joe Milburn and Hayden Richardson, based in Rockhampton, Queensland, working remotely with clients Australia-wide. Clients deal directly with the founders rather than through account managers, and there is no larger team behind them.

The studio sells three things, in the order they matter to the business:

- Core, the primary focus and what funds the studio: custom operational software — business systems, CRMs, internal tools and web applications — for established Australian service businesses, typically 10 to 50 staff, that have outgrown off-the-shelf SaaS.
- Wing: MVP builds for startup founders, reached mainly through giveaways and referrals.
- Workshop: the studio's own products, including Flow Channels, a CRM and communications platform for service businesses.

Delivered work that may be referred to by name: MedVault, a secure medical records application; Up2Talk, a voice-first application for truck drivers; Caribeae, swim school management; and Now What, a content platform.

The audience that matters most is the owner or operator of an established Australian service business paying for several SaaS subscriptions that no longer fit how they work. Startup founders are a secondary audience.

This is background about the business, not a source of categories and not evidence. Content pillars, formats and metrics come from the taxonomy and the frozen evidence; nothing in this description supports a claim about how anything performed.` as const;

/**
 * The background block as it appears in an instruction.
 *
 * Fenced and named, so the model can tell where reviewed configuration ends and
 * the untrusted regions after it begin. Both callers use this rather than
 * interpolating the text themselves, so the two prompts cannot drift into
 * describing the same business differently.
 */
export function renderBusinessProfile(): string {
  return `<<<BUSINESS BACKGROUND>>>
${businessProfileText}
<<<END BUSINESS BACKGROUND>>>`;
}

function deepFreeze<T>(value: T): T {
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.values(value).forEach((child) => deepFreeze(child));
    Object.freeze(value);
  }
  return value;
}

export const businessProfileArtifacts = deepFreeze({
  profile: {
    kind: "business_profile",
    version: businessProfileVersion,
    lifecycle: "active" satisfies AnalysisArtifactLifecycle,
    // v1.0.0. Changing this text is a contract change, not an edit: it is part
    // of the strategy manifest hash, so a strategy generated before and after
    // it are provably different requests rather than one that quietly answered
    // differently.
    sha256: "c0d37cfb1373b7f8db22296202c1f0d7eb89452687b0793f4fa1b9a15cc23bf0",
    text: businessProfileText,
  },
  lifecycleValues: analysisArtifactLifecycles,
} as const);
