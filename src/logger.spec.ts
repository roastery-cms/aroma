import { afterEach, describe, expect, test } from "bun:test";
import { AromaException } from "@/exceptions/aroma-exception";
import { NOOP_VOID } from "@/internal/noop";
import { _registerContextReader, Logger } from "@/logger";
import { createRedactProcessor } from "@/processors/redact";
import { NullTransport } from "@/transports/null-transport";
import type { Bindings } from "@/types/bindings";
import type { ILogEvent } from "@/types/log-event.interface";
import type { ITransport } from "@/types/transport.interface";

describe("Logger — pino-style API", () => {
	test("trace() emits with level 'trace'", () => {
		const sink = new NullTransport();
		const logger = new Logger({ level: "trace", transports: [sink] });

		logger.trace("hello trace");

		expect(sink.events).toHaveLength(1);
		expect(sink.events[0]?.level).toBe("trace");
		expect(sink.events[0]?.msg).toBe("hello trace");
	});

	test("debug() emits with level 'debug'", () => {
		const sink = new NullTransport();
		const logger = new Logger({ level: "debug", transports: [sink] });

		logger.debug("hello debug");

		expect(sink.events[0]?.level).toBe("debug");
	});

	test("info(msg) builds event with level, msg, time, bindings", () => {
		const sink = new NullTransport();
		const logger = new Logger({
			level: "info",
			bindings: { service: "api" },
			transports: [sink],
		});

		const before = Date.now();
		logger.info("hello");
		const after = Date.now();

		const event = sink.events[0];
		expect(event?.level).toBe("info");
		expect(event?.msg).toBe("hello");
		expect(event?.bindings).toEqual({ service: "api" });
		expect(event?.time).toBeGreaterThanOrEqual(before);
		expect(event?.time).toBeLessThanOrEqual(after);
	});

	test("warn(meta, msg) pino-style: meta first, msg second", () => {
		const sink = new NullTransport();
		const logger = new Logger({ transports: [sink] });

		logger.warn({ userId: 42 }, "user warned");

		expect(sink.events[0]?.meta).toEqual({ userId: 42 });
		expect(sink.events[0]?.msg).toBe("user warned");
	});

	test("info(meta) without msg leaves msg undefined", () => {
		const sink = new NullTransport();
		const logger = new Logger({ transports: [sink] });

		logger.info({ event: "queue.empty", workerId: 3 });

		expect(sink.events[0]?.msg).toBeUndefined();
		expect(sink.events[0]?.meta).toEqual({ event: "queue.empty", workerId: 3 });
	});

	test("error(err, msg): native Error is normalised to UnknownException", () => {
		const sink = new NullTransport();
		const logger = new Logger({ transports: [sink] });
		const cause = new Error("root");
		const err = new Error("boom", { cause });

		logger.error(err, "failed");

		const event = sink.events[0];
		expect(event?.msg).toBe("failed");
		// Non-terroir errors are wrapped so event.err always derives from CoreException.
		expect(event?.err?.name).toBe("Unknown Error");
		expect(event?.err?.message).toBe("boom");
		expect(event?.err?.source).toBe("$internal");
		expect(event?.err?.layer).toBe("internal");
		expect(event?.err?.stack).toBeDefined();
		// The original error and its own cause chain are preserved under `cause`.
		const errCause = event?.err?.cause as {
			name: string;
			message: string;
			cause?: { message: string };
		};
		expect(errCause.name).toBe("Error");
		expect(errCause.message).toBe("boom");
		expect(errCause.cause?.message).toBe("root");
	});

	test("error(coreException): a terroir exception passes through with source/layer", () => {
		const sink = new NullTransport();
		const logger = new Logger({ transports: [sink] });
		const err = new AromaException("transport down", { source: "console" });

		logger.error(err, "failed");

		const event = sink.events[0];
		expect(event?.err?.name).toBe("Aroma Exception");
		expect(event?.err?.message).toBe("transport down");
		expect(event?.err?.source).toBe("console");
		expect(event?.err?.layer).toBe("infra");
	});

	test("error({ err, ...meta }, msg) extracts err from meta object", () => {
		const sink = new NullTransport();
		const logger = new Logger({ transports: [sink] });
		const err = new Error("boom");

		logger.error({ err, step: "payment" }, "checkout failed");

		const event = sink.events[0];
		expect(event?.err?.message).toBe("boom");
		expect(event?.meta).toEqual({ step: "payment" });
		expect(event?.msg).toBe("checkout failed");
	});

	test("fatal() emits with level 'fatal'", () => {
		const sink = new NullTransport();
		const logger = new Logger({ transports: [sink] });

		logger.fatal("hello fatal");

		expect(sink.events[0]?.level).toBe("fatal");
	});
});

