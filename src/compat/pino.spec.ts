import { describe, expect, test } from "bun:test";
import { createPinoCompatTransport } from "@/compat/pino";
import type { ILogEvent } from "@/types/log-event.interface";

function event(overrides: Partial<ILogEvent> = {}): ILogEvent {
	return {
		level: "info",
		time: 1700000000000,
		msg: "test",
		bindings: {},
		...overrides,
	};
}

describe("createPinoCompatTransport", () => {
	test("forwards a JSON line ending with \\n to the wrapped write", () => {
		const captured: string[] = [];
		const adapter = createPinoCompatTransport({
			write(chunk) {
				captured.push(chunk);
			},
		});

		adapter.write(event({ msg: "hello" }));

		expect(captured).toHaveLength(1);
		expect(captured[0]?.endsWith("\n")).toBe(true);
		const parsed = JSON.parse(captured[0] as string);
		expect(parsed.msg).toBe("hello");
	});

	test("propagates a Promise return from the wrapped write", async () => {
		const adapter = createPinoCompatTransport({
			async write() {},
		});
		const out = adapter.write(event());
		expect(out).toBeInstanceOf(Promise);
		await out;
	});

	test("flush() awaits async flush of the wrapped transport", async () => {
		let flushed = false;
		const adapter = createPinoCompatTransport({
			write() {},
			async flush() {
				flushed = true;
			},
		});

		await adapter.flush?.();
		expect(flushed).toBe(true);
	});

	test("flush() uses flushSync when only sync flush is available", async () => {
		let synced = false;
		const adapter = createPinoCompatTransport({
			write() {},
			flushSync() {
				synced = true;
			},
		});

		await adapter.flush?.();
		expect(synced).toBe(true);
	});

	test("close() calls end() when present", async () => {
		let ended = false;
		const adapter = createPinoCompatTransport({
			write() {},
			end() {
				ended = true;
			},
		});

		await adapter.close?.();
		expect(ended).toBe(true);
	});

	test("default name is 'pino-compat'", () => {
		const adapter = createPinoCompatTransport({ write() {} });
		expect(adapter.name).toBe("pino-compat");
	});

	test("name override is honored", () => {
		const adapter = createPinoCompatTransport(
			{ write() {} },
			{ name: "elastic" },
		);
		expect(adapter.name).toBe("elastic");
	});

	test("level option is exposed", () => {
		const adapter = createPinoCompatTransport(
			{ write() {} },
			{ level: "warn" },
		);
		expect(adapter.level).toBe("warn");
	});
});
