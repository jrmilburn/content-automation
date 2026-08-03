import {
  analysisExistsForJob,
  createWorkspaceContext,
  findAnalysisJobForBackgroundJob,
  findAnalysisSourceAsset,
  publishPostAnalysis,
  recordAnalysisProviderFile,
  recordAnalysisStage,
  runIdempotentJobHandler,
  type DatabaseClient,
  type JobHandlerExecutionContext,
  type TransactionalJobResult,
} from "@studio-parallel/db";
import {
  analysisContractArtifacts,
  completePostCreativeAnalysisV1,
  createAnalysisInstruction,
  JobHandlerFailure,
  validatePostCreativeAnalysisV1,
  type QueueHandlerRegistration,
  type QueueJobEnvelope,
} from "@studio-parallel/domain";
import {
  GeminiError,
  type GeminiAdapter,
  type ObjectStorageAdapter,
} from "@studio-parallel/integrations";
import { parseCorrelationId, type JsonLogger } from "@studio-parallel/observability";

/**
 * Produces one immutable creative analysis of one video.
 *
 * The shape of this handler is dictated by the fact that the expensive step is
 * irreversible. Uploading a video to Gemini and reading it costs money, so every
 * decision that could avoid that call happens before it: the result check, the
 * frozen inputs, the asset state. Once a provider file exists its name is
 * persisted immediately, so a worker that dies still owes a release rather than
 * abandoning paid bytes to their 48-hour expiry.
 *
 * A rejected response and a broken provider are kept apart throughout. A model
 * that returns invalid JSON gets exactly one repair attempt and is then a
 * semantic failure, because asking a fourth time costs another video read to
 * learn the same thing. A 429 or a 5xx is not a verdict at all and stays
 * retryable.
 *
 * The provider file is released on every path, including a rejected request.
 * Nothing derived from the video, the prompt or the response is ever logged.
 */

export const analysisRunQueue = { name: "analysis.run", version: 1 } as const;

export type AnalysisRunDependencies = Readonly<{
  acquireConcurrency?: ((signal: AbortSignal) => Promise<() => void>) | undefined;
  database: DatabaseClient;
  gemini: GeminiAdapter;
  logger: JsonLogger;
  now?: (() => Date) | undefined;
  storage: ObjectStorageAdapter;
}>;

/**
 * Maps a provider failure onto the retry policy.
 *
 * Exported so the whole matrix is testable without a provider: the switch is
 * exhaustive over `GeminiResponseClass`, so a new class added to the adapter
 * becomes a type error here rather than a silently unclassified failure.
 */
export function toJobFailure(error: GeminiError): JobHandlerFailure {
  switch (error.responseClass) {
    case "rate_limit":
      return new JobHandlerFailure({
        errorClass: "RATE_LIMIT",
        errorCode: "ANALYSIS_PROVIDER_RATE_LIMITED",
        ...(error.retryAfterMs === null ? {} : { providerRetryAfterMs: error.retryAfterMs }),
      });
    case "timeout":
    case "transient":
      return new JobHandlerFailure({
        errorClass: "TRANSIENT",
        errorCode: "ANALYSIS_PROVIDER_UNAVAILABLE",
      });
    case "file_failed":
      // The provider could not process the upload. A fresh upload may succeed,
      // so this is transient rather than a verdict about the video.
      return new JobHandlerFailure({
        errorClass: "TRANSIENT",
        errorCode: "ANALYSIS_PROVIDER_FILE_FAILED",
      });
    case "safety_blocked":
      return new JobHandlerFailure({
        errorClass: "SEMANTIC_OUTPUT",
        errorCode: "ANALYSIS_RESPONSE_BLOCKED",
      });
    case "no_candidate":
      return new JobHandlerFailure({
        errorClass: "SEMANTIC_OUTPUT",
        errorCode: "ANALYSIS_RESPONSE_EMPTY",
      });
    case "authorisation":
      // A project API key is not something a user can reconnect, so this is an
      // operator problem rather than a credential the product can repair.
      return new JobHandlerFailure({
        errorClass: "UNKNOWN",
        errorCode: "ANALYSIS_PROVIDER_UNAUTHORISED",
      });
    case "invalid_request":
      return new JobHandlerFailure({
        errorClass: "INVALID_INPUT",
        errorCode: "ANALYSIS_REQUEST_REJECTED",
      });
  }
}

