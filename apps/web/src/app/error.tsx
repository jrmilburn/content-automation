"use client";

import { useEffect, useRef } from "react";

import { ErrorSummary } from "../components/states";

export default function RootError({ reset }: Readonly<{ error: Error; reset: () => void }>) {
  const containerRef = useRef<HTMLElement>(null);

  useEffect(() => {
    containerRef.current?.querySelector<HTMLElement>("h1")?.focus();
  }, []);

  return (
    <main className="boundary-page boundary-page--error" ref={containerRef}>
      <ErrorSummary
        description="The requested view could not be loaded. Stored workspace data is unchanged."
        headingLevel={1}
        title="This view did not load"
      />
      <button className="button button--primary" onClick={reset} type="button">
        Try again
      </button>
    </main>
  );
}
