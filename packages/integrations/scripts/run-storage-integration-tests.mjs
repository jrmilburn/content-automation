import { spawnSync } from "node:child_process";
import process from "node:process";

/**
 * Runs the storage adapter suite against a disposable MinIO.
 *
 * MinIO speaks the S3 protocol the adapter targets, so this is the only place
 * the real signing, multipart and abort paths are exercised. Unit tests use the
 * in-memory fake and cannot prove any of that: a fake agrees with whatever it
 * was written to agree with.
 */

const composeArguments = ["compose", "-f", "compose.storage-test.yml"];
const dockerCommand = process.platform === "win32" ? "docker.exe" : "docker";
const npmCliPath = process.env.npm_execpath;

if (!npmCliPath) {
  throw new Error("npm_execpath is required; run this script through npm");
}

const testEnvironment = {
  ...process.env,
  APP_ENV: "test",
  PROVIDER_MODE: "fake",
  STORAGE_ACCESS_KEY_ID: "studio_parallel_test",
  STORAGE_BUCKET: "studio-parallel-source-test",
  STORAGE_ENDPOINT: "http://127.0.0.1:59000",
  STORAGE_FORCE_PATH_STYLE: "true",
  STORAGE_REGION: "us-east-1",
  STORAGE_SECRET_ACCESS_KEY: "studio_parallel_test_secret",
};

function run(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    cwd: process.cwd(),
    env: testEnvironment,
    shell: false,
    stdio: "inherit",
    ...options,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`${command} ${arguments_.join(" ")} exited with ${result.status}`);
  }
}

try {
  run(dockerCommand, [...composeArguments, "down", "--volumes", "--remove-orphans"]);
  run(dockerCommand, [...composeArguments, "up", "--detach", "--wait"]);
  run(process.execPath, [npmCliPath, "run", "test:storage:integration:existing"]);
} finally {
  run(dockerCommand, [...composeArguments, "down", "--volumes", "--remove-orphans"]);
}
