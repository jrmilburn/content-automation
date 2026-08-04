import { InstagramVideoImportButton } from "./instagram-video-import-button";

/**
 * Brings the post's own Instagram video across as its source video.
 *
 * The wording is careful about two things. It says a copy is being made, not
 * that the video is being linked, because a link to a URL Meta re-signs on
 * every request would stop working within the hour. And it says the copy is the
 * version Instagram serves, because that file has been re-encoded for delivery
 * and is not the master the account owner filmed — a reader comparing quality
 * later needs to know which one they are looking at.
 *
 * Only the framing lives here. The button itself is separate because the posts
 * list repeats it per row, where this heading and copy would be repeated with
 * it.
 */
export function InstagramVideoImportControl({ postId }: Readonly<{ postId: string }>) {
  return (
    <section aria-labelledby="video-import-heading" className="video-import">
      {/* A level 2 heading because the page heading is the only one above it
          when no video is attached yet: a level 3 there would skip a level. */}
      <h2 id="video-import-heading">Use the video from Instagram</h2>
      <p>
        Copy this post&rsquo;s video straight from Instagram instead of uploading the file yourself.
        It copies the version Instagram serves, which has been re-encoded for playback, so it may
        not match the quality of your original.
      </p>
      <InstagramVideoImportButton postId={postId} />
    </section>
  );
}
