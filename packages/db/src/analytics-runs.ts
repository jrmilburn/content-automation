import { createHash } from "node:crypto";

import { analyticsVersion, statisticsVersion } from "@studio-parallel/domain";

import type { Prisma, PrismaClient } from "./generated/prisma/client.js";
import { createId } from "./id.js";
import type { WorkspaceContext } from "./workspace-context.js";

/**
 * The calculation run, and the debounce that decides when one is due.
 *
 * Two problems are solved here. Publication has to be atomic, so statistics are
 * written under a `BUILDING` run that no reader can see and become visible in
 * the single statement that makes the run `ACTIVE`. And a burst of imports must
 * not produce a run per snapshot, so the first unprocessed change starts a
 * window and later changes extend nothing.
 *
 * Debounce is deliberately anchored to the *first* change rather than the last.
 * Extending on every change would let a steadily-importing account never become
 * due at all, which is the failure mode that turns a debounce into a starvation
 * bug.
 */

type Executor = PrismaClient | Prisma.TransactionClient;

/** How long after the first unprocessed change a recalculation becomes due. */
export const analyticsDebounceMs = 5 * 60 * 1_000;

export const analyticsRunFailureCodes = [
  "CALCULATION_FAILED",
  "INPUTS_CHANGED",
  "NO_ELIGIBLE_ANALYSES",
  "STATISTIC_COUNT_MISMATCH",
] as const;

export type AnalyticsRunFailureCode = (typeof analyticsRunFailureCodes)[number];

/**
 * Marks an account's analytics as needing recalculation.
 *
 * Called after a new snapshot or a newly current analysis. Already-dirty
 * accounts are left alone so the window keeps its original anchor.
 */
export async function markAnalyticsDirty(
  executor: Executor,
  context: WorkspaceContext,
  input: Readonly<{ instagramAccountId: string; now: Date }>,
): Promise<void> {
  await executor.instagramAccount.updateMany({
    data: {
      analyticsDirtySince: input.now,
      analyticsDueAt: new Date(input.now.getTime() + analyticsDebounceMs),
    },
    where: {
      // Only a clean account starts a window. A dirty one already has one, and
      // moving it would let continuous activity postpone the run forever.
      analyticsDirtySince: null,
      id: input.instagramAccountId,
      workspaceId: context.workspaceId,
    },
  });
}

export type DueAccount = Readonly<{
  dirtySince: Date;
  instagramAccountId: string;
  workspaceId: string;
}>;

/** Accounts whose debounce window has closed. */
export async function listAccountsDueForAnalytics(
  executor: Executor,
  input: Readonly<{ limit: number; now: Date }>,
): Promise<readonly DueAccount[]> {
  const accounts = await executor.instagramAccount.findMany({
    orderBy: { analyticsDueAt: "asc" },
    select: { analyticsDirtySince: true, id: true, workspaceId: true },
    take: Math.min(Math.max(input.limit, 1), 100),
    where: {
      analyticsDueAt: { lte: input.now },
      connectionStatus: "ACTIVE",
    },
  });

  return Object.freeze(
    accounts
      .filter((account) => account.analyticsDirtySince !== null)
      .map((account) =>
        Object.freeze({
          dirtySince: account.analyticsDirtySince as Date,
          instagramAccountId: account.id,
          workspaceId: account.workspaceId,
        }),
      ),
  );
}

/**
 * Hashes the inputs a run read.
 *
 * Compared again at activation. A run whose inputs changed while it was
 * building is rejected rather than published, because activating it would
 * present a set that never existed at any single moment — half from before the
 * change and half from after.
 */
