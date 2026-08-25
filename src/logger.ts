import {
	AromaException,
	ProcessorFailureException,
} from "@/exceptions/aroma-exception";
import { domainSafeValue } from "@/internal/domain-safe";
import { NOOP_VOID } from "@/internal/noop";
import { serializeError } from "@/internal/serialize-error";
import type { Bindings } from "@/types/bindings";
import type { ILogEvent } from "@/types/log-event.interface";
import { LEVEL_NUMERIC, type LogLevel } from "@/types/log-level";
import type { ILogger } from "@/types/logger.interface";
import type { IProcessor } from "@/types/processor.interface";
import type { ITransport } from "@/types/transport.interface";

type ContextReader = () => Bindings | undefined;
let contextReader: ContextReader | undefined;

/**
 * Wire the AsyncLocalStorage-backed context into the core. The
 * `@roastery/aroma/context` subpath calls this automatically when imported;
 * the core never depends on `node:async_hooks` statically, keeping it
 * runtime-agnostic.
 *
 * @remarks
 * Context bindings returned by `reader` take **precedence over** the
 * logger's own `bindings` on key collision. The mental model is that the
 * context is the "narrower scope" (per request / per task) and should
 * therefore override the broader scope (the logger instance's globals).
 *
 * @internal
 */
export function _registerContextReader(reader: ContextReader): void {
	contextReader = reader;
}

/**
 * Construction options accepted by the `Logger` constructor. `createAroma`
 * accepts a strict superset (it wraps these and adds defaults for
 * `transports` and `redact`); reach for `LoggerOptions` directly only when
 * you need finer control than the factory exposes.
 *
 * @see {@link Logger}
 * @see {@link CreateAromaArgs}
 */
export type LoggerOptions = {
	/** Minimum severity that will be broadcast to transports. Defaults to `"info"`. */
	level?: LogLevel;
	/** Persistent context attached to every event emitted by this logger. Defaults to `{}`. */
	bindings?: Readonly<Bindings>;
	/** Sinks the logger broadcasts events to. Iterated in order. Defaults to `[]`. */
	transports?: ReadonlyArray<ITransport>;
	/**
	 * Sequential pipeline of processors applied to every event before
	 * broadcast. Defaults to `[]`. Use the bundled `createRedactProcessor`,
	 * `createEnrichProcessor`, etc. or implement your own `IProcessor`.
	 */
	processors?: ReadonlyArray<IProcessor>;
	/** Callback fired (synchronously, fire-and-forget) for each transport whose `write` rejects. */
	onError?: (err: AromaException) => void;
};

const LEVELS: ReadonlyArray<LogLevel> = [
	"trace",
	"debug",
	"info",
	"warn",
	"error",
	"fatal",
];

type LevelMethod = (first?: unknown, second?: unknown) => void;

/**
 * The lowest severity any transport would accept, as a number to compare
 * against before doing any work.
 *
 * A transport with no `level` of its own accepts everything, so one of those
 * disables the shortcut entirely. **No transports at all** means no possible
 * recipient, and the shortcut then drops every event — which is the honest
 * reading of "would anyone receive this?", and why a `Logger` built without
 * transports never runs its processors.
 */
function lowestAcceptedLevel(transports: ReadonlyArray<ITransport>): number {
	let lowest = Number.POSITIVE_INFINITY;

	for (const transport of transports) {
		if (transport.level === undefined) {
			return Number.NEGATIVE_INFINITY;
		}
		lowest = Math.min(lowest, LEVEL_NUMERIC[transport.level]);
	}

	return lowest;
}

/** Shared empty bindings for the diagnostic line, which deliberately carries none. */
const EMPTY_BINDINGS: Readonly<Bindings> = Object.freeze({});

/**
 * Interpret the first argument of a level call as `meta`, converting it first
 * when it is itself a `@roastery/beans` domain object.
 *
 * @remarks
 * `log.info(user, "created")` would otherwise be **silently emptied**, not
 * leaked: `emit` spreads `meta`, and a spread copies own enumerable keys
 * including symbol ones — so `[Context]`, `[Properties]` and `[Source]` come
 * across holding live value objects while no string key does. `JSON.stringify`
 * then drops the symbols and the line reads `"meta":{}`. The domain processor
 * cannot help: by the time it runs the spread has happened and what is left is
 * no longer recognisable as a domain object.
 *
 * The prototype check keeps this off the hot path. A plain literal — what
 * almost every call site passes — has `Object.prototype`, so the common case
 * costs one `getPrototypeOf` and nothing else; only a class instance is worth
 * running the converter over.
 *
 * A value object converts to a primitive rather than an object (that is the
 * point of unwrapping it), so it is wrapped under `value` to stay spreadable.
 */
