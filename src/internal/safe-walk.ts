/**
 * The one traversal in this package.
 *
 * Both cross-cutting safety concerns — converting `@roastery/beans` domain
 * objects to their safe form, and masking fields by key name — are the same
 * walk over the same payload with a different decision at each node. They used
 * to be two: the domain conversion stopped at the top level and key-name
 * redaction went six levels deep, and a `beans` `Entity` sitting below a plain
 * literal fell between them — {@link descendable} refuses to enter a class
 * instance, and the conversion never reached one that far down.
 * `JSON.stringify` then called the entity's lossless, deliberately unredacted
 * `toJSON()`, which is the exact leak the domain integration exists to
 * prevent.
 *
 * Keeping one traversal is what makes that class of bug unreachable rather
 * than merely fixed: one depth bound, one set of descent rules, one cycle
 * guard, so the two concerns cannot drift apart again.
 *
 * **This module is deliberately not reachable from any barrel.** The visitor
 * call in {@link walkRecord} is an indirect call on a hot path, and its
 * polymorphism is the number of distinct visitors in the process — two, both
 * of them ours. Exporting it would let a consumer add more and turn that site
 * megamorphic.
 *
 * @internal
 */

import { AromaException } from "@/exceptions/aroma-exception";

/** Substituted for a back reference, matching what `safeStringify` emits so the serialised line is unchanged from a reader's point of view. */
const CIRCULAR = "[Circular]";

/**
 * Returned by a {@link Visitor} that has no opinion about a value: not mine,
 * descend into it if it is the kind of thing you descend into.
 *
 * A sentinel rather than `undefined` because `undefined` is a legitimate
 * replacement — a visitor must be able to say "replace this with nothing" —
 * and rather than returning the value itself, because identity cannot
 * distinguish *"not mine, go look inside"* from *"mine, and the answer is this
 * same object, do not look inside"*.
 */
export const PASS: unique symbol = Symbol("aroma.walk.pass");

/**
 * A replacement that becomes one sibling key per field in the **enclosing
 * record** — `event` becomes `event.name`, `event.aggregateId`,
 * `event.occurredAt`.
 *
 * @remarks
 * Honoured only at the top level of a record, which is where
 * `createEcsProcessor` reads it back: `mapDomainEvents` folds
 * `<prefix>.name` / `.aggregateId` / `.occurredAt` into an ECS `event` object,
 * and it scans only the root of the document it is given. A dotted key minted
 * at depth 3 would be invisible to it *and* Elasticsearch would expand it into
 * a real `event` object, colliding with the reserved ECS namespace — a
 * document that looks like ECS and is not.
 *
 * Everywhere else — deeper in a record, inside an array, a `Set`, a `Map`
 * value, or in value position — it resolves to a plain nested object. A
 * `SpreadFields` instance must **never** reach a transport; every container
 * position unwraps it.
 */
export class SpreadFields {
	public constructor(public readonly fields: Record<string, unknown>) {}
}

/**
 * Decide what happens to one value.
 *
 * Return {@link PASS} to hand the value back to the walk, a replacement to
 * substitute it, or a {@link SpreadFields} to expand it into sibling keys. A
 * replacement is **terminal** — the walk does not descend into what a visitor
 * produced.
 *
 * @param value - the value found at `key`.
 * @param key - the key it was found under. For an array or `Set` element,
 *   which has no key of its own, this is the key of the collection — enough
 *   for a redaction context's `name`, and harmless for key-name matching,
 *   which had already established that key is not in the list before it
 *   descended.
 */
export type Visitor = (value: unknown, key: string) => unknown;

/**
 * Everything a walk needs that does not change between nodes, built **once**
 * per processor rather than once per event.
 *
 * A single object rather than three threaded parameters: it collapses the
 * invariant half of the recursion's argument list and gives every frame a
 * stable hidden class.
 */