type RunOutcome = Readonly<{
  analysis: ReturnType<typeof validatePostCreativeAnalysisV1>;
  finishReason: string | null;
  latencyMs: number;
  modelVersion: string | null;
  usage: Readonly<{
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
  }>;
}>;

/**
 * Asks the model once and validates what comes back.
 *
 * Separated from the retry decision so the single-repair policy is visible: the
 * caller runs this at most twice, and the second run exists only because a model
 * that returned nearly-valid JSON usually returns valid JSON when asked again.
 */
async function requestAnalysis(
  dependencies: AnalysisRunDependencies,
  input: Readonly<{ fileUri: string; probedDurationSeconds: number }>,
): Promise<RunOutcome> {
  const response = await dependencies.gemini.generateStructuredText({
    fileUri: input.fileUri,
    instruction: createAnalysisInstruction(),
    mimeType: "video/mp4",
  });

  let parsed: unknown;

  try {
    parsed = JSON.parse(response.text);
  } catch {
    throw new JobHandlerFailure({
      errorClass: "SEMANTIC_OUTPUT",
      errorCode: "ANALYSIS_RESPONSE_NOT_JSON",
    });
  }

  const stamped = completePostCreativeAnalysisV1(parsed, {
    probedDurationSeconds: input.probedDurationSeconds,
  });

  return Object.freeze({
    analysis: validatePostCreativeAnalysisV1(stamped, {
      probedDurationSeconds: input.probedDurationSeconds,
    }),
    finishReason: response.finishReason,
    latencyMs: response.durationMs,
    modelVersion: response.modelVersion,
    usage: Object.freeze({
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      totalTokens: response.usage.totalTokens,
    }),
  });
}

