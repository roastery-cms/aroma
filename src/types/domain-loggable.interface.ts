/**
 * A `@roastery/beans` domain object, described by what the logger actually
 * needs from it rather than by which class it descends from.
 *
 * @remarks
 * This exists so the typed API agrees with the runtime. `Bindings` is
 * `Record<string, unknown>`, and TypeScript gives an implicit index signature
 * to object *literals* but not to class instances — which is why
 * `log.info({ user }, "…")` compiles and `log.info(user, "…")` does not, even
 * though the logger handles both. Without this overload, the runtime support
 * for passing a domain object directly would only ever be reachable from
 * JavaScript or through a cast.
 *
 * Structural rather than nominal on purpose, for the same reason the domain
 * converter's detection is: `instanceof` is unreliable across two copies of
 * `beans` in one `node_modules`, and a shape survives that boundary. It also
 * keeps `@roastery/aroma/types` free of a value import from beans, so a
 * consumer typing an adapter does not pull the domain pillars into their
 * type-checking graph.
 *
 * The two members are the two contracts the converter recognises: the
 * redacted serialisation every entity, record and multiplicity wrapper
 * provides, and the shape of a domain event.
 *
 * @since 0.1.0
 *
 * @see {@link ILogger.info} — where the overload lives.
 * @see `domainSafeValue` in `@/internal/domain-safe` — what accepts these at runtime.
 */
export type IDomainLoggable =
	| {
			/** The redacted serialisation — `Entity`, `DomainRecord`, and the `arrayOf`/`optionalOf`/`nullableOf` wrappers. */
			toSafeJSON(): unknown;
	  }
	| {
			/** A stable, dot-namespaced event name (e.g. `"order.confirmed"`). */
			readonly name: string;
			/** ISO 8601 instant the event was raised. */
			readonly occurredAt: string;
			/** The raising entity's own `id`. */
			readonly aggregateId: string;
	  };
