import { conversionFailed } from "@/internal/conversion-failure";
import { createDomainPlan, domainSafeDeep } from "@/internal/domain-safe";
import { assertWalkDepth } from "@/internal/safe-walk";
import type { ILogEvent } from "@/types/log-event.interface";
import type { IProcessor } from "@/types/processor.interface";

/**
 * Arguments accepted by {@link createDomainProcessor}.
 *
 * @since 0.1.0
 */
export type DomainProcessorOptions = {
	/**
	 * How many levels to descend. Defaults to `MAX_WALK_DEPTH`.
	 *
	 * @remarks
	 * Past the bound the walk substitutes `"[truncated: depth]"` rather than
	 * letting a subtree through unconverted — a bound on this walk is a bound on
	 * visibility, never on safety. Must be an integer in
	 * `1..MAX_CONFIGURABLE_DEPTH`.
	 *
	 * @since 0.1.0
	 */
	maxDepth?: number;
};

/**
 * Build a processor that replaces every `@roastery/beans` domain object in an
 * event's `bindings` / `meta` with its **safe** serialisation, before anything
 * can reach a transport.
 *
 * @remarks
 * This closes a leak that neither package could close alone.
 * `Entity.toJSON()` and `DomainRecord.toJSON()` are the *persistence*
 * contract: lossless and deliberately unredacted. `JSON.stringify` — which
 * every transport in this package eventually reaches — calls exactly that.
 * So `log.info({ user }, "created")` would write a `sensitive` property in
 * the clear, and key-name masking cannot help: the top-level key (`user`) is
 * not itself sensitive, and the leak sits one level below it. This processor
 * swaps in `toSafeJSON()`, which redacts.
 *
 * It lives in the pipeline rather than in the serialiser on purpose: a
 * `ConsoleTransport` (which goes through `safeStringify`) or a
 * `NullTransport` (which exposes `transport.events` raw) would otherwise
 * still see the live instance holding the real values.
 *
 * Conversions, per top-level key:
 *
 * - a `ValueObject` is unwrapped to its `.value` — or replaced by the
 *   configured placeholder when its class declares `sensitive: true`;
 * - an `Entity` / `DomainRecord` / multiplicity wrapper becomes
 *   `toSafeJSON()`; a `Command` becomes `toJSON()`, which `beans` already
 *   redacts;
 * - a domain event is flattened into prefixed sibling keys
 *   (`event.name`, `event.aggregateId`, `event.occurredAt`, `event.payload`).
 *
 * Scope is **deep**: a domain object is converted wherever it sits, including
 * below a plain literal, inside an array, a `Map` or a `Set`. An earlier draft
 * was top-level only, on the reasoning that key-name masking was shallow too —
 * and when that half went deep and this one did not, `{ ctx: { user } }`
 * started leaking. Recursion *inside* a domain object remains `toSafeJSON`'s
 * own job.
 *
 * Events and bindings that hold no domain object come back by identity, so the
 * pipeline stays allocation-free for the common case.
 *
 * @param options - optional depth bound; see
 *   {@link DomainProcessorOptions.maxDepth}.
 * @returns an `IProcessor` ready to be inserted in the pipeline.
 *
 * @example
 * ```ts
 * import { createDomainProcessor } from "@roastery/aroma/processors";
 *
 * const log = createAroma({ processors: [createDomainProcessor()] });
 * log.info({ user }, "created");
 * // meta.user.password → "[redacted]", never the real value
 * ```
 *
 * @since 0.1.0
 *
 * @see {@link createAroma} — injects this automatically, and always.
 * @see {@link createRedactProcessor} — the key-name half, now opt-in.
 * @see {@link IProcessor}
 */
export function createDomainProcessor(
	options: DomainProcessorOptions = {},
): IProcessor {
	const plan = createDomainPlan(assertWalkDepth(options.maxDepth));

	return {
		name: "domain",
		process(event: ILogEvent): ILogEvent {
			// The two records are converted independently so one hostile getter
			// costs one record rather than the whole line — see `conversionFailed`.
			let nextBindings: ILogEvent["bindings"];
			try {
				nextBindings = domainSafeDeep(
					event.bindings as Record<string, unknown>,
					plan,
				) as ILogEvent["bindings"];
			} catch (reason) {
				nextBindings = conversionFailed(reason) as ILogEvent["bindings"];
			}

			let nextMeta: ILogEvent["meta"];
			try {
				nextMeta = event.meta
					? (domainSafeDeep(
							event.meta as Record<string, unknown>,
							plan,
						) as ILogEvent["meta"])
					: event.meta;
			} catch (reason) {
				nextMeta = conversionFailed(reason) as ILogEvent["meta"];
			}

			if (nextBindings === event.bindings && nextMeta === event.meta) {
				return event;
			}

			return { ...event, bindings: nextBindings, meta: nextMeta };
		},
	};
}
