import { describe, expect, it } from "vitest";

import { dedupeCollaboratorPosts } from "./analytics-cohorts.js";

/**
 * The one part of cohort loading that is not a query.
 *
 * Selection itself needs a database and is proved in the integration suite. The
 * dedupe is arithmetic on rows already read, and it is what stops a pooled
 * median counting one collaborator reel as two posts.
 */

function post(id: string, providerMediaId: string) {
  return { id, providerMediaId };
}

describe("dedupeCollaboratorPosts", () => {
  it("drops the second copy of a post two linked accounts both published", () => {
    const deduped = dedupeCollaboratorPosts([
      post("post-a", "media-1"),
      post("post-b", "media-1"),
      post("post-c", "media-2"),
    ]);

    expect(deduped.map((entry) => entry.id)).toEqual(["post-a", "post-c"]);
  });

  it("keeps the first copy, so which one survives does not vary between runs", () => {
    // The query orders totally, so keeping the first row makes a pooled cohort
    // and its fingerprint reproducible rather than planner-dependent.
    expect(
      dedupeCollaboratorPosts([post("post-b", "media-1"), post("post-a", "media-1")])[0]?.id,
    ).toBe("post-b");
  });

  it("leaves posts with distinct media ids alone, in the order they arrived", () => {
    const posts = [post("post-a", "media-1"), post("post-b", "media-2")];

    expect(dedupeCollaboratorPosts(posts)).toEqual(posts);
  });
});
