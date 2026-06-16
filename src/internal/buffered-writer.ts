import { write as fsWriteCallback, writeSync } from "node:fs";

function fsWriteAsync(fd: number, data: string): Promise<void> {
	return new Promise((resolve, reject) => {
		fsWriteCallback(fd, data, (err) => {
			if (err) reject(err);
			else resolve();
		});
	});
}

export type BackpressurePolicy = "block" | "drop" | "sample";

/**
 * Statistics exposed by a `BufferedWriter` for diagnostics and metrics.
 *
 * @internal
 */
type BufferedWriterStats = {
	bufferedBytes: number;
	pendingCount: number;
	flushCount: number;
	droppedCount: number;
	writeErrorCount: number;
};

/**
 * Options accepted by `BufferedWriter`.
 *
 * @internal
 */
type BufferedWriterOptions = {
	fd: number;
	bufferSize?: number; // default 4096
	maxBuffered?: number; // default 65536
	backpressure?: BackpressurePolicy;
	onDrop?: (dropCount: number) => void;
	onWriteError?: (err: Error) => void;
};

/**
 * Sonic-boom-like buffered writer over a raw file descriptor. Accumulates
 * lines in memory and descarrega in batches to amortise syscalls.
 *
 * Behaviour summary:
 * - **`push(line)`** appends a line to the buffer and schedules a flush for
 *   the next tick via `setImmediate`. Repeated pushes in the same tick
 *   coalesce into a single flush (one syscall per tick), so buffered data is
 *   written promptly and is never stranded waiting for the buffer to fill.
 * - **Backpressure** kicks in when `bufferedBytes >= maxBuffered`:
 *   - `"drop"`: the line is discarded, `droppedCount` increments, `onDrop`
 *     is called with the new total. Default policy.
 *   - `"block"`: never drops — the overflow line is still buffered and an
 *     immediate flush is scheduled. The buffer may therefore grow past
 *     `maxBuffered` under sustained saturation (bounded only by available
 *     memory), so pair it with periodic `flush()` when the sink can fall
 *     behind. It does **not** block the calling thread (`push` is sync).
 *   - `"sample"`: 1-in-N strategy — keeps roughly 1 of every 10 lines
 *     under saturation. Simple and adaptive without configuration.
 * - **`flush()`** awaits the next flush cycle and resolves when the
 *   buffer is empty.
 * - **`writeSync(line)`** bypasses the buffer entirely and writes via
 *   `fs.writeSync` — used for fatal logs that must hit the fd before the
 *   process can exit.
 * - **`close()`** drains, then prevents further writes (subsequent calls
 *   are silent no-ops).
 *
 * @internal — shared between `FastStdioTransport` and `FileTransport`.
 */
export class BufferedWriter {
	private readonly fd: number;
	private readonly bufferSize: number;
	private readonly maxBuffered: number;
	private readonly policy: BackpressurePolicy;
	private readonly onDrop?: (dropCount: number) => void;
	private readonly onWriteError?: (err: Error) => void;

	private buf: string[] = [];
	private bufBytes = 0;
	private flushScheduled = false;
	private flushing = false;
	private waiters: Array<() => void> = [];
	private dropped = 0;
	private flushCount = 0;
	private errors = 0;
	private sampleCursor = 0;
	private closed = false;

	public constructor(options: BufferedWriterOptions) {
		this.fd = options.fd;
		this.bufferSize = options.bufferSize ?? 4096;
		this.maxBuffered = options.maxBuffered ?? 65536;
		this.policy = options.backpressure ?? "drop";
		this.onDrop = options.onDrop;
		this.onWriteError = options.onWriteError;
	}

	/**
	 * Append a line to the buffer.
	 *
	 * @returns `true` when the line was accepted into the buffer (and will be
	 *   written), `false` when it was discarded — by the `"drop"` policy, a
	 *   `"sample"` skip, or because the writer is closed. Callers tracking
	 *   on-disk byte counts should only count accepted lines.
	 */
	public push(line: string): boolean {
		if (this.closed) return false;
		// UTF-8 byte count, not UTF-16 code units — keeps `bufferSize` /
		// `maxBuffered` honest for multibyte payloads.
		const bytes = Buffer.byteLength(line);
		if (this.bufBytes + bytes > this.maxBuffered) {
			return this.handleSaturation(line, bytes);
		}
		this.buf.push(line);
		this.bufBytes += bytes;
		// Schedule a flush for the end of the current tick regardless of how
		// much is buffered. Repeated pushes in the same tick coalesce into a
		// single flush (one syscall), but low-volume logs are never stranded
		// waiting for the buffer to fill — they reach the fd by the next tick.
		this.schedule();
		return true;
	}

	public writeSync(line: string): void {
		if (this.closed) return;
		try {
			writeSync(this.fd, line);
		} catch (err) {
			this.errors += 1;
			this.onWriteError?.(err as Error);
		}
	}

	public async flush(): Promise<void> {
		if (this.bufBytes === 0 && !this.flushing) return;
		await new Promise<void>((resolve) => {
			this.waiters.push(resolve);
			this.schedule();
		});
	}

	public async close(): Promise<void> {
		await this.flush();
		this.closed = true;
	}

	public getStats(): BufferedWriterStats {
		return {
			bufferedBytes: this.bufBytes,
			pendingCount: this.buf.length,
			flushCount: this.flushCount,
			droppedCount: this.dropped,
			writeErrorCount: this.errors,
		};
	}

	private handleSaturation(line: string, bytes: number): boolean {
		if (this.policy === "drop") {
			this.dropped += 1;
			this.onDrop?.(this.dropped);
			return false;
		}
		if (this.policy === "sample") {
			// Keep roughly 1 in 10 lines under saturation.
			this.sampleCursor += 1;
			if (this.sampleCursor % 10 !== 0) {
				this.dropped += 1;
				this.onDrop?.(this.dropped);
				return false;
			}
			this.buf.push(line);
			this.bufBytes += bytes;
			this.schedule();
			return true;
		}
		// "block" — accept the overflow line but force an immediate flush schedule.
		this.buf.push(line);
		this.bufBytes += bytes;
		this.schedule();
		return true;
	}

	private schedule(): void {
		if (this.flushScheduled || this.flushing) return;
		this.flushScheduled = true;
		setImmediate(() => {
			this.flushScheduled = false;
			void this.doFlush();
		});
	}

	private async doFlush(): Promise<void> {
		if (this.flushing) return;
		if (this.buf.length === 0) {
			this.drainWaiters();
			return;
		}
		this.flushing = true;
		const chunk = this.buf.join("");
		this.buf = [];
		this.bufBytes = 0;
		try {
			await fsWriteAsync(this.fd, chunk);
			this.flushCount += 1;
		} catch (err) {
			this.errors += 1;
			this.onWriteError?.(err as Error);
		} finally {
			this.flushing = false;
			if (this.buf.length > 0) {
				this.schedule();
			} else {
				this.drainWaiters();
			}
		}
	}

	private drainWaiters(): void {
		if (this.waiters.length === 0) return;
		const pending = this.waiters;
		this.waiters = [];
		for (const w of pending) w();
	}
}
