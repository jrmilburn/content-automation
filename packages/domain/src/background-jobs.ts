export const queueDefinitions = [
  { name: "instagram.sync.account", version: 1 },
  { name: "instagram.snapshot.post", version: 1 },
  { name: "instagram.token.maintain", version: 1 },
  { name: "instagram.media.import", version: 1 },
  { name: "instagram.comments.post", version: 1 },
  { name: "asset.validate", version: 1 },
  { name: "asset.cleanup", version: 1 },
  { name: "analysis.run", version: 1 },
  { name: "analytics.recalculate", version: 1 },
  { name: "strategy.generate", version: 1 },
  { name: "system.reconcile", version: 1 },
] as const;

export type QueueName = (typeof queueDefinitions)[number]["name"];

/**
 * How long the queue will hold an undelivered or unfinished message.
 *
 * Shared with the reconciler rather than kept inside the queue adapter, because
 * it is the boundary between "in flight" and "gone". A dispatched job that no
 * worker has claimed is entirely normal below this age and unrecoverable above
 * it, and reconciliation that does not know the difference cannot tell a healthy
 * job from a stranded one.
 */
export const queueDeliveryExpirySeconds = 900;

export type VersionedQueue = Readonly<{
  name: QueueName;
  version: number;
}>;

export type QueueJobEnvelope = Readonly<{
  correlationId: string;
  domainJobId: string;
  handlerVersion: number;
  queueName: QueueName;
  workspaceId: string;
}>;

export type QueueHandlerContext = Readonly<{
  attempt: number;
  signal: AbortSignal;
}>;

export type QueueHandler = (
  envelope: QueueJobEnvelope,
  context: QueueHandlerContext,
) => Promise<void>;

export type QueueHandlerRegistration = Readonly<{
  handler: QueueHandler;
  queue: VersionedQueue;
}>;

export type QueuePublishResult = Readonly<{
  created: boolean;
  deliveryId: string;
}>;

export type QueuePublisher = Readonly<{
  publish(envelope: QueueJobEnvelope): Promise<QueuePublishResult>;
}>;

const queueNames = new Set<string>(queueDefinitions.map(({ name }) => name));
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function isQueueName(value: string): value is QueueName {
  return queueNames.has(value);
}

export function queueVersionKey(queue: VersionedQueue): string {
  return `${queue.name}.v${queue.version}`;
}

export function parseQueueJobEnvelope(value: unknown): QueueJobEnvelope | undefined {
  if (!isRecord(value) || Object.keys(value).length !== 5) return undefined;

  const { correlationId, domainJobId, handlerVersion, queueName, workspaceId } = value;

  if (
    typeof correlationId !== "string" ||
    !uuidPattern.test(correlationId) ||
    typeof domainJobId !== "string" ||
    !uuidPattern.test(domainJobId) ||
    typeof handlerVersion !== "number" ||
    !Number.isSafeInteger(handlerVersion) ||
    handlerVersion < 1 ||
    typeof queueName !== "string" ||
    !isQueueName(queueName) ||
    typeof workspaceId !== "string" ||
    !uuidPattern.test(workspaceId)
  ) {
    return undefined;
  }

  return Object.freeze({
    correlationId,
    domainJobId,
    handlerVersion,
    queueName,
    workspaceId,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
