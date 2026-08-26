import type { AromaException } from "@/exceptions/aroma-exception";
import {
	claimMaskingWarning,
	MASKING_WARNING_MSG,
} from "@/internal/masks-keys";
import { Logger } from "@/logger";
import { createDomainProcessor } from "@/processors/domain";
import { FastStdioTransport } from "@/transports/fast-stdio-transport";
import type { Bindings } from "@/types/bindings";
import type { LogLevel } from "@/types/log-level";
import type { ILogger } from "@/types/logger.interface";
import type { IProcessor } from "@/types/processor.interface";
import type { ITransport } from "@/types/transport.interface";

/**
 * Arguments accepted by `createAroma`. Every field is optional and falls
 * back to a sensible default so `createAroma()` (no args) returns a
 * working logger that writes to stdout/stderr at `"info"` and above, with
 * `@roastery/beans` domain objects converted to their safe form.
 *
 * @since 0.0.1
 *
 * @see {@link createAroma}
 * @see {@link LoggerOptions}
 */
export type CreateAromaArgs = {
	/** Minimum severity that will be broadcast to transports. Defaults to `"info"`. */
	level?: LogLevel;
	/**
	 * Sinks the logger broadcasts events to. When omitted **or when an empty
	 * array is provided**, a single `FastStdioTransport` is injected so the
	 * logger is useful out of the box.
	 *
	 * @remarks
	 * `transports: []` is treated as "no preference" — it does **not** mean
	 * "silence the logger". To build a silent logger (e.g. for tests), pass an
	 * explicit `NullTransport`:
	 *
	 * ```ts
	 * const silent = createAroma({ transports: [new NullTransport()] });
	 * ```
	 */
	transports?: ReadonlyArray<ITransport>;
	/**
	 * Sequential pipeline of processors applied to every event before
	 * broadcast. The auto-injected **domain** processor runs before any of
	 * them, so the final pipeline is `[domain, ...processors]`.
	 *
	 * This is where key-name redaction goes, if you want it:
	 *
	 * ```ts
	 * import { createRedactProcessor, DEFAULT_REDACT_KEYS } from "@roastery/aroma/processors";
	 *
	 * createAroma({
	 *   processors: [createRedactProcessor({ keys: [...DEFAULT_REDACT_KEYS] })],
	 * });
	 * ```
	 */
	processors?: ReadonlyArray<IProcessor>;
	/**
	 * Silence the one-time startup warning about this logger not masking fields
	 * by name.
	 *
	 * @remarks
	 * Key-name masking is opt-in since 0.1.0, and unlike the removal of the
	 * `redact` option there is no compile error for anyone who simply never
	 * passed it — so `createAroma()` says so once at startup, on stderr *and*
	 * as one `warn` line on the log stream, since a service that discards
	 * stderr would otherwise never see it.
	 * Set this when the choice is deliberate: a service whose payloads are all
	 * domain objects, or one where masking is applied further down the line.
	 *
	 * @since 0.1.0
	 */
	acknowledgeNoMasking?: boolean;
	/**
	 * How many levels the domain conversion descends into `bindings`, `meta`
	 * and `err.cause`. Defaults to 24.
	 *
	 * @remarks
	 * Past the bound the walk substitutes `"[truncated: depth]"` rather than
	 * letting a subtree through unconverted, so lowering this trades visibility
	 * for cost and never for safety. Raising it is for payloads that are
	 * genuinely deeper than 24 levels; the walk's node budget bounds the total
	 * work either way. Must be an integer in `1..64`, checked here rather than
	 * clamped — a bound you did not get is worse than an error you did.
	 *
	 * @since 0.1.0
	 */
	maxDepth?: number;
	/** Callback fired for each transport whose `write` rejects. Defaults to no callback. */
	onError?: (err: AromaException) => void;
};

