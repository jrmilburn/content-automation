import { analysisModelRequested } from "@studio-parallel/domain";
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

// Instagram Login credentials are the Instagram app values from the Business
// login settings panel, not the Facebook app values from App settings > Basic.
// Sending the Facebook app id to the token endpoint fails as "Invalid platform
// app", so the id is constrained to the numeric form Meta issues.
const instagramOAuthConfigSchema = z.object({
  INSTAGRAM_APP_ID: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[0-9]+$/u, "must be the numeric Instagram app id"),
  INSTAGRAM_APP_SECRET: z
    .string()
    .trim()
    .min(32)
    .max(128)
    .regex(/^[A-Za-z0-9]+$/u, "must be the Instagram app secret"),
});

export type InstagramOAuthConfig = Readonly<z.infer<typeof instagramOAuthConfigSchema>>;

// Envelope encryption master key. Database administrators and backups must not
// hold this value, so it is supplied only through the deployment secret manager
// and never given a usable default.
const credentialEncryptionConfigSchema = z
  .object({
    CREDENTIAL_ENCRYPTION_KEY: z
      .string()
      .trim()
      .min(1)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/u, "must be base64"),
    CREDENTIAL_ENCRYPTION_KEY_VERSION: z.coerce.number().int().min(1).max(1_000_000).default(1),
  })
  .superRefine((config, context) => {
    // Buffer.from silently drops invalid base64 characters rather than
    // throwing, so the decoded length is the only reliable check.
    if (Buffer.from(config.CREDENTIAL_ENCRYPTION_KEY, "base64").length !== 32) {
      context.addIssue({
        code: "custom",
        path: ["CREDENTIAL_ENCRYPTION_KEY"],
        message: "must decode to exactly 32 bytes",
      });
    }
  });

export type CredentialEncryptionConfig = Readonly<z.infer<typeof credentialEncryptionConfigSchema>>;

const localStorageBucket = "local-source-video-not-live";

// Coercion is spelled out because z.coerce.boolean() treats the string "false"
// as true, which would silently enable path-style addressing against a real
// provider.
const storageBooleanSchema = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

// Bucket, region and endpoint identify a private S3-compatible store; they are
// safe deploy config rather than secrets. Credentials load separately so a
// process that only needs to know the bucket never touches key material.
const objectStorageConfigSchema = z
  .object({
    APP_ENV: z.enum(["local", "test", "preview", "staging", "production"]).default("local"),
    STORAGE_BUCKET: z
      .string()
      .trim()
      .min(3)
      .max(63)
      .regex(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/u, "must be a valid bucket name")
      .default(localStorageBucket),
    // R2 issues "auto"; AWS issues a named region. Both are opaque here.
    STORAGE_REGION: z.string().trim().min(1).max(64).default("auto"),
    // Absent means AWS S3's own endpoint. R2, MinIO and other compatible
    // providers supply one.
    STORAGE_ENDPOINT: z.url().optional(),
    // MinIO and some compatible providers cannot serve virtual-host addressing.
    STORAGE_FORCE_PATH_STYLE: storageBooleanSchema,
    // 1 GiB product cap from docs/technical/video-ingestion.md.
    UPLOAD_MAX_BYTES: z.coerce.number().int().min(1).max(5_497_558_138_880).default(1_073_741_824),
    // S3 requires every part except the last to be at least 5 MiB and allows at
    // most 10,000 parts.
    UPLOAD_PART_SIZE_BYTES: z.coerce
      .number()
      .int()
      .min(5_242_880)
      .max(5_368_709_120)
      .default(8_388_608),
    // 15-minute signed operations from docs/technical/video-ingestion.md.
    UPLOAD_SIGNED_URL_TTL_SECONDS: z.coerce.number().int().min(60).max(3_600).default(900),
    // Abandoned multipart uploads are swept after 24 hours.
    UPLOAD_ABANDON_AFTER_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  })
  .superRefine((config, context) => {
    const partsRequired = Math.ceil(config.UPLOAD_MAX_BYTES / config.UPLOAD_PART_SIZE_BYTES);

    if (partsRequired > 10_000) {
      context.addIssue({
        code: "custom",
        path: ["UPLOAD_PART_SIZE_BYTES"],
        message: "must allow UPLOAD_MAX_BYTES to be uploaded in at most 10000 parts",
      });
    }

    if (config.APP_ENV !== "staging" && config.APP_ENV !== "production") {
      return;
    }

    if (config.STORAGE_BUCKET === localStorageBucket) {
      context.addIssue({
        code: "custom",
        path: ["STORAGE_BUCKET"],
        message: "must be the deployed private bucket",
      });
    }

    if (config.STORAGE_ENDPOINT === undefined) {
      return;
    }

    let endpoint: URL;

    try {
      endpoint = new URL(config.STORAGE_ENDPOINT);
    } catch {
      return;
    }

    if (endpoint.protocol !== "https:") {
      context.addIssue({
        code: "custom",
        path: ["STORAGE_ENDPOINT"],
        message: "must use HTTPS in staging and production",
      });
    }
  });

