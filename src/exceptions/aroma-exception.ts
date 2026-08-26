import { InfraException } from "@roastery/terroir/exceptions/models";

/**
 * Construction options accepted by `AromaException` and its subclasses.
 *
 * @since 0.0.1
 *
 * @see {@link AromaException}
 */
export type AromaExceptionOptions = {
	/**
	 * Identifier of the module or subsystem responsible for the failure.
	 * Defaults to `"@roastery/aroma"` when omitted.
	 */
	source?: string;
	/**
	 * Underlying value that triggered this exception, preserved via the
	 * standard `Error.cause` slot.
	 */
	cause?: unknown;
};

/**
 * Thrown by `@roastery/aroma` whenever the logger itself fails — most
 * commonly when a transport's `write` rejects and an `onError` handler is
 * configured to receive structured failure notifications.
 *
 * @remarks
 * Sits at the infrastructure layer of the terroir exception hierarchy:
 * `AromaException → InfraException → CoreException → Error`. The
 * `[Layer]` discriminator is pinned to `"infra"` by
 * `InfraException`.
 *
 * @example
 * ```ts
 * import { createAroma, AromaException } from "@roastery/aroma";
 *
 * const log = createAroma({
 *   onError: (err: AromaException) => {
 *     telemetry.record("logger.transport_failure", { source: err.source });
 *   },
 * });
 * ```
 *
 * @since 0.0.1
 *
 * @see {@link InfraException}
 * @see {@link LoggerOptions.onError}
 */
export class AromaException extends InfraException {
	public readonly name: string = "Aroma Exception";
	public readonly message: string;
	public readonly source: string;

	public constructor(message: string, options: AromaExceptionOptions = {}) {
		super(
			message,
			options.cause !== undefined ? { cause: options.cause } : undefined,
		);
		this.message = message;
		this.source = options.source ?? "@roastery/aroma";
	}
}

/**
 * Raised by `FastStdioTransport` (and other buffered transports) when the
 * backpressure policy is `"drop"` and the in-memory buffer reaches its
 * configured cap. The dropped event itself isn't preserved — only the fact
 * that a drop happened, plus a running count of how many events have been
 * dropped so far.
 *
 * Surfaces through `LoggerOptions.onError` like any other transport
 * failure; consumers typically wire it to a counter on their telemetry
 * pipeline so they know when to scale the sink.
 *
 * @example
 * ```ts
 * import { BackpressureDropException, createAroma } from "@roastery/aroma";
 *
 * createAroma({
 *   onError: (err) => {
 *     if (err instanceof BackpressureDropException) {
 *       metrics.increment("logger.drops", { count: err.dropCount });
 *     }
 *   },
 * });
 * ```
 *
 * @since 0.0.1
 *
 * @see {@link AromaException}
 */
export class BackpressureDropException extends AromaException {
	public override readonly name = "Backpressure Drop Exception";
	public readonly dropCount: number;

	public constructor(
		message: string,
		options: AromaExceptionOptions & { dropCount: number },
	) {
		super(message, options);
		this.dropCount = options.dropCount;
	}
}

/**
 * Raised when a processor throws while transforming an event.
 *
 * @remarks
 * The pipeline is no longer only our own trivial, synchronous code. Since the
 * domain integration it runs `@roastery/beans` code (`toSafeJSON`, recursive,
 * with value-object getters along the way) and, through the redaction
 * placeholder, **arbitrary consumer code**. Any of it can throw, and
 * `Logger.emit` used to run the pipeline unguarded — so `log.info({ user },
 * "…")` could take down the very application the logger was supposed to be
 * observing.
 *
 * The event that was in flight is **discarded**, never forwarded. A processor
 * that throws midway leaves the event in an indeterminate state: possibly
 * half-converted, possibly still holding the live instance the redaction step
 * had not finished redacting. Handing that to the transports would turn the
 * failure of a security processor into exactly the leak it exists to prevent.
 * Losing one log line is strictly better — and it is never lost silently: the
 * failure reaches `onError`, and a diagnostic line naming the processor is
 * written straight to the transports.
 *
 * @example
 * ```ts
 * import { createAroma, ProcessorFailureException } from "@roastery/aroma";
 *
 * createAroma({
 *   onError: (err) => {
 *     if (err instanceof ProcessorFailureException) {
 *       metrics.increment("logger.processor_failure", {
 *         processor: err.processorName,
 *       });
 *     }
 *   },
 * });
 * ```
 *
 * @since 0.1.0
 *
 * @see {@link AromaException}
 * @see {@link IProcessor} — the contract whose failure this reports.
 */
export class ProcessorFailureException extends AromaException {
	public override readonly name = "Processor Failure Exception";
	/** `IProcessor.name` of the processor that threw, or `"<unnamed>"`. */
	public readonly processorName: string;

	public constructor(
		message: string,
		options: AromaExceptionOptions & { processorName: string },
	) {
		super(message, options);
		this.processorName = options.processorName;
	}
}
