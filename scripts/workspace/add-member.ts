import { argv, env, exit } from "node:process";

import { loadDatabaseConfig } from "@studio-parallel/config";
import {
  createDatabaseClient,
  createWorkspaceContext,
  grantWorkspaceMember,
  type MemberRole,
} from "@studio-parallel/db";
import { createCorrelationId } from "@studio-parallel/observability";

/**
 * Grants a colleague access to the workspace.
 *
 * Sign-in is invite-only, and until now nothing outside the database seed could
 * create the row it requires — so a colleague on the approved domain was
 * refused with no way for an operator to fix it.
 *
 *   npm run workspace:member:add -- someone@studioparallel.au [admin]
 *
 * The target database is printed before anything is written, because this is
 * the same class of command as a migration: quietly acting on the wrong
 * database is worse than failing.
 */

function required(value: string | undefined, message: string): string {
  if (!value) {
    console.error(message);
    exit(1);
  }

  return value;
}

const email = required(argv[2], "usage: npm run workspace:member:add -- <email@domain> [admin]");
const role: MemberRole = argv[3]?.toLowerCase() === "admin" ? "ADMIN" : "MEMBER";
const approvedDomain = required(
  env["GOOGLE_WORKSPACE_DOMAIN"],
  "GOOGLE_WORKSPACE_DOMAIN is required. Add it to .env.vercel or export it.",
);

async function main(): Promise<void> {
  const databaseUrl = loadDatabaseConfig().DATABASE_URL;

  console.log(`target:   ${new URL(databaseUrl).host}`);
  console.log(`domain:   ${approvedDomain}`);
  console.log(`role:     ${role}`);

  const database = createDatabaseClient(databaseUrl);

  try {
    const workspaces = await database.workspace.findMany({ select: { id: true, name: true } });

    if (workspaces.length !== 1 || !workspaces[0]) {
      console.error(
        `Expected exactly one workspace, found ${workspaces.length}. Refusing to guess which one to grant access to.`,
      );
      exit(1);
    }

    console.log(`workspace: ${workspaces[0].name}`);

    const result = await grantWorkspaceMember(database, createWorkspaceContext(workspaces[0].id), {
      approvedDomain,
      correlationId: createCorrelationId(),
      email,
      role,
    });

    if (result.outcome === "wrong_domain") {
      console.error(
        `\n${result.email} is not on ${result.approvedDomain}. Only addresses on the approved Workspace domain can be granted access.`,
      );
      exit(1);
    }

    console.log(
      result.outcome === "granted"
        ? `\nGranted. ${result.email} can now sign in as ${result.role}.`
        : `\nAlready a member. ${result.email} is ${result.role}; nothing changed.`,
    );
  } finally {
    await database.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  exit(1);
});
