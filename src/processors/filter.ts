import type { ILogEvent } from "@/types/log-event.interface";
import type { IProcessor } from "@/types/processor.interface";

/**
 * Predicate evaluated against each event to decide whether it passes
 * through the pipeline. Return `true` to keep, `false` to drop.
 *
 * @since 0.0.1
 *
 * @see {@link createFilterProcessor}
 */
export type FilterPredicate = (event: ILogEvent) => boolean;

/**
 * Build a processor that drops events failing a user-supplied predicate.
 * The predicate runs once per event, synchronously, before any transport
 * receives the event.
 *
 * Typical uses:
 *
 * - Suppress noisy probes: `(e) => e.bindings?.healthcheck !== true`
 * - Production allow-list: `(e) => e.level !== "trace"`
 * - Tenant-aware muting: `(e) => allowedTenants.has(e.bindings?.tenantId)`
 *
 * @param predicate - returns `true` to keep the event, `false` to drop it.
 * @returns an `IProcessor` ready to be inserted in the pipeline.
 *
 * @example
 * ```ts
 * import { createFilterProcessor } from "@roastery/aroma/processors";
 *
 * const processors = [
 *   createFilterProcessor((e) => e.bindings.route !== "/healthz"),
 * ];
 * ```
 *
 * @since 0.0.1
 *
 * @see {@link IProcessor}
 */
export function createFilterProcessor(predicate: FilterPredicate): IProcessor {
	return {
		name: "filter",
		process(event: ILogEvent): ILogEvent | null {
			return predicate(event) ? event : null;
		},
	};
}
