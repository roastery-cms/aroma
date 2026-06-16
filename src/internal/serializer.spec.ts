import { describe, expect, test } from "bun:test";
import { serializeEvent } from "@/internal/serializer";
import type { ILogEvent } from "@/types/log-event.interface";

function ev(overrides: Partial<ILogEvent> = {}): ILogEvent {
	return {
		level: "info",
		time: 1700000000000,
		bindings: {},
		...overrides,
	};
}

describe("serializeEvent", () => {
	test("emits canonical JSON for minimum event", () => {
		const json = serializeEvent(ev());
		const parsed = JSON.parse(json);
		expect(parsed).toEqual({
			level: "info",
			time: 1700000000000,
			bindings: {},
		});
	});

	test("includes msg when present", () => {
		const parsed = JSON.parse(serializeEvent(ev({ msg: "hello" })));
		expect(parsed.msg).toBe("hello");
	});

	test("omits msg key when absent", () => {
		const parsed = JSON.parse(serializeEvent(ev()));
		expect(parsed).not.toHaveProperty("msg");
	});

	test("escapes special characters in msg", () => {
		const parsed = JSON.parse(
			serializeEvent(ev({ msg: 'has "quotes" and\nnewline' })),
		);
		expect(parsed.msg).toBe('has "quotes" and\nnewline');
	});

	test("includes meta when present", () => {
		const parsed = JSON.parse(serializeEvent(ev({ meta: { userId: 42 } })));
		expect(parsed.meta).toEqual({ userId: 42 });
	});

	test("includes err when present", () => {
		const parsed = JSON.parse(
			serializeEvent(
				ev({
					err: {
						name: "Error",
						message: "boom",
						stack: "at line",
						source: "$internal",
						layer: "internal",
					},
				}),
			),
		);
		expect(parsed.err.name).toBe("Error");
		expect(parsed.err.message).toBe("boom");
	});

	test("uses {} literal for empty bindings/meta (fast path)", () => {
		const json = serializeEvent(ev({ meta: {} }));
		expect(json).toContain('"bindings":{}');
		expect(json).toContain('"meta":{}');
	});

	test("falls back to safeStringify on cycles", () => {
		const circular: Record<string, unknown> = { name: "loop" };
		circular.self = circular;

		const json = serializeEvent(ev({ bindings: circular }));
		expect(json).toContain('"[Circular]"');
		// Parses round-trip
		expect(() => JSON.parse(json)).not.toThrow();
	});

	test("coerces BigInt values to string instead of dropping the event", () => {
		const json = serializeEvent(ev({ meta: { count: 10n } }));
		// Must not throw and must preserve the value as its decimal string.
		const parsed = JSON.parse(json);
		expect(parsed.meta).toEqual({ count: "10" });
	});
});
