import { Command } from "@roastery/beans/application/command";
import { DomainEvent } from "@roastery/beans/domain/domain-event";
import type { IDomainEvent } from "@roastery/beans/domain/domain-event/types";
import { Entity } from "@roastery/beans/domain/entity";
import { DomainRecord } from "@roastery/beans/domain/record";
import { ValueObject } from "@roastery/beans/domain/value-object";
import type { IValueObjectContext } from "@roastery/beans/domain/value-object/types";
import { Context, Meta } from "@roastery/terroir/symbols";
import { AROMA_SOURCE, redactedValue } from "@/internal/redacted-value";
import {
	createWalkPlan,
	MAX_WALK_DEPTH,
	PASS,
	SpreadFields,
	type Visitor,
	type WalkPlan,
	walkRecord,
	walkValue,
} from "@/internal/safe-walk";

/** Minimal view of the `[Meta]` slot every `ValueObject` instance carries. */
type ValueObjectMeta = {
	sensitive?: boolean;
	redactWith?: Parameters<typeof redactedValue>[2];
};

/** Anything exposing the wrapper/record contract for a redacted serialisation. */
type SafeJsonBearing = { toSafeJSON: () => unknown };

/**
 * Decide what a single value becomes on its way to a log line, leaving
 * anything that is not a `@roastery/beans` domain object to the walk.
 *
 * Detection is a two-tier ladder. A value whose prototype is `Object.prototype`
 * cannot be an instance of any `beans` class, so it skips the seven
 * `instanceof` checks — which matters because a plain literal is most of what a
 * deep walk meets, and the walk now runs on nested payloads that never reached
 * this code before.
 *
 * The full ladder, for a value with a prototype of its own:
 *
 * | Detection | Action |
 * |---|---|
 * | `Array` / `Map` / `Set` | {@link PASS} — the walk descends |
 * | a `ValueObject` — by `instanceof` **or** by carrying `defineMeta` | sensitive → placeholder; otherwise the unwrapped `.value` |
 * | `instanceof Entity` / `DomainRecord` | `toSafeJSON()` |
 * | `instanceof Command` | `toJSON()` — already redacted by `beans` |
 * | `instanceof DomainEvent` or the `IDomainEvent` shape | {@link SpreadFields} |
 * | `typeof value.toSafeJSON === "function"` | `toSafeJSON()` |
 * | none of the above | {@link PASS} |
 *
 * @remarks
 * The `toSafeJSON` branch is **not** leftover duck-typing. `arrayOf` /
 * `optionalOf` / `nullableOf` mint **anonymous classes at runtime**, so there
 * is no exported class to test `instanceof` against; the contract they do
 * guarantee is `toSafeJSON`, and that is what the branch catches. It runs last
 * so it only ever sees what the named classes did not claim.
 *
 * Unwrapping a non-sensitive `ValueObject` is a deliberate side benefit:
 * `{ email: emailVO }` logs as `{ email: "a@b.c" }` rather than
 * `{ email: { value: "a@b.c" } }`.
 *
 * Everything this returns is **terminal** — the walk does not descend into a
 * conversion's output. Recursion inside a domain object is `toSafeJSON`'s own
 * job, and it already does it; descending again would only risk converting
 * something twice. The one exception is a {@link SpreadFields}' `payload`,
 * which {@link domainEventFields} converts itself.
 */
const visitDomain: Visitor = (value: unknown, key: string): unknown => {
	// The plan sets `primitives: false`, so `value` is a non-null object.
	const prototype = Object.getPrototypeOf(value as object);

	if (prototype === Object.prototype || prototype === null) {
		// Cheap, but **not** a free pass, and writing it as one would silently
		// delete two live branches:
		//
		// - a domain object that crossed a copy boundary or a serialisation and
		//   arrived as a plain bag still carrying `toSafeJSON`. Detection failing
		//   here produces no type error and no exception — just the leak back.
		// - a hand-raised domain event. `Entity.raiseEvent` accepts any
		//   `{ name, ...payload }` and the buffer stores plain objects, so a
		//   `{ name, occurredAt, aggregateId }` literal is production shape, not
		//   a test artefact.
		//
		// A genuine `ValueObject` cannot reach here — its prototype is its class's
		// — so `defineMeta` is not worth a third load on this path.
		if (typeof (value as SafeJsonBearing).toSafeJSON === "function") {
			return (value as SafeJsonBearing).toSafeJSON();
		}

		if (hasEventShape(value as object)) {
			return new SpreadFields(domainEventFields(value as IDomainEvent));
		}

		return PASS;
	}

	if (Array.isArray(value) || value instanceof Map || value instanceof Set) {
		return PASS;
	}

	if (isValueObject(value as object)) {
		return fromValueObject(value as object, key);
	}

	if (value instanceof Entity || value instanceof DomainRecord) {
		return value.toSafeJSON();
	}

	if (value instanceof Command) {
		return value.toJSON();
	}

	if (isDomainEvent(value as object)) {
		return new SpreadFields(domainEventFields(value as IDomainEvent));
	}

	if (typeof (value as SafeJsonBearing).toSafeJSON === "function") {
		return (value as SafeJsonBearing).toSafeJSON();
	}

	// A `Date`, an `Error`, a database handle: not ours, and `descendable`
	// refuses to look inside it either.
	return PASS;
};

