import { parentPort, workerData } from "node:worker_threads";
import { FORMATTED } from "@/internal/formatted";
import {
	FileTransport,
	type FileTransportOptions,
} from "@/transports/file-transport";

/**
 * Worker entry point that hosts a `FileTransport` off the main thread.
 *
 * Receives `{ type: "event", event }`, `{ type: "flush" }`, and
 * `{ type: "close" }` messages via `parentPort`. Replies with
 * `{ type: "flushed" }` once a flush completes so the parent
 * `WorkerTransport` can resolve its `flush()` promise.
 *
 * @example
 * ```ts
 * // main.ts
 * import { WorkerTransport } from "@roastery/aroma/transports";
 *
 * const transport = new WorkerTransport({
 *   target: require.resolve("@roastery/aroma/transports/worker/file-worker"),
 *   targetOptions: { path: "/var/log/app.log" },
 * });
 * ```
 *
 * @internal
 */

if (!parentPort) {
	throw new Error("file-worker must be loaded as a worker thread");
}

const transport = new FileTransport(workerData as FileTransportOptions);

parentPort.on("message", async (msg: unknown) => {
	if (typeof msg !== "object" || msg === null) return;
	const tagged = msg as {
		type: string;
		event?: unknown;
		formatted?: boolean;
		level?: unknown;
		time?: unknown;
	};
	if (tagged.type === "event") {
		const event = tagged.event as Record<string, unknown>;
		if (tagged.formatted) {
			// Re-apply the brand + routing fields that structured clone stripped,
			// so `serializeEvent` emits this format-processed (e.g. ECS) record
			// verbatim instead of falling back to the canonical shape.
			Object.defineProperty(event, "level", {
				value: tagged.level,
				enumerable: false,
				writable: true,
				configurable: true,
			});
			Object.defineProperty(event, "time", {
				value: tagged.time,
				enumerable: false,
				writable: true,
				configurable: true,
			});
			Object.defineProperty(event, FORMATTED, {
				value: true,
				enumerable: false,
			});
		}
		transport.write(event as unknown as Parameters<typeof transport.write>[0]);
	} else if (tagged.type === "flush") {
		await transport.flush();
		parentPort?.postMessage({ type: "flushed" });
	} else if (tagged.type === "close") {
		await transport.close();
	}
});
