/**
 * Pure rules for importing a post's own Instagram video as its source asset.
 *
 * Two decisions live here because both must be provable without a network: what
 * makes a post importable at all, and which hosts the bytes may be read from.
 * The client and the handler are then left with nothing but transport.
 *
 * Importing copies the file Instagram serves. That file is a delivery re-encode
 * rather than the master the account owner filmed, and the URL it comes from is
 * re-signed on every request. Neither fact makes the copy useless; both make it
 * something that has to be labelled, which is why an imported asset is recorded
 * with its origin rather than being indistinguishable from an upload.
 */

/** Fields the single-media read needs. A subset of the pinned media contract. */
export const instagramMediaImportFields = [
  "id",
  "media_type",
  "media_product_type",
  "media_url",
] as const;

/**
 * Hosts a media download may read from.
 *
 * Meta serves media from its own CDN under these registered domains, and the
 * signed URL it hands out points at one of them. Restricting the download to
 * this set is what keeps the SSRF rule intact: the operator never supplies a
 * URL, and even the provider cannot redirect the read to an arbitrary host.
 */
export const instagramMediaHostSuffixes = [".cdninstagram.com", ".fbcdn.net"] as const;

export function isAllowedInstagramMediaUrl(candidate: string): boolean {
  let url: URL;

  try {
    url = new URL(candidate);
  } catch {
    return false;
  }

  if (url.protocol !== "https:") return false;
  // Credentials in the authority would make the host a suffix of an attacker's
  // choosing to a careless reader, so refuse them outright.
  if (url.username || url.password) return false;

  const host = url.hostname.toLowerCase();

  return instagramMediaHostSuffixes.some((suffix) => host.endsWith(suffix));
}

export const instagramMediaImportRefusalReasons = [
  "POST_NOT_FOUND",
  "NOT_A_VIDEO",
  "ALREADY_HAS_SOURCE",
  "IMPORT_IN_PROGRESS",
  "ACCOUNT_NOT_CONNECTED",
  "RATE_LIMITED",
] as const;

export type InstagramMediaImportRefusalReason = (typeof instagramMediaImportRefusalReasons)[number];

/** Media kinds that can carry a video file. */
const importableMediaKinds = new Set(["REEL", "VIDEO"]);

/**
 * Whether a post is the kind of thing that has a video to import.
 *
 * Checked before anything is fetched, so an image or an album is answered
 * rather than turned into a job that fails at the provider.
 */
export function isImportableInstagramMediaKind(mediaKind: string): boolean {
  return importableMediaKinds.has(mediaKind);
}

export const instagramMediaImportFailureReasons = [
  "MEDIA_UNREADABLE",
  "MEDIA_URL_ABSENT",
  "MEDIA_URL_NOT_ALLOWED",
  "MEDIA_TOO_LARGE",
  "MEDIA_DOWNLOAD_FAILED",
] as const;

export type InstagramMediaImportFailureReason = (typeof instagramMediaImportFailureReasons)[number];

/**
 * Key for one post's import.
 *
 * Anchored on the post with no time bucket, so a second press while the first
 * import is still queued is recognised as the same work rather than starting a
 * second download. A finished import is not repeatable under the same key,
 * which is correct: the post has a source asset now, and replacing it is a
 * different action with its own cleanup.
 */
export function instagramMediaImportKey(postId: string): string {
  return `instagram-media-import-${postId}`;
}
