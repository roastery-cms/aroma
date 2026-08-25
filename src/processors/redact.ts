import { DEFAULT_REDACT_MAX_DEPTH, redactDeep } from "@/internal/redact";
import type { ILogEvent } from "@/types/log-event.interface";
import type { IProcessor } from "@/types/processor.interface";

/**
 * Options accepted by `createRedactProcessor`.
 *
 * @see {@link createRedactProcessor}
 */
export type RedactProcessorOptions = {
	/**
	 * Field names whose values get replaced with the configured placeholder,
	 * wherever they appear in `bindings`, `meta` or `err.cause`. Empty array →
	 * processor is a no-op pass-through.
	 */
	keys: ReadonlyArray<string>;
	/**
	 * How many levels deep to look. Defaults to
	 * {@link DEFAULT_REDACT_MAX_DEPTH}.
	 *
	 * @remarks
	 * `1` restores the historical top-level-only behaviour exactly, which is
	 * the escape hatch for a consumer who depends on seeing nested fields in
	 * the clear.
	 */
	maxDepth?: number;
};

/**
 * Build a processor that replaces sensitive fields in an event's `bindings`,
 * `meta` and `err.cause` with the configured redaction placeholder.
 *
 * @remarks
 * Scope is **deep** by key name: a listed key is masked wherever it appears,
 * to {@link RedactProcessorOptions.maxDepth} levels. The top-level-only
 * behaviour it replaces left the commonest shape in an HTTP service exposed —
 * `{ req: { headers: { authorization } } }` keeps its secret three levels
 * down, and no domain processor reaches it because a Node request is not a
 * `beans` object. Dot-path *targeting* (`"user.password"`) is still not
 * interpreted: keys match by name at any depth, which is the behaviour that
 * cannot be got wrong by omission.
 *
 * `err`'s canonical fields (`name`, `message`, `stack`, `source`, `layer`,
 * `code`) are never touched — a key list containing `"message"` must not erase
 * the error's own — but `err.cause` is traversed, since a plain object handed
 * to `new BadRequestException(…, { cause })` is as good a hiding place as any.
 *
 * @param options - redaction configuration; `keys` lists field names to mask.
 * @returns an `IProcessor` ready to be inserted in the pipeline.
 *
 * @example
 * ```ts
 * import { createRedactProcessor } from "@roastery/aroma/processors";
 *
 * const processors = [
 *   createRedactProcessor({ keys: ["password", "token"] }),
 * ];
 * ```
 *
 * @see {@link IProcessor}
 * @see {@link DEFAULT_REDACT_KEYS}
 */
export function createRedactProcessor(
	options: RedactProcessorOptions,
): IProcessor {
	// Built once, not per event: constructing a seven-element Set inside the
	// traversal cost 248 ns an event — more than the traversal itself.
	const keys: ReadonlySet<string> = new Set(options.keys);
	const maxDepth = options.maxDepth ?? DEFAULT_REDACT_MAX_DEPTH;

	return {
		name: "redact",
		process(event: ILogEvent): ILogEvent {
			const nextBindings = redactDeep(
				event.bindings as Record<string, unknown>,
				keys,
				maxDepth,
			) as ILogEvent["bindings"];
			const nextMeta = event.meta
				? (redactDeep(
						event.meta as Record<string, unknown>,
						keys,
						maxDepth,
					) as ILogEvent["meta"])
				: event.meta;
			const nextErr = redactErr(event.err, keys, maxDepth);

			if (
				nextBindings === event.bindings &&
				nextMeta === event.meta &&
				nextErr === event.err
			) {
				return event;
			}

			return {
				...event,
				bindings: nextBindings,
				meta: nextMeta,
				err: nextErr,
			};
		},
	};
}

/**
 * Redact inside a serialised error without disturbing its canonical shape.
 *
 * Only `cause` is traversed. The other fields are the error's identity, and
 * a key list that happened to contain `"message"` or `"stack"` must not blank
 * them — that would destroy the diagnostic while protecting nothing.
 */
function redactErr(
	err: ILogEvent["err"],
	keys: ReadonlySet<string>,
	maxDepth: number,
): ILogEvent["err"] {
	if (!err || err.cause === undefined) {
		return err;
	}

	// `cause` is a value, not a record, so it is wrapped to reuse the same
	// traversal — including the top-level key check, which is what catches
	// `{ cause: { password } }`.
	const wrapped = { cause: err.cause };
	const redacted = redactDeep(wrapped, keys, maxDepth + 1);

	return redacted === wrapped ? err : { ...err, cause: redacted.cause };
}
