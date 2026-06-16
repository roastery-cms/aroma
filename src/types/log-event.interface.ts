import type { CoreExceptionType } from "@roastery/terroir/exceptions/core";
import type { Bindings } from "@/types/bindings";
import type { LogLevel } from "@/types/log-level";

/**
 * Wire-format shape of a single log entry as it leaves the `Logger` and
 * reaches a transport.
 *
 * Every call to `logger.{trace|…|fatal}()` that passes the level threshold
 * materialises exactly one `ILogEvent`. Methods bound below the threshold
 * are `NOOP_VOID` and never construct an event at all.
 *
 * Transports must treat the event as **immutable**; the logger already
 * clones bindings/meta and applies redaction before passing the event to
 * `ITransport.write`, so any mutation by a transport would only leak
 * across transports running in parallel.
 *
 * @remarks
 * - `time` is epoch milliseconds (`Date.now()`); not ISO and not high-resolution.
 * - `bindings` carries the persistent context attached to the logger
 *   instance (set by `createAroma`/`Logger` and extended via `Logger.child`).
 *   `meta` carries the per-call payload. Both are redacted in-place by the
 *   pipeline.
 * - `msg` is optional — pino-style call shapes (`logger.info({ event: "x" })`)
 *   leave it absent so the event itself becomes the structured payload.
 * - `err`, when present, is the structured form produced by
 *   `serializeError` — never the raw `Error` instance.
 *
 * @see {@link Logger} — the only producer of events in this package.
 * @see {@link ITransport.write} — the consumer signature.
 * @see {@link serializeError} — how `err` is built from a thrown value.
 */
export interface ILogEvent {
    /** Severity of the entry. Drives both internal filtering and the value indexed by aggregators. */
    level: LogLevel;
    /** Wall-clock timestamp in epoch milliseconds (`Date.now()`). */
    time: number;
    /** Human-readable message. Optional — absent when the caller passed only `meta`. */
    msg?: string;
    /** Persistent context attached to the logger; post-redaction snapshot of the parent + child bindings. */
    bindings: Readonly<Bindings>;
    /** Per-call payload, post-redaction. `undefined` when the caller passed no `meta`. */
    meta?: Readonly<Bindings>;
    /**
     * Serialised error, normalised to the shape of a `terroir` `CoreException`
     * (always carrying `source` and the architectural `layer`). Values that are
     * not already a `CoreException` are wrapped in an `UnknownException` by
     * {@link serializeError}, with the original value preserved under `cause`.
     * `cause` is serialised recursively. `undefined` when the caller passed no
     * `err`. Never the raw `Error` instance — this is a plain, JSON-safe object.
     */
    err?: {
        /** `name` of the (normalised) exception — e.g. `"Unknown Error"`. */
        name: string;
        /** Human-readable message. */
        message: string;
        /** Stack trace if available — typically a multi-line string. */
        stack?: string;
        /** Originating module/component (`CoreException.source`); `"$internal"` for wrapped errors. */
        source: string;
        /** Architectural layer discriminator (`"internal"` for wrapped errors). */
        layer: CoreExceptionType;
        /** Recursively serialised `cause`; a non-`Error` cause is passed through unchanged. */
        cause?: unknown;
    };
}
