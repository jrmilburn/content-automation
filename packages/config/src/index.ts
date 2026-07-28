import { z } from "zod";

const localEnvironments = new Set(["local", "test", "preview"]);
const localAuthDefaults = {
  clientId: "local-google-client.invalid",
  clientSecret: "local-google-secret-not-live",
  secret: "local-only-auth-secret-not-for-deployment-000000",
} as const;

const runtimeConfigSchema = z
  .object({
    APP_ENV: z.enum(["local", "test", "preview", "staging", "production"]).default("local"),
    APP_RELEASE: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u, "must be a safe release identifier")
      .default("development"),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    PROVIDER_MODE: z.enum(["fake", "live"]).default("fake"),
    PUBLIC_ORIGIN: z.url().default("http://localhost:3000"),
    QUEUE_DISPATCH_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(20),
    QUEUE_RECONCILE_INTERVAL_SECONDS: z.coerce.number().int().min(1).max(300).default(5),
    WORKER_HEALTH_PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
    WORKER_SHUTDOWN_GRACE_SECONDS: z.coerce.number().int().min(1).max(300).default(30),
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

const databaseConfigSchema = z
  .object({
    DATABASE_URL: z.url(),
  })
  .superRefine((config, context) => {
    let url: URL;

    try {
      url = new URL(config.DATABASE_URL);
    } catch {
      return;
    }

    if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
      context.addIssue({
        code: "custom",
        path: ["DATABASE_URL"],
        message: "must use the postgres or postgresql protocol",
      });
    }
  });

export type DatabaseConfig = Readonly<z.infer<typeof databaseConfigSchema>>;

const authConfigSchema = z
  .object({
    APP_ENV: z.enum(["local", "test", "preview", "staging", "production"]).default("local"),
    AUTH_GOOGLE_ID: z.string().trim().min(1).max(255).default(localAuthDefaults.clientId),
    AUTH_GOOGLE_SECRET: z.string().trim().min(1).max(512).default(localAuthDefaults.clientSecret),
    AUTH_SECRET: z.string().min(32).max(512).default(localAuthDefaults.secret),
    AUTH_SESSION_MAX_AGE_SECONDS: z.coerce.number().int().min(900).max(86_400).default(28_800),
    GOOGLE_WORKSPACE_DOMAIN: z
      .string()
      .trim()
      .toLowerCase()
      .regex(
        /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u,
        "must be a valid lower-case domain",
      )
      .default("example.invalid"),
    PUBLIC_ORIGIN: z.url().default("http://localhost:3000"),
  })
  .superRefine((config, context) => {
    if (config.APP_ENV === "staging" || config.APP_ENV === "production") {
      for (const [field, value, placeholder] of [
        ["AUTH_GOOGLE_ID", config.AUTH_GOOGLE_ID, localAuthDefaults.clientId],
        ["AUTH_GOOGLE_SECRET", config.AUTH_GOOGLE_SECRET, localAuthDefaults.clientSecret],
        ["AUTH_SECRET", config.AUTH_SECRET, localAuthDefaults.secret],
      ] as const) {
        if (value === placeholder) {
          context.addIssue({
            code: "custom",
            path: [field],
            message: "must be supplied by the deployment secret manager",
          });
        }
      }

      if (config.GOOGLE_WORKSPACE_DOMAIN === "example.invalid") {
        context.addIssue({
          code: "custom",
          path: ["GOOGLE_WORKSPACE_DOMAIN"],
          message: "must be the approved Workspace domain",
        });
      }

      let publicOrigin: URL;

      try {
        publicOrigin = new URL(config.PUBLIC_ORIGIN);
      } catch {
        return;
      }

      if (publicOrigin.protocol !== "https:") {
        context.addIssue({
          code: "custom",
          path: ["PUBLIC_ORIGIN"],
          message: "must use HTTPS in staging and production",
        });
      }

      if (publicOrigin.hostname === "localhost" || publicOrigin.hostname === "127.0.0.1") {
        context.addIssue({
          code: "custom",
          path: ["PUBLIC_ORIGIN"],
          message: "must not use a loopback host in staging and production",
        });
      }
    }

    let publicOrigin: URL;

    try {
      publicOrigin = new URL(config.PUBLIC_ORIGIN);
    } catch {
      return;
    }

    if (
      publicOrigin.pathname !== "/" ||
      publicOrigin.search ||
      publicOrigin.hash ||
      publicOrigin.username ||
      publicOrigin.password
    ) {
      context.addIssue({
        code: "custom",
        path: ["PUBLIC_ORIGIN"],
        message: "must contain only the public scheme, host and optional port",
      });
    }
  });

export type AuthConfig = Readonly<z.infer<typeof authConfigSchema>>;

const metaWebhookConfigSchema = z.object({
  META_WEBHOOK_VERIFY_TOKEN: z
    .string()
    .min(32)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/u, "must be a URL-safe secret"),
});

export type MetaWebhookConfig = Readonly<z.infer<typeof metaWebhookConfigSchema>>;

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

export function loadDatabaseConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): DatabaseConfig {
  const result = databaseConfigSchema.safeParse(environment);

  if (!result.success) {
    throw new ConfigurationError(result.error.issues);
  }

  return Object.freeze(result.data);
}

export function loadAuthConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): AuthConfig {
  const result = authConfigSchema.safeParse(environment);

  if (!result.success) {
    throw new ConfigurationError(result.error.issues);
  }

  return Object.freeze(result.data);
}

export function loadMetaWebhookConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): MetaWebhookConfig {
  const result = metaWebhookConfigSchema.safeParse(environment);

  if (!result.success) {
    throw new ConfigurationError(result.error.issues);
  }

  return Object.freeze(result.data);
}