export function createAnalysisRunHandler(
  dependencies: AnalysisRunDependencies,
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
        execute: async (execution: JobHandlerExecutionContext): Promise<TransactionalJobResult> => {
          const correlationId = parseCorrelationId(envelope.correlationId);

          if (!correlationId) {
            throw new JobHandlerFailure({
              errorClass: "INVALID_INPUT",
              errorCode: "ANALYSIS_CORRELATION_INVALID",
            });
          }

          await execution.recordStage("loading_inputs");

          const job = await findAnalysisJobForBackgroundJob(
            dependencies.database,
            workspace,
            execution.jobId,
          );

          // Nothing frozen to analyse. A retry cannot discover inputs the
          // request never recorded.
          if (job === null) return Object.freeze({ commit: async () => undefined });

          const asset = await findAnalysisSourceAsset(
            dependencies.database,
            workspace,
            job.videoAssetId,
          );

          if (asset === null || asset.state !== "READY") {
            throw new JobHandlerFailure({
              errorClass: "INVALID_INPUT",
              errorCode: "ANALYSIS_ASSET_NOT_READY",
            });
          }

          if (asset.durationMs === null || asset.durationMs <= 0) {
            // Validation measures duration exactly; without it the contract's
            // duration checks cannot be applied and the analysis would be
            // unverifiable.
            throw new JobHandlerFailure({
              errorClass: "INVALID_INPUT",
              errorCode: "ANALYSIS_DURATION_UNKNOWN",
            });
          }

          const probedDurationSeconds = asset.durationMs / 1000;
          let providerFileName = job.providerFileName;

          try {
            if (providerFileName === null) {
              await execution.recordStage("uploading_source");
              await recordAnalysisStage(dependencies.database, workspace, {
                analysisJobId: job.id,
                stage: "UPLOADING",
              });

              const stored = await dependencies.storage.getObject(asset.objectKey);

              if (stored === null) {
                throw new JobHandlerFailure({
                  errorClass: "TRANSIENT",
                  errorCode: "ANALYSIS_OBJECT_UNREADABLE",
                });
              }

              const uploaded = await dependencies.gemini.uploadVideo({
                // Streamed straight through: a gigabyte of video never becomes
                // resident in the worker.
                body: stored.body,
                byteLength: Number(stored.metadata.bytes),
                displayName: `analysis-${job.id}`,
                mimeType: "video/mp4",
              });

              providerFileName = uploaded.name;
              // Written before the model request: the window that matters is
              // the one where a worker dies holding paid bytes.
              await recordAnalysisProviderFile(dependencies.database, workspace, {
                analysisJobId: job.id,
                providerFileName: uploaded.name,
              });
            }

            await execution.recordStage("awaiting_provider_file");
            await recordAnalysisStage(dependencies.database, workspace, {
              analysisJobId: job.id,
              stage: "AWAITING_FILE",
            });

            const file = await dependencies.gemini.waitForActiveFile(providerFileName);

            await execution.recordStage("requesting_analysis");
            await recordAnalysisStage(dependencies.database, workspace, {
              analysisJobId: job.id,
              stage: "REQUESTING",
            });

            let outcome = await requestAnalysis(dependencies, {
              fileUri: file.uri,
              probedDurationSeconds,
            });

            // Exactly one repair. A second invalid response is the contract
            // failing rather than the model slipping, and a third read of the
            // video costs as much as the first.
            if (!outcome.analysis.valid && !job.repairAttempted) {
              await execution.recordStage("repairing");
              await recordAnalysisStage(dependencies.database, workspace, {
                analysisJobId: job.id,
                repairAttempted: true,
                stage: "REPAIRING",
              });

              outcome = await requestAnalysis(dependencies, {
                fileUri: file.uri,
                probedDurationSeconds,
              });
            }

            if (!outcome.analysis.valid) {
              dependencies.logger.warn("analysis.response_invalid", {
                correlationId,
                jobId: execution.jobId,
                postId: job.instagramPostId,
                reasonCode: outcome.analysis.issues[0]?.code ?? "SCHEMA_INVALID",
                stage: "analysis_run",
              });

              throw new JobHandlerFailure({
                errorClass: "SEMANTIC_OUTPUT",
                errorCode: "ANALYSIS_RESPONSE_INVALID",
              });
            }

            const analysis = outcome.analysis.data;

            await execution.recordStage("publishing");

            return Object.freeze({
              commit: async (transaction) => {
                const result = await publishPostAnalysis(transaction, workspace, {
                  analysedAt: now(),
                  analysis,
                  analysisJobId: job.id,
                  finishReason: outcome.finishReason,
                  inputTokens: outcome.usage.inputTokens,
                  instagramPostId: job.instagramPostId,
                  modelVersion: outcome.modelVersion,
                  outputTokens: outcome.usage.outputTokens,
                  promptSha256: analysisContractArtifacts.prompt.sha256,
                  providerLatencyMs: outcome.latencyMs,
                  requestSignature: job.requestSignature,
                  schemaSha256: analysisContractArtifacts.schema.sha256,
                  totalTokens: outcome.usage.totalTokens,
                  transcriptRevisionId: null,
                  validationWarnings: [],
                  videoAssetId: job.videoAssetId,
                });

                if (!result.published) return;

                dependencies.logger.info("analysis.published", {
                  correlationId,
                  jobId: execution.jobId,
                  postId: job.instagramPostId,
                  stage: "analysis_run",
                  unit: "milliseconds",
                  value: outcome.latencyMs,
                });

                if (outcome.usage.totalTokens !== null) {
                  dependencies.logger.info("analysis.usage_recorded", {
                    correlationId,
                    jobId: execution.jobId,
                    postId: job.instagramPostId,
                    stage: "analysis_run",
                    unit: "count",
                    value: outcome.usage.totalTokens,
                  });
                }
              },
            });
          } catch (error) {
            if (error instanceof GeminiError) throw toJobFailure(error);
            throw error;
          } finally {
            // Paid bytes are released on every path, including a rejected
            // request. A failure to release is not worth failing the job over:
            // the provider expires the file in 48 hours regardless.
            if (providerFileName !== null) {
              await dependencies.gemini.deleteFile(providerFileName).catch(() => undefined);
              await recordAnalysisProviderFile(dependencies.database, workspace, {
                analysisJobId: job.id,
                providerFileName: null,
              }).catch(() => undefined);
            }
          }
        },
        logger: dependencies.logger,
        // The published analysis is the durable evidence this job's work
        // landed, so a redelivery re-reads it rather than trusting a marker.
        resultExists: async (executor) =>
          analysisExistsForJob(executor, workspace, envelope.domainJobId),
        signal: context.signal,
      });
    },
    queue: analysisRunQueue,
  });
}
