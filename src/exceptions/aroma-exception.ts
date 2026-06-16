import { InfraException } from "@roastery/terroir/exceptions/models";

/**
 * Construction options accepted by `AromaException` and its subclasses.
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
 * `[ExceptionLayer]` discriminator is pinned to `"infra"` by
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
 * @see {@link InfraException}
 * @see {@link LoggerOptions.onError}
 */
export class AromaException extends InfraException {
	public readonly name: string = "Aroma Exception";
	public readonly message: string;
	public readonly source: string;

	public constructor(message: string, options: AromaExceptionOptions = {}) {
		super(message);
		this.message = message;
		this.source = options.source ?? "@roastery/aroma";
		if (options.cause !== undefined) {
			this.cause = options.cause;
		}
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
