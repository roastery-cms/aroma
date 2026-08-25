import { DEFAULT_REDACT_KEYS } from "@/constants/redact-defaults";
import type { AromaException } from "@/exceptions/aroma-exception";
import { DEFAULT_REDACT_MAX_DEPTH } from "@/internal/redact";
import { Logger } from "@/logger";
import { createDomainProcessor } from "@/processors/domain";
import { createRedactProcessor } from "@/processors/redact";
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
 * the default redaction keys applied.
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
	 * Additional sensitive field names to mask in `bindings`, `meta` and
	 * `err.cause`. These are **added** to `DEFAULT_REDACT_KEYS`. Set to
	 * `false` to disable redaction entirely (including defaults), or pass an
	 * object to also control how deep the scan goes:
	 *
	 * ```ts
	 * createAroma({ redact: ["customSecret"] });              // added to the defaults
	 * createAroma({ redact: { keys: [], maxDepth: 1 } });     // top level only
	 * createAroma({ redact: false });                         // nothing at all
	 * ```
	 *
	 * Keys match **at any depth** by default, which is what protects
	 * `{ req: { headers: { authorization } } }`. `maxDepth: 1` restores the
	 * top-level-only behaviour of earlier versions exactly, for a consumer who
	 * depends on seeing a nested field in the clear.
	 *
	 * @remarks
	 * `false` is the single "no masking" switch: it also skips the
	 * auto-injected **domain** processor, so `@roastery/beans` objects are
	 * serialised through their lossless `toJSON()` and a `sensitive` property
	 * reaches the log in the clear. Whoever asks for no redaction does not
	 * want to pay for the sweep either.
	 *
	 * Two consequences worth knowing before choosing it:
	 *
	 * - **Serialise domain objects at the call site.** `user.toSafeJSON()`
	 *   before it enters the log, rather than passing the instance.
	 * - **A domain object cannot cross a `WorkerTransport` boundary.**
	 *   `postMessage` uses structured clone, which keeps only own enumerable
	 *   *string* keys; an entity holds its state under symbols, so it arrives
	 *   at the worker as `{}`. With the processors on this never arises,
	 *   because the event is already plain by the time a transport sees it.
	 */
	redact?:
		| ReadonlyArray<string>
		| false
		| {
				/** Field names added to `DEFAULT_REDACT_KEYS`. */
				keys?: ReadonlyArray<string>;
				/** Levels to descend. Defaults to `DEFAULT_REDACT_MAX_DEPTH`; `1` is top-level only. */
				maxDepth?: number;
		  };
	/**
	 * Sequential pipeline of processors applied to every event before
	 * broadcast. The auto-injected processors (from the `redact` shortcut)
	 * run **before** any user-supplied processor, in the order
	 * `[domain, redact, ...processors]`.
	 */
	processors?: ReadonlyArray<IProcessor>;
	/** Callback fired for each transport whose `write` rejects. Defaults to no callback. */
	onError?: (err: AromaException) => void;
};

/**
 * Canonical entry point for `@roastery/aroma`. Build a logger with the
 * default `FastStdioTransport`, domain-object safety, default redaction
 * keys, optional extra redaction, optional custom processors, and an
 * optional failure callback.
 *
 * @example
 * ```ts
 * import { createAroma } from "@roastery/aroma";
 *
 * const log = createAroma({
 *   level: "info",
 *   redact: ["customSecret"], // added to DEFAULT_REDACT_KEYS
 *   onError: (err) => telemetry.record("logger.failure", err),
 * });
 *
 * log.info({ userId: 42 }, "user registered");
 *
 * const req = log.child({ requestId: "abc-123" });
 * req.warn({ remaining: 5 }, "rate limit close");
 * ```
 *
 * @example
 * ```ts
 * // Disable default redaction (e.g. for an internal-only logger):
 * const log = createAroma({ redact: false });
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
 * @remarks
 * `error` and `fatal` events on `FastStdioTransport` are written
 * **synchronously** by default (`syncFatal: true`), so a `process.exit()`
 * triggered immediately after a fatal log will not lose the line. Buffered
 * `info`/`warn` events flush automatically on the next event-loop tick, so
 * they appear without intervention in normal operation — but a synchronous
 * `process.exit()` in the *same tick* as the log skips that flush, so call
 * `flush()` before exiting to guarantee delivery on shutdown.
 *
 * @see {@link Logger}
 * @see {@link FastStdioTransport}
 * @see {@link createDomainProcessor}
 * @see {@link DEFAULT_REDACT_KEYS}
 */
export function createAroma<TBindings extends Bindings = Bindings>(
	args: CreateAromaArgs = {},
): ILogger<TBindings> {
	const transports =
		args.transports && args.transports.length > 0
			? args.transports
			: [new FastStdioTransport()];

	const processors: IProcessor[] = [];

	if (args.redact !== false) {
		// Domain first: what it produces (unwrapped value-object values, flattened
		// event keys) must still pass under the key-name redaction.
		processors.push(createDomainProcessor());

		// `Array.isArray` widens a ReadonlyArray to `any[]` rather than narrowing
		// the union, so the two accepted shapes are normalised by hand.
		const redact = args.redact ?? {};
		const options: { keys?: ReadonlyArray<string>; maxDepth?: number } =
			Array.isArray(redact)
				? { keys: redact as ReadonlyArray<string> }
				: (redact as { keys?: ReadonlyArray<string>; maxDepth?: number });

		processors.push(
			createRedactProcessor({
				keys: [...DEFAULT_REDACT_KEYS, ...(options.keys ?? [])],
				maxDepth: options.maxDepth ?? DEFAULT_REDACT_MAX_DEPTH,
			}),
		);
	}

	if (args.processors) {
		processors.push(...args.processors);
	}

	return new Logger<TBindings>({
		level: args.level ?? "info",
		bindings: {} as Readonly<TBindings>,
		transports,
		processors,
		onError: args.onError,
	});
}
