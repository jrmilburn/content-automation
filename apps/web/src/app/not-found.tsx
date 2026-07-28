import Link from "next/link";

export default function NotFound() {
  return (
    <main className="boundary-page">
      <div className="boundary-panel">
        <p className="page-location">Not found</p>
        <h1>This page is not available</h1>
        <p>The address may be incorrect, or the resource is not available in this workspace.</p>
        <Link className="button button--primary" href="/">
          Return to dashboard
        </Link>
      </div>
    </main>
  );
}
