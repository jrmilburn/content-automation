import { createHash } from "node:crypto";

import { parseInstagramTimestamp } from "./instagram-media.js";

/**
 * Pure Instagram comment contract: the requested field set, item normalisation,
 * reply flattening, provenance hashing and cursor reading.
 *
 * Comments are the one input to this product that a stranger writes. Everything
 * else in the pipeline is the account's own media, the account's own caption or
 * the model's own output; a comment body is arbitrary text from someone with no
 * relationship to this workspace. So it is normalised here, under test, and the
 * worker adapter is left with nothing but HTTP plumbing — and every consumer
 * treats the result as untrusted data.
 *
 * Nothing here returns provider text in an error: a rejected comment is counted
 * and isolated, never logged, because the reason it was rejected is a property
 * of the shape and the body is the part that must not escape.
 */

/**
 * Replies are expanded inline rather than fetched per comment. A thread is
 * where an account answers its own audience, so dropping it would keep the
 * question and lose the answer — and the alternative is one request per
 * comment, which is the same data at a hundred times the quota.
 */
export const instagramCommentFields = [
  "id",
  "text",
  "timestamp",
  "username",
  "like_count",
  "replies{id,text,timestamp,username,like_count}",
] as const;

/** Provider page size for the comments edge. */
export const instagramCommentPageSize = 50;

/**
 * Hard bound per post. A post with more comments than this keeps its most
 * recent ones; the alternative is letting one viral post consume the whole
 * import budget for every other post on the account.
 */
export const instagramMaximumCommentPages = 20;

export const instagramCommentRejectionReasons = [
  "COMMENT_ID_INVALID",
  "COMMENT_NOT_OBJECT",
  "COMMENT_NOT_SERIALISABLE",
  "COMMENT_TOO_LARGE",
  "TIMESTAMP_INVALID",
] as const;

export type InstagramCommentRejectionReason = (typeof instagramCommentRejectionReasons)[number];

export type NormalisedInstagramComment = Readonly<{
  likeCount: number | null;
  /** Null for a top-level comment; set for every flattened reply. */
  parentProviderCommentId: string | null;
  providerCommentId: string;
  publishedAt: Date;
  rawPayload: Readonly<Record<string, unknown>>;
  rawPayloadHash: string;
  /** Untrusted. Arbitrary text written by someone outside this workspace. */
  text: string;
  /** Untrusted, and absent on some provider responses. */
  username: string | null;
}>;

export type InstagramCommentNormalisation =
  | Readonly<{ comment: NormalisedInstagramComment; ok: true }>
  | Readonly<{ ok: false; reason: InstagramCommentRejectionReason }>;

export type InstagramCommentPage = Readonly<{
  after: string | null;
  hasNextPage: boolean;
  items: readonly unknown[];
}>;

// Comment ids are numeric but run considerably longer than media ids.
const providerCommentIdPattern = /^[0-9]{5,64}$/u;
const providerCursorPattern = /^[A-Za-z0-9_-]{1,512}$/u;
const maximumRawPayloadBytes = 65_536;

// Instagram caps a comment at 2 200 characters. The bound is applied on our
// side too, so a provider change cannot put an unbounded string into a prompt.
const maximumCommentTextLength = 2_200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function reject(reason: InstagramCommentRejectionReason): InstagramCommentNormalisation {
  return Object.freeze({ ok: false as const, reason });
}

function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalise);
  if (!isRecord(value)) return value;

  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    result[key] = canonicalise(value[key]);
  }
  return result;
}

/**
 * Stable provenance hash for one comment.
 *
 * Keys are ordered so provider field ordering cannot change the digest. Unlike
 * media there is nothing ephemeral to strip: a comment carries no signed URL,
 * so the whole item participates.
 */
export function hashInstagramCommentPayload(item: Readonly<Record<string, unknown>>): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalise(item)) ?? "", "utf8")
    .digest("hex");
}

/**
 * Strips characters that would let a comment body forge structure in a prompt
 * or a log line.
 *
 * Control characters are removed rather than escaped because no comment
 * legitimately contains them, and a newline is collapsed to a space so a body
 * cannot open what reads as a new section of the context block. The context
 * assembler indents untrusted blocks as well; this is the second of the two,
 * and it is here because the database should not hold the hostile form either.
 */
