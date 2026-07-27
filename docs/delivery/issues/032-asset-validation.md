Backlog metadata — Priority: P0 · Size: M · Product area: Content ingestion · Target release: v1.0-internal · Parent capability: {{ISSUE:cap-content-ingestion}} [Capability] Video upload and transcript management

## Outcome

Only structurally valid, policy-compliant and decodable source videos become analysis-eligible, with safe rejection reasons and no parser/network exposure.

## Context

This issue delivers one implementation outcome within [Capability] Video upload and transcript management and follows the versioned product/technical contracts.

Relevant documentation:

* `docs/technical/video-ingestion.md`
* `docs/technical/security-and-privacy.md`

## Scope

* Implement asset validation handler that streams private objects and uses resource-limited, network-disabled ffprobe/media tooling.
* Validate length/checksum, magic/container, video stream, duration, dimensions/codecs and configured limits.
* Persist detected metadata, ready/rejected state and safe error class; keep current asset unchanged on failed replacement.
* Delete rejected/quarantined objects on policy schedule and expose cleanup hook.

## Acceptance criteria

- [ ] Zero-byte, truncated/corrupt, encrypted, no-video, MIME/container mismatch and over-limit fixtures are rejected.
- [ ] Supported fixture records detected format, duration/dimensions/codecs and becomes ready exactly once.
- [ ] Probe receives no shell-interpolated filename, network access or unbounded CPU/time/memory/output.
- [ ] Validation retry distinguishes transient object access from permanent media failure.
- [ ] Rejected object is inaccessible and scheduled for purge; safe reason contains no content/path secrets.
- [ ] Replacement failure cannot displace the current ready asset.
- [ ] Structured stage/failure/cleanup metrics and tests exist.

## Out of scope

Transcoding, automatic repair, AI analysis and broad malware platform.

## UI and content notes

There is no dedicated screen. Any surfaced state or error uses the canonical terminology and safe redacted detail defined by the parent capability.

## Implementation notes

Pin/patch media tooling and keep allowed formats narrower than Gemini until fixture-proven. Optional approved malware scan fits before ready state.

## Data and permissions

Worker service reads exact private object; metadata is workspace-owned. Never log filenames, bytes or signed URLs.

## Test notes

* Real small media fixtures plus corrupt/polyglot/resource-limit cases.
* Repeated delivery and replacement atomicity tests.
* Object outage/retry and cleanup tests.

## Dependencies

Blocked by:

* {{ISSUE:upload-storage}} Implement private object storage and signed multipart video upload
* {{ISSUE:jobs-policy}} Implement logical job states, leases, retries and idempotent handler framework

Blocks:

* {{ISSUE:source-editor}} Deliver source video association and transcript/context editor
* {{ISSUE:gemini-adapter}} Integrate paid Gemini video file and model APIs with usage controls
