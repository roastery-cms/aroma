import { conversionFailed } from "@/internal/conversion-failure";
import { brandAsMasking } from "@/internal/masks-keys";
import { createRedactPlan } from "@/internal/redact";
import { MAX_WALK_DEPTH, walkRecord } from "@/internal/safe-walk";
import type { ILogEvent } from "@/types/log-event.interface";
import type { IProcessor } from "@/types/processor.interface";

/**
 * The field names `createRedactProcessor` is most often pointed at — the ones
 * that carry a secret in almost every codebase.
 *
 * @remarks
 * Until 0.0.3 these were applied automatically by `createAroma`. They are now
 * a starting list you opt into, because the domain layer is what actually
 * knows a field is sensitive and a key-name list duplicates that knowledge
 * imperfectly. They remain worth having for everything the domain layer never
 * sees: a Node request, a third-party API response, a DTO on its way in.
 *
 * @example
 * ```ts
 * import { createRedactProcessor, DEFAULT_REDACT_KEYS } from "@roastery/aroma/processors";
 *
 * createAroma({
 *   processors: [
 *     createRedactProcessor({ keys: [...DEFAULT_REDACT_KEYS, "customSecret"] }),
 *   ],
 * });
 * ```
 *
 * @since 0.1.0
 *
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

/**
 * Options accepted by `createRedactProcessor`.
 *
 * @since 0.0.1
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
	 * How many levels deep to look. Defaults to {@link MAX_WALK_DEPTH}, the
	 * depth shared with the domain conversion.
	 *
	 * @remarks
	 * `1` restricts masking to the top level, which is the escape hatch for a
	 * consumer who depends on seeing nested fields in the clear.
	 *
	 * @since 0.1.0
	 */
	maxDepth?: number;
};

/**
 * Build a processor that replaces sensitive fields in an event's `bindings`,
 * `meta` and `err.cause` with the configured redaction placeholder.
 *
 * @remarks
 * **This is opt-in.** `createAroma` injects the domain processor and nothing
 * else: `@roastery/beans` objects are converted through `toSafeJSON()`,
 * because the domain layer is what knows which of its fields are sensitive,
 * but a plain `{ password: "hunter2" }` is written out verbatim unless you add
 * this processor. Until 0.0.3 it was injected automatically.
 *
 * Add it when your payloads include things the domain layer never modelled —
 * which is most of what an HTTP service logs:
 *
 * - a Node request: `{ req: { headers: { authorization } } }`
 * - a third-party response: `{ stripe: { token } }`
 * - a DTO that has not been validated into value objects yet
 * - a plain object handed to `new BadRequestException(…, { cause })`
 *
 * Scope is **deep** by key name: a listed key is masked wherever it appears,
 * to {@link RedactProcessorOptions.maxDepth} levels. Dot-path *targeting*
 * (`"user.password"`) is not interpreted — keys match by name at any depth,
 * which is the behaviour that cannot be got wrong by omission.
 *
 * `err`'s canonical fields (`name`, `message`, `stack`, `source`, `layer`,
 * `code`) are never touched — a key list containing `"message"` must not erase
 * the error's own — but `err.cause` is traversed.
 *
 * @param options - redaction configuration; `keys` lists field names to mask.
 * @returns an `IProcessor` ready to be inserted in the pipeline.
 *
 * @example
 * ```ts
 * import { createAroma } from "@roastery/aroma";
 * import { createRedactProcessor, DEFAULT_REDACT_KEYS } from "@roastery/aroma/processors";
 *
 * const log = createAroma({
 *   processors: [createRedactProcessor({ keys: [...DEFAULT_REDACT_KEYS] })],
 * });
 * ```
 *
 * @since 0.0.1
 *
 * @see {@link IProcessor}
 * @see {@link DEFAULT_REDACT_KEYS}
 * @see {@link createDomainProcessor} — the domain-object half, injected by default.
 */
export function createRedactProcessor(
	options: RedactProcessorOptions,
): IProcessor {
	// Built once, not per event: constructing a seven-element Set inside the
	// traversal cost 248 ns an event — more than the traversal itself.
	const keys: ReadonlySet<string> = new Set(options.keys);
	const maxDepth = options.maxDepth ?? MAX_WALK_DEPTH;
	const plan = createRedactPlan(keys, maxDepth);
	// `err.cause` is wrapped in a record to reuse the same walk, which spends a
	// level on the wrapper.
	const causePlan = createRedactPlan(keys, maxDepth + 1);

	// Branded so `createAroma` can tell that this pipeline has key-name masking
	// in it, without matching on the free-form `name`.
	return brandAsMasking({
		name: "redact",
		process(event: ILogEvent): ILogEvent {
			// Independently, for the same reason the domain processor does it: a
			// hostile getter in one record must not cost the other, or the line.
			let nextBindings: ILogEvent["bindings"];
			try {
				nextBindings = walkRecord(
					event.bindings as Record<string, unknown>,
					plan,
				) as ILogEvent["bindings"];
			} catch (reason) {
				nextBindings = conversionFailed(reason) as ILogEvent["bindings"];
			}

			let nextMeta: ILogEvent["meta"];
			try {
				nextMeta = event.meta
					? (walkRecord(
							event.meta as Record<string, unknown>,
							plan,
						) as ILogEvent["meta"])
					: event.meta;
			} catch (reason) {
				nextMeta = conversionFailed(reason) as ILogEvent["meta"];
			}

			let nextErr: ILogEvent["err"];
			try {
				nextErr = redactErr(event.err, causePlan);
			} catch {
				// `err`'s canonical fields are the diagnostic; keep them rather than
				// blank them, and drop only the cause that could not be walked.
				nextErr = event.err ? { ...event.err, cause: undefined } : event.err;
			}

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
	});
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
	causePlan: ReturnType<typeof createRedactPlan>,
): ILogEvent["err"] {
	if (!err || err.cause === undefined) {
		return err;
	}

	// `cause` is a value, not a record, so it is wrapped to reuse the same
	// traversal — including the top-level key check, which is what catches
	// `{ cause: { password } }`.
	const wrapped = { cause: err.cause };
	const redacted = walkRecord(wrapped, causePlan);

	return redacted === wrapped ? err : { ...err, cause: redacted.cause };
}
