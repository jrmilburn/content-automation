import { execFile } from "node:child_process";

/**
 * Wrapper around `ffprobe`, the only component in this system that parses
 * attacker-influenced bytes.
 *
 * Three rules hold here and are the reason this file exists separately from the
 * handler:
 *
 * 1. The probe is executed through `execFile` with an argument array, never a
 *    shell. A filename can therefore not be interpolated into a command line.
 * 2. It runs with an explicit wall-clock timeout and a bounded output buffer,
 *    so a crafted container cannot hold a worker slot open or exhaust memory
 *    through probe output.
 * 3. It is given `-protocol_whitelist file` so a container that embeds an HTTP
 *    or concat reference cannot make the probe fetch anything. ffprobe will
 *    happily follow such a reference otherwise, which would turn media
 *    validation into a server-side request forgery primitive.
 */

/** Detected shape of one media object, in the units this product stores. */
export type ProbedMedia = Readonly<{
  audioCodec: string | null;
  containerFormats: readonly string[];
  durationMs: number;
  heightPx: number;
  videoCodec: string;
  widthPx: number;
}>;

/** Why the probe could not produce a usable description. */
export type ProbeFailureReason = "UNDECODABLE" | "NO_VIDEO_STREAM" | "TIMED_OUT";

export type ProbeResult =
  Readonly<{ media: ProbedMedia; ok: true }> | Readonly<{ ok: false; reason: ProbeFailureReason }>;

export type MediaProbeLimits = Readonly<{
  maxOutputBytes: number;
  timeoutMs: number;
}>;

export type MediaProbe = Readonly<{
  probe(filePath: string, limits: MediaProbeLimits): Promise<ProbeResult>;
}>;

type FfprobeStream = Readonly<{
  codec_name?: unknown;
  codec_type?: unknown;
  duration?: unknown;
  height?: unknown;
  width?: unknown;
}>;

type FfprobeOutput = Readonly<{
  format?: Readonly<{ duration?: unknown; format_name?: unknown }>;
  streams?: readonly FfprobeStream[];
}>;

function readFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value !== "string") {
    return null;
  }

  const parsed = Number.parseFloat(value);

  return Number.isFinite(parsed) ? parsed : null;
}

function readCodecName(value: unknown): string | null {
  // Codec names are lowercase identifiers such as "h264". Anything else is a
  // probe surprise and is treated as unknown rather than stored.
  return typeof value === "string" && /^[a-z0-9_]{1,63}$/u.test(value) ? value : null;
}

/**
 * Splits ffprobe's `format_name`, which is a comma-separated list of every
 * format the demuxer matched rather than a single answer. An MP4 reports
 * "mov,mp4,m4a,3gp,3g2,mj2" and a WebM reports "matroska,webm", so callers must
 * compare against the set instead of expecting one name.
 */
function parseContainerFormats(value: unknown): readonly string[] {
  if (typeof value !== "string") {
    return Object.freeze([]);
  }

  return Object.freeze(
    value
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => /^[a-z0-9_]{1,63}$/u.test(entry)),
  );
}

export function interpretProbeOutput(raw: string): ProbeResult {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return Object.freeze({ ok: false, reason: "UNDECODABLE" });
  }

  if (typeof parsed !== "object" || parsed === null) {
    return Object.freeze({ ok: false, reason: "UNDECODABLE" });
  }

  const output = parsed as FfprobeOutput;
  const streams = Array.isArray(output.streams) ? output.streams : [];
  const video = streams.find((stream) => stream.codec_type === "video");

  // An object that demuxes but carries no video stream is a valid file and an
  // invalid source video, so it is reported distinctly from a parse failure.
  if (video === undefined) {
    return Object.freeze({ ok: false, reason: "NO_VIDEO_STREAM" });
  }

  const videoCodec = readCodecName(video.codec_name);
  const widthPx = readFiniteNumber(video.width);
  const heightPx = readFiniteNumber(video.height);

  // A video stream the probe cannot describe is not something downstream
  // analysis can act on, and guessing dimensions would be worse than refusing.
  if (videoCodec === null || widthPx === null || heightPx === null) {
    return Object.freeze({ ok: false, reason: "UNDECODABLE" });
  }

  // Container duration is authoritative when present; some streams omit their
  // own. A container that reports neither cannot be range-checked.
  const durationSeconds =
    readFiniteNumber(output.format?.duration) ?? readFiniteNumber(video.duration);

  if (durationSeconds === null) {
    return Object.freeze({ ok: false, reason: "UNDECODABLE" });
  }

  const audio = streams.find((stream) => stream.codec_type === "audio");

  return Object.freeze({
    media: Object.freeze({
      audioCodec: audio === undefined ? null : readCodecName(audio.codec_name),
      containerFormats: parseContainerFormats(output.format?.format_name),
      durationMs: Math.round(durationSeconds * 1000),
      heightPx: Math.trunc(heightPx),
      videoCodec,
      widthPx: Math.trunc(widthPx),
    }),
    ok: true,
  });
}

export function createFfprobeMediaProbe(command = "ffprobe"): MediaProbe {
  return Object.freeze({
    probe(filePath: string, limits: MediaProbeLimits): Promise<ProbeResult> {
      return new Promise<ProbeResult>((resolve, reject) => {
        execFile(
          command,
          [
            // Only the local file protocol. Without this a crafted container can
            // reference a remote URL and the probe will fetch it.
            "-protocol_whitelist",
            "file",
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            filePath,
          ],
          {
            encoding: "utf8",
            maxBuffer: limits.maxOutputBytes,
            shell: false,
            timeout: limits.timeoutMs,
            // Only PATH is passed through, so no inherited credential reaches a
            // process that parses untrusted input. PATH itself cannot be
            // dropped: without it the runtime cannot resolve a bare command
            // name and every probe fails as ENOENT.
            env: { PATH: process.env["PATH"] ?? "" },
          },
          (error, stdout) => {
            if (error === null) {
              resolve(interpretProbeOutput(stdout));
              return;
            }

            const failure = error as NodeJS.ErrnoException & {
              killed?: boolean;
              signal?: string | null;
            };

            // Checked before the resource-limit branch: a missing binary is a
            // deployment fault, not a verdict about the media, and must never
            // be recorded as a rejected asset.
            if (failure.code === "ENOENT") {
              reject(new Error("ffprobe is not available in this image"));
              return;
            }

            // A timeout or an output overrun is a resource-limit stop, so it
            // stays distinguishable from a decode failure. `signal` is compared
            // against both nullish forms: a normal non-zero exit reports null,
            // but a spawn failure leaves it undefined, and treating undefined
            // as "was signalled" would misreport every such error as a timeout.
            if (
              failure.killed === true ||
              (failure.signal ?? null) !== null ||
              failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
            ) {
              resolve(Object.freeze({ ok: false, reason: "TIMED_OUT" }));
              return;
            }

            // A non-zero exit is ffprobe declining to decode the input.
            resolve(Object.freeze({ ok: false, reason: "UNDECODABLE" }));
          },
        );
      });
    },
  });
}
