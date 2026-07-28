import { OperationalError } from "@studio-parallel/observability";

export type ConcurrencyPermit = () => void;

export type ProviderConcurrencyGate = Readonly<{
  acquire(provider: string, signal?: AbortSignal): Promise<ConcurrencyPermit>;
}>;

type PendingPermit = {
  provider: string;
  reject(error: OperationalError): void;
  resolve(permit: ConcurrencyPermit): void;
  signal?: AbortSignal;
};

const safeProviderPattern = /^[a-z][a-z0-9_]{0,63}$/u;

export function createProviderConcurrencyGate(options: {
  globalLimit: number;
  providerLimits: Readonly<Record<string, number>>;
}): ProviderConcurrencyGate {
  validateLimit(options.globalLimit);
  const providerLimits = new Map<string, number>();

  for (const [provider, limit] of Object.entries(options.providerLimits)) {
    if (!safeProviderPattern.test(provider)) throw concurrencyError("JOB_PROVIDER_INVALID");
    validateLimit(limit);
    providerLimits.set(provider, limit);
  }

  const activeByProvider = new Map<string, number>();
  const pending: PendingPermit[] = [];
  let activeGlobal = 0;

  const drain = (): void => {
    if (activeGlobal >= options.globalLimit) return;

    for (let index = 0; index < pending.length && activeGlobal < options.globalLimit;) {
      const request = pending[index];
      if (!request) break;
      if (request.signal?.aborted) {
        pending.splice(index, 1);
        request.reject(concurrencyError("JOB_CONCURRENCY_ABORTED"));
        continue;
      }

      const providerLimit = providerLimits.get(request.provider);
      const providerActive = activeByProvider.get(request.provider) ?? 0;
      if (providerLimit === undefined || providerActive >= providerLimit) {
        index += 1;
        continue;
      }

      pending.splice(index, 1);
      activeGlobal += 1;
      activeByProvider.set(request.provider, providerActive + 1);
      let released = false;
      request.resolve(() => {
        if (released) return;
        released = true;
        activeGlobal -= 1;
        const remaining = (activeByProvider.get(request.provider) ?? 1) - 1;
        if (remaining === 0) activeByProvider.delete(request.provider);
        else activeByProvider.set(request.provider, remaining);
        drain();
      });
    }
  };

  return Object.freeze({
    acquire(provider, signal) {
      if (!providerLimits.has(provider)) {
        return Promise.reject(concurrencyError("JOB_PROVIDER_UNCONFIGURED"));
      }
      if (signal?.aborted) {
        return Promise.reject(concurrencyError("JOB_CONCURRENCY_ABORTED"));
      }

      return new Promise<ConcurrencyPermit>((resolve, reject) => {
        const request: PendingPermit = { provider, reject, resolve };
        if (signal) request.signal = signal;
        pending.push(request);

        const abort = (): void => {
          const index = pending.indexOf(request);
          if (index === -1) return;
          pending.splice(index, 1);
          reject(concurrencyError("JOB_CONCURRENCY_ABORTED"));
        };
        signal?.addEventListener("abort", abort, { once: true });

        const originalResolve = request.resolve;
        request.resolve = (permit) => {
          signal?.removeEventListener("abort", abort);
          originalResolve(permit);
        };
        drain();
      });
    },
  });
}

function validateLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    throw concurrencyError("JOB_CONCURRENCY_LIMIT_INVALID");
  }
}

function concurrencyError(code: string): OperationalError {
  return new OperationalError({ code, errorClass: "conflict", statusCode: 409 });
}
