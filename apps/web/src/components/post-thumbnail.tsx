"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Renders a provider thumbnail that is expected to break.
 *
 * `providerThumbnailUrl` is a signed CDN URL that Meta expires, so a post
 * imported weeks ago will usually fail to load. The fallback is therefore the
 * normal state, not an error state: it stays silent, keeps the row's layout,
 * and never blocks the list. The image is unoptimised on purpose — running an
 * expiring URL through an image optimiser would cache a link that is already
 * dead.
 */
export function PostThumbnail({ label, url }: Readonly<{ label: string; url: string | null }>) {
  const [failed, setFailed] = useState(false);
  const imageRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    // The page is server-rendered, so an image can finish failing before React
    // hydrates and attaches `onError`. That error is never replayed, and
    // without this check a pre-hydration failure would leave the browser's
    // broken-image icon on screen permanently. A loaded-but-zero-width image is
    // the only reliable signal after the fact.
    const image = imageRef.current;
    if (image?.complete && image.naturalWidth === 0) setFailed(true);
  }, []);

  if (!url || failed) {
    return (
      <span aria-hidden="true" className="post-thumbnail post-thumbnail--fallback">
        <span className="post-thumbnail__glyph">▣</span>
      </span>
    );
  }

  return (
    <img
      alt=""
      className="post-thumbnail"
      decoding="async"
      loading="lazy"
      onError={() => setFailed(true)}
      ref={imageRef}
      referrerPolicy="no-referrer"
      src={url}
      title={label}
    />
  );
}
