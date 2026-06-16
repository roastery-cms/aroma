/**
 * Severity tag attached to every log event.
 *
 * The order of the union mirrors increasing severity: `trace` is the most
 * verbose (development-only diagnostic noise), `fatal` is reserved for
 * unrecoverable failures that typically precede process termination. The
 * literal strings themselves are what gets serialised onto `ILogEvent.level`
 * and shipped to aggregators — keep them stable.
 *
 * @remarks
 * Numeric thresholds used internally for filtering live in `LEVEL_NUMERIC`
 * (this same module). Each level is spaced by ten so future levels can be
 * slotted in without renumbering existing comparisons — a convention
 * borrowed from pino.
 *
 * **Anti-pattern**: do not encode structured data into `msg` by passing
 * `JSON.stringify(obj)`. Downstream tools index `msg` as a plain string and
 * cannot extract fields from inside it. Pass the object as the `meta`
 * argument instead — it becomes a queryable top-level field on the event.
 *
 * @example
 * ```ts
 * // Bad: structured payload trapped inside msg as escaped string
 * logger.info(JSON.stringify({ userId: 42 }));
 *
 * // Good: payload travels in meta, queryable as event.meta.userId
 * logger.info({ userId: 42 }, "user registered");
 * ```
 *
 * @see {@link ILogger} — methods are named after each level.
 * @see {@link ILogEvent.level} — where the chosen level lands on the wire.
 * @see {@link LEVEL_NUMERIC} — numeric mapping used for comparisons.
 */
export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

/**
 * Numeric severity assigned to each `LogLevel`. Higher number = higher
 * severity. Levels are spaced by ten so future levels (e.g. `notice: 35`
 * between `info` and `warn`) can be added without renumbering or breaking
 * comparisons stored elsewhere.
 *
 * Exposed at the public API so consumers building custom transports or
 * processors can perform the same severity comparisons the logger uses
 * internally — without re-deriving the mapping.
 *
 * @example
 * ```ts
 * import { LEVEL_NUMERIC } from "@roastery/aroma";
 *
 * function isAtLeast(level: LogLevel, threshold: LogLevel): boolean {
 *   return LEVEL_NUMERIC[level] >= LEVEL_NUMERIC[threshold];
 * }
 * ```
 *
 * @see {@link LogLevel}
 */
export const LEVEL_NUMERIC = {
	trace: 10,
	debug: 20,
	info: 30,
	warn: 40,
	error: 50,
	fatal: 60,
} as const satisfies Record<LogLevel, number>;

/**
 * Union of the numeric severity values in `LEVEL_NUMERIC`. Useful when a
 * custom processor needs to type a pre-computed numeric threshold without
 * loosening to plain `number`.
 *
 * @see {@link LEVEL_NUMERIC}
 */
export type LogLevelNumeric = (typeof LEVEL_NUMERIC)[LogLevel];
