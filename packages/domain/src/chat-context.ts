import { createHash } from "node:crypto";

import { chatContractArtifacts, chatPromptVersion, chatSchemaVersion } from "./chat-contract.js";

/**
 * Turning several sources of already-computed work into one bounded document.
 *
 * The assistant is only ever as good as what it was shown, and what it may be
 * shown grows: today the current strategy, the comparisons behind it, the
 * account and its recent posts; later a competitor set, a brand guideline, a
 * calendar. So the shape a source produces is defined here and the sources
 * themselves are defined where they can query — a new one is a new entry in the
 * registry and nothing else changes.
 *
 * Two rules make that safe rather than merely convenient.
 *
 * Order is priority. Sources are assembled in the order the registry lists
 * them, and when the budget runs out the tail is dropped rather than each block
 * being trimmed. A half-quoted strategy is worse than an absent competitor set,
 * because the model cannot tell that the half it received was half.
 *
 * Only what survived is citable. `evidenceIds` is collected from the blocks that
 * were actually included, so an id from a dropped block is unknown to the
 * validator and a reply citing it loses the citation. The alternative — offering
 * every id and hoping — invites the model to cite something it never saw.
 */

export type ChatContextBlock = Readonly<{
  /** The prose the model reads. Already redacted and already bounded by its source. */
  body: string;
  /** Ids this block makes citable, and which a reply may therefore reference. */
  evidenceIds: readonly string[];
  /** Stable key of the source that produced it, recorded on the message. */
  source: string;
  /** Heading the model sees, in the product's own words. */
  title: string;
}>;

export type ChatContextAssembly = Readonly<{
  /** Sources that did not fit, so the caller can say what the answer could not see. */
  droppedSources: readonly string[];
  evidenceIds: readonly string[];
  hash: string;
  includedSources: readonly string[];
  text: string;
  tokenEstimate: number;
}>;

/**
 * How much of the request one turn's context may occupy.
 *
 * Well below the model's window, because the window is not the constraint: the
 * bill is. A conversation sends its context again on every turn, so a budget
 * sized to what the model could accept would multiply the cost of a twenty-turn
 * conversation by the size of the account's history.
 */
export const chatContextTokenBudget = 24_000;

/** Characters per token. Deliberately pessimistic, so the estimate over-counts. */
const charactersPerToken = 3;

export function estimateChatTokens(text: string): number {
  return Math.ceil(text.length / charactersPerToken);
}

/**
 * Stops any line inside a block from closing the region that contains it.
 *
 * Block bodies quote captions, transcripts and evidence explanations, none of
 * which this product wrote. A line reading `<<<END CONTEXT>>>` inside one of
 * them would, to a model reading top to bottom, end the untrusted region early
 * and make everything after it look like instructions. Indenting such a line
 * costs a space and removes the trick, in the same way `renderChatConversation`
 * indents every line of a message so nobody can forge a turn.
 */
function neutraliseFences(body: string): string {
  return body
    .split("\n")
    .map((line) => (line.startsWith("<<<") ? ` ${line}` : line))
    .join("\n");
}

function renderBlock(block: ChatContextBlock): string {
  return `## ${block.title}\n${neutraliseFences(block.body)}`;
}

/**
 * Assembles the blocks that fit, in the order given, and reports what did not.
 *
 * The budget is checked against the running total rather than each block alone,
 * so a large early block correctly starves the ones after it instead of every
 * block being measured against the whole allowance.
 */
export function assembleChatContext(
  blocks: readonly ChatContextBlock[],
  options: Readonly<{ tokenBudget?: number }> = {},
): ChatContextAssembly {
  const budget = options.tokenBudget ?? chatContextTokenBudget;

  const included: ChatContextBlock[] = [];
  const dropped: string[] = [];
  let tokens = 0;

  for (const block of blocks) {
    const cost = estimateChatTokens(renderBlock(block));
    if (included.length > 0 && tokens + cost > budget) {
      dropped.push(block.source);
      continue;
    }
    included.push(block);
    tokens += cost;
  }

  const text =
    included.length === 0
      ? "(no context is available for this account yet)"
      : included.map(renderBlock).join("\n\n");

  const evidenceIds = [...new Set(included.flatMap((block) => [...block.evidenceIds]))];

  return Object.freeze({
    droppedSources: Object.freeze(dropped),
    evidenceIds: Object.freeze(evidenceIds),
    hash: createChatContextHash(text),
    includedSources: Object.freeze(included.map((block) => block.source)),
    text,
    tokenEstimate: estimateChatTokens(text),
  });
}

/**
 * The canonical hash of one assembled context.
 *
 * Covers the contract versions as well as the text, so the same evidence read
 * under a different prompt is a different context. A stored message records
 * this rather than the context itself: the text is large, reproducible from the
 * sources it names, and the question a reader actually asks later is "was this
 * answer built on what I am looking at now", which a hash answers.
 */
export function createChatContextHash(text: string): string {
  return createHash("sha256")
    .update(
      [
        chatSchemaVersion,
        chatContractArtifacts.schema.sha256,
        chatPromptVersion,
        chatContractArtifacts.prompt.sha256,
        text,
      ].join("\n"),
    )
    .digest("hex");
}
