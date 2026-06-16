import { serializeEvent } from "@/internal/serializer";
import type { ILogEvent } from "@/types/log-event.interface";
import type { LogLevel } from "@/types/log-level";
import type { ITransport } from "@/types/transport.interface";

/**
 * Default transport bundled with `@roastery/aroma`. Writes one JSON event
 * per line — to `process.stderr` for `error` / `fatal`, to `process.stdout`
 * for every other level.
 *
 * **Despite the name, this transport does not use `console.*`.** Going
 * through `console.{log,info,error,…}` would block the event loop on every
 * call (the `console` methods are synchronous and serialise their arguments
 * inline). Instead, the transport invokes the underlying stream's
 * `write(line, callback)` directly: writes to pipes and sockets are routed
 * through libuv and resolve asynchronously, while writes to a TTY are still
 * non-blocking thanks to the same callback-based contract. The bundled
 * transport stays appropriate for production logging.
 *
 * @remarks
 * - The line passed to the stream always ends with `\n`; consumers reading
 *   one event per line do not need additional framing.
 * - Cycles in `bindings` / `meta` do not throw — `safeStringify` substitutes
 *   `"[Circular]"` for repeat references.
 * - The constructor accepts an optional per-transport `level` to filter
 *   independently of the `Logger`'s own threshold.
 *
 * @example
 * ```ts
 * import { createAroma, ConsoleTransport } from "@roastery/aroma";
 *
 * // Default factory wiring (createAroma() injects this automatically).
 * const log = createAroma();
 *
 * // Manual wiring with a higher per-transport threshold.
 * const log2 = createAroma({
 *   transports: [new ConsoleTransport({ level: "warn" })],
 * });
 * ```
 *
 * @see {@link ITransport} — the contract this class implements.
 * @see {@link safeStringify} — handles cycles before the line hits the stream.
 */
export class ConsoleTransport implements ITransport {
	/** Stable identifier surfaced inside `AromaException.message` ("transport \"console\" failed"). */
	public readonly name = "console";
	/** Optional per-transport minimum severity; `undefined` means inherit the logger's threshold. */
	public readonly level?: LogLevel;

	/**
	 * @param options - optional construction settings. `level` gates this
	 *   transport in addition to the parent logger's threshold.
	 */
	public constructor(options: { level?: LogLevel } = {}) {
		this.level = options.level;
	}

	/**
	 * Serialise the event and write it to the appropriate stdio stream.
	 *
	 * @param event - the event to emit; already redacted by the logger.
	 * @returns a `Promise` that resolves once the stream has acknowledged
	 *   the chunk, or rejects if the stream's callback received an error
	 *   (e.g. EPIPE on a closed pipe).
	 */
	public write(event: ILogEvent): Promise<void> {
		const line = `${serializeEvent(event)}\n`;
		const stream =
			event.level === "error" || event.level === "fatal"
				? process.stderr
				: process.stdout;

		return new Promise((resolve, reject) => {
			stream.write(line, (err) => {
				if (err) {
					reject(err);
					return;
				}
				resolve();
			});
		});
	}
}