export type WalkPlan = {
	readonly visit: Visitor;
	/**
	 * Call `visit` for non-object values too.
	 *
	 * Key-name masking needs it — it decides on the *key* and has to fire on
	 * `{ password: "hunter2" }`, where the value is a string. The domain
	 * conversion does not: it decides on the *value*, and a primitive can never
	 * be a domain object. Skipping the call for it saves one indirect call per
	 * primitive key, which on a flat payload is every key there is.
	 */
	readonly primitives: boolean;
	readonly maxDepth: number;
	/**
	 * How many objects the walk will **enter** before it stops descending.
	 *
	 * {@link MAX_WALK_DEPTH} bounds how deep a payload can take the walk;
	 * nothing bounded how *wide* it could be, and the walk costs about 9 ns a
	 * node. A list of 200 rows is ~19 µs — fine — but nothing stopped a runaway
	 * structure from being unbounded, and entering class instances widened what
	 * "runaway" can reach.
	 */
	readonly maxNodes: number;
	/**
	 * What a bound means when the walk hits one.
	 *
	 * @remarks
	 * `true` — the walk substitutes a marker for anything it could not look
	 * inside. `false` — it hands the value back untouched.
	 *
	 * The two walks in this package want opposite answers, and the difference is
	 * not a preference. The domain conversion is a **safety** pass: a subtree it
	 * did not enter may hold a `beans` object whose `toJSON()` is the lossless,
	 * unredacted persistence contract, so passing it through turns a guard on
	 * cost into the leak the walk exists to prevent. Key-name masking is a
	 * **heuristic** pass over a payload the conversion has already made safe: a
	 * subtree it did not enter is merely unmasked, exactly as it would be if the
	 * key were spelled differently, and deleting it would trade real data for no
	 * secrecy at all.
	 */
	readonly truncateWhenBounded: boolean;
};

/**
 * How deep a walk descends when no bound is given.
 *
 * @remarks
 * This was 6 for as long as depth was the *only* bound there was, and the
 * number came from `redactDeep`'s original tuning, where the cost of a runaway
 * payload had nowhere else to be stopped:
 *
 * | payload | bound 1 | 4 | 6 | 8 | 12 |
 * |---|---|---|---|---|---|
 * | flat, 4 keys | 39 ns | 52 ns | 54 ns | 51 ns | 36 ns |
 * | realistic, 4 deep | 12 ns | 354 ns | 336 ns | 339 ns | 337 ns |
 * | pathological, 12 deep | 14 ns | 318 ns | 376 ns | 540 ns | 721 ns |
 *
 * Two things changed that. {@link MAX_WALK_NODES} now bounds the total work
 * absolutely, so depth is no longer where cost is contained — the only jobs it
 * still has are keeping the recursion off the stack and stopping a
 * `class A { toJSON() { return new A(); } }` from projecting forever. And the
 * bound stopped being free: it used to hand the value back untouched, which
 * made a `sensitive` field below the seventh level leave through the entity's
 * unredacted `toJSON()`. It now substitutes a marker instead, which is safe but
 * *lossy* — and losing the tail of a payload at level 7 is far too shallow to
 * be acceptable.
 *
 * So the bound is set past any realistic payload rather than close to one, and
 * truncation becomes the exception it should have been. Raising it costs
 * nothing on data that is not that deep — the walk stops when it runs out of
 * nesting, which is why the realistic row above is flat from 4 onwards.
 *
 * **Counting rule:** the record handed to {@link walkRecord} is depth 1, so
 * its own values are reached at depth 2. `maxDepth: 1` therefore visits the
 * top level and descends nowhere.
 *
 * @see {@link MAX_CONFIGURABLE_DEPTH} — the ceiling on overriding it.
 */
export const MAX_WALK_DEPTH = 24;

/**
 * The highest `maxDepth` a consumer may ask for.
 *
 * @remarks
 * The walk is recursive, so a bound is also a bound on stack frames. 64 is far
 * past any payload anyone means to log and far short of anything that could
 * exhaust a stack, which makes it a guard rail rather than a tuning knob.
 */
export const MAX_CONFIGURABLE_DEPTH = 64;

/**
 * How many objects a walk will enter when no budget is given.
 *
 * Deliberately far past any sane payload rather than tuned close to one: at
 * ~9 ns a node this is roughly 90 µs, and the widest realistic payload
 * measured — 200 rows of 11 fields — enters about 200 objects. The budget is a
 * stop for a structure that has gone wrong, not a policy about payload size,
 * so it should never fire on a log line anyone meant to write.
 */
export const MAX_WALK_NODES = 10_000;

