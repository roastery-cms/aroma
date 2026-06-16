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

		expect(result?.bindings).toEqual({ user: "alan", password: "[REDACTED]" });
	});

	test("masks listed keys in meta", () => {
		const proc = createRedactProcessor({ keys: ["token"] });
		const result = proc.process(
			makeEvent({ bindings: {}, meta: { token: "abc", other: "ok" } }),
		);

		expect(result?.meta).toEqual({ token: "[REDACTED]", other: "ok" });
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
