import type { Bindings } from "@/types/bindings";

/**
 * Public contract of the logger: a sync `void`-returning method per
 * `LogLevel`, plus `log` (delegates to the configured default level),
 * `child` (context inheritance), and the optional `flush`/`close`
 * graceful-shutdown hooks.
 *
 * **API shape is pino-style** — `meta` first, optional `msg` second:
 *
 * ```ts
 * logger.info("event happened");
 * logger.info({ userId: 42 }, "user registered");
 * logger.info({ event: "queue.empty" });        // msg-less, all data in meta
 * logger.error(err, "checkout failed");          // Error as first arg
 * logger.error({ err, step: "auth" }, "failed");// Error inside meta key "err"
 * ```
 *
 * The `TBindings` type parameter tracks the **accumulated shape** of the
 * logger's persistent context — `log.child({ a: 1 }).child({ b: 2 })`
 * carries the intersection of both keys in its type. Runtime behaviour
 * is unaffected; the generic exists for tooling and reasoning.
 *
 * @remarks
 * - Level methods are **synchronous and return `void`**. Methods below the
 *   logger's threshold are bound to a shared `NOOP_VOID` — zero allocation
 *   on the dropped path.
 * - The first argument is parsed at runtime: `string` → `msg`; `Error` → the
 *   thrown value (stored on `event.err`); any other object → `meta`. When
 *   the first argument is a meta object containing an `err` key whose value
 *   is an `Error`, it is extracted onto `event.err`.
 * - Tests should not inspect a return value (there isn't one); attach a
 *   `NullTransport` and read `transport.events[]`.
 *
 * @typeParam TBindings - shape of the persistent context attached to this
 *   logger. Accumulates across `child()` calls.
 *
 * @see {@link Logger} — the bundled concrete implementation.
 * @see {@link createAroma} — recommended construction path.
 * @see {@link NullTransport} — capture transport for tests.
 */
export interface ILogger<TBindings extends Bindings = Bindings> {
	/**
	 * Emit at `"trace"`. Most verbose level; intended for fine-grained
	 * development diagnostics that would be too noisy in production.
	 */
	trace(msg: string): void;
	trace(err: Error, msg?: string): void;
	trace<TMeta extends Bindings>(meta: TMeta, msg?: string): void;

	/**
	 * Emit at `"debug"`. Diagnostic information useful while investigating
	 * a specific behaviour but not interesting in normal operation.
	 */
	debug(msg: string): void;
	debug(err: Error, msg?: string): void;
	debug<TMeta extends Bindings>(meta: TMeta, msg?: string): void;

	/**
	 * Emit at `"info"`. Default production level — significant lifecycle
	 * events (request received, job started, connection established).
	 */
	info(msg: string): void;
	info(err: Error, msg?: string): void;
	info<TMeta extends Bindings>(meta: TMeta, msg?: string): void;

	/**
	 * Emit at `"warn"`. Recoverable abnormality — degraded behaviour that
	 * did not stop the operation but warrants attention.
	 */
	warn(msg: string): void;
	warn(err: Error, msg?: string): void;
	warn<TMeta extends Bindings>(meta: TMeta, msg?: string): void;

	/**
	 * Emit at `"error"`. A handled failure — an operation could not complete
	 * but the process keeps running.
	 */
	error(msg: string): void;
	error(err: Error, msg?: string): void;
	error<TMeta extends Bindings>(meta: TMeta, msg?: string): void;

	/**
	 * Emit at `"fatal"`. Unrecoverable failure — the process is typically
	 * about to terminate. Pair with `flush()`/`close()` on shutdown to make
	 * sure the entry actually reaches its sinks before exit.
	 */
	fatal(msg: string): void;
	fatal(err: Error, msg?: string): void;
	fatal<TMeta extends Bindings>(meta: TMeta, msg?: string): void;

	/**
	 * Emit at the logger's configured default level. Convenient when the
	 * level is itself a configuration knob and the caller doesn't want to
	 * branch on it.
	 */
	log(msg: string): void;
	log(err: Error, msg?: string): void;
	log<TMeta extends Bindings>(meta: TMeta, msg?: string): void;

	/**
	 * Create a derived logger that shares this instance's transports,
	 * redaction list, threshold and `onError` handler, with the supplied
	 * `bindings` merged on top of the parent's bindings.
	 *
	 * The returned logger's type **accumulates** the bindings shape:
	 * `log.child({ a: 1 }).child({ b: 2 })` has type
	 * `ILogger<TBindings & { a: number } & { b: number }>`. Runtime
	 * behaviour is unchanged; the type-system accumulation is for tooling.
	 *
	 * @param bindings - additional context to merge atop the parent's.
	 * @returns a new logger with the accumulated bindings type.
	 *
	 * @example
	 * ```ts
	 * const base = createAroma<{ service: string }>();
	 * const req = base.child({ requestId: "abc" });
	 * // typeof req === ILogger<{ service: string } & { requestId: string }>
	 * ```
	 */
	child<TChild extends Bindings>(bindings: TChild): ILogger<TBindings & TChild>;

	/**
	 * Drain buffered state on every transport that implements `flush`.
	 * No-op for transports without buffering. Safe to call on shutdown.
	 *
	 * @remarks
	 * Typical shutdown sequence: `await log.flush()` then `await log.close()`
	 * inside a `SIGTERM`/`SIGINT` handler before `process.exit()`. See the
	 * "Graceful shutdown" example on {@link createAroma}.
	 */
	flush?(): Promise<void>;

	/**
	 * Release resources on every transport that implements `close`.
	 * No-op for transports without underlying resources. After `close`,
	 * subsequent log calls still execute against the transports but
	 * buffered/socket-backed transports become silent no-ops.
	 *
	 * @see {@link ILogger.flush}
	 */
	close?(): Promise<void>;
}
