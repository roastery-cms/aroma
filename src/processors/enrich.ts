import type { Bindings } from "@/types/bindings";
import type { ILogEvent } from "@/types/log-event.interface";
import type { IProcessor } from "@/types/processor.interface";

/**
 * Build a processor that merges a fixed set of fields into every event's
 * `bindings`. Useful for attaching service-wide identifiers (service name,
 * version, environment, region) without having to set them on every
 * `createAroma` call or `child` invocation.
 *
 * Fields from the incoming event's `bindings` **override** the enrichment
 * defaults on key collision — the more specific (per-instance) context
 * wins over the less specific (global) one.
 *
 * @param extras - the bindings to merge into every event.
 * @returns an `IProcessor` ready to be inserted in the pipeline.
 *
 * @example
 * ```ts
 * import { createEnrichProcessor } from "@roastery/aroma/processors";
 *
 * const processors = [
 *   createEnrichProcessor({
 *     service: "checkout-api",
 *     version: pkg.version,
 *     environment: process.env.NODE_ENV,
 *   }),
 * ];
 * ```
 *
 * @since 0.0.1
 *
 * @see {@link IProcessor}
 */
export function createEnrichProcessor(extras: Bindings): IProcessor {
	return {
		name: "enrich",
		process(event: ILogEvent): ILogEvent {
			return {
				...event,
				bindings: { ...extras, ...event.bindings },
			};
		},
	};
}
