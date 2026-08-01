import { spawnSync } from "node:child_process";
import console from "node:console";
import process from "node:process";

/**
 * Runs the media validation suite against the real ffmpeg toolchain.
 *
 * There is no container to start: the tool under test is the one already in the
 * worker image. What this wrapper adds is a clear failure when it is missing,
 * because the alternative is a wall of ENOENT from inside a test body that
 * reads like the validation logic is broken.
 */

const npmCliPath = process.env.npm_execpath;

if (!npmCliPath) {
  throw new Error("npm_execpath is required; run this script through npm");
}

for (const tool of ["ffmpeg", "ffprobe"]) {
  const probe = spawnSync(tool, ["-version"], { shell: false, stdio: "ignore" });

  if (probe.error || probe.status !== 0) {
    console.error(
      `${tool} is required for the media validation suite but is not on PATH.\n` +
        "It ships in the worker image; install it locally with your package manager " +
        "(macOS: brew install ffmpeg, Debian/Ubuntu: apt-get install ffmpeg).",
    );
    process.exit(1);
  }
}

const result = spawnSync(process.execPath, [npmCliPath, "run", "test:media:integration:existing"], {
  cwd: process.cwd(),
  env: { ...process.env, APP_ENV: "test", PROVIDER_MODE: "fake" },
  shell: false,
  stdio: "inherit",
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
