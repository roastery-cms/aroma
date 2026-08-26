import { AROMA_SOURCE, redactedValue } from "@/internal/redacted-value";
import {
	createWalkPlan,
	MAX_WALK_DEPTH,
	PASS,
	type WalkPlan,
	walkRecord,
} from "@/internal/safe-walk";

/**
 * Build the walk plan for key-name masking: a listed key is replaced by the
 * configured placeholder, everything else is left to the walk.
 *
 * Call it **once**, at processor construction — see `createRedactProcessor`,
 * where the `Set` and this plan are both hoisted out of the hot path.
 * Constructing a seven-element `Set` inside the traversal used to cost 248 ns
 * an event, more than the traversal it was for.
 *
 * `primitives: true`: this visitor decides on the *key*, so it has to fire on
 * `{ password: "hunter2" }`, where the value is a string.
 *
 * @param keys - field names to mask, wherever they appear.
 * @param maxDepth - levels to descend. Defaults to {@link MAX_WALK_DEPTH}.
 *
 * @internal
 */
export function createRedactPlan(
	keys: ReadonlySet<string>,
	maxDepth: number = MAX_WALK_DEPTH,
): WalkPlan {
	return createWalkPlan(
		(value: unknown, key: string): unknown =>
			keys.has(key)
				? redactedValue(value, { name: key, source: AROMA_SOURCE })
				: PASS,
		true,
		maxDepth,
		// A subtree this walk did not reach is unmasked, not unsafe — the domain
		// conversion has already been through the same payload. Truncating here
		// would delete real data to protect nothing.
		false,
	);
}

/**
 * Return a copy of `target` with every key listed in `keys` replaced by the
 * configured redaction placeholder — **at any depth**, not just the top
 * level. The original `target` is never mutated.
 *
 * @remarks
 * This is key-name masking, and it is the half of log safety that
 * `@roastery/beans` cannot do. The domain layer knows a `PasswordVO` is
 * sensitive; a Node request object, a third-party API response and a DTO that
 * has not been validated into value objects yet are not domain objects and
 * never will be. `{ req: { headers: { authorization } } }` is the shape that
 * motivates it.
 *
 * Since 0.1.0 it is **opt-in** — `createAroma` no longer injects it. See
 * `createRedactProcessor`.
 *
 * The traversal itself lives in `@/internal/safe-walk`, shared with the domain
 * conversion, which is what keeps the two from drifting to different depths
 * the way they did in 0.0.3.
 *
 * @param target - object to scan; passes through `undefined` unchanged.
 * @param keys - field names replaced wherever they appear.
 * @param maxDepth - levels to descend. `1` restricts masking to the top level.
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
 * @typeParam T - shape of the input object. The return type preserves it as a
 *   convenience, and it is approximate in two places: a masked value becomes
 *   whatever the placeholder is, and a `Map` / `Set` is normalised to an object
 *   / array. Cast through `unknown` if you need to read either back.
 *
 * @see {@link redactedValue} — how the placeholder is resolved.
 * @see {@link MAX_WALK_DEPTH} — the shared default depth.
 *
 * @internal
 */
export function redactDeep<T extends Record<string, unknown> | undefined>(
	target: T,
	keys: ReadonlyArray<string> | ReadonlySet<string>,
	maxDepth: number = MAX_WALK_DEPTH,
): T {
	if (!target) {
		return target;
	}

	const keySet: ReadonlySet<string> =
		keys instanceof Set ? keys : new Set(keys as ReadonlyArray<string>);

	if (keySet.size === 0) {
		return target;
	}

	return walkRecord(target, createRedactPlan(keySet, maxDepth));
}
