import {
	AromaException,
	ProcessorFailureException,
} from "@/exceptions/aroma-exception";
import { conversionFailed } from "@/internal/conversion-failure";
import { brandAsDiagnostic } from "@/internal/diagnostic";
import { createDomainPlan, domainSafeValue } from "@/internal/domain-safe";
import { NOOP_VOID } from "@/internal/noop";
import { assertWalkDepth, type WalkPlan } from "@/internal/safe-walk";
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
 * wraps these, defaulting `transports` and injecting the domain processor;
 * reach for `LoggerOptions` directly when you need finer control than the
 * factory exposes — including the one thing the factory will not do, which is
 * build a logger that converts nothing.
 *
 * @since 0.0.1
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
	/**
	 * How many levels the domain conversion descends into `bindings`, `meta`
	 * and `err.cause`. Defaults to {@link MAX_WALK_DEPTH}.
	 *
	 * @remarks
	 * Below the bound the walk substitutes `"[truncated: depth]"` rather than
	 * passing a subtree through unconverted, so this trades visibility for
	 * cost — never for safety. Must be an integer in
	 * `1..MAX_CONFIGURABLE_DEPTH`.
	 *
	 * @since 0.1.0
	 */
	maxDepth?: number;
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
 * How often a single failing processor may put a diagnostic line on the
 * stream. Exported so a spec can wait out a window without hard-coding it.
 *
 * @internal
 */
export const DIAGNOSTIC_WINDOW_MS = 1_000;

type FailureWindow = { windowStart: number; suppressed: number };

/**
 * How many distinct failure messages are tracked per processor.
 *
 * The window is per `(processor, message)` so a second, different failure is
 * not swallowed inside the first one's second. But the message is arbitrary
 * consumer text and may well carry an id — `"failed for order 91823"` — so an
 * unbounded map would trade a log flood for a memory leak. Past this many
 * distinct messages, the rest share one window: still rate limited, no longer
 * distinguished.
 */
const MAX_TRACKED_REASONS = 8;

/** Where the overflow beyond {@link MAX_TRACKED_REASONS} is pooled. */
const OVERFLOW_REASON = "";

/**
 * When each processor last had a diagnostic line written for it, per failure
 * message, and how many have been swallowed since.
 *
 * Keyed by the processor rather than held on the instance because `child()`
 * shares the processor array by reference: a per-instance counter would let
 * every child re-open the window and the flood would come back, one stream per
 * request.
 */
const failureWindows = new WeakMap<IProcessor, Map<string, FailureWindow>>();

/**
 * Copy `meta` for the event, without letting the copy throw at the caller.
 *
 * A spread reads every own enumerable property, so a payload carrying an
 * accessor that throws — or a `Proxy` with a hostile trap — would take down the
 * `log.info()` that was merely describing it. This runs before the pipeline
 * exists, so no processor guard can cover it.
 */
function snapshot(meta: Bindings | undefined): Bindings | undefined {
	if (!meta) return undefined;
	try {
		return { ...meta };
	} catch (reason) {
		return conversionFailed(reason);
	}
}

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
 * running the converter over. The record it becomes is walked properly by the
 * domain processor a moment later, so nothing is lost by stopping here.
 *
 * A value object converts to a primitive rather than an object (that is the
 * point of unwrapping it), so it is wrapped under `value` to stay spreadable.
 */
function asMeta(first: object, plan: WalkPlan): Bindings {
	const prototype = Object.getPrototypeOf(first);
	if (prototype === Object.prototype || prototype === null) {
		return first as Bindings;
	}

	const safe = domainSafeValue(first, "meta", plan);
	if (safe === first) {
		return first as Bindings;
	}

	return typeof safe === "object" && safe !== null
		? (safe as Bindings)
		: ({ value: safe } as Bindings);
}