/** Substituted for a subtree the walk refused to enter because the budget ran out. */
const TRUNCATED = "[truncated: node budget]";

/**
 * Where a record's converted projection goes when the projection is not itself
 * a record.
 *
 * Namespaced like `CONVERSION_ERROR_KEY`, and for the same reason: it is the
 * walk speaking about the payload rather than anything the payload contained.
 */
export const PROJECTED_VALUE_KEY = "$aroma.value";

/** Substituted for a subtree that sits below {@link WalkPlan.maxDepth}. */
const TRUNCATED_DEPTH = "[truncated: depth]";

/**
 * Validate a caller-supplied depth bound and resolve the default.
 *
 * @remarks
 * Throwing here is deliberate, and does not contradict the rule that this
 * package never throws at the caller: that rule is about `log.info()`, where a
 * failure has to degrade because the application is mid-flight and the payload
 * is not the logger's to reject. A bound outside `1..{@link
 * MAX_CONFIGURABLE_DEPTH}` is a mistake in configuration, discovered once at
 * construction, and silently clamping it would leave someone believing they
 * had a depth they do not have.
 *
 * @param maxDepth - the requested bound, or `undefined` for the default.
 * @returns the bound to use.
 * @throws AromaException when the value is not an integer in range.
 *
 * @internal
 */
export function assertWalkDepth(maxDepth: number | undefined): number {
	if (maxDepth === undefined) {
		return MAX_WALK_DEPTH;
	}

	if (
		!Number.isInteger(maxDepth) ||
		maxDepth < 1 ||
		maxDepth > MAX_CONFIGURABLE_DEPTH
	) {
		throw new AromaException(
			`maxDepth must be an integer between 1 and ${MAX_CONFIGURABLE_DEPTH}, received ${String(maxDepth)}`,
		);
	}

	return maxDepth;
}

/**
 * Build a plan. Call it once, at processor construction — never per event.
 *
 * @param visit - the per-value decision.
 * @param primitives - whether `visit` should see non-object values.
 * @param maxDepth - levels to descend. Defaults to {@link MAX_WALK_DEPTH}.
 * @param truncateWhenBounded - see {@link WalkPlan.truncateWhenBounded}.
 */
export function createWalkPlan(
	visit: Visitor,
	primitives: boolean,
	maxDepth: number = MAX_WALK_DEPTH,
	truncateWhenBounded = true,
	maxNodes: number = MAX_WALK_NODES,
): WalkPlan {
	return { visit, primitives, maxDepth, maxNodes, truncateWhenBounded };
}

/**
 * The mutable half of a walk: the ancestors currently on the stack, and what
 * is left of the node budget.
 *
 * Allocated on the **first real descent**, never per call — a flat payload,
 * which is the common one, never reaches a descendable value and so allocates
 * nothing. That was already true of the bare `WeakSet` it replaces, and the
 * budget rides along for free.
 *
 * The corollary is that the budget only governs descent. A record of ten
 * thousand primitives is not bounded by it, and does not need to be: the walk
 * skips primitives outright for the domain plan, and the cost that made a
 * budget necessary is entering objects.
 */
type WalkState = { readonly seen: WeakSet<object>; left: number };

/** Objects the walk is willing to look inside. */
type Descendable =
	| Record<string, unknown>
	| unknown[]
	| Map<unknown, unknown>
	| Set<unknown>;

/**
 * Whether the walk will look inside `value`. Everything except binary.
 *
 * @remarks
 * This used to require a prototype of `Object.prototype`, on the reasoning
 * that a class instance is either a domain object the visitor already claimed
 * or something whose internals are none of a logger's business. The second
 * half of that was wrong in a way that cost a leak: an ordinary class that
 * merely *carries* an entity was refused too, and `JSON.stringify` then
 * serialised its own enumerable properties straight into the entity's
 * lossless, unredacted `toJSON()`. That was door 6.
 *
 * Descending into class instances turns out to be far cheaper and safer than
 * it sounds, because `Object.keys` returns only **own enumerable** properties:
 *
 * - a getter declared on a class lives on the *prototype*, so it is never
 *   invoked here — the lazy-getter hazard is mostly imaginary;
 * - `Date`, `Error`, `Promise`, `URL`, `RegExp` and `ArrayBuffer` have no own
 *   enumerable properties at all, so they come back by identity through the
 *   ordinary lazy clone rather than through a special case.
 *
 * Binary is the one real exception and the only rule left: `Object.keys` on a
 * typed array returns one entry per element, so walking a megabyte `Buffer`
 * would mean a million visits — and no domain object has ever hidden inside
 * one.
 *
 * What remains reachable is an own enumerable accessor that throws, or a
 * `Proxy` with a hostile trap. Neither can take down a log line: the bundled
 * processors convert `bindings` and `meta` under their own `try` and degrade
 * the failed record (see `conversionFailed`).
 */
