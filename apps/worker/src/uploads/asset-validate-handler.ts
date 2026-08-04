import type { MediaValidationConfig, ObjectStorageConfig } from "@studio-parallel/config";
import {
  createWorkspaceContext,
  findVideoAssetForValidation,
  recordVideoAssetValidation,
  runIdempotentJobHandler,
  videoAssetResourceType,
  type DatabaseClient,
  type JobHandlerExecutionContext,
  type TransactionalJobResult,
  type VideoAssetForValidation,
} from "@studio-parallel/db";
import {
  JobHandlerFailure,
  type QueueHandlerRegistration,
  type QueueJobEnvelope,
} from "@studio-parallel/domain";
import type { ObjectStorageAdapter } from "@studio-parallel/integrations";
import { parseCorrelationId, type JsonLogger } from "@studio-parallel/observability";

import type { MediaProbe } from "./media-probe.js";
import { stageObjectForProbe, StagedObjectTooLargeError } from "./object-staging.js";
import { evaluateProbedMedia, type RejectionCode } from "./validation-policy.js";

/**
 * Decides whether one uploaded object is a source video this product will
 * analyse.
 *
 * This is the only place that turns a PENDING_VALIDATION asset into READY, and
 * it is deliberately the narrow gate: the upload API can store bytes, but
 * nothing becomes analysis-eligible until a probe has described it and the
 * configured policy has accepted that description.
 *
 * Two failure kinds are kept apart throughout. A rejection is a verdict about
 * the media and is terminal — retrying cannot make a corrupt file decode, so it
 * is recorded on the asset and the job succeeds. An operational fault (the
 * object store is unreachable, the probe binary is missing) is not a verdict at
 * all, so it is raised as a retryable failure and the asset stays pending.
 *
 * The staged copy is removed on every path. Nothing derived from the object —
 * its key, its filename, its bytes — is ever logged.
 */

export const assetValidateQueue = { name: "asset.validate", version: 1 } as const;

export type AssetValidateDependencies = Readonly<{
  database: DatabaseClient;
  logger: JsonLogger;
  mediaConfig: MediaValidationConfig;
  now?: (() => Date) | undefined;
  probe: MediaProbe;
  storage: ObjectStorageAdapter;
  storageConfig: ObjectStorageConfig;
}>;

/**
 * How long a rejected object may keep holding bytes.
 *
 * docs/technical/video-ingestion.md gives rejected and quarantined objects 24
 * hours after diagnostic metadata is captured, which is exactly what this row
 * has just captured.
 */
const rejectedPurgeDelayMs = 24 * 60 * 60 * 1000;

type Verdict =
  | Readonly<{
      accepted: true;
      audioCodec: string | null;
      containerFormat: string;
      durationMs: number;
      heightPx: number;
      videoCodec: string;
      widthPx: number;
    }>
  | Readonly<{ accepted: false; code: RejectionCode }>;

type DecideOptions = Readonly<{
  asset: VideoAssetForValidation;
  dependencies: AssetValidateDependencies;
  execution: JobHandlerExecutionContext;
}>;

/**
 * Produces the verdict for one pending asset.
 *
 * Separate from the handler so the retryable/terminal split stays legible: this
 * function returns a `Verdict` for anything that is a judgement about the media
 * and throws `JobHandlerFailure` for anything that is not.
 */
async function decideVerdict({ asset, dependencies, execution }: DecideOptions): Promise<Verdict> {
  const maxBytes = dependencies.storageConfig.UPLOAD_MAX_BYTES;

  // A completed upload that stored nothing is rejected without troubling the
  // probe.
  if (asset.bytes <= 0n) {
    return Object.freeze({ accepted: false, code: "EMPTY_OBJECT" });
  }

  if (asset.bytes > BigInt(maxBytes)) {
    return Object.freeze({ accepted: false, code: "BYTES_EXCEEDED" });
  }

  await execution.recordStage("reading_object");

  const stored = await dependencies.storage.getObject(asset.objectKey);

  // The completion path only creates an asset after observing the object, so an
  // absent object now is a storage fault rather than a media verdict.
  if (stored === null) {
    throw new JobHandlerFailure({
      errorClass: "TRANSIENT",
      errorCode: "ASSET_VALIDATE_OBJECT_UNREADABLE",
    });
  }

  let handle;

  try {
    handle = await stageObjectForProbe(stored.body, maxBytes);
  } catch (error) {
    // The stored object holds more bytes than the recorded size claimed, which
    // the staging ceiling caught mid-stream.
    if (error instanceof StagedObjectTooLargeError) {
      return Object.freeze({ accepted: false, code: "BYTES_EXCEEDED" });
    }

    throw error;
  }

  try {
    const { staged } = handle;

    if (staged.bytes === 0) {
      return Object.freeze({ accepted: false, code: "EMPTY_OBJECT" });
    }

    // The browser's checksum is advisory, but when it was supplied and disagrees
    // with the bytes the server just read, the upload did not deliver what the
    // client believed it delivered.
    if (asset.declaredChecksum !== null && asset.declaredChecksum.toLowerCase() !== staged.sha256) {
      return Object.freeze({ accepted: false, code: "CHECKSUM_MISMATCH" });
    }

    await execution.heartbeat();
    await execution.recordStage("probing_media");

    const probed = await dependencies.probe.probe(staged.filePath, {
      maxOutputBytes: dependencies.mediaConfig.MEDIA_PROBE_MAX_OUTPUT_BYTES,
      timeoutMs: dependencies.mediaConfig.MEDIA_PROBE_TIMEOUT_MS,
    });

    if (!probed.ok) {
      // A probe that ran out of time has not judged the media. Letting that
      // stand as a rejection would make a loaded worker look like a corrupt
      // upload, so it retries instead.
      if (probed.reason === "TIMED_OUT") {
        throw new JobHandlerFailure({
          errorClass: "TRANSIENT",
          errorCode: "ASSET_VALIDATE_PROBE_TIMED_OUT",
        });
      }

      return Object.freeze({ accepted: false, code: probed.reason });
    }

    const evaluated = evaluateProbedMedia(
      {
        declaredContentType: asset.declaredContentType,
        headerFamily: staged.family,
        media: probed.media,
      },
      dependencies.mediaConfig,
    );

    if (!evaluated.accepted) {
      return Object.freeze({ accepted: false, code: evaluated.code });
    }

    return Object.freeze({
      accepted: true,
      audioCodec: evaluated.media.audioCodec,
      // Store the demuxer list as one field; it is what the probe actually
      // reported, and collapsing it to a single guessed name would record
      // something the probe never said.
      containerFormat: evaluated.media.containerFormats.join(","),
      durationMs: evaluated.media.durationMs,
      heightPx: evaluated.media.heightPx,
      videoCodec: evaluated.media.videoCodec,
      widthPx: evaluated.media.widthPx,
    });
  } finally {
    await handle.dispose();
  }
}

