import { FORMATTED } from "@/internal/formatted";
import type { ILogEvent } from "@/types/log-event.interface";
import type { IProcessor } from "@/types/processor.interface";

/**
 * Build a processor that remaps the canonical `ILogEvent` fields onto the
 * field names defined by the
 * [Elastic Common Schema](https://www.elastic.co/guide/en/ecs/current/index.html)
 * (ECS). The output object stays plain JSON — only the keys change — so
 * any transport can emit ECS-ready logs.
 *
 * Field mapping:
 *
 * | aroma            | ECS                  |
 * |------------------|----------------------|
 * | `level`          | `log.level`          |
 * | `time` (ms)      | `@timestamp` (ISO 8601) |
 * | `msg`            | `message`            |
 * | `bindings`       | spread at the root   |
 * | `meta`           | spread at the root   |
 * | `err.name`       | `error.type`         |
 * | `err.message`    | `error.message`      |
 * | `err.stack`      | `error.stack_trace`  |
 *
 * Because the processor reshapes the event structurally, it **must run
 * last** in the pipeline — after redact / enrich / otel. This is a
 * convention, not enforced at runtime: a processor placed *after* this one
 * receives the already-reshaped event (no `bindings` / `meta` / `msg` keys,
 * with `level` / `time` and the internal format brand stored as
 * non-enumerable properties). Any such processor that spreads the event
 * (`{ ...event }`) silently strips the brand and routing fields, reverting
 * the ECS mapping — so keep ECS strictly last.
 *
 * @returns an `IProcessor` ready to be inserted at the **end** of the
 *   pipeline.
 *
 * @example
 * ```ts
 * import { createAroma } from "@roastery/aroma";
 * import { createEcsProcessor } from "@roastery/aroma/processors";
 *
 * const log = createAroma({
 *   processors: [
 *     // …other processors first
 *     createEcsProcessor(),
 *   ],
 * });
 * ```
 *
 * @see {@link IProcessor}
 */
export function createEcsProcessor(): IProcessor {
	return {
		name: "ecs",
		process(event: ILogEvent): ILogEvent {
			const out: Record<string, unknown> = {
				"@timestamp": new Date(event.time).toISOString(),
				log: { level: event.level },
				...event.bindings,
				...(event.meta ?? {}),
			};
			if (event.msg !== undefined) {
				out.message = event.msg;
			}
			if (event.err) {
				out.error = {
					type: event.err.name,
					message: event.err.message,
					stack_trace: event.err.stack,
				};
			}
			// Keep canonical `level`/`time` readable for in-process transport
			// routing (FastStdio/Console route error/fatal to stderr) without
			// leaking them into the ECS output line — non-enumerable props are
			// skipped by `JSON.stringify`, so the emitted document stays pure ECS.
			Object.defineProperty(out, "level", {
				value: event.level,
				enumerable: false,
				writable: true,
				configurable: true,
			});
			Object.defineProperty(out, "time", {
				value: event.time,
				enumerable: false,
				writable: true,
				configurable: true,
			});
			// Brand the event so `serializeEvent` emits this remapped object
			// verbatim instead of dropping the ECS-shaped keys it doesn't know.
			Object.defineProperty(out, FORMATTED, {
				value: true,
				enumerable: false,
			});
			return out as unknown as ILogEvent;
		},
	};
}
