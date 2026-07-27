import { z } from "zod";

const localEnvironments = new Set(["local", "test", "preview"]);

const runtimeConfigSchema = z
  .object({
    APP_ENV: z.enum(["local", "test", "preview", "staging", "production"]).default("local"),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    PROVIDER_MODE: z.enum(["fake", "live"]).default("fake"),
    PUBLIC_ORIGIN: z.url().default("http://localhost:3000"),
    WORKER_HEALTH_PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
  })
  .superRefine((config, context) => {
    if (localEnvironments.has(config.APP_ENV) && config.PROVIDER_MODE === "live") {
      context.addIssue({
        code: "custom",
        path: ["PROVIDER_MODE"],
        message: "must be fake in local, test and preview environments",
      });
    }

    if (config.APP_ENV === "staging" || config.APP_ENV === "production") {
      let origin: URL;

      try {
        origin = new URL(config.PUBLIC_ORIGIN);
      } catch {
        return;
      }

      if (origin.protocol !== "https:") {
        context.addIssue({
          code: "custom",
          path: ["PUBLIC_ORIGIN"],
          message: "must use HTTPS in staging and production",
        });
      }

      if (origin.hostname === "localhost" || origin.hostname === "127.0.0.1") {
        context.addIssue({
          code: "custom",
          path: ["PUBLIC_ORIGIN"],
          message: "must not use a loopback host in staging and production",
        });
      }
    }
  });

export type RuntimeConfig = Readonly<z.infer<typeof runtimeConfigSchema>>;

export class ConfigurationError extends Error {
  readonly fields: readonly string[];

  constructor(issues: readonly z.core.$ZodIssue[]) {
    const safeIssues = issues.map((issue) => ({
      field: issue.path.join(".") || "configuration",
      message: issue.message,
    }));
    super(
      `Invalid runtime configuration: ${safeIssues
        .map(({ field, message }) => `${field} ${message}`)
        .join("; ")}`,
    );
    this.name = "ConfigurationError";
    this.fields = safeIssues.map(({ field }) => field);
  }
}

export function loadRuntimeConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): RuntimeConfig {
  const result = runtimeConfigSchema.safeParse(environment);

  if (!result.success) {
    throw new ConfigurationError(result.error.issues);
  }

  return Object.freeze(result.data);
}
