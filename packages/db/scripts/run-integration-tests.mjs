import { spawnSync } from "node:child_process";
import process from "node:process";

const composeArguments = ["compose", "-f", "compose.db-test.yml"];
const dockerCommand = process.platform === "win32" ? "docker.exe" : "docker";
const npmCliPath = process.env.npm_execpath;

if (!npmCliPath) {
  throw new Error("npm_execpath is required; run this script through npm");
}
const testDatabaseUrl =
  "postgresql://studio_parallel_test:studio_parallel_test@127.0.0.1:55432/studio_parallel_test";
const testEnvironment = {
  ...process.env,
  APP_ENV: "test",
  DATABASE_URL: testDatabaseUrl,
  PROVIDER_MODE: "fake",
  PUBLIC_ORIGIN: "http://localhost:3000",
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
  run(process.execPath, [npmCliPath, "run", "db:generate"]);
  run(process.execPath, [npmCliPath, "run", "db:migrate:deploy"]);
  run(process.execPath, [npmCliPath, "run", "db:seed"]);
  run(process.execPath, [npmCliPath, "run", "db:drift:check"]);
  run(process.execPath, [npmCliPath, "run", "test:db:integration:existing"]);
} finally {
  run(dockerCommand, [...composeArguments, "down", "--volumes", "--remove-orphans"]);
}
