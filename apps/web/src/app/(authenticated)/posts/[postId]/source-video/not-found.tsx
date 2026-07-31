import Link from "next/link";

import { PageHeader } from "../../../../../components/page-header";
import { ErrorSummary } from "../../../../../components/states";

/**
 * Shown when the post is absent, belongs to another workspace, or was never a
 * valid identifier. All three render identically and disclose nothing about
 * the post, so the page cannot be used to discover what exists elsewhere.
 */
export default function SourceVideoNotFound() {
  return (
    <div className="page-stack">
      <PageHeader
        action={
          <Link className="button button--secondary" href="/posts">
            Back to posts
          </Link>
        }
        description="Source video"
        title="Source video"
      />
      <ErrorSummary
        action={{ href: "/posts", label: "Return to posts" }}
        description="This post is unavailable in the current workspace. No post data was disclosed."
        title="Post not found"
      />
    </div>
  );
}
