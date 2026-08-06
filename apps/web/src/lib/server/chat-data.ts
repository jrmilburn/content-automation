import "server-only";

import { loadAuthConfig } from "@studio-parallel/config";
import {
  createWorkspaceContext,
  listInstagramAccountSummaries,
  listPublishedTrendScopes,
  type ChatMessageRecord,
  type ChatSessionSummary,
  type StrategyEvidenceEntry,
} from "@studio-parallel/db";

import { getChatStore } from "./chat-store";
import { getDatabase } from "./database";
import { requireShellActor } from "./shell-session";

/**
 * What the assistant's screens need to show.
 *
 * The conversation list and one conversation are separate reads, because they
 * are separate pages and a reader on one does not pay for the other. Both start
 * from the session, and both take the workspace from the session rather than
 * from anything in the URL.
 *
 * Two empty results are kept apart, as on strategy and trends: a workspace with
 * no linked account, which cannot usefully hold a conversation at all, and one
 * that has never started a conversation. They lead to different next actions.
 */

export type ChatAccountOption = Readonly<{ id: string; label: string }>;

export type ChatSnapshot = Readonly<{
  accounts: readonly ChatAccountOption[];
  hasAccount: boolean;
  /**
   * Whether the account this would ask about has a strategy behind it.
   *
   * The assistant is not refused without one — it can still say what is missing,
   * and refusing would leave a workspace with posts and no strategy holding a
   * screen that does nothing. It changes what the screen says before the first
   * question, so nobody asks what to make next and is told only that there is
   * nothing to answer from.
   */
  hasStrategy: boolean;
  /** The account a new conversation would be about, or null for the pooled scope. */
  selectedAccountId: string | null;
  sessions: readonly ChatSessionSummary[];
}>;

export type ChatSessionDetail = Readonly<{
  /** The manifest this conversation's citations resolve against, as it stands now. */
  evidence: readonly StrategyEvidenceEntry[];
  messages: readonly ChatMessageRecord[];
  session: ChatSessionSummary;
}>;

async function accountOptions(
  workspaceId: string,
  now: Date,
): Promise<readonly ChatAccountOption[]> {
  const summaries = await listInstagramAccountSummaries(
    getDatabase(),
    createWorkspaceContext(workspaceId),
    { now },
  );

  return Object.freeze(
    summaries.map((summary) =>
      Object.freeze({
        id: summary.accountId,
        label: summary.username ? `@${summary.username}` : "Unnamed account",
      }),
    ),
  );
}

const testAccounts: readonly ChatAccountOption[] = Object.freeze([
  Object.freeze({ id: "019a0000-0000-7000-8000-000000000301", label: "@studioparallel" }),
]);

/**
 * Which calculation a new conversation asks about.
 *
 * Pooled where one has published, and the first connected account otherwise —
 * the trends and strategy screens' rule, because all three read the same runs
 * and a conversation that disagreed with the document it is about would be
 * answering from a different population than the one on screen.
 *
 * Null is the pooled scope here, not the absence of an account; `hasAccount` is
 * what says whether there is anything connected at all.
 *
 * The fixture workspace never reaches the database, so it answers from its own
 * single account — the same arrangement, and the same reason, as the strategy
 * and trends fixtures: a pooled fixture would stop covering the per-account
 * captions those runs exist to check.
 */
async function defaultChatScope(
  context: ReturnType<typeof createWorkspaceContext>,
  accounts: readonly ChatAccountOption[],
): Promise<string | null> {
  const first = accounts[0]?.id ?? null;
  if (first === null || loadAuthConfig().APP_ENV === "test") return first;

  const published = await listPublishedTrendScopes(getDatabase(), context);
  return published.includes(null) ? null : first;
}

export async function loadChatSnapshot(now = new Date()): Promise<ChatSnapshot> {
  const principal = await requireShellActor();
  const context = createWorkspaceContext(principal.workspaceId);

  const accounts =
    loadAuthConfig().APP_ENV === "test"
      ? testAccounts
      : await accountOptions(principal.workspaceId, now);

  const store = getChatStore();

  // The same scope the strategy screen resolves, and it has to be the same one:
  // a conversation is about a strategy, so a new one opened against the first
  // account while the strategy screen shows the pooled document would answer
  // "there is no strategy" about a strategy the reader is looking at.
  const selectedAccountId = await defaultChatScope(context, accounts);

  const [sessions, evidence] = await Promise.all([
    store.listSessions(context),
    store.loadEvidence(context, { instagramAccountId: selectedAccountId }),
  ]);

  return Object.freeze({
    accounts,
    hasAccount: accounts.length > 0,
    hasStrategy: evidence.length > 0,
    selectedAccountId,
    sessions,
  });
}

/**
 * One conversation, or null.
 *
 * Null covers a session that does not exist and one belonging to another
 * workspace alike, so a crafted id in the URL cannot be told apart from a wrong
 * guess. The route turns it into the same not-found response either way.
 */
export async function loadChatSessionDetail(sessionId: string): Promise<ChatSessionDetail | null> {
  const principal = await requireShellActor();
  const context = createWorkspaceContext(principal.workspaceId);
  const store = getChatStore();

  const conversation = await store.loadConversation(context, sessionId);
  if (conversation === null) return null;

  const evidence = await store.loadEvidence(context, {
    instagramAccountId: conversation.session.instagramAccountId,
  });

  return Object.freeze({
    evidence,
    messages: conversation.messages,
    session: conversation.session,
  });
}