/**
 * Canonical entry point for `@roastery/aroma`. Build a logger with the
 * default `FastStdioTransport`, domain-object safety, optional custom
 * processors, and an optional failure callback.
 *
 * @remarks
 * **What this protects, and what it does not.** The injected domain processor
 * converts `@roastery/beans` objects through `toSafeJSON()`, so a `sensitive`
 * property cannot leave inside an `Entity`, a `ValueObject`, a `Command`, a
 * domain event or a collection of them — at any depth. That is the half of log
 * safety the domain layer can answer, because it is the half it models.
 *
 * It does **not** mask by field name. A plain `{ password: "hunter2" }`,
 * a Node request carrying an `authorization` header, or a third-party response
 * carrying a `token` are written out verbatim, because nothing in the domain
 * model describes them. Until 0.0.3 a default key list was applied here; it is
 * now opt-in, one line in `processors`:
 *
 * ```ts
 * import { createRedactProcessor, DEFAULT_REDACT_KEYS } from "@roastery/aroma/processors";
 *
 * createAroma({
 *   processors: [createRedactProcessor({ keys: [...DEFAULT_REDACT_KEYS] })],
 * });
 * ```
 *
 * Add it at the edge — HTTP handlers, integrations, anything logging a payload
 * that has not been validated into value objects yet.
 *
 * There is no switch to turn the domain processor off. A logger that converts
 * nothing is `new Logger({ transports: [...] })`, which is exported from the
 * root for exactly this kind of fine control — but note that a live domain
 * instance then **cannot cross a `WorkerTransport` boundary**: structured
 * clone keeps only own enumerable string keys, and an entity holds its state
 * under symbols, so it arrives as `{}`.
 *
 * `error` and `fatal` events on `FastStdioTransport` are written
 * **synchronously** by default (`syncFatal: true`), so a `process.exit()`
 * triggered immediately after a fatal log will not lose the line. Buffered
 * `info`/`warn` events flush automatically on the next event-loop tick, so
 * they appear without intervention in normal operation — but a synchronous
 * `process.exit()` in the *same tick* as the log skips that flush, so call
 * `flush()` before exiting to guarantee delivery on shutdown.
 *
 * @example
 * ```ts
 * import { createAroma } from "@roastery/aroma";
 *
 * const log = createAroma({
 *   level: "info",
 *   onError: (err) => telemetry.record("logger.failure", err),
 * });
 *
 * log.info({ userId: 42 }, "user registered");
 *
 * const req = log.child({ requestId: "abc-123" });
 * req.warn({ remaining: 5 }, "rate limit close");
 * ```
 *
 * @example Graceful shutdown — flush buffered events before the process exits
 * ```ts
 * import { createAroma } from "@roastery/aroma";
 *
 * const log = createAroma();
 *
 * async function shutdown(signal: NodeJS.Signals): Promise<void> {
 *   log.info({ signal }, "shutdown requested");
 *   await log.flush();   // drain any buffered transports (e.g. FastStdioTransport)
 *   await log.close();   // release file handles, sockets, worker threads
 *   process.exit(0);
 * }
 *
 * process.on("SIGTERM", shutdown);
 * process.on("SIGINT", shutdown);
 * ```
 *
 * @since 0.0.1
 *
 * @see {@link Logger}
 * @see {@link FastStdioTransport}
 * @see {@link createDomainProcessor}
 * @see {@link createRedactProcessor} — the opt-in key-name half.
 */
export function createAroma<TBindings extends Bindings = Bindings>(
	args: CreateAromaArgs = {},
): ILogger<TBindings> {
	const transports =
		args.transports && args.transports.length > 0
			? args.transports
			: [new FastStdioTransport()];

	// Domain first: whatever a user processor does to the event, it sees a
	// payload that no longer holds a live domain instance.
	const processors: IProcessor[] = [
		createDomainProcessor({ maxDepth: args.maxDepth }),
	];

	if (args.processors) {
		processors.push(...args.processors);
	}

	const logger = new Logger<TBindings>({
		level: args.level ?? "info",
		bindings: {} as Readonly<TBindings>,
		transports,
		processors,
		maxDepth: args.maxDepth,
		onError: args.onError,
	});

	// After construction, not before: half of this warning goes out on the log
	// stream, which needs the logger that is being warned about.
	if (claimMaskingWarning(processors, args.acknowledgeNoMasking === true)) {
		logger._emitDiagnostic("warn", MASKING_WARNING_MSG, {
			hint: "add createRedactProcessor({ keys: [...DEFAULT_REDACT_KEYS] }) to processors, or set acknowledgeNoMasking: true",
		});
	}

	return logger;
}
