import {
  createWorkspaceContext,
  failStrategyGeneration,
  findStrategyGenerationForJob,
  publishStrategyGeneration,
  recordStrategyStage,
  runIdempotentJobHandler,
  strategyResultExistsForJob,
  type DatabaseClient,
  type FrozenStrategyGeneration,
  type JobHandlerExecutionContext,
  type TransactionalJobResult,
} from "@studio-parallel/db";
import {
  completeStrategyV1,
  createStrategyInstruction,
  createStrategyRecommendationFingerprint,
  JobHandlerFailure,
  renderStrategyManifest,
  validateStrategyV1,
  type QueueHandlerRegistration,
  type QueueJobEnvelope,
  type StrategyValidationResult,
} from "@studio-parallel/domain";
import { GeminiError, type GeminiAdapter } from "@studio-parallel/integrations";
import { parseCorrelationId, type JsonLogger } from "@studio-parallel/observability";

import { toJobFailure, withHeartbeat } from "../analysis/analysis-run-handler.js";

/**
 * Turns one frozen manifest into one validated strategy.
 *
 * The evidence is never re-read. Retrieval happened when the request was made
 * and was frozen with it, so this handler loads those rows and argues from them
 * even on a redelivery hours later. Re-running retrieval would quietly
 * substitute whatever the account looks like now, and a retry would then defend
 * a different set of numbers than the attempt it replaced.
 *
 * The model gets text and nothing else. No video, no database, no tools — the
 * manifest states exactly what may be cited and which numbers may be written,
 * and `validateStrategyV1` holds the response to it. A response that cites
 * evidence it was not given is refused rather than repaired into plausibility.
 *
 * Publication moves the account's current pointer in the same transaction as
 * the result, so a failure leaves the previous strategy exactly where it was.
 */

export const strategyGenerateQueue = {
  name: "strategy.generate",
  version: 1,
} as const;

export type StrategyGenerateDependencies = Readonly<{
  acquireConcurrency?: ((signal: AbortSignal) => Promise<() => void>) | undefined;
  database: DatabaseClient;
  gemini: GeminiAdapter;
  logger: JsonLogger;
  now?: (() => Date) | undefined;
}>;

type RunOutcome = Readonly<{
  finishReason: string | null;
  durationMs: number;
  modelVersion: string | null;
  strategy: StrategyValidationResult;
  usage: Readonly<{
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
  }>;
}>;

/**
 * One ask, rendered from the frozen rows and held to the frozen manifest.
 *
 * Rendering here rather than storing the prompt keeps one representation of the
 * evidence: the rows are the record, and the text is derived from them, so the
 * two cannot drift into disagreeing about what the model was shown.
 */
async function requestStrategy(
  dependencies: StrategyGenerateDependencies,
  execution: JobHandlerExecutionContext,
  generation: FrozenStrategyGeneration,
): Promise<RunOutcome> {
  const manifestText = renderStrategyManifest(
    {
      ageWindow: generation.ageWindow,
      instagramAccountId: generation.instagramAccountId,
      primaryMetric: generation.primaryMetric as never,
      publishedFrom: generation.publishedFrom.toISOString(),
      publishedTo: generation.publishedTo.toISOString(),
    },
    generation.entries,
  );

  const constraint =
    generation.editorialConstraint === null
      ? ""
      : `\n\nEditorial constraint from the account owner: ${generation.editorialConstraint}`;

  const instruction = `${createStrategyInstruction({ mode: generation.mode })}${constraint}

${manifestText}`;

  const result = await withHeartbeat(execution, () =>
    dependencies.gemini.generateStructuredText({ instruction }),
  );

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.text);
  } catch {
    // Not valid JSON at all. Distinguished from a schema failure because the
    // provider's own response mime type was asked to guarantee this much.
    throw new JobHandlerFailure({
      errorClass: "SEMANTIC_OUTPUT",
      errorCode: "STRATEGY_RESPONSE_NOT_JSON",
    });
  }

  return Object.freeze({
    durationMs: result.durationMs,
    finishReason: result.finishReason,
    modelVersion: result.modelVersion,
    strategy: validateStrategyV1(completeStrategyV1(parsed, { mode: generation.mode }), {
      manifest: generation.manifest,
      mode: generation.mode,
      recentRecommendationFingerprints: generation.recentRecommendationFingerprints,
    }),
    usage: Object.freeze({
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      totalTokens: result.usage.totalTokens,
    }),
  });
}

export function createStrategyGenerateHandler(
  dependencies: StrategyGenerateDependencies,
): QueueHandlerRegistration {
  const now = dependencies.now ?? (() => new Date());

  return Object.freeze({
    handler: async (envelope: QueueJobEnvelope, context: { signal: AbortSignal }) => {
      const workspace = createWorkspaceContext(envelope.workspaceId);

      await runIdempotentJobHandler({
        ...(dependencies.acquireConcurrency
          ? { acquireConcurrency: dependencies.acquireConcurrency }
          : {}),
        context: workspace,
        database: dependencies.database,
        envelope,
        execute: (execution) => generate({ dependencies, envelope, execution, now, workspace }),
        logger: dependencies.logger,
        now,
        // The stored result rather than a marker: a crash between the write and
        // the job's own bookkeeping still reads as done.
        resultExists: async (executor) =>
          strategyResultExistsForJob(executor, workspace, envelope.domainJobId),
        signal: context.signal,
      });
    },
    queue: strategyGenerateQueue,
  });
}

