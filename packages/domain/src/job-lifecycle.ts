export const backgroundJobStates = [
  "QUEUED",
  "PROCESSING",
  "RETRY_SCHEDULED",
  "SUCCEEDED",
  "FAILED_ATTENTION",
  "CANCELLED",
] as const;

export type BackgroundJobState = (typeof backgroundJobStates)[number];

export const jobAttemptStates = [
  "ACTIVE",
  "SUCCEEDED",
  "RETRY_SCHEDULED",
  "FAILED_ATTENTION",
  "LEASE_EXPIRED",
] as const;

export type JobAttemptState = (typeof jobAttemptStates)[number];

export const terminalBackgroundJobStates = ["SUCCEEDED", "FAILED_ATTENTION", "CANCELLED"] as const;

const allowedTransitions: Readonly<Record<BackgroundJobState, readonly BackgroundJobState[]>> = {
  CANCELLED: [],
  FAILED_ATTENTION: ["QUEUED"],
  PROCESSING: ["QUEUED", "RETRY_SCHEDULED", "SUCCEEDED", "FAILED_ATTENTION"],
  QUEUED: ["PROCESSING", "CANCELLED"],
  RETRY_SCHEDULED: ["QUEUED", "CANCELLED"],
  SUCCEEDED: [],
};

export class InvalidJobTransitionError extends Error {
  readonly code = "JOB_TRANSITION_INVALID";
  readonly from: BackgroundJobState;
  readonly to: BackgroundJobState;

  constructor(from: BackgroundJobState, to: BackgroundJobState) {
    super("JOB_TRANSITION_INVALID");
    this.name = "InvalidJobTransitionError";
    this.from = from;
    this.to = to;
  }
}

export function canTransitionJob(from: BackgroundJobState, to: BackgroundJobState): boolean {
  return allowedTransitions[from].includes(to);
}

export function assertJobTransition(from: BackgroundJobState, to: BackgroundJobState): void {
  if (!canTransitionJob(from, to)) throw new InvalidJobTransitionError(from, to);
}

export function isTerminalJobState(
  state: BackgroundJobState,
): state is (typeof terminalBackgroundJobStates)[number] {
  return terminalBackgroundJobStates.includes(
    state as (typeof terminalBackgroundJobStates)[number],
  );
}

const safeStagePattern = /^[a-z][a-z0-9_]{0,63}$/u;

export function isSafeJobStage(stage: string): boolean {
  return safeStagePattern.test(stage);
}
