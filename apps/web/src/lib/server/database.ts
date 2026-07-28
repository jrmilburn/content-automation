import "server-only";

import { loadDatabaseConfig } from "@studio-parallel/config";
import { createDatabaseClient, type DatabaseClient } from "@studio-parallel/db";

let database: DatabaseClient | undefined;

export function getDatabase(): DatabaseClient {
  database ??= createDatabaseClient(loadDatabaseConfig().DATABASE_URL);
  return database;
}
