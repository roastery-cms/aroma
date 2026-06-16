/**
 * Barrel for `@roastery/aroma/otel`. OpenTelemetry correlation as an
 * opt-in subpath — importing it does not pull `@opentelemetry/api` into
 * the core bundle. The peer dependency is declared as **optional**, so
 * consumers without OTel pay zero cost.
 *
 * @module @roastery/aroma/otel
 *
 * @example
 * ```ts
 * import { createAroma } from "@roastery/aroma";
 * import { createOtelProcessor, primeOtel } from "@roastery/aroma/otel";
 *
 * await primeOtel(); // resolve the lazy import once at boot
 *
 * const log = createAroma({
 *   processors: [createOtelProcessor()],
 * });
 * ```
 *
 * @see {@link createOtelProcessor}
 * @see {@link getActiveTraceContext}
 * @see {@link primeOtel}
 */

export { createOtelProcessor } from "@/otel/processor";
export {
	_resetOtelCache,
	_setOtelApiForTest,
	type ActiveTraceContext,
	getActiveTraceContext,
	primeOtel,
} from "@/otel/trace-context";
