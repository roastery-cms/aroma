import { Worker } from "node:worker_threads";
import { isFormatted } from "@/internal/formatted";
import type { ILogEvent } from "@/types/log-event.interface";
import type { LogLevel } from "@/types/log-level";
import type { ITransport } from "@/types/transport.interface";

/**
 * Options accepted by `WorkerTransport`.
 *
 * @since 0.0.1
 *
 * @see {@link WorkerTransport}
 */
export type WorkerTransportOptions = {
	/**
	 * Resolved path to the worker entry module. The module must export a
	 * default `ITransport`-like handler that consumes events posted via
	 * `parentPort.on("message", ...)`. See the bundled
	 * `worker/file-worker.ts` template for an example.
	 */
	target: string;
	/** Arbitrary options forwarded to the worker via `workerData`. */
	targetOptions?: unknown;
	/** Per-transport minimum severity. */
	level?: LogLevel;
	/** Optional callback invoked when the worker reports an error. */
	onError?: (err: Error) => void;
	/** Optional human identifier; appears in error messages. */
	name?: string;
};

/**
 * Off-main transport. Spawns a worker thread that owns the actual sink
 * (typically a `FileTransport` or an HTTP client), and posts each event
 * via `postMessage`. The main thread pays only the structured-clone cost
 * of the event — every serialisation, I/O syscall, retry, batching, etc.
 * happens off the main loop.
 *
 * Use when:
 * - Latency-sensitive workloads cannot afford the main thread doing I/O.
 * - The chosen sink does expensive serialisation (gzip on rotate, NDJSON
 *   batching with HTTP retries, etc.).
 *
 * @remarks
 * - `postMessage` performs a structured clone of the event — pass small
 *   payloads. Don't put massive blobs in `meta` and expect the worker
 *   transport to absorb the cost.
 * - The worker is terminated on `close()` after a final `flush` message
 *   is awaited.
 *
 * @example
 * ```ts
 * import { WorkerTransport } from "@roastery/aroma/transports";
 *
 * const transport = new WorkerTransport({
 *   target: new URL("./my-file-worker.js", import.meta.url).pathname,
 *   targetOptions: { path: "/var/log/app.log", rotation: { size: "10MB" } },
 *   onError: (err) => console.error("worker err:", err),
 * });
 * ```
 *
 * @since 0.0.1
 *
 * @see {@link ITransport}
 */
export class WorkerTransport implements ITransport {
	public readonly name: string;
	public readonly level?: LogLevel;

	private readonly worker: Worker;
	private readonly onError?: (err: Error) => void;
	private flushPending: (() => void) | null = null;
	private closed = false;

	public constructor(options: WorkerTransportOptions) {
		this.name = options.name ?? "worker";
		this.level = options.level;
		this.onError = options.onError;

		this.worker = new Worker(options.target, {
			workerData: options.targetOptions,
		});
		this.worker.on("error", (err: unknown) =>
			this.onError?.(err instanceof Error ? err : new Error(String(err))),
		);
		this.worker.on("message", (msg) => {
			if (
				typeof msg === "object" &&
				msg !== null &&
				(msg as { type?: string }).type === "flushed"
			) {
				this.flushPending?.();
				this.flushPending = null;
			}
		});
		// If the worker dies (crash, uncaught error, terminate), mark the
		// transport closed and resolve any in-flight flush so callers don't hang
		// forever waiting for a "flushed" reply that will never arrive.
		this.worker.on("exit", () => {
			this.closed = true;
			this.flushPending?.();
			this.flushPending = null;
		});
	}

	public write(event: ILogEvent): void {
		if (this.closed) return;
		// `postMessage` structured-clones the event, which drops symbol-keyed
		// and non-enumerable properties. A format processor (e.g. ECS) brands
		// the event and stores `level`/`time` non-enumerably — both would be
		// lost across the boundary, so carry them explicitly and let the worker
		// re-apply them before serialisation.
		if (isFormatted(event)) {
			this.worker.postMessage({
				type: "event",
				event,
				formatted: true,
				level: event.level,
				time: event.time,
			});
			return;
		}
		this.worker.postMessage({ type: "event", event });
	}

	public async flush(): Promise<void> {
		if (this.closed) return;
		await new Promise<void>((resolve) => {
			this.flushPending = resolve;
			this.worker.postMessage({ type: "flush" });
		});
	}

	public async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		await this.flush().catch(() => {});
		this.worker.postMessage({ type: "close" });
		await this.worker.terminate();
	}
}