export type ObjectStorageConfig = Readonly<z.infer<typeof objectStorageConfigSchema>>;

// Codec and container names arrive as lowercase comma-separated lists so a
// deployment can narrow or widen the accepted set without a code change, which
// is what docs/technical/video-ingestion.md means by configuration owning the
// validation policy.
const codecListSchema = (fallback: string) =>
  z
    .string()
    .trim()
    .default(fallback)
    .transform((value) =>
      Object.freeze(
        value
          .split(",")
          .map((entry) => entry.trim().toLowerCase())
          .filter((entry) => entry.length > 0),
      ),
    )
    .refine((entries) => entries.length > 0, "must list at least one accepted value");

// Validation limits live only in the worker: the web image never decodes media.
// Defaults are the launch policy from docs/technical/video-ingestion.md and are
// deliberately narrower than what Gemini accepts, so a format only widens once
// a fixture proves the deployed probe handles it.
const mediaValidationConfigSchema = z
  .object({
    // 20-minute product cap. The floor rejects zero-length and single-frame
    // objects that decode but carry no analysable content.
    MEDIA_MAX_DURATION_SECONDS: z.coerce.number().int().min(1).max(21_600).default(1_200),
    MEDIA_MIN_DURATION_SECONDS: z.coerce.number().int().min(0).max(3_600).default(1),
    MEDIA_MIN_DIMENSION_PX: z.coerce.number().int().min(1).max(16_384).default(128),
    MEDIA_MAX_DIMENSION_PX: z.coerce.number().int().min(1).max(16_384).default(8_192),
    MEDIA_ALLOWED_VIDEO_CODECS: codecListSchema("h264,hevc,vp9,av1"),
    // Audio is optional; when present it must still be one of these.
    MEDIA_ALLOWED_AUDIO_CODECS: codecListSchema("aac,opus"),
    // The probe parses attacker-influenced bytes, so it runs under an explicit
    // wall-clock and output ceiling rather than inheriting the process default.
    MEDIA_PROBE_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(30_000),
    MEDIA_PROBE_MAX_OUTPUT_BYTES: z.coerce
      .number()
      .int()
      .min(1_024)
      .max(16_777_216)
      .default(1_048_576),
  })
  .superRefine((config, context) => {
    if (config.MEDIA_MIN_DURATION_SECONDS > config.MEDIA_MAX_DURATION_SECONDS) {
      context.addIssue({
        code: "custom",
        path: ["MEDIA_MIN_DURATION_SECONDS"],
        message: "must not exceed MEDIA_MAX_DURATION_SECONDS",
      });
    }

    if (config.MEDIA_MIN_DIMENSION_PX > config.MEDIA_MAX_DIMENSION_PX) {
      context.addIssue({
        code: "custom",
        path: ["MEDIA_MIN_DIMENSION_PX"],
        message: "must not exceed MEDIA_MAX_DIMENSION_PX",
      });
    }
  });

