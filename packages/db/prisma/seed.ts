import "dotenv/config";

import { loadDatabaseConfig, loadRuntimeConfig } from "@studio-parallel/config";

import { createDatabaseClient } from "../src/client.js";
import { developmentWorkspace } from "../src/seed-data.js";

const runtimeConfig = loadRuntimeConfig();

if (runtimeConfig.APP_ENV !== "local" && runtimeConfig.APP_ENV !== "test") {
  throw new Error("The non-PII development seed is restricted to local and test environments");
}

const databaseConfig = loadDatabaseConfig();
const database = createDatabaseClient(databaseConfig.DATABASE_URL);

try {
  await database.$transaction(async (transaction) => {
    const otherWorkspaceCount = await transaction.workspace.count({
      where: { id: { not: developmentWorkspace.id } },
    });

    if (otherWorkspaceCount > 0) {
      throw new Error("Development seed refuses to run when another workspace exists");
    }

    await transaction.workspace.upsert({
      create: developmentWorkspace,
      update: {
        name: developmentWorkspace.name,
        timezone: developmentWorkspace.timezone,
      },
      where: { id: developmentWorkspace.id },
    });
  });
} finally {
  await database.$disconnect();
}
