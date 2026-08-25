import { AROMA_SOURCE, redactedValue } from "@/internal/redacted-value";

/**
 * How deep {@link redactDeep} descends when no depth is given.
 *
 * @remarks
 * Redaction used to stop at the top level, which left the single most common
 * shape in an HTTP service unprotected — `{ req: { headers: { authorization
 * } } }` has its secret three levels down, and no domain processor reaches it
 * because a Node request is not a `beans` object.
 *
 * A bound is still needed: the traversal runs on every effective event, and a
 * pathologically nested payload must not turn into unbounded work on the hot
 * path.
 *
 * Six is measured, not guessed. The cost of the bound depends entirely on how
 * deep the *payload* is, because the walk stops when it runs out of nesting:
 *
 * | payload | `maxDepth` 1 | 4 | 6 | 8 | 12 |
 * |---|---|---|---|---|---|
 * | flat, 4 keys | 39 ns | 52 ns | 54 ns | 51 ns | 36 ns |
 * | realistic, 4 deep | 12 ns | 354 ns | 336 ns | 339 ns | 337 ns |
 * | pathological, 12 deep | 14 ns | 318 ns | 376 ns | 540 ns | 721 ns |
 *
 * Raising the bound past the data costs nothing — the realistic row is flat
 * from 4 onwards — so the default is chosen for **coverage**, not for cost:
 * `req.headers.authorization` is three levels, `ctx.request.headers.cookie`
 * four, and six leaves room. The only row where the bound is load-bearing is
 * the pathological one, which is exactly what it is for.
 *
 * @see {@link RedactProcessorOptions.maxDepth} — how to change it per logger.
 */
export const DEFAULT_REDACT_MAX_DEPTH = 6;

/**
 * Substituted for a back reference, matching what `safeStringify` emits so the
 * output is unchanged from a reader's point of view.
 */
const CIRCULAR = "[Circular]";

/** Objects this traversal is willing to descend into. */
type Descendable =
	| Record<string, unknown>
	| unknown[]
	| Map<unknown, unknown>
	| Set<unknown>;

/**
 * Return a copy of `target` with every key listed in `keys` replaced by the
 * configured redaction placeholder — **at any depth**, not just the top
 * level. The original `target` is never mutated.
 *
 * **Lazy clone at every level**: a subtree containing no listed key comes
 * back by identity, and only the path down to a match is rebuilt. An event
 * whose payload holds nothing sensitive therefore allocates nothing, which is
 * the property the shallow version had and the one that must survive going
 * deep.
 *
 * Descends into plain objects, arrays, `Map`s and `Set`s. Anything else —
 * a class instance, a `Date`, an `Error` — is left alone. That is what keeps
 * a `@roastery/beans` object out of this traversal: it has already been
 * converted by the domain processor, which runs first, and its internal
 * redaction is the domain layer's own business.
 *
 * Two protections the top-level-only version never needed:
 *
 * - a `WeakSet` of ancestors, so `const a = {}; a.self = a` terminates
 *   instead of recursing forever. `safeStringify` already handles cycles, but
 *   it runs at serialisation, far too late for this step.
 * - a depth bound (see {@link DEFAULT_REDACT_MAX_DEPTH}).
 *
 * @param target - object to scan; passes through `undefined` unchanged.
 * @param keys - field names replaced wherever they appear.
 * @param maxDepth - levels to descend. `1` restores the historical
 *   top-level-only behaviour exactly.
 * @returns either the original `target` (nothing matched) or a fresh copy
 *   with the matching fields replaced.
 *
 * @example
 * ```ts
 * redactDeep({ req: { headers: { authorization: "Bearer x" } } }, ["authorization"]);
 * // → { req: { headers: { authorization: "[redacted]" } } }
 *
 * redactDeep({ safe: { nested: "ok" } }, ["password"]);
 * // → same object reference, and the same reference for `safe` too
 * ```
 *
 * @typeParam T - shape of the input object; the return type preserves it.
 *
 * @see {@link redactedValue} — how the placeholder is resolved.
 *
 * @internal
 */
export function redactDeep<T extends Record<string, unknown> | undefined>(
	target: T,
	keys: ReadonlyArray<string> | ReadonlySet<string>,
	maxDepth: number = DEFAULT_REDACT_MAX_DEPTH,
): T {
	if (!target || maxDepth < 1) {
		return target;
	}

	// Callers on the hot path pass a Set built once (see
	// `createRedactProcessor`): building one here per event cost 248 ns, more
	// than the entire traversal it was for.
	const keySet: ReadonlySet<string> =
		keys instanceof Set ? keys : new Set(keys as ReadonlyArray<string>);

	if (keySet.size === 0) {
		return target;
	}

	return walkRecord(target, keySet, 1, maxDepth, undefined) as T;
}

