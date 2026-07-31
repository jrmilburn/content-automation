import { loadRuntimeConfig } from "@studio-parallel/config";

import { getFakeObjectStorage } from "../../../../lib/server/object-storage";

export const dynamic = "force-dynamic";

/**
 * Part sink for the fake object store. Never reachable with a real provider.
 *
 * The production upload path sends video bytes straight to the object store and
 * they never enter web memory. That is exactly what cannot happen without a
 * store, so local development and the browser test suite need somewhere for a
 * signed part URL to point. This route is that somewhere, and it is guarded
 * twice over: it refuses outside local, test and preview, and it refuses unless
 * PROVIDER_MODE is fake — a combination configuration already prevents from
 * occurring in staging or production.
 *
 * It exists only so the upload UI can be exercised end to end. It is not a
 * fallback, and nothing in the real path may ever route through it.
 */

const developmentEnvironments = new Set(["local", "test", "preview"]);

export async function PUT(request: Request): Promise<Response> {
  const config = loadRuntimeConfig();

  if (!developmentEnvironments.has(config.APP_ENV) || config.PROVIDER_MODE !== "fake") {
    return new Response(null, { status: 404 });
  }

  const storage = getFakeObjectStorage();

  if (storage === undefined) {
    return new Response(null, { status: 404 });
  }

  const url = new URL(request.url);
  const uploadId = url.searchParams.get("uploadId");
  const partNumber = Number(url.searchParams.get("partNumber"));

  if (uploadId === null || !Number.isSafeInteger(partNumber) || partNumber < 1) {
    return new Response(null, { status: 400 });
  }

  try {
    const body = new Uint8Array(await request.arrayBuffer());
    const etag = storage.putPart(uploadId, partNumber, body);

    return new Response(null, {
      headers: { ETag: `"${etag}"`, "Cache-Control": "no-store, max-age=0" },
      status: 200,
    });
  } catch {
    // An unknown upload id is the fake store's equivalent of an expired or
    // crafted signature.
    return new Response(null, { status: 403 });
  }
}
