import type { ILogEvent } from "@/types/log-event.interface";
import type { LogLevel } from "@/types/log-level";

/**
 * Contract every log sink implements. A transport receives fully-built,
 * already-redacted `ILogEvent`s and decides where they go — stdout/stderr,
 * a file, a remote service, an in-memory buffer for tests, etc.
 *
 * Implementations are free to be synchronous (return `void`) or asynchronous
 * (return `Promise<void>`); the `Logger` invokes `write` fire-and-forget,
 * captures rejections and surfaces them through `LoggerOptions.onError` (as
 * an `AromaException`). A rejected promise from one transport never blocks
 * peer transports or the caller of `logger.info()`.
 *
 * @remarks
 * - `write` is invoked at most once per event per transport.
 * - `flush` and `close` are graceful-shutdown hooks fanned out by
 *   `Logger.flush()` / `Logger.close()`. Omit them entirely if the transport
 *   has no buffered state.
 * - `level`, when set, gates **this transport only** — the logger may pass
 *   events below the per-transport threshold to peer transports.
 * - `name` shows up inside `AromaException.message` ("transport \"X\"
 *   failed") and is the recommended way to disambiguate sinks during
 *   debugging.
 *
 * @see {@link Logger} — orchestrates the broadcast.
 * @see {@link FastStdioTransport} — the bundled stdio implementation.
 * @see {@link NullTransport} — capture transport for tests.
 * @see {@link ILogEvent} — the payload contract.
 */
export interface ITransport {
	/**
	 * Persist a single log event. May return synchronously or asynchronously;
	 * a thrown error or rejected promise is captured by the `Logger` and
	 * surfaced through `LoggerOptions.onError`.
	 *
	 * @param event - the fully-built, already-redacted entry.
	 * @returns `void` for synchronous sinks, or a `Promise<void>` that
	 *   resolves once the entry has reached its destination.
	 */
	write(event: ILogEvent): void | Promise<void>;

	/**
	 * Drain any buffered state. Called by `Logger.flush()`; safe to omit on
	 * transports that don't buffer (e.g. `NullTransport`).
	 */
	flush?(): Promise<void>;

	/**
	 * Release underlying resources (file handles, sockets, worker threads).
	 * Called by `Logger.close()`; safe to omit when there's nothing to close.
	 */
	close?(): Promise<void>;

	/**
	 * Minimum severity this transport will accept. Events below this level
	 * skip this transport but still reach peer transports whose own
	 * threshold allows them.
	 */
	level?: LogLevel;

	/**
	 * Short identifier used for diagnostics. Appears verbatim inside the
	 * message of any `AromaException` raised on a write failure.
	 */
	name?: string;
}
