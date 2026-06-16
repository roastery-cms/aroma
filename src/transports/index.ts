/**
 * Barrel for `@roastery/aroma/transports`. Re-exports the bundled
 * transports.
 *
 * - `FastStdioTransport` — buffered, non-blocking stdio writer. The
 *   recommended default for production use.
 * - `ConsoleTransport` — legacy stdio writer (one syscall per event).
 *   Kept for backward compatibility; new code should use
 *   `FastStdioTransport`.
 * - `NullTransport` — capture transport for tests.
 *
 * Custom transports live in user code and only need the `ITransport`
 * contract from `@roastery/aroma/types`.
 *
 * @module @roastery/aroma/transports
 *
 * @see {@link FastStdioTransport}
 * @see {@link ConsoleTransport}
 * @see {@link NullTransport}
 * @see {@link ITransport}
 */

export { ConsoleTransport } from "@/transports/console-transport";
export {
	FastStdioTransport,
	type FastStdioTransportOptions,
} from "@/transports/fast-stdio-transport";
export {
	type FileRotation,
	FileTransport,
	type FileTransportOptions,
} from "@/transports/file-transport";
export { NullTransport } from "@/transports/null-transport";
export {
	WorkerTransport,
	type WorkerTransportOptions,
} from "@/transports/worker-transport";