function descendable(value: unknown): value is Descendable {
	if (typeof value !== "object" || value === null) {
		return false;
	}

	if (Array.isArray(value) || value instanceof Map || value instanceof Set) {
		return true;
	}

	return !ArrayBuffer.isView(value);
}

/**
 * Walk a `bindings` / `meta` record, applying the plan's visitor to every
 * value at every level.
 *
 * **Lazy clone at every level**: a subtree the visitor had no opinion about
 * comes back by identity and only the path down to a change is rebuilt, so an
 * event carrying nothing of interest allocates nothing. That property is what
 * keeps the walk off the cost of an ordinary log line, and it is the first
 * thing to check if the benchmark ever moves.
 *
 * @param target - the record to walk; `undefined` passes through unchanged.
 * @param plan - the visitor and its bounds.
 * @returns either `target` itself or a fresh record.
 *
 * @typeParam T - shape of the input record; the return type preserves it.
 */
export function walkRecord<T extends Record<string, unknown> | undefined>(
	target: T,
	plan: WalkPlan,
): T {
	if (!target || plan.maxDepth < 1) {
		return target;
	}

	if (!hasProjection(target)) {
		return record(target, plan, 1, undefined) as T;
	}

	// `bindings` and `meta` are records the serialiser reaches by name, so they
	// never pass through `descend` and never saw the projection rule. They are
	// also the two places a consumer's own object arrives whole — `log.info(dto)`
	// snapshots its own enumerable keys, `toJSON` included — which is why door 8
	// was open here as well as at depth.
	const projected = (target as unknown as { toJSON: () => unknown }).toJSON();
	const walked = walkValue(projected, "", plan);

	if (walked === projected) {
		// Nothing of ours in it: hand back the original, and the serialiser calls
		// `toJSON()` exactly as it always did.
		return target;
	}

	if (typeof walked !== "object" || walked === null || Array.isArray(walked)) {
		// A record that serialises as something which is not a record —
		// `{ toJSON: () => [entity] }` is the honest example. Returning the
		// original here would be the leak back, so the converted value is carried
		// under a namespaced key instead of dropped.
		return { [PROJECTED_VALUE_KEY]: walked } as unknown as T;
	}

	return walked as T;
}

/**
 * Walk a single value that is not inside a record — `err.cause`, or a domain
 * object passed as `meta` itself. A {@link SpreadFields} has no siblings to
 * expand into here, so it resolves to its fields.
 *
 * @param value - the value to convert.
 * @param key - the name to report it under; used as a redaction context.
 * @param plan - the visitor and its bounds.
 * @returns the converted value, or `value` itself when nothing matched.
 */
export function walkValue(
	value: unknown,
	key: string,
	plan: WalkPlan,
): unknown {
	const isObject = typeof value === "object" && value !== null;
	const replacement =
		isObject || plan.primitives ? plan.visit(value, key) : PASS;

	if (replacement !== PASS) {
		return resolve(replacement);
	}

	return descend(value, key, plan, 1, undefined, undefined);
}

/** A spread that reached a place with no siblings to expand into is just its fields. */
function resolve(replacement: unknown): unknown {
	return replacement instanceof SpreadFields ? replacement.fields : replacement;
}

/**
 * Descend into a value the visitor passed on, guarding depth, cycles and the
 * node budget.
 *
 * `state.seen` holds the ancestors currently on the stack, so a repeated
 * sibling subtree is still visited while a true cycle is not.
 */
