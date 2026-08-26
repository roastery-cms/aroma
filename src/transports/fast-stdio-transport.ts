import { BackpressureDropException } from "@/exceptions/aroma-exception";
import {
	type BackpressurePolicy,
	BufferedWriter,
} from "@/internal/buffered-writer";
import { serializeEvent } from "@/internal/serializer";
import type { ILogEvent } from "@/types/log-event.interface";
import type { LogLevel } from "@/types/log-level";
import type { ITransport } from "@/types/transport.interface";

/**
 * Options accepted by `FastStdioTransport`.
 *
 * @since 0.0.1
 *
 * @see {@link FastStdioTransport}
 */
export type FastStdioTransportOptions = {
	/** File descriptor to write to. Defaults to `process.stdout.fd` (1). */
	fd?: number;
	/** Alternative fd used for `error`/`fatal` levels. Defaults to `process.stderr.fd` (2). */
	errorFd?: number;
	/** Per-transport minimum severity. */
	level?: LogLevel;
	/**
	 * Soft buffer-size hint in bytes (default 4 KB). Buffered events flush on
	 * the next event-loop tick regardless, so this no longer gates flush
	 * timing; retained for tuning and API compatibility.
	 */
	bufferSize?: number;
	/** Hard cap on buffered bytes before the backpressure policy kicks in. Defaults to 64 KB. */
	maxBuffered?: number;
	/** What to do when the buffer hits `maxBuffered`. Defaults to `"drop"`. */
	backpressure?: BackpressurePolicy;
	/** When `true`, `error` and `fatal` events bypass the buffer and write synchronously. Defaults to `true` (crash-safe). */
	syncFatal?: boolean;
	/** Optional callback invoked whenever an event is dropped due to backpressure. */
	onDrop?: (exception: BackpressureDropException) => void;
	/** Optional callback invoked when an underlying write fails. */
	onWriteError?: (err: Error) => void;
};

/**
 * Non-blocking stdio transport. Buffers events in memory and flushes in
 * batches via `fs.write(fd, chunk, cb)` — one syscall per buffer, not per
 * event. The dropped-log path is zero-allocation; the effective path
 * incurs one push and one `setImmediate` schedule per ~4 KB of output.
 *
 * @remarks
 * - `error` and `fatal` events route to the `errorFd` (stderr by default)
 *   instead of `fd` (stdout). When `syncFatal: true` (default), they
 *   bypass the buffer entirely and write synchronously via `fs.writeSync`
 *   — guaranteeing the line reaches the kernel before the process can
 *   exit on a `process.exit()` after a fatal log.
 * - Backpressure (`maxBuffered` cap) supports three policies:
 *   `"drop"` (default), `"block"` (let the buffer grow past cap until
 *   drained), or `"sample"` (keep ~1 in 10 lines under saturation).
 * - `flush()` returns a promise that resolves when the internal queue is
 *   empty.
 *
 * @example
 * ```ts
 * import { FastStdioTransport } from "@roastery/aroma/transports";
 *
 * const stdio = new FastStdioTransport({
 *   bufferSize: 8 * 1024,
 *   backpressure: "drop",
 *   onDrop: (err) => metrics.increment("logger.drops", { total: err.dropCount }),
 * });
 * ```
 *
 * @since 0.0.1
 *
 * @see {@link ITransport}
 * @see {@link BufferedWriter}
 * @see {@link BackpressureDropException}
 */
export class FastStdioTransport implements ITransport {
	public readonly name = "fast-stdio";
	public readonly level?: LogLevel;

	private readonly stdoutWriter: BufferedWriter;
	private readonly stderrWriter: BufferedWriter;
	private readonly syncFatal: boolean;

	public constructor(options: FastStdioTransportOptions = {}) {
		this.level = options.level;
		this.syncFatal = options.syncFatal ?? true;

		const onDrop = options.onDrop;
		const wrappedOnDrop = onDrop
			? (count: number) =>
					onDrop(
						new BackpressureDropException(
							`fast-stdio dropped ${count} event(s)`,
							{ source: "fast-stdio", dropCount: count },
						),
					)
			: undefined;

		const onWriteError = options.onWriteError;

		this.stdoutWriter = new BufferedWriter({
			fd: options.fd ?? process.stdout.fd,
			bufferSize: options.bufferSize,
			maxBuffered: options.maxBuffered,
			backpressure: options.backpressure,
			onDrop: wrappedOnDrop,
			onWriteError,
		});

		this.stderrWriter = new BufferedWriter({
			fd: options.errorFd ?? process.stderr.fd,
			bufferSize: options.bufferSize,
			maxBuffered: options.maxBuffered,
			backpressure: options.backpressure,
			onDrop: wrappedOnDrop,
			onWriteError,
		});
	}

	public write(event: ILogEvent): void {
		const line = `${serializeEvent(event)}\n`;
		const isFatal = event.level === "error" || event.level === "fatal";
		const writer = isFatal ? this.stderrWriter : this.stdoutWriter;

		if (isFatal && this.syncFatal) {
			writer.writeSync(line);
			return;
		}
		writer.push(line);
	}

	public async flush(): Promise<void> {
		await Promise.all([this.stdoutWriter.flush(), this.stderrWriter.flush()]);
	}

	public async close(): Promise<void> {
		await Promise.all([this.stdoutWriter.close(), this.stderrWriter.close()]);
	}

	/**
	 * Snapshot of the underlying buffer statistics, useful for tests and
	 * health-check endpoints.
	 */
	public getStats() {
		return {
			stdout: this.stdoutWriter.getStats(),
			stderr: this.stderrWriter.getStats(),
		};
	}
}
