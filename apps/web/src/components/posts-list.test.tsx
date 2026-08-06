// @vitest-environment jsdom
import type { InstagramPostListItem } from "@studio-parallel/db";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { PostsFilterValues } from "../lib/posts-list";
import type { PostsSnapshot } from "../lib/server/posts-data";

// Both controls reach a server action, and through it next-auth, which does not
// load under jsdom. What is tested here is which card offers which of them; the
// controls' own behaviour is tested where they live.
vi.mock("./instagram-video-import-button", () => ({
  InstagramVideoImportButton: ({
    context,
    postId,
  }: Readonly<{ context?: string; postId: string }>) => (
    <button data-context={context} data-post={postId} type="button">
      Use the Instagram video
    </button>
  ),
}));

vi.mock("./analysis-request-control", () => ({
  AnalysisRequestControl: ({ context, postId }: Readonly<{ context?: string; postId: string }>) => (
    <button data-context={context} data-post={postId} type="button">
      Analyse this video
    </button>
  ),
}));

const { PostsError, PostsList } = await import("./posts-list");

const accountId = "019a0000-0000-7000-8000-000000000301";

function post(overrides: Partial<InstagramPostListItem> = {}): InstagramPostListItem {
  return {
    caption: "Three lighting mistakes that flatten a product shot.",
    id: "019a0000-0000-7000-8000-000000000401",
    instagramAccountId: accountId,
    lastImportedAt: "2026-07-31T02:00:00.000Z",
    mediaKind: "REEL",
    mediaProductType: "REELS",
    mediaType: "VIDEO",
    permalink: "https://www.instagram.com/reel/abc123/",
    providerThumbnailUrl: "https://scontent.example/signed.jpg",
    publishedAt: "2026-07-29T22:15:00.000Z",
    sourceVideoState: "NONE",
    ...overrides,
  };
}

function values(overrides: Partial<PostsFilterValues> = {}): PostsFilterValues {
  return { account: "", from: "", kind: "all", search: "", to: "", ...overrides };
}

function snapshot(overrides: Partial<PostsSnapshot> = {}): PostsSnapshot {
  return {
    accounts: [{ id: accountId, label: "@studioparallel" }],
    hasAccount: true,
    list: {
      generatedAt: "2026-07-31T03:00:00.000Z",
      nextCursor: null,
      posts: [post()],
      totalCount: 1,
    },
    ...overrides,
  };
}

function emptyList(nextCursor: string | null = null) {
  return { generatedAt: "2026-07-31T03:00:00.000Z", nextCursor, posts: [], totalCount: 0 };
}

/** Posts live under `list`, so this keeps a caller from nesting them wrongly. */
function withPosts(...posts: readonly InstagramPostListItem[]): PostsSnapshot {
  return snapshot({ list: { ...emptyList(), posts: [...posts], totalCount: posts.length } });
}

