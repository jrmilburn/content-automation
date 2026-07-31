import "server-only";

import {
  loadObjectStorageConfig,
  loadObjectStorageCredentials,
  loadRuntimeConfig,
  type ObjectStorageConfig,
} from "@studio-parallel/config";
import {
  createFakeObjectStorage,
  createS3ObjectStorageAdapter,
  type FakeObjectStorage,
  type ObjectStorageAdapter,
} from "@studio-parallel/integrations";

/**
 * Resolves the object-storage adapter for this process.
 *
 * PROVIDER_MODE decides which one is built, and configuration already refuses
 * "live" outside staging and production, so a local or preview deployment
 * cannot reach a real bucket even if storage keys are present in its
 * environment.
 *
 * The fake is held as a module singleton because its uploads live in memory:
 * rebuilding it between requests would drop parts a browser had already sent.
 */

let adapter: ObjectStorageAdapter | undefined;
let fake: FakeObjectStorage | undefined;

export function getObjectStorageConfig(): ObjectStorageConfig {
  return loadObjectStorageConfig();
}

export function isFakeObjectStorage(): boolean {
  return loadRuntimeConfig().PROVIDER_MODE === "fake";
}

/**
 * The in-memory store behind the fake adapter, for the development-only part
 * sink. Returns undefined when a real provider is configured, so the sink can
 * refuse to exist rather than accept bytes it would have to proxy.
 */
export function getFakeObjectStorage(): FakeObjectStorage | undefined {
  if (!isFakeObjectStorage()) {
    return undefined;
  }

  getObjectStorage();

  return fake;
}

export function getObjectStorage(): ObjectStorageAdapter {
  if (adapter !== undefined) {
    return adapter;
  }

  const config = loadObjectStorageConfig();

  if (isFakeObjectStorage()) {
    fake = createFakeObjectStorage({
      partUploadBaseUrl: `${loadRuntimeConfig().PUBLIC_ORIGIN}/api/uploads/fake-part`,
      signedUrlTtlSeconds: config.UPLOAD_SIGNED_URL_TTL_SECONDS,
    });
    adapter = fake.adapter;

    return adapter;
  }

  adapter = createS3ObjectStorageAdapter({
    config,
    credentials: loadObjectStorageCredentials(),
  });

  return adapter;
}
