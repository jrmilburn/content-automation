export const serviceNames = ["web", "worker"] as const;

export {
  analysisContractArtifacts,
  analysisArtifactLifecycles,
  analysisModelRequested,
  analysisPromptText,
  analysisPromptVersion,
  analysisSchemaVersion,
  analysisTaxonomy,
  analysisValidationCodes,
  assertGeminiStructuredOutputSchema,
  createGeminiStructuredOutputSchema,
  geminiPostCreativeAnalysisV1Schema,
  postCreativeAnalysisV1Schema,
  validatePostCreativeAnalysisV1,
  type AnalysisObservation,
  type AnalysisArtifactLifecycle,
  type AnalysisValidationCode,
  type AnalysisValidationContext,
  type AnalysisValidationIssue,
  type AnalysisValidationResult,
  type PostCreativeAnalysisV1,
  type ProviderSchemaAcceptance,
} from "./analysis-contract.js";

export {
  evaluateGoogleOidcProfile,
  isAllowedRequestOrigin,
  oidcDenialReasons,
  resolveSafeReturnUrl,
  type GoogleOidcDecision,
  type GoogleOidcIdentity,
  type OidcDenialReason,
} from "./auth.js";
export {
  buildInstagramRedirectUri,
  createInstagramAuthorizationRequest,
  evaluateInstagramCallback,
  evaluateInstagramGrantedScopes,
  instagramApiVersion,
  instagramAuthorizeUrl,
  instagramConnectionDenialReasons,
  instagramEligibleAccountTypes,
  instagramGraphHost,
  instagramPkceSupported,
  instagramRequiredScopes,
  instagramStateByteLength,
  instagramStateCookieName,
  instagramStateLifetimeSeconds,
  instagramTokenUrl,
  isEligibleInstagramAccountType,
  isValidInstagramRedirectUri,
  openInstagramState,
  resolveTokenExpiry,
  sealInstagramState,
  type InstagramAccountType,
  type InstagramAuthorizationRequest,
  type InstagramCallbackDecision,
  type InstagramConnectionDenialReason,
  type InstagramSealedState,
  type InstagramStateRecord,
} from "./instagram-oauth.js";
export {
  classifyInstagramMedia,
  classifyInstagramResponse,
  hashInstagramMediaPayload,
  instagramBootstrapHorizonDays,
  instagramEphemeralUrlFields,
  instagramMaximumSyncPages,
  instagramMediaFields,
  instagramMediaKinds,
  instagramMediaPageSize,
  instagramMediaRejectionReasons,
  instagramReelProductType,
  instagramResponseClasses,
  instagramSyncTriggers,
  instagramUsageHeaders,
  normaliseInstagramMediaItem,
  parseInstagramRetryAfterMs,
  parseInstagramTimestamp,
  readInstagramMediaPage,
  summariseInstagramUsage,
  type InstagramMediaKind,
  type InstagramMediaNormalisation,
  type InstagramMediaPage,
  type InstagramMediaRejectionReason,
  type InstagramResponseClass,
  type InstagramSyncTrigger,
  type InstagramUsageObservation,
  type NormalisedInstagramMedia,
} from "./instagram-media.js";
export {
  classifyInstagramTokenResponse,
  evaluateInstagramTokenHealth,
  instagramConnectionBlocked,
  instagramRefreshTokenUrl,
  instagramTokenExpiryWarningDays,
  instagramTokenFailures,
  instagramTokenHealthStates,
  instagramTokenLifetimeDays,
  instagramTokenRefreshDueDays,
  instagramTokenRefreshGrantType,
  instagramTokenRefreshMinimumAgeSeconds,
  type InstagramTokenFailure,
  type InstagramTokenHealth,
  type InstagramTokenHealthState,
} from "./instagram-token.js";
export {
  createAvailableDashboardSection,
  dashboardAttentionPriorities,
  orderDashboardAttentionItems,
  type DashboardAction,
  type DashboardAttentionItem,
  type DashboardAttentionPriority,
  type DashboardAttentionSummary,
  type DashboardCoverageSummary,
  type DashboardIntegrationSummary,
  type DashboardMetric,
  type DashboardProcessingSummary,
  type DashboardSection,
  type DashboardStrategySummary,
  type DashboardSummary,
} from "./dashboard.js";
export {
  isQueueName,
  parseQueueJobEnvelope,
  queueDefinitions,
  queueVersionKey,
  type QueueHandler,
  type QueueHandlerContext,
  type QueueHandlerRegistration,
  type QueueJobEnvelope,
  type QueueName,
  type QueuePublisher,
  type QueuePublishResult,
  type VersionedQueue,
} from "./background-jobs.js";
export {
  assertJobTransition,
  backgroundJobStates,
  canTransitionJob,
  isSafeJobStage,
  isTerminalJobState,
  jobAttemptStates,
  terminalBackgroundJobStates,
  InvalidJobTransitionError,
  type BackgroundJobState,
  type JobAttemptState,
} from "./job-lifecycle.js";
export {
  classifyJobHandlerError,
  decideJobRetry,
  jobFailureClasses,
  JobHandlerFailure,
  jobNextActions,
  type JobFailure,
  type JobFailureClass,
  type JobNextAction,
  type JobRetryDecision,
} from "./job-retry.js";
export {
  createStrategyRecommendationFingerprint,
  geminiStrategyV1Schema,
  strategyContractArtifacts,
  strategyModelRequested,
  strategyPromptText,
  strategyPromptVersion,
  strategySchemaVersion,
  strategyTaxonomy,
  strategyV1Schema,
  strategyValidationCodes,
  validateStrategyV1,
  type StrategyClaimDimension,
  type StrategyEvidenceClass,
  type StrategyEvidenceRole,
  type StrategyEvidenceType,
  type StrategyManifestEvidence,
  type StrategyMode,
  type StrategyV1,
  type StrategyValidationCode,
  type StrategyValidationContext,
  type StrategyValidationIssue,
  type StrategyValidationResult,
} from "./strategy-contract.js";

export type ServiceName = (typeof serviceNames)[number];

export const healthKinds = ["live", "ready"] as const;

export type HealthKind = (typeof healthKinds)[number];

export type ServiceHealth = Readonly<{
  service: ServiceName;
  status: "ok";
  kind: HealthKind;
  checks: Readonly<{
    configuration?: "ok";
    process?: "ok";
  }>;
  timestamp: string;
}>;

export function createServiceHealth(
  service: ServiceName,
  kind: HealthKind,
  now: Date = new Date(),
): ServiceHealth {
  return {
    service,
    status: "ok",
    kind,
    checks: kind === "live" ? { process: "ok" } : { configuration: "ok" },
    timestamp: now.toISOString(),
  };
}
