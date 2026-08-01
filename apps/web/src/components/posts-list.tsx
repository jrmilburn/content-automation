import type { InstagramPostListItem } from "@studio-parallel/db";
import Link from "next/link";

import {
  buildPostsHref,
  captionExcerpt,
  formatPublishedAt,
  hasActiveFilters,
  mediaKindFilterOptions,
  pendingTriageDimensions,
  presentMediaKind,
  presentSourceVideo,
  sourceVideoHref,
  type PostsFilterValues,
} from "../lib/posts-list";
import type { PostsSnapshot } from "../lib/server/posts-data";
import { PageHeader } from "./page-header";
import { PostThumbnail } from "./post-thumbnail";
import { EmptyState, ErrorSummary } from "./states";
import { StatusBadge } from "./status-badge";

/**
 * The imported posts triage list.
 *
 * Source video is real stored state and is rendered as such. Analysis and
 * metric state are still named as pending rather than shown as empty values:
 * there is no stored data behind either, and a blank or a zero would read as
 * "checked, nothing wrong" instead of "not captured".
 */

const description = "Find imported posts and triage what still needs work.";

export function PostsList({
  snapshot,
  values,
}: Readonly<{ snapshot: PostsSnapshot; values: PostsFilterValues }>) {
  const { list } = snapshot;
  const filtered = hasActiveFilters(values);

  return (
    <div className="page-stack">
      <PageHeader description={description} title="Posts" />

      {snapshot.hasAccount ? <PostsFilters snapshot={snapshot} values={values} /> : null}

      {list.posts.length > 0 ? (
        <section aria-labelledby="posts-results-heading" className="posts-results">
          <header className="posts-results__header">
            <h2 id="posts-results-heading">Imported posts</h2>
            <p aria-live="polite">
              {list.totalCount} {list.totalCount === 1 ? "post" : "posts"}
              {filtered ? " match these filters" : " imported"}
            </p>
          </header>

          <ol className="posts-grid">
            {list.posts.map((post) => (
              <PostCard key={post.id} post={post} />
            ))}
          </ol>

          <TriagePending />

          {list.nextCursor ? (
            <nav aria-label="Pagination" className="posts-pagination">
              <Link
                className="button button--secondary"
                href={buildPostsHref(values, list.nextCursor)}
              >
                Show older posts
              </Link>
            </nav>
          ) : null}
        </section>
      ) : (
        <PostsEmpty filtered={filtered} hasAccount={snapshot.hasAccount} />
      )}
    </div>
  );
}

export function PostsError({ reference }: Readonly<{ reference: string }>) {
  return (
    <div className="page-stack">
      <PageHeader description={description} title="Posts" />
      <ErrorSummary
        action={{ href: "/posts", label: "Try again" }}
        correlationId={reference}
        description="Imported posts could not be loaded. Nothing was changed and existing data remains safe."
        title="Posts did not load"
      />
    </div>
  );
}

function PostsEmpty({
  filtered,
  hasAccount,
}: Readonly<{ filtered: boolean; hasAccount: boolean }>) {
  if (!hasAccount) {
    return (
      <EmptyState
        action={{ href: "/settings/integrations", label: "Connect Instagram account" }}
        description="Connect an Instagram professional account. Posts appear here once its first sync completes."
        title="No Instagram account connected"
      />
    );
  }

  if (filtered) {
    return (
      <EmptyState
        action={{ href: "/posts", label: "Clear filters" }}
        description="Try a broader date range, a different media type, or fewer search words."
        title="No posts match these filters"
      />
    );
  }

  return (
    <EmptyState
      action={{ href: "/settings/integrations", label: "Check connection health" }}
      description="The account is connected but nothing has been imported yet. Importing runs in the background after a connection is made."
      title="No posts imported yet"
    />
  );
}

function PostsFilters({
  snapshot,
  values,
}: Readonly<{ snapshot: PostsSnapshot; values: PostsFilterValues }>) {
  return (
    <section aria-labelledby="posts-filters-heading" className="posts-filters">
      <div className="posts-filters__heading">
        <h2 id="posts-filters-heading">Find posts</h2>
        <Link href="/posts">Clear all</Link>
      </div>
      <form action="/posts" className="posts-filter-form" method="get">
        <label className="posts-filter-form__search">
          <span>Search captions</span>
          <input
            autoComplete="off"
            defaultValue={values.search}
            maxLength={120}
            name="q"
            placeholder="Words in the caption"
            type="search"
          />
        </label>
        <label>
          <span>Media type</span>
          <select defaultValue={values.kind} name="kind">
            <option value="all">All media</option>
            {mediaKindFilterOptions.map(({ label, value }) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {snapshot.accounts.length > 1 ? (
          <label>
            <span>Account</span>
            <select defaultValue={values.account} name="account">
              <option value="">All accounts</option>
              {snapshot.accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label>
          <span>Published from</span>
          <input defaultValue={values.from} name="from" type="date" />
        </label>
        <label>
          <span>Published to</span>
          <input defaultValue={values.to} name="to" type="date" />
        </label>
        <button className="button button--primary" type="submit">
          Apply filters
        </button>
      </form>
    </section>
  );
}

function PostCard({ post }: Readonly<{ post: InstagramPostListItem }>) {
  const kind = presentMediaKind(post);
  const sourceVideo = presentSourceVideo(post);
  const published = formatPublishedAt(post.publishedAt);
  const headingId = `post-${post.id}`;

  return (
    <li>
      <article aria-labelledby={headingId} className="post-card">
        <PostThumbnail
          label={`${kind.label} published ${published}`}
          url={post.providerThumbnailUrl}
        />
        <div className="post-card__body">
          <div className="post-card__meta">
            <StatusBadge tone={kind.tone}>{kind.label}</StatusBadge>
            <StatusBadge tone={sourceVideo.tone}>{sourceVideo.label}</StatusBadge>
            <h3 id={headingId}>
              <time dateTime={post.publishedAt}>{published}</time>
            </h3>
          </div>
          <p className="post-card__caption">{captionExcerpt(post.caption)}</p>
          <p className="post-card__actions">
            <Link href={sourceVideoHref(post.id)}>
              {sourceVideo.action}
              {/* Every card repeats the same action text, so the link needs the
                  post's own identity to be distinguishable out of context. */}
              <span className="visually-hidden">
                {" "}
                for the {kind.label} published {published}
              </span>
            </Link>
            {post.permalink ? (
              <a href={post.permalink} rel="noreferrer noopener" target="_blank">
                View on Instagram
                <span className="visually-hidden"> ({published}, opens in a new tab)</span>
              </a>
            ) : null}
          </p>
        </div>
      </article>
    </li>
  );
}

/**
 * States plainly which triage dimensions cannot be shown yet. The screen's
 * purpose is to find work that still needs doing, so being silent about the
 * dimensions it cannot see would be the misleading option.
 */
function TriagePending() {
  return (
    <section aria-labelledby="posts-pending-heading" className="posts-pending">
      <h3 id="posts-pending-heading">Not available yet</h3>
      <p>
        These triage signals are not captured for any post yet, so they are not shown and cannot be
        filtered on.
      </p>
      <dl>
        {pendingTriageDimensions.map((dimension) => (
          <div key={dimension.label}>
            <dt>
              <StatusBadge tone="neutral">Not captured</StatusBadge>
              <span>{dimension.label}</span>
            </dt>
            <dd>{dimension.detail}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
