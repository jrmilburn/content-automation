# Deterministic test fixtures

Fixtures in this repository must be synthetic or explicitly rights-cleared. They must never contain production tokens, signed URLs, private videos, transcripts, provider payloads, personally identifiable information or copied internal content.

- Use fixed UUIDs, timestamps and timezones; make workspace ownership explicit.
- Record random seeds and clocks when generated values are necessary.
- Represent provider failures with minimal fabricated shapes, not captured raw responses.
- Keep binary/video fixtures outside the public CI artifact path unless a later issue establishes a restricted rights-cleared test bucket.
- Test reports may contain test names and redacted errors only. Browser traces, screenshots and video are disabled in pull-request CI.

When a provider contract fixture is eventually based on a sandbox response, sanitise it before committing and document the source API/model version without retaining identifiers or content.
