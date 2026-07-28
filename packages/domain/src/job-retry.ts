export const jobFailureClasses = [
  "TRANSIENT",
  "RATE_LIMIT",
  "CREDENTIAL",
  "INVALID_INPUT",
  "SEMANTIC_OUTPUT",
  "DATABASE",
  "UNKNOWN",
] as const;

export type JobFailureClass = (typeof jobFailureClasses)[number];

export const jobNextActions = [
  "RETRY_AUTOMATIC",
  "RECONNECT_ACCOUNT",
  "REPLACE_INPUT",
  "REVIEW_OUTPUT",
  "CONTACT_SUPPORT",
] as const;

export type JobNextAction = (typeof jobNextActions)[number];

export type JobFailure = Readonly<{
  credentialRecoverable?: boolean;
  errorClass: JobFailureClass;
  errorCode: string;
  providerRetryAfterMs?: number;
}>;

export type JobRetryDecision =
  | Readonly<{
      delayMs: number;
      nextAction: "RETRY_AUTOMATIC";
      nextAttemptAt: Date;
      outcome: "RETRY";
    }>
  | Readonly<{
      nextAction: Exclude<JobNextAction, "RETRY_AUTOMATIC">;
      outcome: "FAILED_ATTENTION";
    }>;

export class JobHandlerFailure extends Error {
  readonly failure: JobFailure;

  constructor(failure: JobFailure) {
    super(normaliseErrorCode(failure.errorCode));
    this.name = "JobHandlerFailure";
    this.failure = Object.freeze({
      ...failure,
      errorCode: normaliseErrorCode(failure.errorCode),
      ...(isPositiveFinite(failure.providerRetryAfterMs)
        ? { providerRetryAfterMs: Math.floor(failure.providerRetryAfterMs) }
        : {}),
    });
  }
}

type RetryDecisionInput = Readonly<{
  attemptNumber: number;
  failure: JobFailure;
  jobCreatedAt: Date;
  maxAttempts: number;
  now: Date;
  random?: () => number;
}>;

const retryHorizonMs = 86_400_000;
const maximumAttemptsByClass: Readonly<Record<JobFailureClass, number>> = {
  CREDENTIAL: 2,
  DATABASE: 3,
  INVALID_INPUT: 1,
  RATE_LIMIT: 8,
  SEMANTIC_OUTPUT: 2,
  TRANSIENT: 5,
  UNKNOWN: 1,
};
const retryCaps: Readonly<Record<JobFailureClass, readonly number[]>> = {
  CREDENTIAL: [1_000],
  DATABASE: [1_000, 5_000],
  INVALID_INPUT: [],
  RATE_LIMIT: [30_000, 120_000, 600_000, 1_800_000, 7_200_000, 21_600_000, 43_200_000],
  SEMANTIC_OUTPUT: [1_000],
  TRANSIENT: [30_000, 120_000, 600_000, 1_800_000, 7_200_000],
  UNKNOWN: [],
};
const safeErrorCodePattern = /^[A-Z][A-Z0-9_]{0,63}$/u;

export function classifyJobHandlerError(error: unknown): JobFailure {
  if (error instanceof JobHandlerFailure) return error.failure;
  return Object.freeze({ errorClass: "UNKNOWN", errorCode: "JOB_HANDLER_FAILED" });
}

export function decideJobRetry(input: RetryDecisionInput): JobRetryDecision {
  const failure = normaliseFailure(input.failure);
  const terminalAction = terminalNextAction(failure);
  const caps = retryCaps[failure.errorClass];
  const classMaximumAttempts = maximumAttemptsByClass[failure.errorClass];
  const allowedAttempts = Math.min(input.maxAttempts, classMaximumAttempts);

  if (
    terminalAction ||
    !Number.isSafeInteger(input.attemptNumber) ||
    input.attemptNumber < 1 ||
    !Number.isSafeInteger(input.maxAttempts) ||
    input.maxAttempts < 1 ||
    input.attemptNumber >= allowedAttempts
  ) {
    return Object.freeze({
      nextAction: terminalAction ?? fallbackTerminalAction(failure.errorClass),
      outcome: "FAILED_ATTENTION",
    });
  }

  const cap = caps[input.attemptNumber - 1];
  if (cap === undefined) {
    return Object.freeze({
      nextAction: fallbackTerminalAction(failure.errorClass),
      outcome: "FAILED_ATTENTION",
    });
  }

  const random = clampRandom(input.random?.() ?? Math.random());
  const jitteredDelayMs = Math.max(1_000, Math.floor(cap * random));
  const providerDelayMs = isPositiveFinite(failure.providerRetryAfterMs)
    ? Math.floor(failure.providerRetryAfterMs)
    : 0;
  const delayMs = Math.max(jitteredDelayMs, providerDelayMs);
  const retryDeadline = input.jobCreatedAt.getTime() + retryHorizonMs;
  const nextAttemptAt = new Date(input.now.getTime() + delayMs);

  if (delayMs > retryHorizonMs || nextAttemptAt.getTime() > retryDeadline) {
    return Object.freeze({
      nextAction: fallbackTerminalAction(failure.errorClass),
      outcome: "FAILED_ATTENTION",
    });
  }

  return Object.freeze({
    delayMs,
    nextAction: "RETRY_AUTOMATIC",
    nextAttemptAt,
    outcome: "RETRY",
  });
}

function normaliseFailure(failure: JobFailure): JobFailure {
  return Object.freeze({
    ...failure,
    errorCode: normaliseErrorCode(failure.errorCode),
  });
}

function terminalNextAction(
  failure: JobFailure,
): Exclude<JobNextAction, "RETRY_AUTOMATIC"> | undefined {
  switch (failure.errorClass) {
    case "CREDENTIAL":
      return failure.credentialRecoverable === true ? undefined : "RECONNECT_ACCOUNT";
    case "INVALID_INPUT":
      return "REPLACE_INPUT";
    case "UNKNOWN":
      return "CONTACT_SUPPORT";
    default:
      return undefined;
  }
}

function fallbackTerminalAction(
  errorClass: JobFailureClass,
): Exclude<JobNextAction, "RETRY_AUTOMATIC"> {
  switch (errorClass) {
    case "CREDENTIAL":
      return "RECONNECT_ACCOUNT";
    case "INVALID_INPUT":
      return "REPLACE_INPUT";
    case "SEMANTIC_OUTPUT":
      return "REVIEW_OUTPUT";
    default:
      return "CONTACT_SUPPORT";
  }
}

function normaliseErrorCode(value: string): string {
  return safeErrorCodePattern.test(value) ? value : "JOB_HANDLER_FAILED";
}

function clampRandom(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(Math.max(value, 0), 1);
}

function isPositiveFinite(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