/**
 * The one plan for domain conversion, built at module load.
 *
 * `primitives: false` because a primitive can never be a domain object, which
 * saves an indirect call per primitive key — on a flat payload, every key
 * there is.
 */
const DOMAIN_PLAN = createWalkPlan(visitDomain, false);

/**
 * Build a domain plan with a non-default depth bound.
 *
 * @remarks
 * Returns the shared {@link DOMAIN_PLAN} when the bound is the default one, so
 * the overwhelmingly common case keeps a single plan object and the walk's
 * recursion keeps a single hidden class. A logger that overrides `maxDepth`
 * pays for one more.
 *
 * @param maxDepth - levels to descend.
 *
 * @internal
 */
export function createDomainPlan(maxDepth: number): WalkPlan {
	return maxDepth === MAX_WALK_DEPTH
		? DOMAIN_PLAN
		: createWalkPlan(visitDomain, false, maxDepth);
}

/**
 * Convert a single value to the form that is safe to log, leaving anything
 * that is not a `@roastery/beans` domain object untouched **by identity**.
 *
 * @param value - any value; primitives and `null` return immediately.
 * @param key - the key the value was found under, used as the `name` of the
 *   fallback redaction context when a `ValueObject` carries no `[Context]`.
 * @param plan - depth-bounded plan to walk with. Defaults to the shared one.
 * @returns the safe form, or `value` itself when nothing matched.
 *
 * @example
 * ```ts
 * domainSafeValue(new PasswordVO("hunter2", ctx), "password"); // → "[redacted]"
 * domainSafeValue(new EmailVO("a@b.c", ctx), "email");         // → "a@b.c"
 * domainSafeValue(user, "user");                               // → user.toSafeJSON()
 * ```
 *
 * @see {@link domainSafeDeep} — the record sweep that shares this decision.
 *
 * @internal
 */
export function domainSafeValue(
	value: unknown,
	key: string,
	plan: WalkPlan = DOMAIN_PLAN,
): unknown {
	return walkValue(value, key, plan);
}

/**
 * Sweep a `bindings` / `meta` record, replacing every domain object with its
 * safe form and flattening a top-level domain event into prefixed sibling
 * keys.
 *
 * **Depth matters here, and used not to.** An earlier draft swept only the top
 * level, on the reasoning that key-name redaction was shallow too. Redaction
 * then went deep and this did not, and an `Entity` below a plain literal fell
 * between the two — redaction refuses to enter a class instance, this never
 * reached one — so `{ ctx: { user } }` was serialised through the entity's
 * lossless `toJSON()`. It now descends with the shared walk, which is also
 * what makes that divergence impossible to reintroduce.
 *
 * **Lazy clone**: when nothing matches, the original comes back by identity
 * and nothing is allocated.
 *
 * @param target - the record to sweep; `undefined` passes through unchanged.
 * @param plan - depth-bounded plan to walk with. Defaults to the shared one.
 * @returns either `target` itself or a fresh record with the safe forms.
 *
 * @example
 * ```ts
 * domainSafeDeep({ ctx: { user }, event: orderConfirmed });
 * // → { ctx: { user: { …, password: "[redacted]" } },
 * //     "event.name": "order.confirmed",
 * //     "event.aggregateId": "01J…",
 * //     "event.occurredAt": "2026-08-25T13:04:11.000Z" }
 * ```
 *
 * @typeParam T - shape of the input record; the return type preserves it.
 *
 * @see {@link createDomainProcessor} — the pipeline stage that applies this.
 *
 * @internal
 */
export function domainSafeDeep<T extends Record<string, unknown> | undefined>(
	target: T,
	plan: WalkPlan = DOMAIN_PLAN,
): T {
	return walkRecord(target, plan);
}

/**
 * Whether `value` is a `ValueObject`.
 *
 * `instanceof` is the first answer and the structural one is the safety net:
 * two copies of `@roastery/beans` in one `node_modules` — which two packages
 * with different ranges are enough to produce — mint two `ValueObject` bases,
 * and an instance of one is not `instanceof` the other. Detection would fail
 * silently, the object would come back by identity, and the leak would be
 * back with no type error and no exception to notice.
 *
 * `defineMeta` is the same discriminant `beans` itself uses for this exact
 * reason (`is-value-object.ts`), and it lives on the prototype, so it
 * survives the copy boundary that `instanceof` does not.
 */
