import type { SourceVideoAsset } from "../lib/server/source-video-data";

import { AnalysisRequestControl } from "./analysis-request-control";

/**
 * What happened to the video that was uploaded.
 *
 * This exists because an upload used to vanish into the product: the file
 * stored, a row was created, validation failed, and the page still showed an
 * empty upload control. The only way to learn any of that was to query the
 * database.
 *
 * Each state says what it is and what to do next. `PENDING_VALIDATION` says
 * explicitly that the page will not update on its own, because a spinner that
 * never resolves is a worse lie than a plain instruction to reload.
 */

const rejectionMessages: Readonly<Record<string, string>> = Object.freeze({
  AUDIO_CODEC_UNSUPPORTED: "The audio track uses a format that cannot be analysed.",
  BYTES_EXCEEDED: "The file is larger than this workspace accepts.",
  CHECKSUM_MISMATCH: "The stored file did not match what was uploaded. Upload it again.",
  CONTAINER_MISMATCH: "The file contents did not match the file type it claimed to be.",
  CONTAINER_UNSUPPORTED: "That container format cannot be analysed. Use MP4, MOV or WebM.",
  DIMENSIONS_OUT_OF_RANGE: "The video's dimensions are outside the range that can be analysed.",
  DURATION_OUT_OF_RANGE: "The video is too short or too long to analyse.",
  EMPTY_OBJECT: "The stored file was empty.",
  NO_VIDEO_STREAM: "The file has no video track.",
  UNDECODABLE: "The video could not be decoded. It may be corrupt.",
  VIDEO_CODEC_UNSUPPORTED: "The video uses a codec that cannot be analysed.",
});

function describeRejection(code: string | null): string {
  return code === null
    ? "The video could not be validated."
    : (rejectionMessages[code] ?? "The video could not be validated.");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);

  return `${minutes}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

/**
 * How the video got here.
 *
 * Stated for every asset rather than only for imports, because "uploaded" and
 * "copied from Instagram" mean different things about the file's quality, and a
 * label that appears only sometimes leaves the other case ambiguous.
 */
function describeOrigin(origin: SourceVideoAsset["origin"]): string {
  return origin === "PROVIDER_IMPORT"
    ? "Copied from Instagram — the version Instagram serves, re-encoded for playback"
    : "Uploaded from your own file";
}

export function SourceVideoStatus({ asset }: Readonly<{ asset: SourceVideoAsset }>) {
  const imported = asset.origin === "PROVIDER_IMPORT";
  const dimensions =
    asset.widthPx !== null && asset.heightPx !== null ? `${asset.widthPx}×${asset.heightPx}` : null;

  const details = [
    formatBytes(asset.bytes),
    asset.durationMs === null ? null : formatDuration(asset.durationMs),
    dimensions,
  ].filter((detail): detail is string => detail !== null);

  return (
    <section aria-labelledby="source-video-status-heading" className="source-video-status">
      <h2 id="source-video-status-heading">Attached video</h2>

      {asset.state === "PENDING_VALIDATION" ? (
        <p className="source-video-status__state" data-state="checking" role="status">
          {imported ? "Copied from Instagram" : "Uploaded"} and being checked. This page does not
          update on its own — reload it to see the result. If it stays here, the check may have
          failed; an administrator can look at the job for this video.
        </p>
      ) : null}

      {asset.state === "READY" ? (
        <>
          <p className="source-video-status__state" data-state="ready" role="status">
            Checked and ready to analyse.
          </p>
          <AnalysisRequestControl postId={asset.instagramPostId} />
        </>
      ) : null}

      {asset.state === "REJECTED" ? (
        <p className="source-video-status__state" data-state="rejected" role="alert">
          {describeRejection(asset.rejectionCode)}{" "}
          {imported
            ? "Upload your own file instead, or try Instagram again."
            : "Upload a different file to replace it."}
        </p>
      ) : null}

      <dl className="source-video-status__details">
        <div>
          <dt>Size</dt>
          <dd>{details.join(" · ")}</dd>
        </div>
        <div>
          <dt>Source</dt>
          <dd>{describeOrigin(asset.origin)}</dd>
        </div>
        <div>
          <dt>Added</dt>
          <dd>
            <time dateTime={asset.uploadedAt}>
              {asset.uploadedAt.slice(0, 16).replace("T", " ")}
            </time>
          </dd>
        </div>
      </dl>
    </section>
  );
}
