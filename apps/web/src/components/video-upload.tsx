"use client";

import { acceptedVideoContentTypes, acceptedVideoFileExtensions } from "@studio-parallel/domain";
import { useCallback, useRef, useState } from "react";

import { createUploadSession, type UploadSession, type UploadSnapshot } from "../lib/upload-client";

/**
 * Source-video upload control.
 *
 * The progress bar reports bytes the provider confirmed storing, not bytes
 * handed to the network, so it cannot run ahead of reality and then stall at
 * 100%. Upload and validation are shown as separate stages because a finished
 * upload is not a usable video: the file still has to be probed, and implying
 * otherwise would be the most misleading thing this component could do.
 *
 * A dropped connection offers Resume rather than restarting, and only the parts
 * that never stored are re-sent.
 */

const initialSnapshot: UploadSnapshot = Object.freeze({
  bytesUploaded: 0,
  error: null,
  intentId: null,
  partsCompleted: 0,
  partsTotal: 0,
  phase: "selecting",
  totalBytes: 0,
});

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const stageDescriptions: Readonly<Record<UploadSnapshot["phase"], string>> = Object.freeze({
  completing: "Finishing upload",
  completed: "Uploaded. Checking the video before it can be analysed.",
  error: "Upload stopped",
  paused: "Paused",
  reserving: "Preparing upload",
  selecting: "No video selected",
  uploading: "Uploading",
});

export function VideoUpload({ postId }: Readonly<{ postId: string }>) {
  const [snapshot, setSnapshot] = useState<UploadSnapshot>(initialSnapshot);
  const [fileName, setFileName] = useState<string | null>(null);
  const sessionRef = useRef<UploadSession | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const percent =
    snapshot.totalBytes === 0
      ? 0
      : Math.min(100, Math.round((snapshot.bytesUploaded / snapshot.totalBytes) * 100));

  const startUpload = useCallback(
    async (file: File) => {
      const session = createUploadSession({
        file,
        fileType: file.type,
        onChange: setSnapshot,
        postId,
      });

      sessionRef.current = session;
      await session.start();
    },
    [postId],
  );

  const onSelect = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];

      if (!file) return;

      // The display name is shown but never becomes part of the object key.
      setFileName(file.name);
      void startUpload(file);
    },
    [startUpload],
  );

  const isBusy = snapshot.phase === "uploading" || snapshot.phase === "reserving";
  const canResume = snapshot.phase === "paused" || snapshot.phase === "error";

  return (
    <section aria-labelledby="video-upload-heading" className="video-upload">
      <h2 id="video-upload-heading">Source video</h2>
      <p className="video-upload__limits">
        MP4, MOV or WebM, up to 1 GB. Large uploads need a stable connection and can be resumed if
        it drops.
      </p>

      <label className="video-upload__choose" htmlFor="video-upload-input">
        Choose a video
      </label>
      <input
        accept={[...acceptedVideoContentTypes, ...acceptedVideoFileExtensions].join(",")}
        disabled={isBusy || snapshot.phase === "completing"}
        id="video-upload-input"
        onChange={onSelect}
        ref={inputRef}
        type="file"
      />

      {fileName === null ? null : (
        <p className="video-upload__file">
          <span className="video-upload__file-name">{fileName}</span>
          {snapshot.totalBytes > 0 ? ` · ${formatBytes(snapshot.totalBytes)}` : null}
        </p>
      )}

      {/* Both stages are always named so "uploaded" is never mistaken for
          "ready to analyse". */}
      <ol className="video-upload__stages">
        <li
          className="video-upload__stage"
          data-state={snapshot.phase === "completed" ? "done" : "active"}
        >
          1. Upload
        </li>
        <li
          className="video-upload__stage"
          data-state={snapshot.phase === "completed" ? "active" : "waiting"}
        >
          2. Validation
        </li>
      </ol>

      <p className="video-upload__status" role="status">
        {stageDescriptions[snapshot.phase]}
        {snapshot.partsTotal > 0 && snapshot.phase !== "completed"
          ? ` · part ${Math.min(snapshot.partsCompleted + 1, snapshot.partsTotal)} of ${snapshot.partsTotal}`
          : null}
      </p>

      {snapshot.totalBytes === 0 ? null : (
        <div
          aria-label="Upload progress"
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={percent}
          className="video-upload__progress"
          role="progressbar"
        >
          <div className="video-upload__progress-fill" style={{ width: `${percent}%` }} />
          <span className="video-upload__progress-text">
            {formatBytes(snapshot.bytesUploaded)} of {formatBytes(snapshot.totalBytes)} ({percent}%)
          </span>
        </div>
      )}

      {snapshot.error === null ? null : (
        <p className="video-upload__error" role="alert">
          {snapshot.error}
        </p>
      )}

      <div className="video-upload__actions">
        {snapshot.phase === "uploading" ? (
          <button onClick={() => sessionRef.current?.pause()} type="button">
            Pause
          </button>
        ) : null}

        {canResume ? (
          <button onClick={() => void sessionRef.current?.resume()} type="button">
            Resume upload
          </button>
        ) : null}

        {snapshot.phase === "selecting" || snapshot.phase === "completed" ? null : (
          <button
            className="video-upload__cancel"
            onClick={() => {
              void sessionRef.current?.cancel().then(() => {
                setFileName(null);

                if (inputRef.current) inputRef.current.value = "";
              });
            }}
            type="button"
          >
            Cancel upload
          </button>
        )}
      </div>
    </section>
  );
}
