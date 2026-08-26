/**
 * `@roastery/aroma` — structured, transport-based logger for the Roastery
 * CMS ecosystem. Pino-style call shape, zero-allocation dropped-log path,
 * pluggable processors, domain-object safety by default, `AromaException`
 * failure surfacing.
 *
 * Root entry exposes the canonical factory (`createAroma`) and the
 * concrete `Logger` class for advanced wiring. Subpaths surface the rest
 * of the public API:
 *
 * - `@roastery/aroma/types` — `ILogger`, `ITransport`, `IProcessor`, `ILogEvent`, `LogLevel`, `Bindings`
 * - `@roastery/aroma/transports` — `FastStdioTransport`, `ConsoleTransport`, `FileTransport`, `WorkerTransport`, `NullTransport`
 * - `@roastery/aroma/processors` — `createDomainProcessor`, `createRedactProcessor`, `DEFAULT_REDACT_KEYS`, `createEnrichProcessor`, `createFilterProcessor`, `createSampleProcessor`
 * - `@roastery/aroma/context` — `runWithContext`, `getContext` (AsyncLocalStorage propagation)
 * - `@roastery/aroma/exceptions` — `AromaException`, `BackpressureDropException`
 *
 * The root also exports `isDiagnostic`, for a processor that must not count the
 * logger's own failure report as application traffic.
 *
 * @example
 * ```ts
 * import { createAroma } from "@roastery/aroma";
 *
 * const log = createAroma();
 *
 * log.info({ userId: 42 }, "user registered");
 * // stdout: {"level":"info","time":1700…,"msg":"user registered",
 * //          "bindings":{},"meta":{"userId":42}}
 *
 * log.info({ user }, "created");
 * // → a `@roastery/beans` entity is serialised through toSafeJSON(),
 * //   so a `sensitive` property never reaches the line
 *
 * log.info({ password: "x" }, "tried");
 * // → written as-is. Key-name masking is opt-in since 0.1.0:
 * //   processors: [createRedactProcessor({ keys: [...DEFAULT_REDACT_KEYS] })]
 *
 * const req = log.child({ requestId: "abc-123" });
 * req.error(new Error("boom"), "checkout failed");
 * ```
 *
 * @packageDocumentation
 */

export type { CreateAromaArgs } from "@/create-aroma";
export { createAroma } from "@/create-aroma";
export { isDiagnostic } from "@/internal/diagnostic";
export { Logger, type LoggerOptions } from "@/logger";
