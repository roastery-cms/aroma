import { describe, expect, test } from "bun:test";
import { NullTransport } from "@/transports/null-transport";

describe("NullTransport", () => {
	test("captures events in arrival order", () => {
		const sink = new NullTransport();

		sink.write({ level: "info", time: 1, msg: "a", bindings: {} });
		sink.write({ level: "warn", time: 2, msg: "b", bindings: {} });

		expect(sink.events).toHaveLength(2);
		expect(sink.events[0]?.msg).toBe("a");
		expect(sink.events[1]?.msg).toBe("b");
	});

	test("clear() resets the buffer", () => {
		const sink = new NullTransport();
		sink.write({ level: "info", time: 1, msg: "a", bindings: {} });

		sink.clear();

		expect(sink.events).toHaveLength(0);
	});

	test("level option is exposed as readonly", () => {
		const sink = new NullTransport({ level: "warn" });
		expect(sink.level).toBe("warn");
	});

	test("default level is undefined", () => {
		const sink = new NullTransport();
		expect(sink.level).toBeUndefined();
	});

	test("name is 'null'", () => {
		const sink = new NullTransport();
		expect(sink.name).toBe("null");
	});
});
