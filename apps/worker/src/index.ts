import { loadRuntimeConfig } from "@studio-parallel/config";

import { createHealthServer } from "./health.js";

const config = loadRuntimeConfig();
const server = createHealthServer(config.APP_ENV);

server.listen(config.WORKER_HEALTH_PORT, () => {
  process.stdout.write(
    `${JSON.stringify({
      environment: config.APP_ENV,
      event: "worker.started",
      healthPort: config.WORKER_HEALTH_PORT,
      providerMode: config.PROVIDER_MODE,
      service: "worker",
    })}\n`,
  );
});

function shutDown(signal: NodeJS.Signals): void {
  process.stdout.write(
    `${JSON.stringify({
      event: "worker.stopping",
      service: "worker",
      signal,
    })}\n`,
  );

  server.close((error) => {
    if (error) {
      process.stderr.write(
        `${JSON.stringify({
          error: error.name,
          event: "worker.stop_failed",
          service: "worker",
        })}\n`,
      );
      process.exitCode = 1;
    }
  });
}

process.once("SIGINT", shutDown);
process.once("SIGTERM", shutDown);