function descend(
	value: unknown,
	key: string,
	plan: WalkPlan,
	depth: number,
	state: WalkState | undefined,
	parent: object | undefined,
): unknown {
	// Order matters, and it is the whole of door 8. A primitive or a binary
	// value comes back by identity — deliberate, and safe, because neither can
	// hold a domain object. Anything the walk *would* have entered and cannot
	// becomes a marker instead: a guard that hands the value back unconverted
	// trades a cost problem for the leak the walk exists to prevent, which is
	// the rule the node budget below already follows.
	if (!descendable(value)) {
		return value;
	}

	if (depth > plan.maxDepth) {
		return plan.truncateWhenBounded ? TRUNCATED_DEPTH : value;
	}

	// Allocated on the first real descent, not per call: a flat payload — the
	// common one — never reaches here with a descendable value, and an empty
	// WeakSet cost 62 ns an event to sit there. Seeding it with `parent` is
	// what makes a payload pointing back at its own root collapse immediately
	// instead of unrolling one extra level first.
	const walk: WalkState = state ?? {
		seen: new WeakSet<object>(parent ? [parent] : []),
		left: plan.maxNodes,
	};

	if (walk.left <= 0) {
		// The budget stops the walk at the door of an object it has not entered,
		// and substitutes a marker rather than the value. Passing the value
		// through unconverted is the one thing it must never do — that would
		// turn a cost guard into the leak the walk exists to prevent.
		return plan.truncateWhenBounded ? TRUNCATED : value;
	}
	walk.left--;

	if (walk.seen.has(value)) {
		// **Not** the original object. Returning it would hand back the very
		// ancestor whose fields are mid-conversion — a cycle would then carry an
		// unconverted copy out through the back reference, which is what an
		// adversarial spec caught here once already.
		return CIRCULAR;
	}
	walk.seen.add(value);

	let next: unknown;
	if (Array.isArray(value)) {
		next = array(value, key, plan, depth, walk);
	} else if (value instanceof Map) {
		next = fromMap(value, plan, depth, walk);
	} else if (value instanceof Set) {
		next = array([...value], key, plan, depth, walk);
	} else if (hasProjection(value)) {
		next = project(value, key, plan, depth, walk);
	} else {
		next = record(value as Record<string, unknown>, plan, depth, walk);
	}

	walk.seen.delete(value);
	return next;
}

/**
 * Whether this object serialises as something other than its own properties.
 *
 * @remarks
 * The walk decides what to convert by reading own enumerable properties;
 * `JSON.stringify` decides what to emit by calling `toJSON()`. While the two
 * agree, converting the properties is enough. When they disagree the
 * conversion is bypassed completely: a class holding its state in a `#private`
 * field or a non-enumerable property shows the walk nothing, and then hands
 * the serialiser the entity's own unredacted `toJSON()`. That was door 7.
 *
 * This used to require the value to have a prototype of its own, excluding a
 * plain literal that carries its own `toJSON` on the reasoning that a
 * literal's properties are visible to the walk anyway. A literal whose
 * projection reads from a **closure** is the counter-example, and it was door
 * 8 — reachable from all four entry points, since nothing about it is exotic:
 *
 * ```ts
 * const user = await repo.find(id);
 * log.info({ res: { toJSON: () => ({ data: user }) } }, "responded");
 * ```
 *
 * The exclusion was defended on cost, and that was wrong: the property load
 * below happens for every object either way, and it was the `getPrototypeOf`
 * — which only ran when a `toJSON` existed — that did the excluding. Dropping
 * it makes this cheaper, not dearer, and leaves the rule exactly the one
 * `JSON.stringify` uses: a callable `toJSON`, own or inherited, decides what
 * this value is.
 */
function hasProjection(value: object): boolean {
	return typeof (value as { toJSON?: unknown }).toJSON === "function";
}

/**
 * Walk what the object will actually serialise as, rather than what it holds.
 *
 * Returning the **original** when the projection came back unchanged is what
 * keeps this from becoming "replace every object by its `toJSON()`": a `Date`
 * projects to a string, nothing inside it is ours, and the `Date` itself is
 * handed back — by identity, which is what the lazy clone promises and what a
 * transport reading the raw event depends on. Only a projection that actually
 * contained something worth converting replaces its object.
 *
 * The visitor runs on the projection before the walk descends into it, because
 * the projection may *be* a domain object — `toJSON() { return this.#user; }`
 * is a perfectly ordinary thing to write.
 *
 * Depth advances by one: the projection is content from inside the object, and
 * spending a level here also bounds `class A { toJSON() { return new A(); } }`
 * at {@link MAX_WALK_DEPTH} instead of leaving it to exhaust the node budget.
 */
