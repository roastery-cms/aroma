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
 * | `err.code`       | `error.code` (+ `http.response.status_code` on the application layer) |
 * | `<k>.name`       | `event.action`       |
 * | `<k>.aggregateId`| `event.id`           |
 * | `<k>.occurredAt` | `event.created`      |
 *
 * The last three are the flattened keys the **domain processor** produces for
 * a domain event (`event.name`, `order.aggregateId`, …). They cannot be
 * spread into an ECS document as-is: Elasticsearch expands a dotted name into
 * an object, and `event` is a **reserved ECS namespace** whose `event.action`
 * / `event.id` / `event.created` mean something specific. Left alone they
 * produce a document that looks like ECS and is not, so they are translated
 * here — along with `event.kind` and an `event.dataset` taken from the
 * prefix, which is what makes the document filterable in Kibana. Any
 * `<k>.payload` stays under its own key, outside the namespace.
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
 * @since 0.0.1
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
				const error: Record<string, unknown> = {
					type: event.err.name,
					message: event.err.message,
					stack_trace: event.err.stack,
				};
				if (event.err.code !== undefined) {
					// ECS types `error.code` as a keyword, so it travels as a string;
					// the numeric HTTP status belongs in the field HTTP dashboards
					// actually query, and only the application layer has one.
					error.code = String(event.err.code);
					if (event.err.layer === "application") {
						out.http = { response: { status_code: event.err.code } };
					}
				}
				out.error = error;
			}
			mapDomainEvents(out);
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

/** The flattened domain-event suffixes the domain processor emits, and where ECS keeps them. */
const EVENT_FIELDS: ReadonlyArray<[suffix: string, ecsField: string]> = [
	["name", "action"],
	["aggregateId", "id"],
	["occurredAt", "created"],
];

/**
 * Fold `<prefix>.name` / `.aggregateId` / `.occurredAt` keys into the ECS
 * `event` namespace, in place.
 *
 * Runs over the already-spread document, which is why the ECS processor has
 * to stay last: it sees the domain processor's output, so the translation is
 * a rename rather than a re-derivation. A document carrying no such keys is
 * untouched and pays one lookup per candidate suffix.
 */
function mapDomainEvents(out: Record<string, unknown>): void {
	const prefixes = new Set<string>();

	for (const key of Object.keys(out)) {
		const separator = key.lastIndexOf(".");
		if (separator <= 0) continue;

		const suffix = key.slice(separator + 1);
		if (EVENT_FIELDS.some(([candidate]) => candidate === suffix)) {
			prefixes.add(key.slice(0, separator));
		}
	}

	for (const prefix of prefixes) {
		const ecsEvent: Record<string, unknown> = {
			kind: "event",
			dataset: prefix,
		};

		for (const [suffix, ecsField] of EVENT_FIELDS) {
			const key = `${prefix}.${suffix}`;
			if (key in out) {
				ecsEvent[ecsField] = out[key];
				delete out[key];
			}
		}

		// A payload is the event's own data, not ECS metadata about the event —
		// it stays where it was rather than being pushed into the namespace.
		out.event = ecsEvent;
	}
}
