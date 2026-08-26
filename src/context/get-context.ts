import { ALS_STORE } from "@/context/als";
import type { Bindings } from "@/types/bindings";

/**
 * Read the current async context bindings, if any. Returns `undefined`
 * when no `runWithContext` is on the stack. The `Logger` uses this
 * internally; consumers typically don't need to call it directly.
 *
 * @returns the merged bindings for the current async chain, or `undefined`.
 *
 * @example
 * ```ts
 * import { getContext } from "@roastery/aroma/context";
 *
 * function audit(action: string) {
 *   const ctx = getContext();
 *   db.audit.insert({ action, requestId: ctx?.requestId });
 * }
 * ```
 *
 * @since 0.0.1
 *
 * @see {@link runWithContext}
 */
export function getContext(): Bindings | undefined {
	return ALS_STORE.getStore();
}
