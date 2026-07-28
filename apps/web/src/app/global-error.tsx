"use client";

export default function GlobalError({ reset }: Readonly<{ error: Error; reset: () => void }>) {
  return (
    <html lang="en">
      <body>
        <main className="boundary-page">
          <div className="boundary-panel">
            <p className="page-location">Workspace unavailable</p>
            <h1>The application could not start</h1>
            <p>Stored workspace data is unchanged. Try loading the application again.</p>
            <button className="button button--primary" onClick={reset} type="button">
              Try again
            </button>
          </div>
        </main>
      </body>
    </html>
  );
}
