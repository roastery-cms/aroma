const REDACTED = "[REDACTED]";

/**
 * Return a copy of `target` with any top-level key listed in `keys`
 * replaced by the `"[REDACTED]"` sentinel. The original `target` is never
 * mutated.
 *
 * **Lazy clone**: if no key from `keys` is present at the top level of
 * `target`, the original object is returned by identity — no allocation
 * happens. This keeps the hot path zero-cost for the common case where
 * nothing actually needs redaction.
 *
 * MVP scope is **shallow only** — nested paths (e.g. `"user.password"`)
 * are not interpreted. Extending to dot-paths later is additive.
 *
 * @param target - object to scan; passes through `undefined` unchanged.
 * @param keys - field names that should be replaced if present at the top level.
 * @returns either the original `target` (no match) or a fresh copy with
 *   matching fields replaced.
 *
 * @example
 * ```ts
 * redactShallow({ user: "alan", password: "x" }, ["password"]);
 * // → { user: "alan", password: "[REDACTED]" }
 *
 * redactShallow({ safe: "ok" }, ["password"]);
 * // → same object reference (no allocation)
 * ```
 *
 * @typeParam T - shape of the input object; the return type preserves it.
 *
 * @internal
 */
export function redactShallow<T extends Record<string, unknown> | undefined>(
	target: T,
	keys: ReadonlyArray<string>,
): T {
	if (!target || keys.length === 0) {
		return target;
	}

	let hit = false;
	for (const key of keys) {
		if (key in target) {
			hit = true;
			break;
		}
	}
	if (!hit) {
		return target;
	}

	const keySet = new Set(keys);
	const next: Record<string, unknown> = { ...target };

	for (const key of Object.keys(next)) {
		if (keySet.has(key)) {
			next[key] = REDACTED;
		}
	}

	return next as T;
}