/**
 * Bundled concrete implementation of `ILogger`. Composes any number of
 * `ITransport`s, runs the processor pipeline, gates broadcasts by severity,
 * and surfaces failures via the optional `onError` callback.
 *
 * Note that a `Logger` built with **no transports** accepts nothing, and
 * therefore runs no processors at all — see `lowestAcceptedLevel`. That is the
 * honest reading of "would anyone receive this?", but it does mean a processor
 * kept for its side effects (a sampling counter, a metric) goes quiet on a
 * transportless logger. `createAroma` always injects one, so this only arises
 * when building a `Logger` by hand.
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
 * @since 0.0.1
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
	private readonly maxDepth: number;
	private readonly domainPlan: WalkPlan;

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
		this.maxDepth = assertWalkDepth(options.maxDepth);
		this.domainPlan = createDomainPlan(this.maxDepth);

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
			maxDepth: this.maxDepth,
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
				// Reading the caller's payload can throw: an own enumerable
				// accessor, a Proxy trap. `asMeta` converts, and the spread below
				// invokes every getter — both happen before any processor exists to
				// be blamed, so nothing downstream could catch it and `log.info()`
				// would throw in the caller's face. A log call must never do that.
				try {
					const obj = asMeta(first, this.domainPlan);
					const maybeErr = obj.err;
					if (maybeErr instanceof Error) {
						err = maybeErr;
						const { err: _stripped, ...rest } = obj;
						meta = rest;
					} else {
						meta = obj;
					}
				} catch (reason) {
					meta = conversionFailed(reason);
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
			meta: snapshot(meta),
			err: err ? serializeError(err, this.domainPlan) : undefined,
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
	 * a silent one: the `ProcessorFailureException` goes to `onError` — every
	 * time, since that is the consumer's own telemetry hook and throttling it
	 * would hide failures — and a diagnostic line goes to the transports.
	 *
	 * That line carries the processor's name and the error's message and
	 * **nothing from the original payload** — not even `bindings`. The payload
	 * is precisely what nobody can vouch for at this point: the processor that
	 * failed may have been the one redacting it.
	 *
	 * @remarks
	 * The line is **rate limited to one per processor per failure message per
	 * second**, with the swallowed count carried into the next one. A processor
	 * that fails on every event otherwise turns a stream of `info` into a stream
	 * of `error`, one for one — which is what pages someone at four in the
	 * morning about a bug in their own processor, having buried the signal under
	 * itself.
	 *
	 * Keying on the message as well as the processor is what keeps a *second*,
	 * different failure from disappearing inside the first one's window; see
	 * {@link MAX_TRACKED_REASONS} for the bound that keeps that from becoming a
	 * memory leak.
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

		const now = Date.now();
		const reasonText =
			reason instanceof Error ? reason.message : String(reason);

		let windows = failureWindows.get(processor);
		if (windows === undefined) {
			windows = new Map<string, FailureWindow>();
			failureWindows.set(processor, windows);
		}

		const key =
			windows.has(reasonText) || windows.size < MAX_TRACKED_REASONS
				? reasonText
				: OVERFLOW_REASON;
		const open = windows.get(key);

		if (open !== undefined && now - open.windowStart < DIAGNOSTIC_WINDOW_MS) {
			open.suppressed++;
			return;
		}

		const suppressed = open?.suppressed ?? 0;
		windows.set(key, { windowStart: now, suppressed: 0 });

		const meta: Bindings = {
			processor: processorName,
			reason: reasonText,
		};
		if (suppressed > 0) {
			meta.suppressed = suppressed;
		}

		this.reportFailure(
			brandAsDiagnostic({
				level: "error",
				time: now,
				msg: failure.message,
				bindings: EMPTY_BINDINGS,
				meta,
			}),
			processor,
		);
	}

	/**
	 * Put the diagnostic line on the transports, in the same shape as every
	 * other line on the stream.
	 *
	 * It is run through the pipeline **with the processor that threw removed**.
	 * Skipping the pipeline entirely was the safe move, and it was also how a
	 * consumer using `createEcsProcessor` ended up with one canonical
	 * `ILogEvent` interleaved in a stream of ECS documents — the schema broke
	 * on precisely the line saying something else had broken. Removing only the
	 * culprit keeps the original guarantee (the processor that just threw
	 * cannot take down the report of its own failure) and restores the format.
	 *
	 * Anything the second pass does wrong — a throw, or a `null` that would
	 * drop the line — falls back to the raw diagnostic. One attempt, never a
	 * recursion, and never silence: a filter that would discard this line is
	 * overruled, because the guarantee it belongs to is that a dropped log line
	 * is never a silent one.
	 */
	private reportFailure(
		diagnostic: ILogEvent,
		failed: IProcessor | undefined,
	): void {
		let event: ILogEvent | null = diagnostic;

		try {
			for (const processor of this.processors) {
				if (processor === failed) continue;
				event = processor.process(event);
				if (event === null) break;
			}
		} catch {
			event = null;
		}

		this.broadcast(event ?? diagnostic, LEVEL_NUMERIC[diagnostic.level]);
	}

	/**
	 * Put a line about the logger itself on the log stream.
	 *
	 * @remarks
	 * Goes through the pipeline like any other event — that is what keeps it in
	 * the stream's own format, so a `createEcsProcessor` downstream does not end
	 * up with one canonical `ILogEvent` in the middle of a run of ECS documents.
	 * It is branded, so a processor kept for its side effects can tell it apart
	 * from real traffic with `isDiagnostic`.
	 *
	 * Gated by both the logger's level and the transports', because a diagnostic
	 * nobody would receive is not worth building.
	 *
	 * @param level - severity of the line.
	 * @param msg - what to say.
	 * @param meta - optional payload.
	 *
	 * @internal
	 */
	public _emitDiagnostic(level: LogLevel, msg: string, meta?: Bindings): void {
		const value = LEVEL_NUMERIC[level];
		if (value < this.levelValue || value < this.minTransportLevel) {
			return;
		}

		this.reportFailure(
			brandAsDiagnostic({
				level,
				time: Date.now(),
				msg,
				bindings: EMPTY_BINDINGS,
				meta,
			}),
			undefined,
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