function asMeta(first: object): Bindings {
	const prototype = Object.getPrototypeOf(first);
	if (prototype === Object.prototype || prototype === null) {
		return first as Bindings;
	}

	const safe = domainSafeValue(first, "meta");
	if (safe === first) {
		return first as Bindings;
	}

	return typeof safe === "object" && safe !== null
		? (safe as Bindings)
		: ({ value: safe } as Bindings);
}

/**
 * Bundled concrete implementation of `ILogger`. Composes any number of
 * `ITransport`s, applies redaction, gates broadcasts by severity, and
 * surfaces transport failures via the optional `onError` callback.
 *
 * The hot path is optimised for the **dropped-log case**: at construction
 * time, every level method whose severity is below the configured
 * threshold is bound to the shared `NOOP_VOID` — a single function call
 * with zero allocations. Methods at or above the threshold get a dispatch
 * function that parses the call shape (pino-style) and forwards to the
 * private `emit`.
 *
 * @remarks
 * Lifecycle of an effective log call:
 *
 * 1. Parse the first argument: `string` → `msg`; `Error` → `err`; any other
 *    object → `meta` (with `err` extracted if `meta.err` is an `Error`).
 * 2. Build an `ILogEvent` with `time = Date.now()`, the supplied `msg`, and
 *    snapshots of `bindings` / `meta` / `err`. Logger-level `bindings` are
 *    overlaid by request-scoped context bindings (when a context reader is
 *    registered) — context wins on key collision.
 * 3. Run the configured `processors` in declaration order; a processor that
 *    returns `null` drops the event before it reaches any transport.
 * 4. Filter transports by their optional per-transport `level`.
 * 5. Broadcast fire-and-forget — sync transports run inline, async
 *    transports return promises whose rejection lands in `onError`. The
 *    caller of `logger.info()` never sees a rejection.
 *
 * @see {@link ILogger}
 * @see {@link createAroma}
 * @see {@link AromaException}
 */