async function generate(input: {
  dependencies: StrategyGenerateDependencies;
  envelope: QueueJobEnvelope;
  execution: JobHandlerExecutionContext;
  now: () => Date;
  workspace: ReturnType<typeof createWorkspaceContext>;
}): Promise<TransactionalJobResult> {
  const { dependencies, envelope, execution, now, workspace } = input;
  const { database, logger } = dependencies;

  const correlationId = parseCorrelationId(envelope.correlationId);
  if (!correlationId) {
    throw new JobHandlerFailure({
      errorClass: "INVALID_INPUT",
      errorCode: "STRATEGY_CORRELATION_INVALID",
    });
  }

  await execution.recordStage("loading_manifest");

  // Resolved through the job, so a redelivery finds the generation it was
  // created with and a crafted payload cannot point it at another account.
  const generation = await findStrategyGenerationForJob(database, workspace, envelope.domainJobId);

  if (generation === null) {
    throw new JobHandlerFailure({
      errorClass: "INVALID_INPUT",
      errorCode: "STRATEGY_GENERATION_MISSING",
    });
  }

  if (generation.entries.length === 0) {
    // A manifest with nothing in it would let the model write whatever it liked
    // and cite nothing, which validation would then reject anyway.
    throw new JobHandlerFailure({
      errorClass: "INVALID_INPUT",
      errorCode: "STRATEGY_MANIFEST_EMPTY",
    });
  }

  await execution.recordStage("requesting_strategy");
  await recordStrategyStage(database, workspace, {
    stage: "REQUESTING",
    strategyGenerationId: generation.id,
  });

  let outcome: RunOutcome;
  try {
    outcome = await requestStrategy(dependencies, execution, generation);

    // Exactly one repair, and the bound is a stored column rather than a local
    // counter, so a redelivery cannot spend the allowance a second time. A
    // second invalid response is the contract failing rather than the model
    // slipping.
    if (!outcome.strategy.valid && !generation.repairAttempted) {
      await execution.recordStage("repairing");
      await recordStrategyStage(database, workspace, {
        repairAttempted: true,
        stage: "REPAIRING",
        strategyGenerationId: generation.id,
      });

      outcome = await requestStrategy(dependencies, execution, generation);
    }
  } catch (error) {
    if (error instanceof GeminiError) {
      const failure = toJobFailure(error);
      // The reason code only. The provider's own text is untrusted, unbounded
      // and often echoes the input, so it never reaches a stored record.
      await failStrategyGeneration(database, workspace, {
        failureClass: failure.failure.errorClass,
        failureCode: failure.failure.errorCode,
        now: now(),
        strategyGenerationId: generation.id,
      });
      throw failure;
    }
    throw error;
  }

  if (!outcome.strategy.valid) {
    // The issue code only. The response itself is untrusted text that often
    // echoes the input, so it never reaches a log or a stored record.
    const reasonCode = outcome.strategy.issues[0]?.code ?? "SCHEMA_INVALID";
    logger.warn("strategy.response_invalid", {
      correlationId,
      jobId: envelope.domainJobId,
      reasonCode,
      stage: "requesting_strategy",
      workspaceId: workspace.workspaceId,
    });

    await failStrategyGeneration(database, workspace, {
      failureClass: "SEMANTIC_OUTPUT",
      failureCode: "STRATEGY_RESPONSE_INVALID",
      now: now(),
      strategyGenerationId: generation.id,
    });

    throw new JobHandlerFailure({
      errorClass: "SEMANTIC_OUTPUT",
      errorCode: "STRATEGY_RESPONSE_INVALID",
    });
  }

  const strategy = outcome.strategy.data;
  const fingerprints = strategy.recommendations.map((recommendation) =>
    createStrategyRecommendationFingerprint(recommendation),
  );

  await execution.recordStage("publishing");

  return Object.freeze({
    commit: async (transaction) => {
      const published = await publishStrategyGeneration(transaction, workspace, {
        finishReason: outcome.finishReason,
        generatedAt: now(),
        inputTokens: outcome.usage.inputTokens,
        instagramAccountId: generation.instagramAccountId,
        modelVersion: outcome.modelVersion,
        outputTokens: outcome.usage.outputTokens,
        providerLatencyMs: outcome.durationMs,
        recommendationFingerprints: fingerprints,
        result: strategy as never,
        strategyGenerationId: generation.id,
        totalTokens: outcome.usage.totalTokens,
      });

      if (!published.published) return;

      logger.info("strategy.published", {
        correlationId,
        durationMs: outcome.durationMs,
        jobId: envelope.domainJobId,
        outcome: generation.mode,
        stage: "publishing",
        value: fingerprints.length,
        workspaceId: workspace.workspaceId,
      });
    },
  });
}
