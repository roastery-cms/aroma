import { CoreException } from "@roastery/terroir/exceptions/core";
import { UnknownException } from "@roastery/terroir/exceptions";
import { ExceptionLayer } from "@roastery/terroir/exceptions/symbols";
import type { ILogEvent } from "@/types/log-event.interface";

/**
 * Plain-object shape produced from a thrown value. Mirrors `ILogEvent["err"]`
 * exactly, deriving the type by indexed access so the two stay in lockstep
 * automatically.
 *
 * @internal
 */
type SerializedError = NonNullable<ILogEvent["err"]>;

/**
 * Normalise any thrown value to the serialised shape of a `terroir`
 * `CoreException` and return a plain, JSON-safe object (a raw `Error`
 * instance survives `JSON.stringify` as `{}` because its fields are
 * non-enumerable — this is what reconstitutes them as data).
 *
 * - A value that already derives from `CoreException` (any layer) is
 *   serialised as-is, preserving its `name`, `source` and `[ExceptionLayer]`.
 * - Anything else — a native `Error`, or a non-`Error` value caught in a
 *   `catch (e: unknown)` block — is wrapped in an `UnknownException`
 *   (`source: "$internal"`, `layer: "internal"`); the original value is kept
 *   under `cause` so nothing is lost.
 *
 * `cause` is serialised recursively: an `Error` / `CoreException` cause becomes
 * a nested plain object, any other value is passed through unchanged.
 *
 * @param value - the thrown value to serialise; accepts `unknown`.
 * @returns a `{ name, message, stack, source, layer, cause }` object suitable
 *   for assignment onto `ILogEvent.err`.
 *
 * @example
 * ```ts
 * serializeError(new TypeError("bad"));
 * // → { name: "Unknown Error", message: "bad", source: "$internal",
 * //     layer: "internal", stack: "...",
 * //     cause: { name: "TypeError", message: "bad", stack: "..." } }
 * ```
 *
 * @see {@link ILogEvent.err} — destination of the returned shape.
 *
 * @internal
 */
export function serializeError(value: unknown): SerializedError {
	const exc = value instanceof CoreException ? value : wrapUnknown(value);
	return fromCoreException(exc);
}

/**
 * Wrap a non-`CoreException` value in an `UnknownException`, keeping the
 * original under `cause`. The wrapper's `message` mirrors the source error's
 * message (or `String(value)` for non-`Error` values).
 */
function wrapUnknown(value: unknown): UnknownException {
	const message = value instanceof Error ? value.message : String(value);
	const wrapped = new UnknownException(message);
	(wrapped as { cause?: unknown }).cause = value;
	return wrapped;
}

/**
 * Serialise a `CoreException` to the canonical top-level shape — the only
 * variant that carries `source` and `layer`.
 */
function fromCoreException(exc: CoreException): SerializedError {
	return {
		name: exc.name,
		message: exc.message,
		stack: exc.stack,
		source: exc.source,
		layer: exc[ExceptionLayer],
		cause: serializeCause((exc as { cause?: unknown }).cause),
	};
}

/**
 * Recursively serialise a `cause`. A `CoreException` keeps its `source` /
 * `layer`; a native `Error` is reduced to `name` / `message` / `stack`; any
 * other value passes through unchanged.
 */
function serializeCause(cause: unknown): unknown {
	if (cause instanceof CoreException) {
		return fromCoreException(cause);
	}
	if (cause instanceof Error) {
		return {
			name: cause.name,
			message: cause.message,
			stack: cause.stack,
			cause: serializeCause((cause as { cause?: unknown }).cause),
		};
	}
	return cause;
}
