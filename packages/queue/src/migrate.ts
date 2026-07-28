import { loadDatabaseConfig } from "@studio-parallel/config";

import { migrateQueueSchema } from "./queue.js";

const { DATABASE_URL } = loadDatabaseConfig();
const status = await migrateQueueSchema(DATABASE_URL);

process.stdout.write(
  `${JSON.stringify({ event: "queue.schema_migrated", ...status, stage: "migration" })}\n`,
);
