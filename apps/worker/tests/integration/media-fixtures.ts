import { execFile } from "node:child_process";
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

/**
 * Builds real media with ffmpeg for the validation suite.
 *
 * The fixtures are generated rather than committed. Binary media in git is
 * heavy, opaque to review and impossible to adjust without a new blob, and
 * every property these tests assert on — codec, container, duration, dimensions
 * — is exactly what the generating command already states out loud.
 *
 * Generation uses ffmpeg; validation uses ffprobe. They ship together, so a
 * machine that can build the fixtures can also probe them.
 */

const run = promisify(execFile);

export type MediaFixtures = Readonly<{
  dispose(): Promise<void>;
  path(name: string): string;
}>;

// Small and short. These exist to exercise branches, not to look like content,
// and every extra pixel is time on every run.
const width = 320;
const height = 568;
const seconds = 2;

async function ffmpeg(args: readonly string[]): Promise<void> {
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);
}

/** Colour bars plus a tone, which is enough for any probe to describe. */
function synthesisedInputs(duration = seconds): readonly string[] {
  return [
    "-f",
    "lavfi",
    "-i",
    `testsrc=size=${width}x${height}:rate=15:duration=${duration}`,
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=440:duration=${duration}`,
  ];
}

export async function createMediaFixtures(): Promise<MediaFixtures> {
  const directory = await mkdtemp(join(tmpdir(), "sp-fixtures-"));
  const path = (name: string): string => join(directory, name);

  // The supported shape: H.264 video, AAC audio, MP4 container.
  await ffmpeg([
    ...synthesisedInputs(),
    "-c:v",
    "libx264",
    "-c:a",
    "aac",
    "-pix_fmt",
    "yuv420p",
    "-shortest",
    path("supported.mp4"),
  ]);

  // Same policy, different family, so the WebM branch is covered too.
  await ffmpeg([
    ...synthesisedInputs(),
    "-c:v",
    "libvpx-vp9",
    "-c:a",
    "libopus",
    "-shortest",
    path("supported.webm"),
  ]);

  // Decodes cleanly and carries no video stream.
  await ffmpeg([
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=440:duration=${seconds}`,
    "-c:a",
    "aac",
    path("audio-only.m4a"),
  ]);

  // A codec outside the configured allow-list, in an accepted container.
  await ffmpeg([
    ...synthesisedInputs(),
    "-c:v",
    "mpeg4",
    "-c:a",
    "aac",
    "-shortest",
    path("unsupported-codec.mp4"),
  ]);

  // Below the configured dimension floor.
  await ffmpeg([
    "-f",
    "lavfi",
    "-i",
    `testsrc=size=64x64:rate=15:duration=${seconds}`,
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    path("tiny.mp4"),
  ]);

  // A real MP4 with its tail removed: the bytes start out valid, which is what
  // separates truncation from random rubbish.
  await ffmpeg([
    ...synthesisedInputs(),
    "-c:v",
    "libx264",
    "-c:a",
    "aac",
    "-pix_fmt",
    "yuv420p",
    "-shortest",
    path("truncated.mp4"),
  ]);
  await truncate(path("truncated.mp4"), 2048);

  // Not media at all, but carrying an accepted extension.
  await writeFile(path("not-media.mp4"), Buffer.from("this is not a video, it is prose\n"));

  // A ZIP header is the shape a polyglot commonly hides behind.
  await writeFile(
    path("polyglot.mp4"),
    Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(2048, 7)]),
  );

  await writeFile(path("empty.mp4"), Buffer.alloc(0));

  return Object.freeze({
    async dispose() {
      await rm(directory, { force: true, recursive: true });
    },
    path,
  });
}
