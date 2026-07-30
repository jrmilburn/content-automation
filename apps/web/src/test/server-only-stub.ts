// `server-only` throws on import outside a React Server Component, which makes
// server modules unimportable under Vitest. Tests alias the package to this
// no-op so server-side logic can be unit tested directly. The real guard still
// applies in the Next.js build, which is where a client import would be a bug.
export {};