describe("PostsList empty states", () => {
  it("distinguishes no connected account and points at the integration screen", () => {
    render(
      <PostsList
        snapshot={snapshot({ accounts: [], hasAccount: false, list: emptyList() })}
        values={values()}
      />,
    );

    expect(screen.getByRole("heading", { name: "No Instagram account connected" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Connect Instagram account" })).toHaveAttribute(
      "href",
      "/settings/integrations",
    );
    // Filters would be meaningless with nothing to filter.
    expect(screen.queryByRole("button", { name: "Apply filters" })).toBeNull();
  });

  it("distinguishes a connected account that has imported nothing yet", () => {
    render(<PostsList snapshot={snapshot({ list: emptyList() })} values={values()} />);

    expect(screen.getByRole("heading", { name: "No posts imported yet" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Apply filters" })).toBeVisible();
  });

  it("distinguishes no filter matches and offers to clear them", () => {
    render(
      <PostsList
        snapshot={snapshot({ list: emptyList() })}
        values={values({ search: "nothing" })}
      />,
    );

    expect(screen.getByRole("heading", { name: "No posts match these filters" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Clear filters" })).toHaveAttribute("href", "/posts");
  });
});

describe("PostsList results", () => {
  it("renders identity, publication time and caption excerpt", () => {
    render(<PostsList snapshot={snapshot()} values={values()} />);

    // Scoped to the results: the filter form also offers "Reel" as an option.
    const results = screen.getByRole("region", { name: "Imported posts" });
    expect(within(results).getByText("Reel")).toBeVisible();
    expect(within(results).getByText(/Three lighting mistakes/u)).toBeVisible();
    expect(screen.getByRole("time")).toHaveAttribute("datetime", "2026-07-29T22:15:00.000Z");
  });

  it("names a missing caption rather than rendering an empty row", () => {
    render(
      <PostsList
        snapshot={snapshot({
          list: { ...emptyList(), posts: [post({ caption: null })], totalCount: 1 },
        })}
        values={values()}
      />,
    );

    expect(screen.getByText("No caption")).toBeVisible();
  });

  it("opens the provider permalink safely in a new tab", () => {
    render(<PostsList snapshot={snapshot()} values={values()} />);

    const link = screen.getByRole("link", { name: /View on Instagram/u });
    expect(link).toHaveAttribute("href", "https://www.instagram.com/reel/abc123/");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
  });

  it("omits the permalink entirely when none was stored", () => {
    render(
      <PostsList
        snapshot={snapshot({
          list: { ...emptyList(), posts: [post({ permalink: null })], totalCount: 1 },
        })}
        values={values()}
      />,
    );

    expect(screen.queryByRole("link", { name: /View on Instagram/u })).toBeNull();
  });

  it("falls back silently when the expiring thumbnail URL fails to load", () => {
    const { container } = render(<PostsList snapshot={snapshot()} values={values()} />);

    const image = container.querySelector("img");
    expect(image).not.toBeNull();
    fireEvent.error(image as HTMLImageElement);

    // A dead signed URL is the normal state for an older post, so it must not
    // surface as an error or collapse the row.
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".post-thumbnail--fallback")).not.toBeNull();
    expect(screen.getByText(/Three lighting mistakes/u)).toBeVisible();
  });

  it("renders the fallback immediately when no thumbnail was stored", () => {
    const { container } = render(
      <PostsList
        snapshot={snapshot({
          list: { ...emptyList(), posts: [post({ providerThumbnailUrl: null })], totalCount: 1 },
        })}
        values={values()}
      />,
    );

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".post-thumbnail--fallback")).not.toBeNull();
  });

  it("keeps retained unsupported media visible as its own triage bucket", () => {
    render(
      <PostsList
        snapshot={snapshot({
          list: {
            ...emptyList(),
            posts: [post({ mediaKind: "UNSUPPORTED", mediaProductType: null, mediaType: "STORY" })],
            totalCount: 1,
          },
        })}
        values={values()}
      />,
    );

    const results = screen.getByRole("region", { name: "Imported posts" });
    expect(within(results).getByText("Unsupported media")).toBeVisible();
  });
});

describe("PostsList unavailable triage signals", () => {
  it("names each uncaptured dimension rather than showing a zero or a blank", () => {
    render(<PostsList snapshot={snapshot()} values={values()} />);

    const pending = screen.getByRole("region", { name: "Not available yet" });
    for (const label of ["Analysis", "Metrics"]) {
      expect(within(pending).getByText(label)).toBeVisible();
    }
    expect(within(pending).getAllByText("Not captured")).toHaveLength(2);
  });

  it("no longer claims source video is uncaptured now that it is stored", () => {
    render(<PostsList snapshot={snapshot()} values={values()} />);

    const pending = screen.getByRole("region", { name: "Not available yet" });

    expect(within(pending).queryByText("Source video")).toBeNull();
  });

  it("never renders a zero for an uncaptured signal", () => {
    const { container } = render(<PostsList snapshot={snapshot()} values={values()} />);

    const pending = container.querySelector(".posts-pending");
    expect(pending?.textContent).not.toMatch(/\b0\b/u);
  });
});

describe("PostsList account labelling", () => {
  const secondAccountId = "019a0000-0000-7000-8000-000000000302";

  function twoAccounts(): PostsSnapshot {
    return snapshot({
      accounts: [
        { id: accountId, label: "@studioparallel" },
        { id: secondAccountId, label: "@parallelstudio" },
      ],
      list: {
        generatedAt: "2026-07-31T03:00:00.000Z",
        nextCursor: null,
        posts: [
          post(),
          post({
            id: "019a0000-0000-7000-8000-000000000402",
            instagramAccountId: secondAccountId,
          }),
        ],
        totalCount: 2,
      },
    });
  }

  it("states which account each row belongs to once a second is connected", () => {
    const { container } = render(<PostsList snapshot={twoAccounts()} values={values()} />);

    // Two accounts' posts interleave by date, so a row that does not say whose
    // it is cannot be read correctly. Scoped to the rows, because the filter
    // control lists the same names.
    const labelled = [...container.querySelectorAll(".posts-grid .post-card__account")].map(
      (element) => element.textContent,
    );

    expect(labelled).toEqual(["@studioparallel", "@parallelstudio"]);
  });

  it("names the account in every link, so the rows stay distinguishable out of context", () => {
    render(<PostsList snapshot={twoAccounts()} values={values()} />);

    // A card offers more than one link with the same visible words, so each of
    // them has to carry the row's own identity rather than only the first.
    const links = screen.getAllByRole("link", {
      name: /for the Reel published .* on @parallelstudio$/u,
    });

    expect(links.length).toBeGreaterThan(1);
    for (const link of links) expect(link).toBeVisible();
  });

  it("says nothing about the account when only one is connected", () => {
    const { container } = render(<PostsList snapshot={snapshot()} values={values()} />);

    // With one account the label would repeat on every row and add nothing.
    expect(container.querySelector(".post-card__account")).toBeNull();
  });
});

describe("PostsList source video", () => {
  it("links every post to its own source video page", () => {
    render(
      <PostsList
        snapshot={withPosts(post(), post({ id: "019a0000-0000-7000-8000-000000000402" }))}
        values={values()}
      />,
    );

    const links = screen
      .getAllByRole("link")
      .map((link) => link.getAttribute("href"))
      .filter((href) => href?.includes("/source-video"));

    expect(links).toEqual([
      "/posts/019a0000-0000-7000-8000-000000000401/source-video",
      "/posts/019a0000-0000-7000-8000-000000000402/source-video",
    ]);
  });

  it("identifies which post a source video link belongs to", () => {
    // Every card carries the same visible action text, so without the post's
    // own identity the links are indistinguishable to a screen reader listing
    // them out of context.
    //
    // The name has no space before "for" because the accessible-name algorithm
    // trims each element's text before joining, which is also why the sibling
    // "View on Instagram" link reads as "...Instagram(30 July...".
    render(<PostsList snapshot={snapshot()} values={values()} />);

    expect(
      screen.getByRole("link", { name: /^Add source video\s*for the Reel published/u }),
    ).toBeVisible();
  });

  it("distinguishes all four source video states", () => {
    for (const [state, label, action] of [
      ["NONE", "No source video", "Add source video"],
      ["PENDING_VALIDATION", "Checking source video", "View source video"],
      ["READY", "Source video ready", "Replace source video"],
      ["REJECTED", "Source video rejected", "Upload a different file"],
    ] as const) {
      const { unmount } = render(
        <PostsList snapshot={withPosts(post({ sourceVideoState: state }))} values={values()} />,
      );

      expect(screen.getByText(label)).toBeVisible();
      expect(screen.getByRole("link", { name: new RegExp(action, "u") })).toBeVisible();

      unmount();
    }
  });

  it("separates a post that never had a video from one whose video was refused", () => {
    // Both need action, but not the same action: one needs a first upload and
    // the other needs a different file.
    const { unmount } = render(
      <PostsList snapshot={withPosts(post({ sourceVideoState: "NONE" }))} values={values()} />,
    );
    expect(screen.queryByText("Source video rejected")).toBeNull();
    unmount();

    render(
      <PostsList snapshot={withPosts(post({ sourceVideoState: "REJECTED" }))} values={values()} />,
    );
    expect(screen.queryByText("No source video")).toBeNull();
    expect(screen.getByText("Source video rejected")).toBeVisible();
  });
});

describe("PostsList filters and pagination", () => {
  it("submits filters as a GET form so state lives in the URL", () => {
    render(<PostsList snapshot={snapshot()} values={values()} />);

    const form = screen.getByRole("button", { name: "Apply filters" }).closest("form");
    expect(form).toHaveAttribute("method", "get");
    expect(form).toHaveAttribute("action", "/posts");
  });

  it("reflects the active filter values back into the form", () => {
    render(
      <PostsList snapshot={snapshot()} values={values({ kind: "REEL", search: "lighting" })} />,
    );

    expect(screen.getByLabelText("Search captions")).toHaveValue("lighting");
    expect(screen.getByLabelText("Media type")).toHaveValue("REEL");
  });

  it("hides the account selector when there is only one account to choose", () => {
    render(<PostsList snapshot={snapshot()} values={values()} />);
    expect(screen.queryByLabelText("Account")).toBeNull();
  });

  it("offers the account selector once a second account exists", () => {
    render(
      <PostsList
        snapshot={snapshot({
          accounts: [
            { id: accountId, label: "@studioparallel" },
            { id: "019a0000-0000-7000-8000-000000000302", label: "@second" },
          ],
        })}
        values={values()}
      />,
    );

    expect(screen.getByLabelText("Account")).toBeVisible();
  });

  it("carries the active filters into the next-page link", () => {
    render(
      <PostsList
        snapshot={snapshot({
          list: {
            ...emptyList("019a0000-0000-7000-8000-000000000409"),
            posts: [post()],
            totalCount: 40,
          },
        })}
        values={values({ kind: "REEL" })}
      />,
    );

    const next = screen.getByRole("link", { name: "Show older posts" });
    expect(next).toHaveAttribute("href", expect.stringContaining("kind=REEL"));
    expect(next).toHaveAttribute("href", expect.stringContaining("after="));
  });

  it("offers no next page on the last page", () => {
    render(<PostsList snapshot={snapshot()} values={values()} />);
    expect(screen.queryByRole("link", { name: "Show older posts" })).toBeNull();
  });
});

describe("PostsError", () => {
  it("reports a safe failure with a correlation reference", () => {
    render(<PostsError reference="0192f2a0-0000-7000-8000-00000000abcd" />);

    expect(screen.getByRole("heading", { name: "Posts did not load" })).toBeVisible();
    expect(screen.getByText(/existing data remains safe/u)).toBeVisible();
    expect(screen.getByText("0192f2a0-0000-7000-8000-00000000abcd")).toBeVisible();
  });
});

describe("PostsList per-post actions", () => {
  function actions() {
    const results = screen.getByRole("region", { name: "Imported posts" });
    return {
      analyse: within(results).queryByRole("button", { name: /Analyse this video/u }),
      link: within(results).queryByRole("button", { name: /Use the Instagram video/u }),
    };
  }

  it.each(["NONE", "REJECTED"] as const)(
    "offers the Instagram copy for a reel in %s",
    (sourceVideoState) => {
      render(<PostsList snapshot={withPosts(post({ sourceVideoState }))} values={values()} />);

      expect(actions().link).toBeVisible();
      // Nothing to analyse until a video is attached and checked.
      expect(actions().analyse).toBeNull();
    },
  );

  it("offers analysis once the video has been checked, and no longer offers a copy", () => {
    render(
      <PostsList snapshot={withPosts(post({ sourceVideoState: "READY" }))} values={values()} />,
    );

    expect(actions().analyse).toBeVisible();
    // Importing over an attached video would be a replacement, which is a
    // separate outcome the server refuses.
    expect(actions().link).toBeNull();
  });

  it("offers nothing while the video is still being checked", () => {
    render(
      <PostsList
        snapshot={withPosts(post({ sourceVideoState: "PENDING_VALIDATION" }))}
        values={values()}
      />,
    );

    expect(actions().analyse).toBeNull();
    expect(actions().link).toBeNull();
  });

  it.each(["CAROUSEL_ALBUM", "IMAGE", "UNSUPPORTED"] as const)(
    "never offers a copy for %s, which has no video to copy",
    (mediaKind) => {
      render(
        <PostsList
          snapshot={withPosts(post({ mediaKind, sourceVideoState: "NONE" }))}
          values={values()}
        />,
      );

      expect(actions().link).toBeNull();
    },
  );

  it("names the post each button belongs to, so repeated labels stay distinguishable", () => {
    render(
      <PostsList
        snapshot={withPosts(
          post({ id: "019a0000-0000-7000-8000-000000000401" }),
          post({
            id: "019a0000-0000-7000-8000-000000000402",
            publishedAt: "2026-07-27T03:40:00.000Z",
          }),
        )}
        values={values()}
      />,
    );

    const buttons = screen.getAllByRole("button", { name: /Use the Instagram video/u });
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toHaveAttribute("data-post", "019a0000-0000-7000-8000-000000000401");
    expect(buttons[1]).toHaveAttribute("data-post", "019a0000-0000-7000-8000-000000000402");
    expect(new Set(buttons.map((button) => button.getAttribute("data-context")))).toHaveProperty(
      "size",
      2,
    );
  });
});
