import { serializeEvent } from "@/internal/serializer";
import type { ILogEvent } from "@/types/log-event.interface";
import type { LogLevel } from "@/types/log-level";
import type { ITransport } from "@/types/transport.interface";

/**
 * Shape of a pino-style transport. Pino transports are simple writable
 * objects (or stream-like) accepting newline-delimited JSON chunks.
 *
 * This intentionally narrow type covers the pino transport ecosystem
 * (`pino-elasticsearch`, `pino-loki`, `pino-datadog`, …) without pulling
 * pino itself in as a dependency.
 *
 * @since 0.0.1
 *
 * @see {@link createPinoCompatTransport}
 */
export type PinoCompatibleTransport = {
	write(chunk: string): void | boolean | Promise<void>;
	flushSync?(): void;
	flush?(): Promise<void> | void;
	end?(): void;
};

/**
 * Options accepted by `createPinoCompatTransport`.
 *
 * @since 0.0.1
 *
 * @see {@link createPinoCompatTransport}
 */
export type PinoCompatOptions = {
	/** Per-transport minimum severity. */
	level?: LogLevel;
	/** Identifier surfaced in `AromaException.message` on errors. */
	name?: string;
};

/**
 * Adapt a pino-shaped transport into the aroma `ITransport` contract.
 *
 * Lets you reuse the entire pino transport ecosystem
 * (`pino-elasticsearch`, `pino-loki`, `pino-datadog`, …) inside an aroma
 * pipeline without rewriting any code. Each event is serialised with the
 * canonical aroma format and appended with `\n`, then forwarded to the
 * wrapped transport's `write`.
 *
 * Lifecycle hooks (`flush` / `close`) bridge to the pino conventions
 * (`flush`/`flushSync`/`end`) where they exist.
 *
 * @param transport - the pino-shaped sink.
 * @param options - per-aroma options (level, name).
 * @returns an `ITransport` ready to be passed to `createAroma`.
 *
 * @example
 * ```ts
 * import { createAroma } from "@roastery/aroma";
 * import { createPinoCompatTransport } from "@roastery/aroma/compat";
 * import pinoElastic from "pino-elasticsearch";
 *
 * const elastic = pinoElastic({ index: "app", node: "https://es:9200" });
 *
 * const log = createAroma({
 *   transports: [createPinoCompatTransport(elastic, { name: "elastic" })],
 * });
 * ```
 *
 * @since 0.0.1
 *
 * @see {@link ITransport}
 */
export function createPinoCompatTransport(
	transport: PinoCompatibleTransport,
	options: PinoCompatOptions = {},
): ITransport {
	return {
		name: options.name ?? "pino-compat",
		level: options.level,
		write(event: ILogEvent): void | Promise<void> {
			const line = `${serializeEvent(event)}\n`;
			const result = transport.write(line);
			if (result instanceof Promise) return result.then(() => undefined);
			return undefined;
		},
		async flush(): Promise<void> {
			if (typeof transport.flush === "function") {
				const r = transport.flush();
				if (r instanceof Promise) await r;
				return;
			}
			if (typeof transport.flushSync === "function") {
				transport.flushSync();
			}
		},
		async close(): Promise<void> {
			if (typeof transport.end === "function") {
				transport.end();
			}
		},
	};
}