function project(
	value: object,
	key: string,
	plan: WalkPlan,
	depth: number,
	state: WalkState,
): unknown {
	const projected = (value as { toJSON: () => unknown }).toJSON();
	const isObject = typeof projected === "object" && projected !== null;
	const replacement =
		isObject || plan.primitives ? plan.visit(projected, key) : PASS;

	const walked =
		replacement === PASS
			? descend(projected, key, plan, depth + 1, state, value)
			: resolve(replacement);

	return walked === projected ? value : walked;
}

function record(
	rec: Record<string, unknown>,
	plan: WalkPlan,
	depth: number,
	state: WalkState | undefined,
): Record<string, unknown> {
	const visit = plan.visit;
	const wantsPrimitives = plan.primitives;
	let next: Record<string, unknown> | undefined;

	for (const key of Object.keys(rec)) {
		const value = rec[key];
		const isObject = typeof value === "object" && value !== null;
		const replacement = isObject || wantsPrimitives ? visit(value, key) : PASS;

		if (replacement === PASS) {
			if (!isObject) continue;

			const walked = descend(value, key, plan, depth + 1, state, rec);
			if (walked === value) continue;

			next ??= { ...rec };
			next[key] = walked;
			continue;
		}

		// A visitor that claimed the entry but produced the same object must not
		// force a clone.
		if (replacement === value) continue;

		next ??= { ...rec };

		// A spread is the one replacement that changes the *record's* shape
		// rather than one value's, and only at the top level — see
		// {@link SpreadFields}.
		if (depth === 1 && replacement instanceof SpreadFields) {
			delete next[key];
			const fields = replacement.fields;
			for (const field of Object.keys(fields)) {
				next[`${key}.${field}`] = fields[field];
			}
			continue;
		}

		next[key] = resolve(replacement);
	}

	return next ?? rec;
}

function array(
	values: unknown[],
	key: string,
	plan: WalkPlan,
	depth: number,
	state: WalkState | undefined,
): unknown[] {
	const visit = plan.visit;
	const wantsPrimitives = plan.primitives;
	let next: unknown[] | undefined;

	for (let index = 0; index < values.length; index++) {
		const item = values[index];
		const isObject = typeof item === "object" && item !== null;
		const replacement = isObject || wantsPrimitives ? visit(item, key) : PASS;

		let walked: unknown;
		if (replacement === PASS) {
			if (!isObject) continue;
			walked = descend(item, key, plan, depth + 1, state, values);
		} else {
			walked = resolve(replacement);
		}

		if (walked !== item) {
			next ??= [...values];
			next[index] = walked;
		}
	}

	return next ?? values;
}

/**
 * Convert a `Map` to a plain object, walking each value. A `Set` gets the same
 * treatment through {@link array}.
 *
 * Unlike an array this is **not** lazy, because identity is not a safe default
 * here: `JSON.stringify(new Map(…))` is `{}`, so handing the Map back
 * untouched does not preserve the log line, it erases it — including any
 * redaction just applied inside it, which would then be invisible rather than
 * absent. Normalising is the only outcome that keeps the entry readable, and a
 * `Map` in a log payload is rare enough that the allocation is not a hot path.
 */
function fromMap(
	values: Map<unknown, unknown>,
	plan: WalkPlan,
	depth: number,
	state: WalkState | undefined,
): Record<string, unknown> {
	const visit = plan.visit;
	const wantsPrimitives = plan.primitives;
	const next: Record<string, unknown> = {};

	for (const [entryKey, entryValue] of values) {
		const key = String(entryKey);
		const isObject = typeof entryValue === "object" && entryValue !== null;
		const replacement =
			isObject || wantsPrimitives ? visit(entryValue, key) : PASS;

		next[key] =
			replacement === PASS
				? descend(entryValue, key, plan, depth + 1, state, values)
				: resolve(replacement);
	}

	return next;
}
