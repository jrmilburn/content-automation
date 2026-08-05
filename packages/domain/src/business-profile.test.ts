import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  businessProfileArtifacts,
  businessProfileText,
  businessProfileVersion,
  renderBusinessProfile,
} from "./business-profile.js";
import { analysisTaxonomy } from "./analysis-contract.js";
import { createChatInstruction } from "./chat-contract.js";
import { containsProhibitedClaim, createStrategyInstruction } from "./strategy-contract.js";

describe("business profile artifact", () => {
  it("pins the version and the hash of the text the prompts actually carry", () => {
    expect(Object.isFrozen(businessProfileArtifacts)).toBe(true);
    expect(businessProfileArtifacts.profile.version).toBe(businessProfileVersion);
    expect(createHash("sha256").update(businessProfileText).digest("hex")).toBe(
      businessProfileArtifacts.profile.sha256,
    );
  });

  it("makes no claim the strategy validator would reject in its own output", () => {
    // The background sits in the same request as a rule banning causal and
    // algorithmic language. Text that broke that rule would be teaching the
    // model the register it is about to be punished for using.
    const sentences = businessProfileText.split(/(?<=\.)\s+/u);
    expect(sentences.filter((sentence) => containsProhibitedClaim(sentence))).toEqual([]);
  });

  it("carries no company number and no contact address", () => {
    // Both are facts about the company rather than inputs to a content
    // decision, and a recommended hook quoting an ABN is a failure worth not
    // making available.
    expect(businessProfileText).not.toMatch(/\bABN\b/iu);
    expect(businessProfileText).not.toMatch(/@/u);
    expect(businessProfileText).not.toMatch(/\b\d{2} \d{3} \d{3} \d{3}\b/u);
  });

  it("stays small enough to send on every strategy and every conversation turn", () => {
    // It is re-sent on each turn, so its cost is paid per question rather than
    // per conversation.
    expect(businessProfileText.length).toBeLessThan(2_500);
  });

  it("names no content pillar, because the taxonomy owns those", () => {
    // A background block that named pillars would put the model between two
    // sources of truth, and the schema would reject whichever it chose.
    const pillars = analysisTaxonomy.contentPillar.filter(
      (pillar) => pillar !== "other" && pillar !== "unknown",
    );

    expect(pillars.filter((pillar) => businessProfileText.includes(pillar))).toEqual([]);
  });

  it("says in its own words that it is neither a category source nor evidence", () => {
    expect(businessProfileText).toMatch(/not a source of categories and not evidence/u);
  });
});

describe("renderBusinessProfile", () => {
  it("fences the block so the model can see where reviewed text ends", () => {
    const rendered = renderBusinessProfile();

    expect(rendered.startsWith("<<<BUSINESS BACKGROUND>>>\n")).toBe(true);
    expect(rendered.endsWith("\n<<<END BUSINESS BACKGROUND>>>")).toBe(true);
    expect(rendered).toContain(businessProfileText);
  });
});

describe("both prompts carry the same background", () => {
  it("puts it in the strategy instruction", () => {
    expect(createStrategyInstruction({ mode: "evidence_led" })).toContain(businessProfileText);
  });

  it("puts it in the chat instruction, above the untrusted regions", () => {
    const instruction = createChatInstruction({
      context: "## Strategy\nNothing much.",
      turns: [{ content: "What should I make next?", role: "user" }],
    });

    expect(instruction).toContain(businessProfileText);
    // Above the untrusted region, because labelling reviewed configuration
    // untrusted asks the model to discount the one part of the request this
    // product wrote.
    expect(instruction.indexOf("<<<BUSINESS BACKGROUND>>>")).toBeLessThan(
      instruction.indexOf("<<<CONTEXT>>>"),
    );
  });

  it("describes the same business to both, from one constant", () => {
    const strategy = createStrategyInstruction({ mode: "exploratory" });
    const chat = createChatInstruction({ context: "", turns: [] });

    expect(strategy).toContain(renderBusinessProfile());
    expect(chat).toContain(renderBusinessProfile());
  });
});
