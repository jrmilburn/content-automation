import {
  loadGeminiCredentials,
  type GeminiConfig,
  type RuntimeConfig,
} from "@studio-parallel/config";
import {
  createFakeGemini,
  createGeminiHttpAdapter,
  type GeminiAdapter,
} from "@studio-parallel/integrations";

/**
 * Chooses the Gemini transport for this deployment.
 *
 * Credentials load inside the live branch only, so a `PROVIDER_MODE=fake`
 * deployment never needs a paid key and the worker still boots without one. This
 * mirrors `createWorkerObjectStorage`; the shape is deliberate rather than
 * incidental, because the alternative is a worker that refuses to start over a
 * capability it may never be asked to use.
 */
export function createWorkerGeminiAdapter(
  config: RuntimeConfig,
  geminiConfig: GeminiConfig,
): GeminiAdapter {
  if (config.PROVIDER_MODE === "fake") {
    return createFakeGemini().adapter;
  }

  return createGeminiHttpAdapter({
    config: geminiConfig,
    credentials: loadGeminiCredentials(),
  });
}