export function createAssetValidateHandler(
  dependencies: AssetValidateDependencies,
): QueueHandlerRegistration {
  const now = dependencies.now ?? (() => new Date());

  return Object.freeze({
    handler: async (envelope: QueueJobEnvelope, context: { signal: AbortSignal }) => {
      const workspace = createWorkspaceContext(envelope.workspaceId);

      await runIdempotentJobHandler({
        context: workspace,
        database: dependencies.database,
        envelope,
        execute: async (execution: JobHandlerExecutionContext): Promise<TransactionalJobResult> => {
          const correlationId = parseCorrelationId(envelope.correlationId);

          if (!correlationId) {
            throw new JobHandlerFailure({
              errorClass: "INVALID_INPUT",
              errorCode: "ASSET_VALIDATE_CORRELATION_INVALID",
            });
          }

          await execution.recordStage("loading_asset");

          const job = await dependencies.database.backgroundJob.findFirst({
            select: { resourceId: true, resourceType: true },
            where: { id: execution.jobId, workspaceId: workspace.workspaceId },
          });

          if (!job?.resourceId || job.resourceType !== videoAssetResourceType) {
            // Nothing identifiable to validate; a retry could not discover a
            // resource the job never carried.
            return Object.freeze({ commit: async () => undefined });
          }

          const asset = await findVideoAssetForValidation(
            dependencies.database,
            workspace,
            job.resourceId,
          );

          // Already decided, or deleted before the job ran. Either way this
          // attempt must not overwrite the outcome.
          if (asset === null || asset.state !== "PENDING_VALIDATION") {
            return Object.freeze({ commit: async () => undefined });
          }

          const verdict = await decideVerdict({ asset, dependencies, execution });

          await execution.recordStage("recording_outcome");

          const validatedAt = now();

          return Object.freeze({
            commit: async (transaction) => {
              const decided = await recordVideoAssetValidation(transaction, workspace, {
                assetId: asset.id,
                state: verdict.accepted ? "READY" : "REJECTED",
                validatedAt,
                ...(verdict.accepted
                  ? {
                      audioCodec: verdict.audioCodec,
                      containerFormat: verdict.containerFormat,
                      durationMs: verdict.durationMs,
                      heightPx: verdict.heightPx,
                      videoCodec: verdict.videoCodec,
                      widthPx: verdict.widthPx,
                    }
                  : {
                      purgeAfter: new Date(validatedAt.getTime() + rejectedPurgeDelayMs),
                      rejectionCode: verdict.code,
                    }),
              });

              // Another attempt decided first. Leave its verdict alone.
              if (!decided) {
                return;
              }

              dependencies.logger.info(
                verdict.accepted ? "video.asset.validated" : "video.asset.rejected",
                {
                  correlationId,
                  stage: "asset_validate",
                  // Only the safe classification and detected shape. Never the
                  // object key, the staged path or any bytes.
                  ...(verdict.accepted
                    ? { unit: "milliseconds", value: verdict.durationMs }
                    : { reasonCode: verdict.code }),
                },
              );
            },
          });
        },
        logger: dependencies.logger,
        // The asset leaving PENDING_VALIDATION is the durable evidence that this
        // job's work landed, so a redelivery re-reads state rather than relying
        // on a marker row.
        resultExists: async (executor) => {
          const job = await executor.backgroundJob.findFirst({
            select: { resourceId: true },
            where: { id: envelope.domainJobId, workspaceId: workspace.workspaceId },
          });

          if (!job?.resourceId) {
            return false;
          }

          const asset = await executor.videoAsset.findFirst({
            select: { state: true },
            where: { id: job.resourceId, workspaceId: workspace.workspaceId },
          });

          return asset !== null && asset.state !== "PENDING_VALIDATION";
        },
        signal: context.signal,
      });
    },
    queue: assetValidateQueue,
  });
}