describe("Logger — level filtering", () => {
	test("methods below threshold are bound to NOOP_VOID (zero allocation)", () => {
		const sink = new NullTransport();
		const logger = new Logger({ level: "info", transports: [sink] });

		expect((logger as unknown as Record<string, unknown>).trace).toBe(
			NOOP_VOID,
		);
		expect((logger as unknown as Record<string, unknown>).debug).toBe(
			NOOP_VOID,
		);
		expect((logger as unknown as Record<string, unknown>).info).not.toBe(
			NOOP_VOID,
		);
	});

	test("dropped logs do not reach transports", () => {
		const sink = new NullTransport();
		const logger = new Logger({ level: "info", transports: [sink] });

		logger.debug("noisy");

		expect(sink.events).toHaveLength(0);
	});

	test("logs at or above threshold reach transports", () => {
		const sink = new NullTransport();
		const logger = new Logger({ level: "warn", transports: [sink] });

		logger.info("ignored");
		logger.warn("kept");
		logger.error("kept too");

		expect(sink.events.map((e) => e.level)).toEqual(["warn", "error"]);
	});

	test("transport-specific level is respected", () => {
		const low = new NullTransport({ level: "trace" });
		const high = new NullTransport({ level: "error" });
		const logger = new Logger({
			level: "trace",
			transports: [low, high],
		});

		logger.info("hi");
		logger.error("oops");

		expect(low.events.map((e) => e.level)).toEqual(["info", "error"]);
		expect(high.events.map((e) => e.level)).toEqual(["error"]);
	});
});

describe("Logger — redaction (via processor)", () => {
	test("redact processor replaces matching keys in bindings and meta", () => {
		const sink = new NullTransport();
		const logger = new Logger({
			bindings: { service: "api", password: "topsecret" },
			transports: [sink],
			processors: [createRedactProcessor({ keys: ["password", "token"] })],
		});

		logger.info(
			{
				userId: 7,
				token: "abc",
				safe: "ok",
			},
			"login",
		);

		expect(sink.events[0]?.bindings).toEqual({
			service: "api",
			password: "[REDACTED]",
		});
		expect(sink.events[0]?.meta).toEqual({
			userId: 7,
			token: "[REDACTED]",
			safe: "ok",
		});
	});

	test("processor returning null drops the event", () => {
		const sink = new NullTransport();
		const dropAll = {
			name: "drop",
			process: () => null,
		};
		const logger = new Logger({
			transports: [sink],
			processors: [dropAll],
		});

		logger.info("dropped");

		expect(sink.events).toHaveLength(0);
	});

	test("processors run in declaration order", () => {
		const sink = new NullTransport();
		const order: string[] = [];
		const first = {
			name: "first",
			process: (e: ILogEvent) => {
				order.push("first");
				return e;
			},
		};
		const second = {
			name: "second",
			process: (e: ILogEvent) => {
				order.push("second");
				return e;
			},
		};
		const logger = new Logger({
			transports: [sink],
			processors: [first, second],
		});

		logger.info("test");

		expect(order).toEqual(["first", "second"]);
	});
});

describe("Logger — child", () => {
	test("child(bindings) inherits parent bindings and extends with new ones", () => {
		const sink = new NullTransport();
		const parent = new Logger({
			bindings: { service: "api" },
			transports: [sink],
		});

		const child = parent.child({ requestId: "req-1" });
		child.info("child log");

		expect(sink.events[0]?.bindings).toEqual({
			service: "api",
			requestId: "req-1",
		});
	});

	test("child does not mutate parent bindings", () => {
		const sink = new NullTransport();
		const parent = new Logger({
			bindings: { service: "api" },
			transports: [sink],
		});

		const child = parent.child({ requestId: "req-1" });
		child.info("child");
		parent.info("parent");

		const parentEvent = sink.events[1];
		expect(parentEvent?.bindings).toEqual({ service: "api" });
		expect(parentEvent?.bindings).not.toHaveProperty("requestId");
	});

	test("child inherits onError from parent", () => {
		const errors: AromaException[] = [];
		const bad: ITransport = {
			name: "bad",
			write() {
				throw new Error("transport down");
			},
		};
		const parent = new Logger({
			transports: [bad],
			onError: (err) => errors.push(err),
		});

		const child = parent.child({ requestId: "req-1" });
		child.info("hi");

		expect(errors).toHaveLength(1);
		expect(errors[0]).toBeInstanceOf(AromaException);
	});
});

describe("Logger — log() delegate", () => {
	test("log() delegates to the default level method", () => {
		const sink = new NullTransport();
		const logger = new Logger({ level: "warn", transports: [sink] });

		logger.log("via log()");

		expect(sink.events[0]?.level).toBe("warn");
		expect(sink.events).toHaveLength(1);
	});

	test("log() at a level that is NOOP still drops correctly", () => {
		const sink = new NullTransport();
		// level=error means default log() == error()
		const logger = new Logger({ level: "error", transports: [sink] });

		logger.log("kept");

		expect(sink.events[0]?.level).toBe("error");
	});
});