export class Logger<TBindings extends Bindings = Bindings>
	implements ILogger<TBindings>
{
	private readonly level: LogLevel;
	private readonly levelValue: number;
	private readonly bindings: Readonly<Bindings>;
	private readonly transports: ReadonlyArray<ITransport>;
	private readonly processors: ReadonlyArray<IProcessor>;
	private readonly onError?: (err: AromaException) => void;
	private readonly minTransportLevel: number;

	public declare trace: ILogger["trace"];
	public declare debug: ILogger["debug"];
	public declare info: ILogger["info"];
	public declare warn: ILogger["warn"];
	public declare error: ILogger["error"];
	public declare fatal: ILogger["fatal"];
	public declare log: ILogger["log"];

	public constructor(options: LoggerOptions = {}) {
		this.level = options.level ?? "info";
		this.levelValue = LEVEL_NUMERIC[this.level];
		this.bindings = Object.freeze({ ...(options.bindings ?? {}) });
		this.transports = options.transports ?? [];
		this.processors = options.processors ?? [];
		this.onError = options.onError;
		this.minTransportLevel = lowestAcceptedLevel(this.transports);

		for (const lvl of LEVELS) {
			const fn: LevelMethod =
				LEVEL_NUMERIC[lvl] >= this.levelValue
					? this.makeLevelFn(lvl)
					: (NOOP_VOID as LevelMethod);
			(this as unknown as Record<string, LevelMethod>)[lvl] = fn;
		}

		const defaultLevelFn = (this as unknown as Record<string, LevelMethod>)[
			this.level
		] as LevelMethod;
		(this as unknown as Record<string, LevelMethod>).log = defaultLevelFn;
	}

	public child<TChild extends Bindings>(
		bindings: TChild,
	): ILogger<TBindings & TChild> {
		return new Logger<TBindings & TChild>({
			level: this.level,
			bindings: { ...this.bindings, ...bindings } as Readonly<
				TBindings & TChild
			>,
			transports: this.transports,
			processors: this.processors,
			onError: this.onError,
		});
	}

	public async flush(): Promise<void> {
		await Promise.allSettled(
			this.transports
				.filter(
					(t): t is ITransport & { flush: () => Promise<void> } =>
						typeof t.flush === "function",
				)
				.map((t) => t.flush()),
		);
	}

	public async close(): Promise<void> {
		await Promise.allSettled(
			this.transports
				.filter(
					(t): t is ITransport & { close: () => Promise<void> } =>
						typeof t.close === "function",
				)
				.map((t) => t.close()),
		);
	}

	private makeLevelFn(level: LogLevel): LevelMethod {
		return (first?: unknown, second?: unknown): void => {
			let meta: Bindings | undefined;
			let msg: string | undefined;
			let err: Error | undefined;

			if (typeof first === "string") {
				msg = first;
			} else if (first instanceof Error) {
				err = first;
				if (typeof second === "string") {
					msg = second;
				}
			} else if (typeof first === "object" && first !== null) {
				const obj = asMeta(first);
				const maybeErr = obj.err;
				if (maybeErr instanceof Error) {
					err = maybeErr;
					const { err: _stripped, ...rest } = obj;
					meta = rest;
				} else {
					meta = obj;
				}
				if (typeof second === "string") {
					msg = second;
				}
			}

			this.emit(level, msg, meta, err);
		};
	}

	private emit(
		level: LogLevel,
		msg: string | undefined,
		meta: Bindings | undefined,
		err: Error | undefined,
	): void {
		// Nothing downstream would take this event, so nothing upstream should be
		// spent on it. The logger's own threshold is already resolved at
		// construction (methods below it are `NOOP_VOID`); this is the same idea
		// applied to the transports' thresholds, which used to be checked only
		// *after* the whole pipeline had run.
		if (LEVEL_NUMERIC[level] < this.minTransportLevel) {
			return;
		}

		const contextBindings = contextReader?.();
		const mergedBindings = contextBindings
			? { ...this.bindings, ...contextBindings }
			: this.bindings;

		let event: ILogEvent | null = {
			level,
			time: Date.now(),
			msg,
			bindings: mergedBindings,
			meta: meta ? { ...meta } : undefined,
			err: err ? serializeError(err) : undefined,
		};

		for (const processor of this.processors) {
			try {
				event = processor.process(event);
			} catch (processorError) {
				this.handleProcessorError(processor, processorError);
				return;
			}
			if (event === null) return;
		}

		this.broadcast(event, LEVEL_NUMERIC[level]);
	}

	/**
	 * Hand a finished event to every transport whose own `level` accepts it,
	 * fire-and-forget. Sync throws and rejected promises both land in
	 * `onError`; neither reaches the caller, and one failing transport never
	 * blocks its peers.
	 */
	private broadcast(event: ILogEvent, levelValue: number): void {
		for (const transport of this.transports) {
			if (
				transport.level !== undefined &&
				levelValue < LEVEL_NUMERIC[transport.level]
			) {
				continue;
			}

			try {
				const result = transport.write(event);
				if (result && typeof (result as Promise<void>).then === "function") {
					(result as Promise<void>).catch((reason: unknown) => {
						this.handleTransportError(transport, reason);
					});
				}
			} catch (writeError) {
				this.handleTransportError(transport, writeError);
			}
		}
	}

	/**
	 * Report a processor that threw, without letting the failure reach the
	 * caller and without forwarding the event it was working on.
	 *
	 * Two independent notifications, because a dropped log line must never be
	 * a silent one: the `ProcessorFailureException` goes to `onError`, and a
	 * diagnostic line goes straight to the transports.
	 *
	 * That line carries the processor's name and the error's message and
	 * **nothing from the original payload** — not even `bindings`. The payload
	 * is precisely what nobody can vouch for at this point: the processor that
	 * failed may have been the one redacting it. And it goes directly to
	 * `broadcast`, never back through the pipeline, so the processor that just
	 * threw cannot take down the report of its own failure.
	 */
	private handleProcessorError(processor: IProcessor, reason: unknown): void {
		const processorName = processor.name ?? "<unnamed>";
		const failure = new ProcessorFailureException(
			`processor "${processorName}" failed`,
			{ cause: reason, processorName },
		);

		if (this.onError) {
			try {
				this.onError(failure);
			} catch {
				// swallow — best-effort end-to-end
			}
		}

		this.broadcast(
			{
				level: "error",
				time: Date.now(),
				msg: failure.message,
				bindings: EMPTY_BINDINGS,
				meta: {
					processor: processorName,
					reason: reason instanceof Error ? reason.message : String(reason),
				},
			},
			LEVEL_NUMERIC.error,
		);
	}

	private handleTransportError(transport: ITransport, reason: unknown): void {
		if (!this.onError) return;
		try {
			this.onError(
				new AromaException(
					`transport "${transport.name ?? "<unnamed>"}" failed`,
					{ cause: reason },
				),
			);
		} catch {
			// swallow — best-effort end-to-end
		}
	}
}
