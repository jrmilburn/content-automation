"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";

import { formatJobDate } from "../lib/job-diagnostics";
import { StatusBadge } from "./status-badge";

const pollIntervalMs = 15_000;
const staleAfterMs = 45_000;

export function JobLiveRefresh({
  fingerprint,
  generatedAt,
}: Readonly<{ fingerprint: string; generatedAt: string }>) {
  const router = useRouter();
  const previousFingerprint = useRef(fingerprint);
  const [announcement, setAnnouncement] = useState("");
  const [isPending, startTransition] = useTransition();
  const [isStale, setIsStale] = useState(false);

  function refresh() {
    startTransition(() => router.refresh());
  }

  useEffect(() => {
    const interval = window.setInterval(refresh, pollIntervalMs);
    return () => window.clearInterval(interval);
  });

  useEffect(() => {
    setIsStale(false);
    const elapsed = Math.max(0, Date.now() - new Date(generatedAt).getTime());
    const timeout = window.setTimeout(() => setIsStale(true), Math.max(0, staleAfterMs - elapsed));
    return () => window.clearTimeout(timeout);
  }, [generatedAt]);

  useEffect(() => {
    if (previousFingerprint.current !== fingerprint) {
      previousFingerprint.current = fingerprint;
      setAnnouncement("Job information changed after refresh.");
    }
  }, [fingerprint]);

  return (
    <div className="operations-refresh">
      <div className="operations-refresh__status">
        <StatusBadge tone={isStale ? "warning" : "neutral"}>
          {isStale ? "Update delayed" : "Live"}
        </StatusBadge>
        <span>
          Checked <time dateTime={generatedAt}>{formatJobDate(generatedAt)}</time>
        </span>
      </div>
      <button
        className="button button--secondary operations-refresh__button"
        disabled={isPending}
        onClick={refresh}
        type="button"
      >
        {isPending ? "Refreshing…" : "Refresh now"}
      </button>
      <p aria-atomic="true" aria-live="polite" className="visually-hidden">
        {announcement}
      </p>
    </div>
  );
}
