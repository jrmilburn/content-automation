/**
 * One post, as the model reads it.
 *
 * A dossier is the whole of what this product knows about a post: when it went
 * out, how long it was, what the analysis made of it, what it actually did, what
 * was said in it, and what the audience wrote underneath. It replaces the
 * one-line post summary the manifest used to carry.
 *
 * The reason it exists is that the previous shape gave a model seven derived
 * percentages and no way to answer an ordinary question. "What should I make to
 * get more views" needs to know what a view was on each post; a relative effect
 * on engagement rate cannot answer it at any level of confidence. Handing over
 * the rows and letting the model read them is not a loosening of rigour — the
 * statistics are still there, beside the data, saying which comparisons hold up.
 *
 * Everything in a dossier except the metrics is untrusted text. The caption is
 * the account's own, the transcript is the model's own from a previous call, and
 * the comments are strangers'. Every renderer here indents its lines, so nothing
 * a dossier carries can start a line at column zero and forge a section.
 */

export type PostDossierMetrics = Readonly<{
  averageWatchTimeMs: number | null;
  comments: number | null;
  likes: number | null;
  reach: number | null;
  saves: number | null;
  shares: number | null;
  totalInteractions: number | null;
  views: number | null;
}>;

export type PostDossierComment = Readonly<{
  likeCount: number | null;
  text: string;
  username: string | null;
}>;

export type PostDossier = Readonly<{
  /** The observation age of the metrics, so a reader knows what they cover. */
  ageWindow: string | null;
  caption: string | null;
  /** Total stored, which is not the number rendered — the list is capped. */
  commentCount: number;
  comments: readonly PostDossierComment[];
  contentFormat: string | null;
  contentPillar: string | null;
  ctaType: string | null;
  durationSeconds: number | null;
  hookCategory: string | null;
  hookText: string | null;
  metrics: PostDossierMetrics;
  postId: string;
  presenterMode: string | null;
  /** ISO date, day resolution. A time of day is not evidence for anything. */
  publishedAt: string;
  transcript: string | null;
}>;

/** How many comments one dossier renders. */
export const postDossierCommentCap = 12;

/**
 * How much transcript one dossier renders.
 *
 * A minute of speech is roughly a thousand characters, and the analysis
 * contract caps a transcript at forty thousand. Short-form video sits far below
 * the cap, so this bounds the pathological case rather than the normal one.
 */
export const postDossierTranscriptCap = 6_000;

function indent(lines: readonly string[]): string {
  return lines.map((line) => `  ${line}`).join("\n");
}

/**
 * Strips anything that would let untrusted text forge structure, and bounds it.
 *
 * Newlines are collapsed rather than escaped: a transcript is prose and reads
 * the same on one line, and a caption that could open a line at column zero is
 * the one shape the context assembler's fence rules cannot catch once the text
 * is already inside a block.
 */
function flatten(value: string, cap: number): string {
  let result = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    result += code < 0x20 || code === 0x7f ? " " : character;
  }

  const collapsed = result.replace(/\s+/gu, " ").trim();
  return collapsed.length > cap ? `${collapsed.slice(0, cap)}…` : collapsed;
}

function metricLine(metrics: PostDossierMetrics): string {
  // A metric the provider did not report is omitted rather than written as
  // zero. Meta documents an unavailable insight as empty data, and a zero here
  // would be read as "nobody did this" — which is a different claim, and one
  // the model would then reason from.
  const parts: string[] = [];
  const push = (label: string, value: number | null): void => {
    if (value !== null) parts.push(`${label} ${String(value)}`);
  };

  push("views", metrics.views);
  push("reach", metrics.reach);
  push("likes", metrics.likes);
  push("comments", metrics.comments);
  push("shares", metrics.shares);
  push("saves", metrics.saves);
  push("interactions", metrics.totalInteractions);
  push("avg_watch_ms", metrics.averageWatchTimeMs);

  return parts.length === 0 ? "no metrics captured" : parts.join(", ");
}

/**
 * Renders one dossier without an identifier of its own.
 *
 * The strategy manifest labels each entry with its evidence key on the line
 * above, so a key repeated inside the body would give the model two ids for one
 * post and an even chance of citing the one that resolves to nothing.
 */
export function renderPostDossierBody(dossier: PostDossier): string {
  return renderKeyedPostDossier(null, dossier);
}

/** Renders one dossier under the key the reader may cite it by. */
export function renderPostDossier(key: string, dossier: PostDossier): string {
  return renderKeyedPostDossier(key, dossier);
}

function renderKeyedPostDossier(key: string | null, dossier: PostDossier): string {
  const head = [
    ...(key === null ? [] : [key]),
    dossier.publishedAt,
    dossier.durationSeconds === null ? "duration unknown" : `${String(dossier.durationSeconds)}s`,
    `pillar ${dossier.contentPillar ?? "unknown"}`,
    `format ${dossier.contentFormat ?? "unknown"}`,
    `hook ${dossier.hookCategory ?? "unknown"}`,
    `presenter ${dossier.presenterMode ?? "unknown"}`,
    `cta ${dossier.ctaType ?? "unknown"}`,
  ].join(" | ");

  const lines: string[] = [
    `metrics${dossier.ageWindow === null ? "" : ` (${dossier.ageWindow})`}: ${metricLine(dossier.metrics)}`,
  ];

  if (dossier.hookText) lines.push(`hook text: ${flatten(dossier.hookText, 500)}`);
  if (dossier.caption) lines.push(`caption: ${flatten(dossier.caption, 1_000)}`);
  if (dossier.transcript) {
    lines.push(`transcript: ${flatten(dossier.transcript, postDossierTranscriptCap)}`);
  }

  if (dossier.comments.length > 0) {
    const shown = dossier.comments.slice(0, postDossierCommentCap);
    // The stored total is stated beside the rendered count, so a capped list
    // does not read as the whole of what an audience said.
    lines.push(
      `comments (${String(dossier.commentCount)} stored, ${String(shown.length)} shown):`,
    );
    for (const comment of shown) {
      const likes = comment.likeCount === null ? "" : ` (${String(comment.likeCount)} likes)`;
      lines.push(`  @${comment.username ?? "unknown"}${likes}: ${flatten(comment.text, 500)}`);
    }
  } else if (dossier.commentCount === 0) {
    lines.push("comments: none imported");
  }

  return `- ${head}\n${indent(lines)}`;
}

/** Renders a set of dossiers as one block, newest first as supplied. */
export function renderPostDossiers(
  entries: readonly Readonly<{ dossier: PostDossier; key: string }>[],
): string {
  if (entries.length === 0) return "No posts with a completed analysis fall in this period.";

  return entries.map((entry) => renderPostDossier(entry.key, entry.dossier)).join("\n");
}
