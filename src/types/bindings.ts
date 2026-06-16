/**
 * Open-shape record used everywhere a logger needs to carry contextual or
 * payload data: the persistent context attached to a logger
 * (`LoggerOptions.bindings`), the per-call structured data (the `meta`
 * argument of any level method), and the merged result stored on
 * `ILogEvent.bindings` / `ILogEvent.meta`.
 *
 * Keeping a dedicated alias instead of inlining `Record<string, unknown>`
 * everywhere serves two purposes:
 *
 * 1. **Readability** at every call site that mentions logger context —
 *    `Bindings` reads as a domain concept; `Record<string, unknown>` reads
 *    as a type.
 * 2. **Single point of evolution** if we later want to constrain the shape
 *    (e.g. forbid functions, accept only JSON-serialisable values) we can
 *    tighten `Bindings` once and ripple it through the package.
 *
 * @see {@link ILogEvent.bindings}
 * @see {@link ILogger.child}
 */
export type Bindings = Record<string, unknown>;
