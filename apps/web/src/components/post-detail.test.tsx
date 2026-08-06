// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { PostDetail, PostDetailComment } from "../lib/server/post-detail-data";
import { PostDetailScreen } from "./post-detail";

/**
 * What the screen may not get wrong.
 *
 * Three of the assertions below are about a reader being misled rather than
 * about markup: an unreported metric must never appear as a zero, the transcript
 * must be labelled as a model's work before it is read, and a stranger's comment
 * must arrive as text no matter what it contains. Each of those would look
 * perfectly fine on screen if it were broken.
 */

const postId = "019a0000-0000-7000-8000-000000000401";

function comment(overrides: Partial<PostDetailComment> = {}): PostDetailComment {
  return {
    id: "019a0000-0000-7000-8000-000000000501",
    likeCount: 12,
    parentProviderCommentId: null,
    providerCommentId: "c-100",
    publishedAt: "2026-07-30T01:00:00.000Z",
    text: "The softbox tip changed how I shoot.",
    username: "lena.makes",
    ...overrides,
  };
}

function post(overrides: Partial<PostDetail> = {}): PostDetail {
  return {
    analysis: {
      analysedAt: "2026-07-30T04:00:00.000Z",
      contentFormat: "behind_the_scenes",
      contentPillar: "process_and_craft",
      ctaType: "follow",
      durationSeconds: 42,
      hookCategory: "question",
      presenterMode: "founder_on_camera",
      transcript: "The first mistake is putting the key light straight on.",
    },
    caption: "Three lighting mistakes that flatten a product shot.",
    commentCount: 1,
    comments: [comment()],
    id: postId,
    mediaKind: "REEL",
    mediaProductType: "REELS",
    metrics: {
      ageWindow: "day_7",
      averageWatchTimeMs: 12_400,
      capturedAt: "2026-08-05T22:15:00.000Z",
      comments: 4,
      likes: 218,
      reach: 4_902,
      saves: 74,
      shares: 31,
      views: 8_140,
    },
    permalink: "https://www.instagram.com/reel/abc123/",
    publishedAt: "2026-07-29T22:15:00.000Z",
    ...overrides,
  };
}

function metricValue(label: string): string {
  const row = screen.getByRole("rowheader", { name: label }).closest("tr");
  if (row === null) throw new Error(`no row for ${label}`);

  return within(row).getAllByRole("cell")[0]?.textContent ?? "";
}

