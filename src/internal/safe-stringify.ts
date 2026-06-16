/**
 * Stringify a value the way `JSON.stringify` would, but tolerate circular
 * references by substituting `"[Circular]"` for any object reached for the
 * second time during traversal, and coerce `BigInt` values to their decimal
 * string (plain `JSON.stringify` throws on `BigInt`).
 *
 * Used by `ConsoleTransport` so that a binding/meta payload containing an
 * accidental cycle (e.g. a Node `IncomingMessage` with a back-reference to
 * its socket) does not throw mid-write and bring down the transport.
 *
 * @param value - anything `JSON.stringify` would accept, plus values
 *   containing cycles.
 * @returns the JSON-encoded string, with cycles collapsed to `"[Circular]"`.
 *
 * @example
 * ```ts
 * const a: Record<string, unknown> = { name: "loop" };
 * a.self = a;
 * safeStringify(a); // → '{"name":"loop","self":"[Circular]"}'
 * ```
 *
 * @see {@link ConsoleTransport.write} — the sole production caller.
 *
 * @internal
 */
export function safeStringify(value: unknown): string {
	const seen = new WeakSet<object>();

	return JSON.stringify(value, (_key, val) => {
		// BigInt has no JSON representation and would otherwise throw — coerce
		// to its decimal string so the value survives instead of being lost.
		if (typeof val === "bigint") {
			return val.toString();
		}
		if (typeof val === "object" && val !== null) {
			if (seen.has(val as object)) {
				return "[Circular]";
			}
			seen.add(val as object);
		}
		return val;
	});
}
