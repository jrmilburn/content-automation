# Video ingestion and source context

## Goals

Provide durable, private and replaceable source video for an imported post; support optional transcript/script/context; make only validated versions eligible for analysis; and delete data predictably.

## Upload design

1. The authenticated browser asks to create an upload intent for a post.
2. The server loads the post by current workspace, checks permission/state and creates a random workspace-prefixed object key.
3. The server returns short-lived S3-compatible multipart instructions scoped to that exact key, declared byte limit and content type. It never returns storage credentials.
4. The browser uploads directly with progress and retry/resume for multipart parts.
5. Completion sends the upload intent, object version/etag and checksum; the server verifies object metadata and creates a pending `VideoAsset` version.
6. A worker streams the object into an isolated media probe, validates it, and only then marks it `ready`.
7. The post’s current asset pointer changes only after validation. A failed replacement leaves the old current asset untouched.

## Importing the post’s own Instagram video

A user may instead ask for the post’s own video to be copied from Instagram, which is offered wherever upload is offered and only for a post whose media is a video. It exists because the alternative in practice is that posts stay unanalysed while their video sits in Instagram already.

1. The request only enqueues; the worker owns the provider call and the transfer.
2. The worker reads the media node for a **fresh** `media_url`. The URL is never stored: Meta re-signs it on every request, so a kept value is one that has already started refusing.
3. Bytes are read only from Meta’s media CDN hosts, over HTTPS, with every redirect hop re-checked against the same allowlist and no credential attached — the signed URL is the authorisation, and the bearer token has no business reaching a CDN.
4. The transfer is bounded by `UPLOAD_MAX_BYTES` and fails mid-stream rather than storing more, so a response that lies about its length cannot be written in full.
5. The object key is derived from the importing job rather than minted per attempt, so a retry overwrites its own earlier bytes instead of orphaning them where no row points and no purge sweep looks.
6. The asset is created `PENDING_VALIDATION` with origin `PROVIDER_IMPORT`, and the ordinary `asset.validate` job decides whether it is analysable. An imported file gets no more trust than one a person chose.
7. The asset is anchored on the importing job, uniquely. That is what the unique upload intent does for an upload: a redelivered import resolves to the asset it already produced instead of downloading the video again.

The imported copy is Instagram’s delivery re-encode, not the master. That is a real limitation and is stated in the interface rather than hidden: a reader comparing quality needs to know which one they are looking at.

## Proposed v1 validation policy

Configuration, not client code, owns limits. Launch defaults to confirm with Studio Parallel:

- Maximum 1 GiB per file and 20 minutes duration.
- Allowed declared/detected containers: MP4, QuickTime/MOV and WebM.
- Allowed video codecs initially H.264/H.265/VP9/AV1 only when the deployed probe and Gemini contract fixture successfully decode them; audio AAC/Opus where present.
- Reject zero-byte, container/extension mismatch, encrypted, undecodable, no-video-stream and duration/dimension values outside configured bounds.
- Verify server-observed length, magic bytes/container and cryptographic checksum; browser MIME is advisory.
- Run `ffprobe` with CPU/time/memory/output limits and no network access. Never interpolate filenames into a shell.
- Sanitize display names; object keys never contain the original filename.

