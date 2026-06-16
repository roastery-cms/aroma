/**
 * Top-level field names redacted by default whenever a logger is built
 * without explicit `redact: false`. The list covers the most commonly
 * sensitive keys seen in HTTP headers, request bodies, and configuration
 * payloads — chosen to be safe for any application without surprising the
 * caller with overzealous masking.
 *
 * Consumers who want a different set (or nothing) can either:
 *
 * - pass `redact: ["myKey", ...]` to `createAroma` — the array is **added**
 *   to these defaults
 * - pass `redact: false` to disable redaction entirely
 *
 * @see {@link createAroma}
 * @see {@link createRedactProcessor}
 */
export const DEFAULT_REDACT_KEYS = [
	"authorization",
	"cookie",
	"password",
	"token",
	"secret",
	"apiKey",
	"api_key",
] as const;