export type MediaValidationConfig = Readonly<z.infer<typeof mediaValidationConfigSchema>>;

// Gemini host, model and budgets are safe deploy config. The key loads
// separately, so a deployment that only ever runs the worker's jobs is not
// obliged to hold it. The web application now does call Gemini, for the
// assistant and only for the assistant: a chat turn is seconds of text, not
// minutes of video, and queueing it would make a conversation arrive one poll
// at a time. Everything else the model is asked still belongs to the worker.
/**
 * The shape every Gemini model id must take, wherever it is configured.
 *
 * A factory rather than a shared instance so each field owns its own optional
 * and default handling, and so an override cannot be given weaker validation
 * than the model it overrides.
 */
function geminiModelId() {
  return z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9.-]*$/u, "must be a model id")
    .refine(
      (value) => !value.includes("latest"),
      "must be an exact version, never a moving alias",
    );
}

const geminiConfigSchema = z
  .object({
    APP_ENV: z.enum(["local", "test", "preview", "staging", "production"]).default("local"),
    GEMINI_API_HOST: z.url().default("https://generativelanguage.googleapis.com"),
    // An exact stable ID. A moving alias would silently change the model behind
    // a stored analysis, so `latest` is refused rather than merely discouraged.
    GEMINI_MODEL: geminiModelId().default(analysisModelRequested),
    // Per-feature overrides, both unset by default so every call uses
    // `GEMINI_MODEL` until one is deliberately pointed elsewhere.
    //
    // They exist so trying a different model is a configuration change rather
    // than a code change. Analysis deliberately has no override: it is the one
    // call whose output is stored, compared across months and re-read by every
    // later strategy, so changing its model silently would make two analyses
    // in the same comparison incomparable. Strategy and chat both read stored
    // work and produce something a person reads once.
    //
    // Same guards as `GEMINI_MODEL`, including the refusal of `latest`, for the
    // same reason: an override is exactly where a moving alias would be most
    // tempting and least visible.
    //
    // The two are recorded differently, and the asymmetry is structural rather
    // than an oversight. A chat turn runs in the process that holds this
    // config, so `chat_messages.model_requested` records the override. A
    // strategy's row is frozen by the web app at request time and the call is
    // made later by the worker, so the requesting process cannot know which
    // model the worker will use; `strategy_generations.model_requested` keeps
    // the contract default and `model_version` — what the provider says it
    // actually ran — is the field to read when a strategy override is in force.
    GEMINI_CHAT_MODEL: geminiModelId().optional(),
    GEMINI_STRATEGY_MODEL: geminiModelId().optional(),
    // The proofs return a full analysis inside 32k; a smaller ceiling truncates
    // the contract rather than saving money.
    GEMINI_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(1_024).max(65_536).default(32_000),
    // A video upload is minutes of transfer; a model call is seconds of wait.
    GEMINI_UPLOAD_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(1_800_000).default(600_000),
    GEMINI_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(900_000).default(300_000),
    // A conversation waits differently from a job. Nobody watches a strategy
    // generate, so five minutes there costs nothing; a person sitting in front
    // of a chat has decided it is broken long before that, and a request they
    // have already given up on is one this product is still paying for.
    //
    // Sized to fire inside the route's own 60s ceiling rather than level with
    // it, leaving room for the write that follows. A timeout this product
    // raises records a failed turn the reader can see; one the platform raises
    // kills the request between the question and the answer and records
    // nothing.
    GEMINI_CHAT_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(300_000).default(45_000),
    // Not the reply length. The model reasons before it writes and both are
    // billed against this one ceiling, so a limit sized for the answer alone
    // stops the reasoning mid-thought and returns a truncated response with no
    // answer in it at all. That is what 2048 did: every turn spent its whole
    // budget thinking and came back empty.
    //
    // The reply is bounded where it can be bounded honestly — `chatReplyV1Schema`
    // caps it at 4000 characters and validation rejects anything longer. This
    // number exists to leave room to think, so it matches the ceiling analysis
    // and strategy have always used rather than trying to be frugal.
    GEMINI_CHAT_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(1_024).max(32_768).default(32_000),
    GEMINI_FILE_POLL_INTERVAL_MS: z.coerce.number().int().min(250).max(60_000).default(2_000),
    GEMINI_FILE_POLL_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(600).default(60),
    // One concurrent video per project by default. Gemini bills per token and a
    // burst of parallel analyses is the fastest way to spend unintentionally.
    GEMINI_PROJECT_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(1),
  })
  .superRefine((config, context) => {
    if (config.APP_ENV !== "staging" && config.APP_ENV !== "production") {
      return;
    }

    let host: URL;

    try {
      host = new URL(config.GEMINI_API_HOST);
    } catch {
      return;
    }

    if (host.protocol !== "https:") {
      context.addIssue({
        code: "custom",
        path: ["GEMINI_API_HOST"],
        message: "must use HTTPS in staging and production",
      });
    }
  });

