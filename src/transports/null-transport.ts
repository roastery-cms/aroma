import type { ILogEvent } from "@/types/log-event.interface";
import type { LogLevel } from "@/types/log-level";
import type { ITransport } from "@/types/transport.interface";

/**
 * Capture transport that pushes every received event into an in-memory
 * array. Designed for tests and dev-time inspection — never for production.
 *
 * Replaces the previous pattern of awaiting `logger.info()` and asserting
 * on the returned event. With the pino-style sync `void` API, tests instead
 * attach a `NullTransport` and assert on `transport.events[…]` after the
 * call returns.
 *
 * @remarks
 * - The array is kept as a mutable `ILogEvent[]` internally but exposed via
 *   the `events` getter as `ReadonlyArray<ILogEvent>` so test code can't
 *   accidentally mutate it.
 * - `clear()` resets between specs without recreating the transport.
 * - `level` is supported so tests can verify per-transport filtering too.
 *
 * @example
 * ```ts
 * import { Logger, NullTransport } from "@roastery/aroma";
 *
 * const sink = new NullTransport();
 * const log = new Logger({ transports: [sink] });
 *
 * log.info({ userId: 42 }, "user registered");
 *
 * expect(sink.events[0]?.level).toBe("info");
 * expect(sink.events[0]?.meta).toEqual({ userId: 42 });
 * ```
 *
 * @see {@link ITransport}
 */
export class NullTransport implements ITransport {
	public readonly name = "null";
	public readonly level?: LogLevel;
	private readonly _events: ILogEvent[] = [];

	public constructor(options: { level?: LogLevel } = {}) {
		this.level = options.level;
	}

	/** Captured events, in arrival order. Read-only view of the internal buffer. */
	public get events(): ReadonlyArray<ILogEvent> {
		return this._events;
	}

	/**
	 * Append the event to the in-memory buffer. Never throws, never returns
	 * a promise — keeps the hot path free of microtask overhead in tests.
	 */
	public write(event: ILogEvent): void {
		this._events.push(event);
	}

	/** Reset the captured buffer. Convenient between specs in the same file. */
	public clear(): void {
		this._events.length = 0;
	}
}
