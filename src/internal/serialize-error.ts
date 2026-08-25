import { UnknownException } from "@roastery/terroir/exceptions";
import { CoreException } from "@roastery/terroir/exceptions/core";
import { ApplicationException } from "@roastery/terroir/exceptions/models";
import { Layer } from "@roastery/terroir/symbols";
import { domainSafeValue } from "@/internal/domain-safe";
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
 *   serialised as-is, preserving its `name`, `source` and `[Layer]`.
 * - Anything else — a native `Error`, or a non-`Error` value caught in a
 *   `catch (e: unknown)` block — is wrapped in an `UnknownException`
 *   (`source: "$internal"`, `layer: "internal"`); the original value is kept
 *   under `cause` so nothing is lost.
 *
 * An `ApplicationException` additionally carries its `code` — the HTTP status
 * the terroir hierarchy declares as an abstract field on that layer alone.
 *
 * `cause` is serialised recursively: an `Error` / `CoreException` cause becomes
 * a nested plain object, a `@roastery/beans` domain object becomes its safe
 * form, and any other value is passed through unchanged.
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
	return new UnknownException(message, { cause: value });
}

/**
 * Serialise a `CoreException` to the canonical top-level shape — the only
 * variant that carries `source` and `layer`.
 *
 * `code` is emitted for the application layer only: `ApplicationException`
 * declares it as an abstract member, so every concrete application exception
 * has one, and carrying it preserves the hierarchy rather than promoting an
 * ad-hoc own-property.
 */
function fromCoreException(exc: CoreException): SerializedError {
	const serialized: SerializedError = {
		name: exc.name,
		message: exc.message,
		stack: exc.stack,
		source: exc.source,
		layer: exc[Layer],
		cause: serializeCause((exc as { cause?: unknown }).cause),
	};

	if (exc instanceof ApplicationException) {
		serialized.code = exc.code;
	}

	return serialized;
}

/**
 * Recursively serialise a `cause`. A `CoreException` keeps its `source` /
 * `layer`; a native `Error` is reduced to `name` / `message` / `stack`; a
 * domain object is reduced to its safe form; any other value passes through
 * unchanged.
 *
 * @remarks
 * The domain conversion has to happen **here**, not in the domain processor.
 * `serializeError` runs inside `Logger.emit` *before* the processor pipeline,
 * so `err.cause` is the one path into a log line that the processor never
 * sees — and terroir 0.2 actively encourages putting the original failure
 * there (`CoreException`'s own TSDoc says to translate a low-level failure by
 * passing it as `cause`). Without this, `new BadRequestException("checkout",
 * "…", { cause: user })` writes the password out.
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
	return domainSafeValue(cause, "cause");
}