export type GeminiConfig = Readonly<z.infer<typeof geminiConfigSchema>>;

// The Gemini key is never given a default, for the same reason storage keys are
// not: a misconfigured deployment must fail closed rather than bill an
// unintended project. Bounds only — a format regex would put the key's shape
// into a validation message.
const geminiCredentialsSchema = z.object({
  GEMINI_API_KEY: z.string().trim().min(1).max(256),
});

export type GeminiCredentials = Readonly<z.infer<typeof geminiCredentialsSchema>>;

// Storage keys are never given a usable default: a misconfigured deployment
// must fail closed rather than sign requests against an unintended account.
const objectStorageCredentialsSchema = z.object({
  STORAGE_ACCESS_KEY_ID: z.string().trim().min(1).max(128),
  STORAGE_SECRET_ACCESS_KEY: z.string().trim().min(1).max(256),
});

export type ObjectStorageCredentials = Readonly<z.infer<typeof objectStorageCredentialsSchema>>;

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

export function loadInstagramOAuthConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): InstagramOAuthConfig {
  const result = instagramOAuthConfigSchema.safeParse(environment);

  if (!result.success) {
    throw new ConfigurationError(result.error.issues);
  }

  return Object.freeze(result.data);
}

export function loadCredentialEncryptionConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): CredentialEncryptionConfig {
  const result = credentialEncryptionConfigSchema.safeParse(environment);

  if (!result.success) {
    throw new ConfigurationError(result.error.issues);
  }

  return Object.freeze(result.data);
}

export function loadObjectStorageConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ObjectStorageConfig {
  const result = objectStorageConfigSchema.safeParse(environment);

  if (!result.success) {
    throw new ConfigurationError(result.error.issues);
  }

  return Object.freeze(result.data);
}

export function loadObjectStorageCredentials(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ObjectStorageCredentials {
  const result = objectStorageCredentialsSchema.safeParse(environment);

  if (!result.success) {
    throw new ConfigurationError(result.error.issues);
  }

  return Object.freeze(result.data);
}

export function loadGeminiConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): GeminiConfig {
  const result = geminiConfigSchema.safeParse(environment);

  if (!result.success) {
    throw new ConfigurationError(result.error.issues);
  }

  return Object.freeze(result.data);
}

export function loadGeminiCredentials(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): GeminiCredentials {
  const result = geminiCredentialsSchema.safeParse(environment);

  if (!result.success) {
    throw new ConfigurationError(result.error.issues);
  }

  return Object.freeze(result.data);
}

export function loadMediaValidationConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): MediaValidationConfig {
  const result = mediaValidationConfigSchema.safeParse(environment);

  if (!result.success) {
    throw new ConfigurationError(result.error.issues);
  }

  return Object.freeze(result.data);
}
