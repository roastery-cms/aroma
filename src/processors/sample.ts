import type { ILogEvent } from "@/types/log-event.interface";
import type { LogLevel } from "@/types/log-level";
import type { IProcessor } from "@/types/processor.interface";

/**
 * Per-level sampling rates. Each rate is a probability in `[0, 1]` — `0.01`
 * keeps 1% of events at that level. Levels absent from the map are **not
 * sampled** (kept 100%).
 *
 * @since 0.0.1
 *
 * @see {@link createSampleProcessor}
 */
export type SampleRates = Partial<Record<LogLevel, number>>;

/**
 * Build a processor that drops events probabilistically based on the
 * supplied per-level rate map. The most common use is sampling `trace`
 * and `debug` in production to keep volume manageable while still
 * preserving observability into hot code paths.
 *
 * Rates outside `[0, 1]` are clamped: `<= 0` always drops, `>= 1` always
 * keeps. Missing levels keep 100%.
 *
 * @param rates - per-level keep-probability map.
 * @returns an `IProcessor` ready to be inserted in the pipeline.
 *
 * @example
 * ```ts
 * import { createSampleProcessor } from "@roastery/aroma/processors";
 *
 * const processors = [
 *   createSampleProcessor({ trace: 0.01, debug: 0.1 }),
 *   // info/warn/error/fatal kept 100%
 * ];
 * ```
 *
 * @since 0.0.1
 *
 * @see {@link IProcessor}
 */
export function createSampleProcessor(rates: SampleRates): IProcessor {
	return {
		name: "sample",
		process(event: ILogEvent): ILogEvent | null {
			const rate = rates[event.level];
			if (rate === undefined) return event;
			if (rate <= 0) return null;
			if (rate >= 1) return event;
			return Math.random() < rate ? event : null;
		},
	};
}
