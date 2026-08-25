import { describe, expect, test } from "bun:test";
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
