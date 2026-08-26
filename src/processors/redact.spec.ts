import { describe, expect, test } from "bun:test";
import { CONVERSION_ERROR_KEY } from "@/internal/conversion-failure";
import { createRedactProcessor } from "@/processors/redact";
import type { ILogEvent } from "@/types/log-event.interface";

function makeEvent(overrides: Partial<ILogEvent> = {}): ILogEvent {
	return {
		level: "info",
		time: 1700000000000,
		bindings: {},
		...overrides,
	};
}

describe("createRedactProcessor", () => {
	test("masks listed keys in bindings", () => {
		const proc = createRedactProcessor({ keys: ["password"] });
		const result = proc.process(
			makeEvent({ bindings: { user: "alan", password: "secret" } }),
		);

		expect(result?.bindings).toEqual({ user: "alan", password: "[redacted]" });
	});

	test("masks listed keys in meta", () => {
		const proc = createRedactProcessor({ keys: ["token"] });
		const result = proc.process(
			makeEvent({ bindings: {}, meta: { token: "abc", other: "ok" } }),
		);

		expect(result?.meta).toEqual({ token: "[redacted]", other: "ok" });
	});

	test("empty keys list is a no-op pass-through", () => {
		const proc = createRedactProcessor({ keys: [] });
		const event = makeEvent({ bindings: { password: "x" } });

		const result = proc.process(event);
		expect(result).toBe(event); // identity preserved
	});

	test("returns identity when no key matches", () => {
		const proc = createRedactProcessor({ keys: ["password"] });
		const event = makeEvent({
			bindings: { safe: "ok" },
			meta: { also: "fine" },
		});

		const result = proc.process(event);
		expect(result).toBe(event); // no allocation when nothing matches
	});

	test("has name 'redact'", () => {
		const proc = createRedactProcessor({ keys: [] });
		expect(proc.name).toBe("redact");
	});
});

describe("createRedactProcessor — err", () => {
	test("redacts a plain object hiding in err.cause", () => {
		const proc = createRedactProcessor({ keys: ["password"] });
		const result = proc.process(
			makeEvent({
				err: {
					name: "Bad Request",
					message: "auth failed",
					source: "auth",
					layer: "application",
					code: 400,
					cause: { password: "hunter2", attempt: 3 },
				},
			}),
		);

		expect(result?.err?.cause).toEqual({
			password: "[redacted]",
			attempt: 3,
		});
	});

	test("keeps every canonical field of err intact", () => {
		// A key list containing "message" or "stack" must not blank the error's
		// own diagnostic — that would protect nothing and destroy everything.
		const proc = createRedactProcessor({
			keys: ["message", "stack", "name", "source", "layer", "code"],
		});
		const result = proc.process(
			makeEvent({
				err: {
					name: "Bad Request",
					message: "auth failed",
					stack: "at …",
					source: "auth",
					layer: "application",
					code: 400,
				},
			}),
		);

		expect(result?.err).toEqual({
			name: "Bad Request",
			message: "auth failed",
			stack: "at …",
			source: "auth",
			layer: "application",
			code: 400,
		});
	});

	test("redacts a sensitive key nested inside err.cause", () => {
		const proc = createRedactProcessor({ keys: ["authorization"] });
		const result = proc.process(
			makeEvent({
				err: {
					name: "Bad Request",
					message: "auth failed",
					source: "auth",
					layer: "application",
					cause: { req: { headers: { authorization: "Bearer abc" } } },
				},
			}),
		);

		const cause = result?.err?.cause as Record<string, Record<string, unknown>>;
		expect(
			(cause.req as Record<string, Record<string, unknown>>).headers
				?.authorization,
		).toBe("[redacted]");
	});

	test("returns the event by identity when err holds nothing sensitive", () => {
		const proc = createRedactProcessor({ keys: ["password"] });
		const event = makeEvent({
			err: {
				name: "Bad Request",
				message: "auth failed",
				source: "auth",
				layer: "application",
				cause: { attempt: 3 },
			},
		});

		expect(proc.process(event)).toBe(event);
	});
});

describe("createRedactProcessor — a payload that fights back", () => {
	// Entering class instances put own enumerable accessors in reach, so the
	// masking pass degrades the record it could not read instead of throwing and
	// having the whole event discarded. Each record is guarded on its own, so
	// one hostile half never costs the other.
	function hostile(): Record<string, unknown> {
		const payload: Record<string, unknown> = {};
		Object.defineProperty(payload, "boom", {
			enumerable: true,
			get() {
				throw new Error("getter exploded");
			},
		});
		return payload;
	}

	const processor = createRedactProcessor({ keys: ["password"] });

	function event(overrides: Partial<ILogEvent> = {}): ILogEvent {
		return { level: "info", time: 1700000000000, bindings: {}, ...overrides };
	}

	test("a hostile meta is replaced, and the message survives", () => {
		const result = processor.process(
			event({ meta: hostile(), msg: "request" }),
		);

		expect(result?.msg).toBe("request");
		expect(result?.meta?.[CONVERSION_ERROR_KEY]).toContain("getter exploded");
	});

	test("a hostile bindings does not take meta with it", () => {
		const result = processor.process(
			event({ bindings: hostile(), meta: { password: "p", safe: "ok" } }),
		);

		expect(result?.bindings[CONVERSION_ERROR_KEY]).toContain("getter exploded");
		expect(result?.meta?.password).toBe("[redacted]");
		expect(result?.meta?.safe).toBe("ok");
	});

	test("a hostile err.cause drops the cause and keeps the diagnostic", () => {
		// `err`'s canonical fields are the whole point of logging an error. A
		// cause that cannot be walked is dropped; name, message and stack stay.
		const result = processor.process(
			event({
				err: {
					name: "Bad Request",
					message: "invalid cart",
					stack: "Bad Request: invalid cart\n    at …",
					source: "checkout",
					layer: "application",
					cause: hostile(),
				},
			}),
		);

		expect(result?.err?.name).toBe("Bad Request");
		expect(result?.err?.message).toBe("invalid cart");
		expect(result?.err?.stack).toContain("Bad Request");
		expect(result?.err?.cause).toBeUndefined();
	});
});
