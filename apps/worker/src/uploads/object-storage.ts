import {
  loadObjectStorageCredentials,
  type ObjectStorageConfig,
  type RuntimeConfig,
} from "@studio-parallel/config";
import {
  createFakeObjectStorage,
  createS3ObjectStorageAdapter,
  type ObjectStorageAdapter,
} from "@studio-parallel/integrations";

/**
 * Builds the worker's object-storage adapter.
 *
 * Under PROVIDER_MODE=fake this is a different in-memory store from the web
 * process's, so a cleanup sweep here releases nothing the browser reserved
 * there. That is the honest behaviour rather than a defect: with no real
 * provider there are no parts to release, and pretending otherwise would make
 * the fake sweep look like it proved something. Real release behaviour is
 * exercised against MinIO in the storage integration suite.
 */
export function createWorkerObjectStorage(
  config: RuntimeConfig,
  storageConfig: ObjectStorageConfig,
): ObjectStorageAdapter {
  if (config.PROVIDER_MODE === "fake") {
    return createFakeObjectStorage({
      signedUrlTtlSeconds: storageConfig.UPLOAD_SIGNED_URL_TTL_SECONDS,
    }).adapter;
  }

  return createS3ObjectStorageAdapter({
    config: storageConfig,
    credentials: loadObjectStorageCredentials(),
  });
}
