import { domainSafeShallow } from "@/internal/domain-safe";
import type { ILogEvent } from "@/types/log-event.interface";
import type { IProcessor } from "@/types/processor.interface";

/**
 * Build a processor that replaces `@roastery/beans` domain objects found at
 * the top level of an event's `bindings` / `meta` with their **safe**
 * serialisation, before anything can reach a transport.
 *
 * @remarks
 * This closes a leak that neither package could close alone.
 * `Entity.toJSON()` and `DomainRecord.toJSON()` are the *persistence*
 * contract: lossless and deliberately unredacted. `JSON.stringify` — which
 * every transport in this package eventually reaches — calls exactly that.
 * So `log.info({ user }, "created")` would write a `sensitive` property in
 * the clear, and the redact processor cannot help: it is shallow, and the
 * top-level key (`user`) is not itself sensitive. The leak sits one level
 * below it. This processor swaps in `toSafeJSON()`, which redacts.
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
 * Scope is the **top level only**, matching redaction: a domain object nested
 * inside a plain literal is not reached, because recursion inside a domain
 * object is `toSafeJSON`'s own job. Events and bindings that hold no domain
 * object come back by identity, so the pipeline stays allocation-free for
 * the common case.
 *
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
 * @see {@link createAroma} — injects this automatically, ahead of redaction,
 *   unless `redact: false`.
 * @see {@link createRedactProcessor} — the key-name half of the same concern.
 * @see {@link IProcessor}
 */
export function createDomainProcessor(): IProcessor {
	return {
		name: "domain",
		process(event: ILogEvent): ILogEvent {
			const nextBindings = domainSafeShallow(
				event.bindings as Record<string, unknown>,
			) as ILogEvent["bindings"];
			const nextMeta = event.meta
				? (domainSafeShallow(
						event.meta as Record<string, unknown>,
					) as ILogEvent["meta"])
				: event.meta;

			if (nextBindings === event.bindings && nextMeta === event.meta) {
				return event;
			}

			return { ...event, bindings: nextBindings, meta: nextMeta };
		},
	};
}
