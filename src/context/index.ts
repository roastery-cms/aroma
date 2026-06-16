/**
 * Barrel for `@roastery/aroma/context`. Adds AsyncLocalStorage-backed
 * context propagation to any logger built via `createAroma` or `new
 * Logger`. The core does **not** depend on this subpath — importing it
 * activates the integration (the core lazy-detects the store at emit
 * time).
 *
 * Use this when you want `requestId` / `traceId` / `userId` / etc. to
 * ride along on every log inside an async chain without manually
 * threading a `log.child(...)` through every function.
 *
 * @module @roastery/aroma/context
 *
 * @example
 * ```ts
 * import { createAroma } from "@roastery/aroma";
 * import { runWithContext } from "@roastery/aroma/context";
 *
 * const log = createAroma();
 *
 * runWithContext({ requestId: "abc-123" }, async () => {
 *   log.info("started");
 *   await processOrder();
 *   log.info("done");  // still tagged with requestId
 * });
 * ```
 *
 * @see {@link runWithContext}
 * @see {@link getContext}
 */

import { getContext } from "@/context/get-context";
import { _registerContextReader } from "@/logger";

_registerContextReader(getContext);

export { getContext } from "@/context/get-context";
export { runWithContext } from "@/context/run-with-context";
