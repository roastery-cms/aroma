/**
 * The key a bundled processor writes when it could not convert a record.
 *
 * Prefixed so it cannot collide with a caller's field, and readable in a log
 * line without a legend — someone reading `"$aroma.error"` in production knows
 * which package to blame.
 *
 * @internal
 */
export const CONVERSION_ERROR_KEY = "$aroma.error";

/**
 * Stand in for a record whose conversion threw.
 *
 * @remarks
 * `Logger.emit` discards the whole event when a processor throws, and that is
 * the right default for a processor it knows nothing about: one that failed
 * midway leaves the event indeterminate, possibly still holding what a
 * redaction step had not finished redacting.
 *
 * The bundled processors can do better, because they know exactly which half
 * failed. They convert `bindings` and `meta` independently, so a hostile getter
 * in `meta` costs `meta` and not the line — the message, the level, the error
 * and the other record all survive. What is *not* forwarded is the
 * half-converted record, which is the part nobody can vouch for.
 *
 * This became worth doing when the walk started descending into class
 * instances: an own enumerable accessor that throws, or a `Proxy` with a
 * hostile trap, is now reachable from an ordinary `log.info`.
 *
 * @param reason - whatever was thrown.
 * @returns a one-key record naming the failure.
 *
 * @internal
 */
export function conversionFailed(reason: unknown): Record<string, unknown> {
	return {
		[CONVERSION_ERROR_KEY]:
			reason instanceof Error
				? `conversion failed: ${reason.message}`
				: `conversion failed: ${String(reason)}`,
	};
}