Gemini currently accepts MP4, MPEG, MOV, AVI, FLV, MPG, WebM, WMV and 3GPP, but the product intentionally exposes a smaller browser/operations-tested set. See Google’s [video understanding formats and constraints](https://ai.google.dev/gemini-api/docs/video-understanding).

Virus/malware scanning is defence in depth. At minimum, keep uploads private/quarantined until structural validation, use a sandboxed current decoder, block executable/polyglot mismatches and scan with the organisation-approved service if available. Scan failures do not publish the asset.

## Object storage policy

- One private bucket/prefix per environment; production objects never exist in preview/dev.
- Public access disabled at account and bucket level.
- Server-side encryption enabled; provider-managed keys are acceptable for v1 unless policy requires customer-managed keys.
- Object versioning enabled where cost permits; lifecycle removes abandoned multipart uploads and quarantined failures.
- Short-lived signed upload/download URLs (proposed 15 minutes); downloads require a fresh server authorisation.
- CORS allows only the deployed application origins and required multipart methods/headers.
- Store bucket, region, object version, ETag, bytes and checksum; an ETag is not treated as a cryptographic checksum.
- A source asset records its origin. `USER_UPLOAD` is the master the account owner holds. `PROVIDER_IMPORT` is a copy of the file Instagram serves for the same post, fetched by the server on explicit request. The two are validated identically and only one of them is the original, so the difference is stored rather than inferred and is stated wherever an asset is shown.
- Only one server-side write path exists, and it is the import. Every other object arrives through a browser's signed part upload. The server-side write is multipart under the hood so no object is ever held in memory to be stored, it sets the same server-side encryption, and a failed or aborted transfer leaves no object addressable at the key.

## Transcript and context editing

One post can have multiple transcript revisions and one current revision. Editable fields are:

- transcript text and source (`user`, `gemini`, `imported`, `none`);
- language when known;
- optional original script;
- intended audience;
- content objective;
- internal notes;
- controlled content-category tags plus optional freeform tags if approved.

Saving creates a revision when meaningful content changes. Analyse uses an explicit transcript revision ID and input hash, so edits never mutate historical analysis provenance. A user-provided transcript is included as contextual evidence but Gemini still evaluates audio and may report divergence; it does not silently overwrite the user text. Model-extracted transcript can be saved separately only after validation and with its source label.

Apply text length limits, normalise line endings, render as text (never HTML), and exclude content from logs/search analytics unless explicitly enabled.

## Association rules

- A source asset always belongs to exactly one imported post in v1.
- Association commands load both resource and workspace server-side; the client cannot submit an arbitrary object key.
- A post may have one current ready asset, multiple historical/rejected versions and at most one pending replacement intent.
- Changing the current asset makes the current analysis stale but does not delete it.
- A transcript revision belongs to the same post; cross-post revision IDs are rejected.
- Bulk orphan matching and automatic CDN/video fingerprint matching are out of scope. The user chooses the post.

## Analysis handoff

The analysis worker obtains the current asset version and selected transcript/context within one database read transaction, then records their IDs and hashes on the logical job. It streams the private object server-side to Gemini’s File API (recommended for significant/reusable files) rather than issuing a broadly accessible public URL.

Google's Files API usage page currently documents a 2 GB per-file and 20 GB per-project allowance, files stored for 48 hours, and explicit delete support ([Files API](https://ai.google.dev/gemini-api/docs/files)); its video-input guide separately advertises a higher paid file limit. The proposed 1 GiB product cap stays below both, and implementation must verify the paid project's effective limit. The worker polls until `ACTIVE`/`FAILED`, records the provider file name/expiry, and deletes the temporary file after terminal job handling when practical. Cleanup has an independent retry/reconciliation path.

## UI behaviour

- Drop/select area clearly states formats and maximum before selection.
- Progress distinguishes browser upload, server validation and ready state.
- Network failure offers resume/retry without duplicate versions.
- Rejected files show a safe reason and retain no playable signed link.
- Replace explains that existing analysis will become stale; current asset stays until replacement validates.
- Delete explains downstream impact and requires confirmation; focus moves to the status summary after completion.
- Mobile can select/upload and edit transcript, but large uploads warn about connection stability and remain resumable.

## Retention and deletion

Proposed policy pending owner approval:

- Abandoned upload intents/multipart parts: 24 hours.
- Rejected/quarantined objects: delete within 24 hours after diagnostic metadata is captured.
- Gemini temporary files: delete immediately after terminal handling; provider auto-expiry is backup, not the cleanup mechanism.
- Original source videos: retain while the associated post is active, with an explicit delete action; revisit a fixed retention window after cost measurement.
- Superseded assets: 30-day recovery window, then purge unless referenced by a retained analysis and policy requires reproducibility.
- Transcript/script/notes: retain with post until explicit deletion/account erase.

Deletion enters `deletion_pending`, revokes new signed access and jobs, cancels pending analysis for that asset, deletes object versions/temporary Gemini files, clears current pointers and tombstones metadata. The approved policy must decide whether derived analysis content is retained with input hashes or purged; the UI must state the choice. All outcomes are audited and reconciled.

## Observability and tests

Record upload/validation stage timing, bytes, detected format (not filename/content), failure class, cleanup lag, storage bytes and correlation IDs. Tests cover signed-scope authorisation, crafted post/object IDs, expiry, multipart resume/deduplication, magic-byte mismatch, corrupt/truncated media, probe timeout, replacement atomicity, deletion and object-provider failures using non-sensitive fixtures.
