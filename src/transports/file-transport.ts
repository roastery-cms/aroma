import {
	closeSync,
	createReadStream,
	createWriteStream,
	openSync,
	renameSync,
	statSync,
	unlinkSync,
} from "node:fs";
import { resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import {
	type BackpressurePolicy,
	BufferedWriter,
} from "@/internal/buffered-writer";
import { parseSize } from "@/internal/parse-size";
import { serializeEvent } from "@/internal/serializer";
import type { ILogEvent } from "@/types/log-event.interface";
import type { LogLevel } from "@/types/log-level";
import type { ITransport } from "@/types/transport.interface";

/**
 * Rotation policy. Either or both can be set:
 * - `size`: rotate when the current file reaches a size threshold (e.g. `"10MB"`).
 * - `interval`: rotate every wall-clock period (`"daily"` or `"hourly"`).
 *
 * @since 0.0.1
 *
 * @see {@link FileTransport}
 */
export type FileRotation = {
	size?: string | number;
	interval?: "daily" | "hourly";
};

/**
 * Options accepted by `FileTransport`.
 *
 * @since 0.0.1
 *
 * @see {@link FileTransport}
 */
export type FileTransportOptions = {
	/** Absolute or relative path to the log file. The parent directory must already exist. */
	path: string;
	/** Optional rotation policy. Omit to keep growing the same file forever (suitable for short-lived processes). */
	rotation?: FileRotation;
	/** Compress rotated files with gzip. Defaults to `"none"`. */
	compress?: "gzip" | "none";
	/** Per-transport minimum severity. */
	level?: LogLevel;
	/**
	 * Soft buffer-size hint in bytes (default 4 KB). Buffered lines flush on
	 * the next event-loop tick regardless, so this no longer gates flush
	 * timing; retained for tuning and API compatibility.
	 */
	bufferSize?: number;
	/** Hard cap on buffered bytes before backpressure kicks in. Defaults to 64 KB. */
	maxBuffered?: number;
	/** Backpressure policy. Defaults to `"drop"`. */
	backpressure?: BackpressurePolicy;
	/** Optional callback invoked when an underlying write fails. */
	onWriteError?: (err: Error) => void;
};

function formatRotationSuffix(
	date: Date,
	interval?: "daily" | "hourly",
): string {
	const yyyy = date.getUTCFullYear();
	const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
	const dd = String(date.getUTCDate()).padStart(2, "0");
	if (interval === "hourly") {
		const hh = String(date.getUTCHours()).padStart(2, "0");
		return `${yyyy}-${mm}-${dd}-${hh}`;
	}
	return `${yyyy}-${mm}-${dd}`;
}

async function gzipFile(source: string): Promise<void> {
	await pipeline(
		createReadStream(source),
		createGzip(),
		createWriteStream(`${source}.gz`),
	);
	unlinkSync(source);
}

/**
 * Persistent file transport with size- and time-based rotation. Reuses the
 * same `BufferedWriter` as `FastStdioTransport`, so the cost-per-line is
 * identical — one syscall per buffer-fill, not per event.
 *
 * @remarks
 * - **Rotation by size**: the transport polls byte count after each
 *   successful flush. When the current file exceeds `rotation.size`, the
 *   buffer is drained, the fd is closed, the file is renamed with a date
 *   suffix (e.g. `app.log.2026-04-27`), and a fresh fd is opened in its
 *   place. If `compress: "gzip"` is set, the rotated file is gzipped in
 *   the background.
 * - **Rotation by interval**: a `setInterval` ticks every hour or day
 *   (depending on the option) and triggers a rotation. The interval is
 *   cancelled in `close()`.
 * - **Crash safety**: pair `FileTransport` with a SIGTERM handler that
 *   calls `logger.flush()` then `logger.close()` to guarantee buffered
 *   events reach disk before exit.
 *
 * @example
 * ```ts
 * import { FileTransport } from "@roastery/aroma/transports";
 *
 * const file = new FileTransport({
 *   path: "/var/log/app.log",
 *   rotation: { size: "50MB", interval: "daily" },
 *   compress: "gzip",
 * });
 * ```
 *
 * @since 0.0.1
 *
 * @see {@link ITransport}
 * @see {@link BufferedWriter}
 */
export class FileTransport implements ITransport {
	public readonly name = "file";
	public readonly level?: LogLevel;

	private readonly path: string;
	private readonly compress: "gzip" | "none";
	private readonly rotationSize: number | null;
	private readonly rotationInterval: "daily" | "hourly" | null;
	private readonly bufferSize: number | undefined;
	private readonly maxBuffered: number | undefined;
	private readonly backpressure: BackpressurePolicy | undefined;
	private readonly onWriteError?: (err: Error) => void;

	private fd: number;
	private bytesWritten: number;
	private writer: BufferedWriter;
	private intervalTimer?: ReturnType<typeof setInterval>;
	private rotating = false;
	private closed = false;

	public constructor(options: FileTransportOptions) {
		this.path = resolve(options.path);
		this.level = options.level;
		this.compress = options.compress ?? "none";
		this.rotationSize = options.rotation?.size
			? parseSize(options.rotation.size)
			: null;
		this.rotationInterval = options.rotation?.interval ?? null;
		this.bufferSize = options.bufferSize;
		this.maxBuffered = options.maxBuffered;
		this.backpressure = options.backpressure;
		this.onWriteError = options.onWriteError;

		// Ensuring the parent directory exists is intentionally left to the
		// caller — we don't want to silently create directories with default
		// perms. `openSync` below throws a clear ENOENT if it's missing.
		this.fd = openSync(this.path, "a");
		this.bytesWritten = statSync(this.path).size;
		this.writer = this.makeWriter(this.fd);

		if (this.rotationInterval) {
			const periodMs =
				this.rotationInterval === "hourly" ? 3600_000 : 86_400_000;
			this.intervalTimer = setInterval(() => {
				void this.rotate();
			}, periodMs);
			this.intervalTimer.unref?.();
		}
	}

	public write(event: ILogEvent): void {
		if (this.closed) return;
		const line = `${serializeEvent(event)}\n`;
		// Only count bytes the writer actually buffered — lines dropped by the
		// backpressure policy never reach disk, so counting them would inflate
		// `bytesWritten` and rotate on phantom bytes.
		if (!this.writer.push(line)) return;
		// Real UTF-8 byte count so a `rotation.size` of "10MB" rotates at ~10MB
		// even for multibyte payloads (the initial size came from statSync).
		this.bytesWritten += Buffer.byteLength(line);
		if (
			this.rotationSize !== null &&
			this.bytesWritten >= this.rotationSize &&
			!this.rotating
		) {
			void this.rotate();
		}
	}

	public async flush(): Promise<void> {
		await this.writer.flush();
	}

	public async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		if (this.intervalTimer) clearInterval(this.intervalTimer);
		await this.writer.close();
		closeSync(this.fd);
	}

	public getStats() {
		return {
			bytesWritten: this.bytesWritten,
			buffer: this.writer.getStats(),
		};
	}

	private makeWriter(fd: number): BufferedWriter {
		return new BufferedWriter({
			fd,
			bufferSize: this.bufferSize,
			maxBuffered: this.maxBuffered,
			backpressure: this.backpressure,
			onWriteError: this.onWriteError,
		});
	}

	private async rotate(): Promise<void> {
		if (this.rotating || this.closed) return;
		this.rotating = true;
		try {
			await this.writer.flush();
			closeSync(this.fd);
			const suffix = formatRotationSuffix(
				new Date(),
				this.rotationInterval ?? undefined,
			);
			const rotatedPath = `${this.path}.${suffix}`;
			renameSync(this.path, rotatedPath);
			this.fd = openSync(this.path, "a");
			this.bytesWritten = 0;
			this.writer = this.makeWriter(this.fd);
			if (this.compress === "gzip") {
				gzipFile(rotatedPath).catch((err) => this.onWriteError?.(err));
			}
		} finally {
			this.rotating = false;
		}
	}
}
