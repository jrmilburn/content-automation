import { loadDatabaseConfig } from "@studio-parallel/config";
import { queueDefinitions } from "@studio-parallel/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { enqueueBackgroundJob } from "../../src/background-jobs.js";
import { createDatabaseClient, type DatabaseClient } from "../../src/client.js";
import { createWorkspaceContext } from "../../src/workspace-context.js";

/**
 * That a declared queue can actually be enqueued.
 *
 * The queue allowlist is written down twice — `queueDefinitions` in the domain
 * package and a check constraint on each of the two tables an enqueue writes.
 * `instagram.media.import` reached the first without the second, and because the
 * in-process guard reads the domain list, nothing refused the request until
 * Postgres did. The enqueue reports a check violation as a generic dependency
 * failure with the constraint name discarded, so the only visible symptom was a
 * screen saying the video could not be requested.
 *
 * The sibling check in `migrations.test.ts` compares the two lists as text and
 * needs no database. This one runs the real insert against the real schema, so
 * it also fails when a migration exists but says the wrong thing.
 */

const databaseConfig = loadDatabaseConfig();
const workspaceId = "01900000-0000-7000-8000-000000000001";
const workspaceContext = createWorkspaceContext(workspaceId);
const correlationId = "01990000-0000-7000-8000-000000000130";

let database: DatabaseClient;

beforeAll(() => {
  database = createDatabaseClient(databaseConfig.DATABASE_URL);
});

beforeEach(async () => {
  await database.jobOutbox.deleteMany();
  await database.backgroundJob.deleteMany();
});

afterAll(async () => {
  await database.jobOutbox.deleteMany();
  await database.backgroundJob.deleteMany();
  await database.$disconnect();
});

describe("declared queues", () => {
  it.each(queueDefinitions.map(({ name }) => name))("accepts %s", async (queueName) => {
    const { created, job } = await enqueueBackgroundJob(database, workspaceContext, {
      correlationId,
      handlerVersion: 1,
      idempotencyKey: `declared-queue-${queueName}`,
      queueName,
    });

    expect(created).toBe(true);
    expect(job.queueName).toBe(queueName);
    // The outbox carries its own copy of the constraint, and the two rows are
    // written in one transaction: a job row alone would mean the second
    // constraint rejected the name and took the first row down with it.
    await expect(database.jobOutbox.count({ where: { backgroundJobId: job.id } })).resolves.toBe(1);
  });
});
