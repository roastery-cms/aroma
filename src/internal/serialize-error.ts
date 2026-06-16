import type { ILogEvent } from "@/types/log-event.interface";

/**
 * Plain-object shape produced from a thrown `Error`. Mirrors
 * `ILogEvent["err"]` exactly, deriving the type by indexed access so the
 * two stay in lockstep automatically.
 *
 * @internal
 */
type SerializedError = NonNullable<ILogEvent["err"]>;

/**
 * Convert an `Error` instance into a plain serialisable object that survives
 * `JSON.stringify`. Recurses through `cause` so that nested error chains
 * (the `new Error("outer", { cause: inner })` pattern) are preserved
 * end-to-end.
 *
 * When `cause` is itself an `Error`, it is serialised the same way; when it
 * is any other value (string, number, plain object), it is passed through
 * unchanged so callers retain whatever shape they originally attached.
 *
 * @param err - the thrown value to serialise. Must be an `Error`; callers
 *   that hold an `unknown` should `instanceof Error` check first.
 * @returns a `{ name, message, stack, cause }` object suitable for assignment
 *   onto `ILogEvent.err`.
 *
 * @example
 * ```ts
 * const inner = new Error("disk full");
 * const outer = new Error("upload failed", { cause: inner });
 * serializeError(outer);
 * // → { name: "Error", message: "upload failed", stack: "...",
 * //     cause: { name: "Error", message: "disk full", stack: "...", cause: undefined } }
 * ```
 *
 * @see {@link ILogEvent.err} — destination of the returned shape.
 *
 * @internal
 */
export function serializeError(err: Error): SerializedError {
	const cause = (err as { cause?: unknown }).cause;

	return {
		name: err.name,
		message: err.message,
		stack: err.stack,
		cause: cause instanceof Error ? serializeError(cause) : cause,
	};
}
