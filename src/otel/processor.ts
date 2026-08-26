import { getActiveTraceContext } from "@/otel/trace-context";
import type { ILogEvent } from "@/types/log-event.interface";
import type { IProcessor } from "@/types/processor.interface";

/**
 * Build a processor that injects the active OpenTelemetry trace context
 * (`trace_id`, `span_id`, `trace_flags`) into each event's `bindings`,
 * when a span is on the call stack.
 *
 * When no OTel API is installed (or no span is active), the processor is
 * a pass-through — never throws, never adds keys.
 *
 * The injected fields use snake_case to match the OTel Logs Data Model
 * naming convention; aggregators that auto-detect OTel correlation
 * (Grafana Tempo, Honeycomb, Datadog APM) pick them up without extra
 * mapping.
 *
 * @returns an `IProcessor` ready to be inserted in the pipeline.
 *
 * @example
 * ```ts
 * import { createAroma } from "@roastery/aroma";
 * import { createOtelProcessor, primeOtel } from "@roastery/aroma/otel";
 *
 * await primeOtel();
 *
 * const log = createAroma({
 *   processors: [createOtelProcessor()],
 * });
 *
 * // Inside an OTel span, log events automatically carry trace_id/span_id.
 * ```
 *
 * @since 0.0.1
 *
 * @see {@link getActiveTraceContext}
 */
export function createOtelProcessor(): IProcessor {
	return {
		name: "otel",
		process(event: ILogEvent): ILogEvent {
			const ctx = getActiveTraceContext();
			if (!ctx) return event;
			return {
				...event,
				bindings: {
					...event.bindings,
					trace_id: ctx.traceId,
					span_id: ctx.spanId,
					trace_flags: ctx.traceFlags,
				},
			};
		},
	};
}