export function sanitiseInstagramCommentText(value: string): string {
  let result = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      result += " ";
      continue;
    }
    result += character;
  }

  return result.replace(/\s+/gu, " ").trim().slice(0, maximumCommentTextLength);
}

function normaliseOne(
  item: unknown,
  parentProviderCommentId: string | null,
): InstagramCommentNormalisation {
  if (!isRecord(item)) return reject("COMMENT_NOT_OBJECT");

  let serialised: string | undefined;
  try {
    serialised = JSON.stringify(item);
  } catch {
    return reject("COMMENT_NOT_SERIALISABLE");
  }
  if (typeof serialised !== "string") return reject("COMMENT_NOT_SERIALISABLE");
  if (serialised.length > maximumRawPayloadBytes) return reject("COMMENT_TOO_LARGE");

  const providerCommentId = readString(item, "id");
  if (!providerCommentId || !providerCommentIdPattern.test(providerCommentId)) {
    return reject("COMMENT_ID_INVALID");
  }

  const publishedAt = parseInstagramTimestamp(readString(item, "timestamp"));
  if (!publishedAt) return reject("TIMESTAMP_INVALID");

  const rawText = item["text"];
  const rawLikeCount = item["like_count"];
  const username = readString(item, "username");

  return Object.freeze({
    comment: Object.freeze({
      likeCount:
        typeof rawLikeCount === "number" && Number.isInteger(rawLikeCount) && rawLikeCount >= 0
          ? rawLikeCount
          : null,
      parentProviderCommentId,
      providerCommentId,
      publishedAt,
      rawPayload: Object.freeze({ ...item }),
      rawPayloadHash: hashInstagramCommentPayload(item),
      // An empty body is legitimate — a comment can be a lone emoji that the
      // sanitiser keeps, or a sticker the provider reports with no text — so it
      // is stored rather than rejected. A rejection here would lose the fact
      // that someone engaged at all.
      text: typeof rawText === "string" ? sanitiseInstagramCommentText(rawText) : "",
      username,
    }),
    ok: true as const,
  });
}

/**
 * Converts one provider comment, and its expanded replies, into normalised
 * rows.
 *
 * A thread arrives nested and is stored flat, with each reply carrying its
 * parent's provider id. Flat is what the strategy and the assistant read: they
 * ask "what did the audience say about this post", and a two-level tree makes
 * that question need a traversal to answer. The parent id keeps the thread
 * reconstructable for anything that wants it.
 *
 * A rejected reply does not reject its parent. One malformed item is counted
 * and dropped; the comment it belongs to is still worth having.
 */
export function normaliseInstagramCommentItem(item: unknown): Readonly<{
  comments: readonly NormalisedInstagramComment[];
  rejected: readonly InstagramCommentRejectionReason[];
}> {
  const top = normaliseOne(item, null);
  if (!top.ok) return Object.freeze({ comments: Object.freeze([]), rejected: [top.reason] });

  const comments: NormalisedInstagramComment[] = [top.comment];
  const rejected: InstagramCommentRejectionReason[] = [];

  const replies = isRecord(item) && isRecord(item["replies"]) ? item["replies"] : null;
  const replyData = replies && Array.isArray(replies["data"]) ? replies["data"] : [];

  for (const reply of replyData) {
    const normalised = normaliseOne(reply, top.comment.providerCommentId);
    if (normalised.ok) {
      comments.push(normalised.comment);
      continue;
    }
    rejected.push(normalised.reason);
  }

  return Object.freeze({ comments: Object.freeze(comments), rejected: Object.freeze(rejected) });
}

/**
 * Reads one comment page. A cursor is accepted only in the opaque token shape
 * Meta issues, so a hostile `next` value cannot be reflected into a later
 * request URL.
 */
export function readInstagramCommentPage(body: unknown): InstagramCommentPage {
  if (!isRecord(body)) return Object.freeze({ after: null, hasNextPage: false, items: [] });

  const items = Array.isArray(body["data"]) ? Object.freeze([...body["data"]]) : Object.freeze([]);
  const paging = isRecord(body["paging"]) ? body["paging"] : null;
  const cursors = paging && isRecord(paging["cursors"]) ? paging["cursors"] : null;
  const after = cursors ? readString(cursors, "after") : null;

  return Object.freeze({
    after: after && providerCursorPattern.test(after) ? after : null,
    hasNextPage: Boolean(paging && typeof paging["next"] === "string"),
    items,
  });
}
