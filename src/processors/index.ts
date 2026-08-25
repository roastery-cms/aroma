/**
 * Barrel for `@roastery/aroma/processors`. Re-exports the bundled processor
 * factories. Custom processors live in user code and only need to satisfy
 * the `IProcessor` contract from `@roastery/aroma/types`.
 *
 * @module @roastery/aroma/processors
 *
 * @see {@link IProcessor} — implement this in your own processors.
 * @see {@link createDomainProcessor}
 * @see {@link createRedactProcessor}
 * @see {@link createEnrichProcessor}
 * @see {@link createFilterProcessor}
 * @see {@link createSampleProcessor}
 */

export { createDomainProcessor } from "@/processors/domain";
export { createEcsProcessor } from "@/processors/ecs-mapping";
export { createEnrichProcessor } from "@/processors/enrich";
export {
	createFilterProcessor,
	type FilterPredicate,
} from "@/processors/filter";
export {
	createRedactProcessor,
	type RedactProcessorOptions,
} from "@/processors/redact";
export {
	createSampleProcessor,
	type SampleRates,
} from "@/processors/sample";
