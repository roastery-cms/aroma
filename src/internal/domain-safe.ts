import { Command } from "@roastery/beans/application/command";
import { DomainEvent } from "@roastery/beans/domain/domain-event";
import type { IDomainEvent } from "@roastery/beans/domain/domain-event/types";
import { Entity } from "@roastery/beans/domain/entity";
import { DomainRecord } from "@roastery/beans/domain/record";
import { ValueObject } from "@roastery/beans/domain/value-object";
import type { IValueObjectContext } from "@roastery/beans/domain/value-object/types";
import { Context, Meta } from "@roastery/terroir/symbols";
import { AROMA_SOURCE, redactedValue } from "@/internal/redacted-value";

/** Minimal view of the `[Meta]` slot every `ValueObject` instance carries. */
type ValueObjectMeta = {
	sensitive?: boolean;
	redactWith?: Parameters<typeof redactedValue>[2];
};

/** Anything exposing the wrapper/record contract for a redacted serialisation. */
type SafeJsonBearing = { toSafeJSON: () => unknown };

/**
 * Convert a single value to the form that is safe to log, leaving anything
 * that is not a `@roastery/beans` domain object untouched **by identity**.
 *
 * Detection runs in this order, and the order is load-bearing:
 *
 * | Detection | Action |
 * |---|---|
 * | a `ValueObject` — by `instanceof` **or** by carrying `defineMeta` | sensitive → placeholder; otherwise the unwrapped `.value` |
 * | `instanceof Entity` / `DomainRecord` | `toSafeJSON()` |
 * | `instanceof Command` | `toJSON()` — already redacted by `beans` |
 * | `Array` / `Map` / `Set` | converted item by item |
 * | `instanceof DomainEvent` or the `IDomainEvent` shape | plain `{ name, occurredAt, aggregateId, payload? }` |
 * | `typeof value.toSafeJSON === "function"` | `toSafeJSON()` |
 * | none of the above | the value itself |
 *
 * @remarks
 * The last branch is **not** leftover duck-typing. `arrayOf` / `optionalOf` /
 * `nullableOf` mint **anonymous classes at runtime**, so there is no exported
 * class to test `instanceof` against; the contract they do guarantee is
 * `toSafeJSON`, and that is what the branch catches. It runs last so it only
 * ever sees what the named classes did not claim.
 *
 * Unwrapping a non-sensitive `ValueObject` is a deliberate side benefit:
 * `{ email: emailVO }` logs as `{ email: "a@b.c" }` rather than
 * `{ email: { value: "a@b.c" } }`.
 *
 * **Collections are descended into**, because a collection is how a call site
 * transports domain objects: `{ users: [alice, bob] }` is at least as common
 * as `{ user: alice }`, and a raw array matches no `instanceof` and carries no
 * `toSafeJSON`, so it would come back by identity and `JSON.stringify` would
 * call each item's lossless `toJSON()`. That is *not* a move towards deep
 * redaction of plain objects — a plain literal is still left alone, and dot
 * paths remain the additive extension they always were.
 *
 * Recursion is otherwise the domain object's own job: an `Entity`'s
 * `toSafeJSON()` already recurses, so this function never walks into a plain
 * object literal. Nesting through collections is bounded by
 * {@link MAX_DEPTH} so a self-referential array cannot exhaust the stack
 * inside a log call.
 *
 * @param value - any value; primitives and `null` return immediately.
 * @param key - the key the value was found under, used as the `name` of the
 *   fallback redaction context when a `ValueObject` carries no `[Context]`.
 * @returns the safe form, or `value` itself when nothing matched.
 *
 * @example
 * ```ts
 * domainSafeValue(new PasswordVO("hunter2", ctx), "password"); // → "[redacted]"
 * domainSafeValue(new EmailVO("a@b.c", ctx), "email");         // → "a@b.c"
 * domainSafeValue(user, "user");                               // → user.toSafeJSON()
 * ```
 *
 * @see {@link domainSafeShallow} — the top-level sweep that calls this.
 *
 * @internal
 */
export function domainSafeValue(value: unknown, key: string): unknown {
	return convert(value, key, 0);
}

/**
 * How deep {@link domainSafeValue} follows nested collections.
 *
 * A bound is required, not tidy: `const rows = []; rows.push(rows)` is legal,
 * and unbounded recursion here would blow the stack **inside the caller's
 * `log.info()`** — a logger that crashes the request it was describing. Eight
 * levels is far past any real log payload; beyond it, values come back
 * untouched and `serializeEvent` handles the cycle as it always has, by
 * falling back to `safeStringify`.
 *
 * @internal
 */
const MAX_DEPTH = 8;

