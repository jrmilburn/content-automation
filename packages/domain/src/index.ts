export const serviceNames = ["web", "worker"] as const;

export type ServiceName = (typeof serviceNames)[number];

export type ServiceHealth = Readonly<{
  service: ServiceName;
  status: "ok";
  environment: string;
  timestamp: string;
}>;

export function createServiceHealth(
  service: ServiceName,
  environment: string,
  now: Date = new Date(),
): ServiceHealth {
  return {
    service,
    status: "ok",
    environment,
    timestamp: now.toISOString(),
  };
}