export function createRunInputFingerprint(
  input: Readonly<{ analysisIds: readonly string[]; snapshotIds: readonly string[] }>,
): string {
  const canonical = JSON.stringify([
    analyticsVersion,
    statisticsVersion,
    [...input.analysisIds].sort(),
    [...input.snapshotIds].sort(),
  ]);

  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export type StartedRun = Readonly<{ id: string; startedAt: Date }>;

export async function startAnalyticsRun(
  executor: Executor,
  context: WorkspaceContext,
  input: Readonly<{
    ageWindow: string;
    analysisCount: number;
    inputFingerprint: string;
    /** One account, or absent for a run covering every linked account. */
    instagramAccountId?: string;
    now: Date;
    publishedFrom: Date;
    publishedTo: Date;
  }>,
): Promise<StartedRun> {
  const id = createId();

  await executor.accountAnalyticsRun.create({
    data: {
      ageWindow: input.ageWindow,
      analysisCount: input.analysisCount,
      analyticsVersion,
      id,
      inputFingerprint: input.inputFingerprint,
      instagramAccountId: input.instagramAccountId ?? null,
      publishedFrom: input.publishedFrom,
      publishedTo: input.publishedTo,
      startedAt: input.now,
      state: "BUILDING",
      statisticsVersion,
      workspaceId: context.workspaceId,
    },
  });

  return Object.freeze({ id, startedAt: input.now });
}

export type ActivationResult =
  | Readonly<{ activated: true; supersededRunId: string | null }>
  | Readonly<{ activated: false; reason: AnalyticsRunFailureCode }>;

/**
 * Publishes a built run, or refuses and says why.
 *
 * The whole point of this function is the single moment where the previous run
 * becomes `SUPERSEDED` and this one becomes `ACTIVE`. Both statements are in the
 * caller's transaction and a partial unique index guarantees only one `ACTIVE`
 * run per scope — one per account, and one for the accounts pooled — so two
 * concurrent activations cannot both believe they published the current set.
 *
 * The dirty marker is cleared only if it has not moved since the run started. A
 * change that arrived mid-calculation leaves the account dirty, so the next
 * sweep picks it up rather than the change being silently lost.
 */
export async function activateAnalyticsRun(
  executor: Executor,
  context: WorkspaceContext,
  input: Readonly<{
    /**
     * The marker this run started from, supplied only by an account scope. The
     * pooled scope clears nothing, so it has nothing to compare and passes none.
     */
    dirtySince?: Date;
    expectedStatisticCount: number;
    inputFingerprint: string;
    /** The run's scope, matching the one it was started with. */
    instagramAccountId?: string;
    now: Date;
    runId: string;
  }>,
): Promise<ActivationResult> {
  const run = await executor.accountAnalyticsRun.findFirst({
    select: { inputFingerprint: true, startedAt: true },
    where: { id: input.runId, workspaceId: context.workspaceId },
  });

  if (run === null || run.inputFingerprint !== input.inputFingerprint) {
    await failAnalyticsRun(executor, context, {
      failureCode: "INPUTS_CHANGED",
      runId: input.runId,
    });

    return Object.freeze({ activated: false, reason: "INPUTS_CHANGED" as const });
  }

  // Membership, not authorship. Most of a run's statistics were written by an
  // earlier run and collapsed onto here unchanged; counting what this run wrote
  // would fail every run after the first.
  const written = await executor.accountAnalyticsRunStatistic.count({
    where: { runId: input.runId, workspaceId: context.workspaceId },
  });

  // A run that produced fewer statistics than it calculated would publish an
  // incomplete set, which is exactly what activation is supposed to prevent.
  if (written !== input.expectedStatisticCount) {
    await failAnalyticsRun(executor, context, {
      failureCode: "STATISTIC_COUNT_MISMATCH",
      runId: input.runId,
    });

    return Object.freeze({ activated: false, reason: "STATISTIC_COUNT_MISMATCH" as const });
  }

  const previous = await executor.accountAnalyticsRun.findFirst({
    select: { id: true },
    where: {
      // Null is the scope, not the absence of a filter. Left as `undefined`,
      // Prisma would drop the bound and a pooled run would supersede whichever
      // account's run it found first.
      instagramAccountId: input.instagramAccountId ?? null,
      state: "ACTIVE",
      workspaceId: context.workspaceId,
    },
  });

  if (previous) {
    await executor.accountAnalyticsRun.updateMany({
      data: { state: "SUPERSEDED" },
      where: { id: previous.id, workspaceId: context.workspaceId },
    });
  }

  await executor.accountAnalyticsRun.updateMany({
    data: {
      activatedAt: input.now,
      durationMs: input.now.getTime() - run.startedAt.getTime(),
      state: "ACTIVE",
      statisticCount: written,
    },
    where: { id: input.runId, workspaceId: context.workspaceId },
  });

  // Only clears when the marker has not moved. A change that arrived while the
  // run was building must survive, or it is lost until something else dirties
  // the account.
  //
  // A pooled run clears nothing. The debounce marker belongs to an account and
  // one `dirtySince` cannot say which accounts' windows this run consumed;
  // clearing them all against a single marker would discard a change that
  // arrived on another account mid-run, which is the loss this guard prevents.
  //
  // Both halves are checked, because an absent `dirtySince` is not a filter
  // Prisma ignores — it is no filter at all, and the clear would then fire
  // however far the marker had moved.
  const { dirtySince, instagramAccountId } = input;
  if (instagramAccountId !== undefined && dirtySince !== undefined) {
    await executor.instagramAccount.updateMany({
      data: { analyticsDirtySince: null, analyticsDueAt: null },
      where: {
        analyticsDirtySince: dirtySince,
        id: instagramAccountId,
        workspaceId: context.workspaceId,
      },
    });
  }

  return Object.freeze({
    activated: true as const,
    supersededRunId: previous?.id ?? null,
  });
}

/**
 * Records why a run did not publish.
 *
 * The previous `ACTIVE` run is untouched, so a failure leaves the last complete
 * set in place rather than leaving readers with nothing.
 */
export async function failAnalyticsRun(
  executor: Executor,
  context: WorkspaceContext,
  input: Readonly<{ failureCode: AnalyticsRunFailureCode; runId: string }>,
): Promise<void> {
  await executor.accountAnalyticsRun.updateMany({
    data: { failureCode: input.failureCode, state: "FAILED" },
    where: { id: input.runId, state: "BUILDING", workspaceId: context.workspaceId },
  });
}

/**
 * The inputs a scope's published run measured, or null if it has published none.
 *
 * This is how the pooled scope tells whether it is current. An account is told
 * by its debounce marker, but the markers belong to the accounts and their own
 * runs clear them as they publish — so a pooled run that trusted them would find
 * them already clear and conclude it had nothing to do. What it last published
 * is the only record of what it has actually measured.
 */
export async function findActiveRunFingerprint(
  executor: Executor,
  context: WorkspaceContext,
  instagramAccountId: string | null,
): Promise<string | null> {
  const run = await executor.accountAnalyticsRun.findFirst({
    select: { inputFingerprint: true },
    where: {
      activatedAt: { not: null },
      instagramAccountId,
      state: "ACTIVE",
      workspaceId: context.workspaceId,
    },
  });

  return run?.inputFingerprint ?? null;
}

export type ActiveRunSummary = Readonly<{
  activatedAt: string;
  ageWindow: string;
  durationMs: number | null;
  id: string;
  statisticCount: number;
}>;

/** The run whose statistics a reader should see, if any. Null pools accounts. */
export async function findActiveAnalyticsRun(
  executor: Executor,
  context: WorkspaceContext,
  instagramAccountId: string | null,
): Promise<ActiveRunSummary | null> {
  const run = await executor.accountAnalyticsRun.findFirst({
    select: {
      activatedAt: true,
      ageWindow: true,
      durationMs: true,
      id: true,
      statisticCount: true,
    },
    where: { instagramAccountId, state: "ACTIVE", workspaceId: context.workspaceId },
  });

  return run === null || run.activatedAt === null
    ? null
    : Object.freeze({
        activatedAt: run.activatedAt.toISOString(),
        ageWindow: run.ageWindow,
        durationMs: run.durationMs,
        id: run.id,
        statisticCount: run.statisticCount,
      });
}