/** Whether the traversal is willing to look inside `value`. */
function descendable(value: unknown): value is Descendable {
	if (typeof value !== "object" || value === null) {
		return false;
	}

	if (Array.isArray(value) || value instanceof Map || value instanceof Set) {
		return true;
	}

	// Plain objects only. A class instance is either a domain object the
	// converter already handled, or something whose internals are none of the
	// logger's business.
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/**
 * Convert one nested value, returning it by identity when nothing inside
 * changed. `seen` holds the ancestors currently on the stack, so a repeated
 * sibling subtree is still visited while a true cycle is not.
 */
function walk(
	value: unknown,
	keySet: ReadonlySet<string>,
	depth: number,
	maxDepth: number,
	seen: WeakSet<object> | undefined,
	parent: object,
): unknown {
	if (depth > maxDepth || !descendable(value)) {
		return value;
	}

	// Allocated on the first real descent, not per call. A flat payload — the
	// common one — never gets here with a descendable value, and a WeakSet cost
	// 62 ns an event to sit empty. Seeding it with `parent` is what makes a
	// payload pointing back at its own root collapse immediately instead of
	// unrolling one extra level first.
	const ancestors = seen ?? new WeakSet<object>([parent]);

	if (ancestors.has(value)) {
		// **Not** the original object. Returning it would hand back the very
		// ancestor whose sensitive fields are mid-redaction — a cycle would then
		// carry the unredacted copy out through the back reference, which is
		// exactly what an adversarial spec caught here. The sentinel is the one
		// `safeStringify` already substitutes for a cycle, so the serialised line
		// reads the same as it always did; the difference is that the payload is
		// now acyclic and takes the fast path.
		return CIRCULAR;
	}
	ancestors.add(value);

	let next: unknown;
	if (Array.isArray(value)) {
		next = walkArray(value, keySet, depth, maxDepth, ancestors);
	} else if (value instanceof Map) {
		next = walkMap(value, keySet, depth, maxDepth, ancestors);
	} else if (value instanceof Set) {
		next = walkSet(value, keySet, depth, maxDepth, ancestors);
	} else {
		next = walkRecord(value, keySet, depth, maxDepth, ancestors);
	}

	ancestors.delete(value);
	return next;
}

function walkRecord(
	record: Record<string, unknown>,
	keySet: ReadonlySet<string>,
	depth: number,
	maxDepth: number,
	seen: WeakSet<object> | undefined,
): Record<string, unknown> {
	let next: Record<string, unknown> | undefined;

	for (const key of Object.keys(record)) {
		const value = record[key];

		if (keySet.has(key)) {
			next ??= { ...record };
			next[key] = redactedValue(value, { name: key, source: AROMA_SOURCE });
			continue;
		}

		const walked = walk(value, keySet, depth + 1, maxDepth, seen, record);
		if (walked !== value) {
			next ??= { ...record };
			next[key] = walked;
		}
	}

	return next ?? record;
}

function walkArray(
	values: unknown[],
	keySet: ReadonlySet<string>,
	depth: number,
	maxDepth: number,
	seen: WeakSet<object> | undefined,
): unknown[] {
	let next: unknown[] | undefined;

	for (let index = 0; index < values.length; index++) {
		const value = values[index];
		const walked = walk(value, keySet, depth + 1, maxDepth, seen, values);

		if (walked !== value) {
			next ??= [...values];
			next[index] = walked;
		}
	}

	return next ?? values;
}

function walkMap(
	values: Map<unknown, unknown>,
	keySet: ReadonlySet<string>,
	depth: number,
	maxDepth: number,
	seen: WeakSet<object> | undefined,
): Map<unknown, unknown> {
	let next: Map<unknown, unknown> | undefined;

	for (const [key, value] of values) {
		const replacement =
			typeof key === "string" && keySet.has(key)
				? redactedValue(value, { name: key, source: AROMA_SOURCE })
				: walk(value, keySet, depth + 1, maxDepth, seen, values);

		if (replacement !== value) {
			next ??= new Map(values);
			next.set(key, replacement);
		}
	}

	return next ?? values;
}

/**
 * A `Set` has no key to write a replacement through, so it is materialised as
 * an array, walked with the array's own lazy rules, and rebuilt only if
 * something inside actually changed. Sets are rare enough in a log payload
 * that the one array allocation is not worth avoiding at the cost of a
 * partially-rebuilt set.
 */
function walkSet(
	values: Set<unknown>,
	keySet: ReadonlySet<string>,
	depth: number,
	maxDepth: number,
	seen: WeakSet<object> | undefined,
): Set<unknown> {
	const items = [...values];
	const walked = walkArray(items, keySet, depth, maxDepth, seen);

	return walked === items ? values : new Set(walked);
}