describe("Logger — transport failure handling", () => {
	test("a throwing transport does not prevent others from receiving the event", () => {
		const good = new NullTransport();
		const original = new Error("transport down");
		const bad: ITransport = {
			name: "bad",
			write() {
				throw original;
			},
		};
		const errors: AromaException[] = [];

		const logger = new Logger({
			transports: [bad, good],
			onError: (err) => errors.push(err),
		});
		logger.info("hi");

		expect(good.events).toHaveLength(1);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toBeInstanceOf(AromaException);
		expect(errors[0]?.message).toBe('transport "bad" failed');
		expect(errors[0]?.cause).toBe(original);
	});

	test("transport failure is silent when no onError handler is provided", () => {
		const bad: ITransport = {
			name: "bad",
			write() {
				throw new Error("transport down");
			},
		};
		const logger = new Logger({ transports: [bad] });

		expect(() => logger.info("hi")).not.toThrow();
	});

	test("async transport rejection lands in onError", async () => {
		const errors: AromaException[] = [];
		const bad: ITransport = {
			name: "bad-async",
			async write() {
				throw new Error("network down");
			},
		};
		const logger = new Logger({
			transports: [bad],
			onError: (err) => errors.push(err),
		});

		logger.info("hi");
		// wait a microtask for the rejection to land
		await Promise.resolve();
		await Promise.resolve();

		expect(errors).toHaveLength(1);
		expect(errors[0]?.message).toBe('transport "bad-async" failed');
	});

	test("an onError that throws does not bubble up to the caller", () => {
		const bad: ITransport = {
			name: "bad",
			write() {
				throw new Error("boom");
			},
		};
		const logger = new Logger({
			transports: [bad],
			onError: () => {
				throw new Error("user callback exploded");
			},
		});

		expect(() => logger.info("hi")).not.toThrow();
	});
});

describe("Logger — bindings immutability", () => {
	test("bindings passed at construction are isolated from external mutation", () => {
		const input: Bindings = { service: "api" };
		const sink = new NullTransport();
		const logger = new Logger({ bindings: input, transports: [sink] });

		(input as Record<string, unknown>).service = "mutated";
		(input as Record<string, unknown>).leaked = true;
		logger.info("hi");

		expect(sink.events[0]?.bindings).toEqual({ service: "api" });
	});

	test("event.bindings is frozen when no context is registered", () => {
		const sink = new NullTransport();
		const logger = new Logger({
			bindings: { service: "api" },
			transports: [sink],
		});

		logger.info("hi");

		const captured = sink.events[0]?.bindings as Bindings;
		expect(Object.isFrozen(captured)).toBe(true);
		expect(() => {
			(captured as Record<string, unknown>).service = "tampered";
		}).toThrow();
	});
});

describe("Logger — context precedence", () => {
	afterEach(() => {
		// Restore a no-op reader so other test files start clean.
		_registerContextReader(() => undefined);
	});

	test("context bindings take precedence over logger bindings on key collision", () => {
		_registerContextReader(() => ({ requestId: "from-ctx" }));
		const sink = new NullTransport();
		const logger = new Logger({
			bindings: { requestId: "from-binding", service: "api" },
			transports: [sink],
		});

		logger.info("hi");

		expect(sink.events[0]?.bindings).toEqual({
			requestId: "from-ctx",
			service: "api",
		});
	});

	test("missing context falls back to logger bindings unchanged", () => {
		_registerContextReader(() => undefined);
		const sink = new NullTransport();
		const logger = new Logger({
			bindings: { service: "api" },
			transports: [sink],
		});

		logger.info("hi");

		expect(sink.events[0]?.bindings).toEqual({ service: "api" });
	});
});

describe("Logger — lifecycle", () => {
	test("flush() fans out to transports that implement flush", async () => {
		const flushed: string[] = [];
		const a: ITransport = {
			name: "a",
			write() {},
			async flush() {
				flushed.push("a");
			},
		};
		const b: ITransport = { name: "b", write() {} };
		const logger = new Logger({ transports: [a, b] });

		await logger.flush();

		expect(flushed).toEqual(["a"]);
	});

	test("close() fans out to transports that implement close", async () => {
		const closed: string[] = [];
		const a: ITransport = {
			name: "a",
			write() {},
			async close() {
				closed.push("a");
			},
		};
		const b: ITransport = {
			name: "b",
			write() {},
			async close() {
				closed.push("b");
			},
		};
		const logger = new Logger({ transports: [a, b] });

		await logger.close();

		expect(closed.sort()).toEqual(["a", "b"]);
	});
});

describe("Logger — return type", () => {
	test("level methods return void (not Promise)", () => {
		const sink = new NullTransport();
		const logger = new Logger({ transports: [sink] });

		const result: unknown = logger.info("hi");
		expect(result).toBeUndefined();
	});

	test("event captured carries level/msg/time/bindings consistently", () => {
		const sink = new NullTransport();
		const logger = new Logger({ transports: [sink] });

		logger.info("test");
		const captured: ILogEvent | undefined = sink.events[0];

		expect(captured?.level).toBe("info");
		expect(typeof captured?.time).toBe("number");
	});
});
