import { AsyncLocalStorage } from "node:async_hooks";
import type { Bindings } from "@/types/bindings";

/**
 * Singleton `AsyncLocalStorage` instance shared across the `@roastery/aroma/context`
 * subpath and consulted by the core `Logger` when present. Holding it at
 * module scope makes the API import-free for callers — they just call
 * `runWithContext` / `getContext` and the same store is used everywhere.
 *
 * @remarks
 * - The store carries a single `Bindings` value per async chain. Nested
 *   `runWithContext` calls overlay child bindings on top of parents
 *   (parent bindings are still merged by `runWithContext`).
 * - Tying the store to a module-level constant means **every logger in
 *   the process shares the same context tree** — exactly what
 *   distributed-tracing-style context propagation expects.
 *
 * @internal
 */
export const ALS_STORE = new AsyncLocalStorage<Bindings>();
