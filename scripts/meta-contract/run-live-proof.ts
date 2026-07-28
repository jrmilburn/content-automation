import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  loadMetaContractConfiguration,
  runMetaContractProof,
  writeSanitizedProof,
} from "./meta-contract.js";

export async function runLiveMetaContractProof(
  environment: Readonly<Record<string, string | undefined>> = process.env,
) {
  const configuration = loadMetaContractConfiguration(environment);
  const proof = await runMetaContractProof(configuration);
  const outputPath = await writeSanitizedProof(proof, configuration.outputPath);

  console.log(`Sanitized Meta contract proof ${proof.status}: ${outputPath}`);
  if (proof.status !== "passed") process.exitCode = 1;
  return proof;
}

const invokedPath = process.argv[1];
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  runLiveMetaContractProof().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown Meta contract proof failure.";
    console.error(message);
    process.exitCode = 1;
  });
}