describe("metrics", () => {
  it("reads an unreported metric as not measured, and a measured zero as zero", () => {
    // The whole reason the table exists. A zero is a finding a reader would act
    // on; an absence is not, and rendering one as the other is invisible.
    render(
      <PostDetailScreen
        post={post({
          metrics: {
            ageWindow: "day_7",
            averageWatchTimeMs: null,
            capturedAt: "2026-08-05T22:15:00.000Z",
            comments: 0,
            likes: 218,
            reach: null,
            saves: 74,
            shares: 31,
            views: 8_140,
          },
        })}
      />,
    );

    expect(metricValue("Reach")).toBe("Not measured");
    expect(metricValue("Average watch time")).toBe("Not measured");
    expect(metricValue("Comments")).toBe("0");
  });

  it("states the age of the observation above the numbers", () => {
    // Metrics at one hour and at thirty days are not comparable, and a reader
    // who has already drawn a conclusion has been misled by the time they reach
    // a footnote.
    const { container } = render(<PostDetailScreen post={post()} />);
    const table = container.querySelector(".post-detail__metrics");
    const stated = screen.getAllByText(/7 days after publication/u)[0];

    expect(stated).toBeVisible();
    // Above the numbers rather than beneath them.
    expect(stated?.compareDocumentPosition(table as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("says nothing was captured rather than showing a table of zeroes", () => {
    render(<PostDetailScreen post={post({ metrics: null })} />);

    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByText(/No metrics have been captured/u)).toBeVisible();
  });
});

describe("the transcript", () => {
  it("labels the transcript as a model's work before the text of it", () => {
    // A reader who has read it as a record of what was said has already been
    // misled by the time they reach a note underneath.
    const { container } = render(<PostDetailScreen post={post()} />);

    const note = screen.getByText(/not a verbatim record/u);
    const transcript = container.querySelector(".post-detail__transcript");

    expect(screen.getByText("Model-generated")).toBeVisible();
    expect(transcript?.textContent).toContain("putting the key light straight on");
    expect(note.compareDocumentPosition(transcript as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("keeps an unavailable transcript apart from an empty one", () => {
    const analysis = post().analysis;
    if (analysis === null) throw new Error("fixture has an analysis");

    render(<PostDetailScreen post={post({ analysis: { ...analysis, transcript: null } })} />);

    // The observation was reported as unavailable. Rendering nothing would
    // claim the video was silent, which is a finding nobody made.
    expect(screen.getByText(/recorded no transcript/u)).toBeVisible();
  });

  it("names an unobserved analysis facet rather than dropping it", () => {
    const analysis = post().analysis;
    if (analysis === null) throw new Error("fixture has an analysis");

    render(<PostDetailScreen post={post({ analysis: { ...analysis, ctaType: null } })} />);

    expect(screen.getByText("Call to action")).toBeVisible();
    expect(screen.getAllByText("Not observed").length).toBeGreaterThan(0);
  });
});

describe("comments", () => {
  it("renders a stranger's text as text, never as markup", () => {
    // The only table in the product holding text someone else wrote. A comment
    // that reaches the DOM as an element is the failure this assertion exists
    // for, and it would look like nothing at all on screen.
    const hostile = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    const { container } = render(
      <PostDetailScreen post={post({ comments: [comment({ text: hostile })] })} />,
    );

    expect(screen.getByText(hostile)).toBeVisible();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
  });

  it("shows the stored total beside a capped list", () => {
    // A reader shown two comments and told there are two would draw a
    // conclusion about an audience from a two-hundredth of it.
    render(
      <PostDetailScreen
        post={post({
          commentCount: 412,
          comments: [comment(), comment({ id: "b", providerCommentId: "c-101" })],
        })}
      />,
    );

    expect(screen.getByText(/412 comments imported, 2 shown here/u)).toBeVisible();
  });

  it("nests a reply under the comment it answers", () => {
    render(
      <PostDetailScreen
        post={post({
          commentCount: 2,
          comments: [
            comment(),
            comment({
              id: "b",
              parentProviderCommentId: "c-100",
              providerCommentId: "c-101",
              text: "Same here.",
            }),
          ],
        })}
      />,
    );

    const replies = screen.getByRole("list", { name: /Replies to @lena.makes/u });

    expect(within(replies).getByText("Same here.")).toBeVisible();
  });

  it("marks a reply whose parent was not imported", () => {
    // Meta returns replies whose parent falls outside the imported set, so this
    // is a normal state. Presenting it as a new thread would misattribute it.
    render(
      <PostDetailScreen
        post={post({ comments: [comment({ parentProviderCommentId: "c-999" })] })}
      />,
    );

    expect(screen.getByText(/Reply to a comment that was not imported/u)).toBeVisible();
  });

  it("says nothing has been imported rather than that nobody commented", () => {
    render(<PostDetailScreen post={post({ commentCount: 0, comments: [] })} />);

    expect(screen.getByText(/No comments have been imported/u)).toBeVisible();
  });
});

describe("structure", () => {
  it("keeps one first-level heading and every section under it", () => {
    // The a11y suite checks heading order; this pins the shape it checks so a
    // new section cannot quietly skip a level.
    render(<PostDetailScreen post={post()} />);

    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getAllByRole("heading", { level: 2 }).map((node) => node.textContent)).toEqual([
      "This post",
      "Performance",
      "Analysis",
      "Comments",
    ]);
  });

  it("offers the permalink and the source video, and says when there is no permalink", () => {
    render(<PostDetailScreen post={post()} />);
    expect(screen.getByRole("link", { name: /View on Instagram/u })).toHaveAttribute(
      "href",
      "https://www.instagram.com/reel/abc123/",
    );
    expect(screen.getByRole("link", { name: "Manage the source video" })).toHaveAttribute(
      "href",
      `/posts/${postId}/source-video`,
    );

    render(<PostDetailScreen post={post({ permalink: null })} />);
    expect(screen.getByText(/No permalink was returned/u)).toBeVisible();
  });
});
