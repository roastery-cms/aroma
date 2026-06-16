/**
 * Type-only barrel for `@roastery/aroma/types`. Re-exports the public
 * contracts every consumer hovers over: `ILogEvent`, `ILogger`,
 * `ITransport`, `IProcessor`, `Bindings`, the `LogLevel` literal union and
 * the numeric mapping `LEVEL_NUMERIC` used for severity comparisons.
 *
 * Importing from this subpath keeps consumer code agnostic of the bundled
 * concrete implementations (`Logger`, `FastStdioTransport`) — useful when
 * writing custom transports/processors or when typing application-level
 * adapters.
 *
 * @module @roastery/aroma/types
 *
 * @see {@link Logger}
 * @see {@link FastStdioTransport}
 */

export type { Bindings } from "@/types/bindings";
export type { ILogEvent } from "@/types/log-event.interface";
export type { LogLevel, LogLevelNumeric } from "@/types/log-level";
export { LEVEL_NUMERIC } from "@/types/log-level";
export type { ILogger } from "@/types/logger.interface";
export type { IProcessor } from "@/types/processor.interface";
export type { ITransport } from "@/types/transport.interface";
