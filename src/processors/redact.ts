import { redactShallow } from "@/internal/redact";
import type { ILogEvent } from "@/types/log-event.interface";
import type { IProcessor } from "@/types/processor.interface";

/**
 * Options accepted by `createRedactProcessor`.
 *
 * @see {@link createRedactProcessor}
 */
export type RedactProcessorOptions = {
	/**
	 * Top-level field names whose values get replaced with `"[REDACTED]"`.
	 * Empty array → processor is a no-op pass-through.
	 */
	keys: ReadonlyArray<string>;
};

/**
 * Build a processor that replaces sensitive top-level fields in an event's
 * `bindings` and `meta` with the `"[REDACTED]"` sentinel.
 *
 * Scope is intentionally **shallow** in MVP — nested paths (e.g.
 * `"user.password"`) are not interpreted. Future versions can opt-in to
 * dot-paths additively without breaking callers using shallow keys today.
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
	const keys = options.keys;

	return {
		name: "redact",
		process(event: ILogEvent): ILogEvent {
			const nextBindings = redactShallow(
				event.bindings as Record<string, unknown>,
				keys,
			) as ILogEvent["bindings"];
			const nextMeta = event.meta
				? (redactShallow(
						event.meta as Record<string, unknown>,
						keys,
					) as ILogEvent["meta"])
				: event.meta;

			if (nextBindings === event.bindings && nextMeta === event.meta) {
				return event;
			}

			return { ...event, bindings: nextBindings, meta: nextMeta };
		},
	};
}