/** {@link domainSafeValue}'s body, carrying the collection nesting depth. */
function convert(value: unknown, key: string, depth: number): unknown {
	if (typeof value !== "object" || value === null) {
		return value;
	}

	if (isValueObject(value)) {
		return fromValueObject(value, key);
	}

	if (value instanceof Entity || value instanceof DomainRecord) {
		return value.toSafeJSON();
	}

	if (value instanceof Command) {
		return value.toJSON();
	}

	if (Array.isArray(value)) {
		return fromArray(value, key, depth);
	}

	if (value instanceof Map) {
		return fromMap(value, depth);
	}

	if (value instanceof Set) {
		return fromSet(value, key, depth);
	}

	if (isDomainEvent(value)) {
		return domainEventFields(value, depth);
	}

	if (typeof (value as SafeJsonBearing).toSafeJSON === "function") {
		return (value as SafeJsonBearing).toSafeJSON();
	}

	return value;
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
 * Convert an array item by item, returning the original by identity when no
 * item changed — the same lazy clone `redactShallow` uses, so an array of
 * plain values costs one pass and no allocation.
 */
function fromArray(values: unknown[], key: string, depth: number): unknown[] {
	if (depth >= MAX_DEPTH) {
		return values;
	}

	let next: unknown[] | undefined;

	for (let index = 0; index < values.length; index++) {
		const item = values[index];
		const safe = convert(item, key, depth + 1);

		if (safe !== item) {
			next ??= [...values];
			next[index] = safe;
		}
	}

	return next ?? values;
}

/**
 * Convert a `Map` to a plain object, converting each value.
 *
 * Unlike an array this is **not** lazy, because identity is not a safe
 * default here: `JSON.stringify(new Map(...))` is `{}`, so returning the Map
 * untouched does not preserve the log line, it erases it. Converting always
 * is the only outcome that keeps the entry readable, and a `Map` in a log
 * payload is rare enough that the allocation is not a hot path.
 */
function fromMap(
	values: Map<unknown, unknown>,
	depth: number,
): Record<string, unknown> | Map<unknown, unknown> {
	if (depth >= MAX_DEPTH) {
		return values;
	}

	const next: Record<string, unknown> = {};
	for (const [entryKey, entryValue] of values) {
		next[String(entryKey)] = convert(entryValue, String(entryKey), depth + 1);
	}
	return next;
}

/** Convert a `Set` to an array. `JSON.stringify(new Set(…))` is `{}`, so — as with {@link fromMap} — identity would lose the entry. */
function fromSet(
	values: Set<unknown>,
	key: string,
	depth: number,
): unknown[] | Set<unknown> {
	if (depth >= MAX_DEPTH) {
		return values;
	}

	return [...values].map((item) => convert(item, key, depth + 1));
}

/**
 * Sweep the **top level** of a `bindings` / `meta` record, replacing every
 * domain object with its safe form and flattening domain events into
 * prefixed top-level keys.
 *
 * **Lazy clone**, mirroring `redactShallow`: when nothing matches, the
 * original object comes back by identity and nothing is allocated — the cost
 * on a log line that carries no domain object is one `typeof` per key.
 *
 * Depth is deliberately one level, matching the shallow scope of redaction:
 * a domain object nested inside a plain literal (`{ ctx: { user } }`) is not
 * reached. Recursion *inside* a domain object is `toSafeJSON`'s job, and it
 * already does it.
 *
 * @param target - the record to sweep; `undefined` passes through unchanged.
 * @returns either `target` itself or a fresh record with the safe forms.
 *
 * @example
 * ```ts
 * domainSafeShallow({ user, event: orderConfirmed });
 * // → { user: { …, password: "[redacted]" },
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
export function domainSafeShallow<
	T extends Record<string, unknown> | undefined,
>(target: T): T {
	if (!target) {
		return target;
	}

	let next: Record<string, unknown> | undefined;

	for (const key of Object.keys(target)) {
		const value = target[key];

		if (typeof value !== "object" || value === null) {
			continue;
		}

		const safe = domainSafeValue(value, key);
		if (safe === value) {
			continue;
		}

		next ??= { ...target };

		// A domain event is the one conversion that changes the *shape* of the
		// record: it becomes sibling `key.*` fields instead of a nested object.
		if (isDomainEvent(value)) {
			delete next[key];
			for (const field of Object.keys(safe as Record<string, unknown>)) {
				next[`${key}.${field}`] = (safe as Record<string, unknown>)[field];
			}
			continue;
		}

		next[key] = safe;
	}

	return (next ?? target) as T;
}

/**
 * Whether `value` is a domain event. `instanceof DomainEvent` catches
 * subclasses of the base; the structural check catches everything else,
 * because `Entity.raiseEvent` accepts any `{ name, ...payload }` object and
 * the buffer stores plain objects — the `beans` TSDoc is explicit that `.on()`
 * matches by `name` and never by `instanceof`.
 *
 * The named pillars are excluded outright, so the predicate holds on its own
 * rather than relying on being asked in the right order: an entity that
 * happens to own `name`, `occurredAt` and `aggregateId` properties is still
 * an entity.
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

	const candidate = value as Partial<IDomainEvent>;
	return (
		typeof candidate.name === "string" &&
		typeof candidate.occurredAt === "string" &&
		typeof candidate.aggregateId === "string"
	);
}

/**
 * The loggable fields of a domain event, as a plain object. `payload` is
 * omitted when absent — the base declares it with `declare readonly`, so a
 * genuinely payload-less event does not carry the key at all. Whatever
 * payload is there was already resolved by `raiseEvent` from the event's
 * `static payload` declaration; passing it back through
 * {@link domainSafeValue} only covers events built by hand, which can still
 * hold live instances.
 */
function domainEventFields(
	event: IDomainEvent,
	depth: number,
): Record<string, unknown> {
	const fields: Record<string, unknown> = {
		name: event.name,
		aggregateId: event.aggregateId,
		occurredAt: event.occurredAt,
	};

	if (event.payload !== undefined) {
		fields.payload = convert(event.payload, "payload", depth);
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