function isValueObject(value: object): boolean {
	return (
		value instanceof ValueObject ||
		typeof (value as { defineMeta?: unknown }).defineMeta === "function"
	);
}

/** Redact or unwrap a value object, per its own `[Meta]`. */
function fromValueObject(value: object, key: string): unknown {
	const wrapped = (value as { value: unknown }).value;
	const meta = (value as Record<symbol, ValueObjectMeta | undefined>)[Meta];

	if (meta === undefined) {
		// It answers to `defineMeta` but its metadata is unreachable — which is
		// what a duplicated *terroir* looks like, since `Meta` is a `unique
		// symbol` and a second copy mints a different one. Redact rather than
		// unwrap: this module exists so a sensitive value cannot get out, and
		// "cannot tell" has to resolve to the safe answer. With a single copy
		// of terroir the branch is unreachable.
		return redactedValue(wrapped, valueObjectContext(value, key));
	}

	if (meta.sensitive !== true) {
		return wrapped;
	}

	return redactedValue(
		wrapped,
		valueObjectContext(value, key),
		meta.redactWith,
	);
}

/**
 * The structural half of domain-event detection: `Entity.raiseEvent` accepts
 * any `{ name, ...payload }` object and the buffer stores plain objects — the
 * `beans` TSDoc is explicit that `.on()` matches by `name` and never by
 * `instanceof`.
 */
function hasEventShape(value: object): value is IDomainEvent {
	const candidate = value as Partial<IDomainEvent>;
	return (
		typeof candidate.name === "string" &&
		typeof candidate.occurredAt === "string" &&
		typeof candidate.aggregateId === "string"
	);
}

/**
 * Whether `value` is a domain event, for a value that has a prototype of its
 * own. The named pillars are excluded outright, so the predicate holds
 * regardless of the order it is asked in: an entity that happens to own
 * `name`, `occurredAt` and `aggregateId` properties is still an entity.
 */
function isDomainEvent(value: object): value is IDomainEvent {
	if (value instanceof DomainEvent) {
		return true;
	}

	if (
		value instanceof ValueObject ||
		value instanceof Entity ||
		value instanceof DomainRecord ||
		value instanceof Command
	) {
		return false;
	}

	return hasEventShape(value);
}

/**
 * Events whose payload is being converted right now.
 *
 * `raiseEvent` resolves a payload from the event's `static payload`
 * declaration, so in practice it is already plain — but an event assembled by
 * hand can hold anything, including itself. Without this guard
 * `event.payload === event` recurses until the stack goes, **inside the
 * caller's `log.info()`**: a logger that crashes the request it was
 * describing. The walk's own cycle guard does not cover it, because an event
 * is claimed by the visitor and never descended into.
 */
const flattening = new WeakSet<object>();

/** Substituted for an event that is its own payload, matching the walk's sentinel. */
const CIRCULAR = "[Circular]";

/**
 * The loggable fields of a domain event, as a plain object. `payload` is
 * omitted when absent — the base declares it with `declare readonly`, so a
 * genuinely payload-less event does not carry the key at all.
 *
 * The payload is converted here rather than left to the walk, because a
 * {@link SpreadFields} resolves to its fields untouched in every position but
 * one; converting at the source is what keeps `{ rows: [event] }` as safe as
 * `{ event }`.
 */
function domainEventFields(event: IDomainEvent): Record<string, unknown> {
	const fields: Record<string, unknown> = {
		name: event.name,
		aggregateId: event.aggregateId,
		occurredAt: event.occurredAt,
	};

	if (event.payload === undefined) {
		return fields;
	}

	if (flattening.has(event)) {
		fields.payload = CIRCULAR;
		return fields;
	}

	flattening.add(event);
	try {
		fields.payload = domainSafeValue(event.payload, "payload");
	} finally {
		flattening.delete(event);
	}

	return fields;
}

/**
 * The `{ name, source }` a redaction placeholder function receives. A
 * `ValueObject` carries its own under `[Context]` — `source` there is the
 * owning aggregate's type name, which is strictly better than anything the
 * logger could infer — so it wins whenever it is present.
 */
function valueObjectContext(value: object, key: string): IValueObjectContext {
	const own = (value as Record<symbol, IValueObjectContext | undefined>)[
		Context
	];

	return typeof own?.name === "string" && typeof own.source === "string"
		? own
		: { name: key, source: AROMA_SOURCE };
}
