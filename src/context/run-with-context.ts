import { ALS_STORE } from "@/context/als";
import type { Bindings } from "@/types/bindings";

/**
 * Run a callback with the supplied `bindings` attached to the current async
 * context. Any `logger.info(...)` (or other level method) invoked
 * synchronously **or asynchronously inside `fn`** will see those bindings
 * merged into the emitted event's `bindings` automatically.
 *
 * This is the "AsyncLocalStorage-as-context" pattern used by pino,
 * winston-context, and OpenTelemetry — it removes the need to thread a
 * `child` logger through every function call.
 *
 * @param bindings - context to propagate. Merged with any outer context.
 * @param fn - callback executed in the context.
 * @returns whatever `fn` returns (or its `Promise`).
 *
 * @example
 * ```ts
 * import { createAroma } from "@roastery/aroma";
 * import { runWithContext } from "@roastery/aroma/context";
 *
 * const log = createAroma();
 *
 * app.use((req, _res, next) => {
 *   runWithContext({ requestId: req.id, route: req.path }, () => {
 *     log.info("request received");      // event.bindings has requestId+route
 *     handle(req).then(() => log.info("done"));  // still visible across await
 *     next();
 *   });
 * });
 * ```
 *
 * @see {@link getContext}
 */
export function runWithContext<R>(bindings: Bindings, fn: () => R): R {
	const parent = ALS_STORE.getStore();
	const merged = parent ? { ...parent, ...bindings } : bindings;
	return ALS_STORE.run(merged, fn);
}
