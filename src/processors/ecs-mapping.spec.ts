import { describe, expect, test } from "bun:test";
import { serializeEvent } from "@/internal/serializer";
import { Logger } from "@/logger";
import { createEcsProcessor } from "@/processors/ecs-mapping";
import { NullTransport } from "@/transports/null-transport";
import type { ILogEvent } from "@/types/log-event.interface";

const proc = createEcsProcessor();

function event(overrides: Partial<ILogEvent> = {}): ILogEvent {
	return {
		level: "info",
		time: 1700000000000,
		bindings: {},
		...overrides,
	};
}

describe("createEcsProcessor", () => {
	test("level maps to log.level", () => {
		const out = proc.process(event({ level: "warn" })) as unknown as {
			log: { level: string };
		};
		expect(out.log.level).toBe("warn");
	});

	test("time maps to ISO 8601 @timestamp", () => {
		const out = proc.process(
			event({ time: 1700000000000 }),
		) as unknown as Record<string, string>;
		expect(out["@timestamp"]).toBe(new Date(1700000000000).toISOString());
	});

	test("msg maps to message when present", () => {
		const out = proc.process(event({ msg: "hello" })) as unknown as Record<
			string,
			string
		>;
		expect(out.message).toBe("hello");
	});

	test("msg-less events do not emit message field", () => {
		const out = proc.process(event()) as unknown as Record<string, unknown>;
		expect(out.message).toBeUndefined();
	});

	test("err maps to ECS error block", () => {
		const out = proc.process(
			event({
				err: {
					name: "TypeError",
					message: "boom",
					stack: "stack-line\n…",
					source: "$internal",
					layer: "internal",
				},
			}),
		) as unknown as {
			error: { type: string; message: string; stack_trace?: string };
		};
		expect(out.error.type).toBe("TypeError");
		expect(out.error.message).toBe("boom");
		expect(out.error.stack_trace).toBe("stack-line\n…");
	});

	test("bindings and meta spread at root", () => {
		const out = proc.process(
			event({
				bindings: { service: "api" },
				meta: { userId: 42 },
			}),
		) as unknown as Record<string, unknown>;
		expect(out.service).toBe("api");
		expect(out.userId).toBe(42);
	});

	test("preserves canonical level/time for downstream transports", () => {
		const out = proc.process(
			event({ level: "info", time: 99 }),
		) as unknown as Record<string, unknown>;
		expect(out.level).toBe("info");
		expect(out.time).toBe(99);
	});

	test("has name 'ecs'", () => {
		expect(proc.name).toBe("ecs");
	});

	test("ECS fields survive serializeEvent (the real transport write path)", () => {
		const out = proc.process(
			event({
				bindings: { service: "api" },
				meta: { userId: 42 },
				msg: "hi",
			}),
		);

		const parsed = JSON.parse(serializeEvent(out as ILogEvent));

		expect(parsed["@timestamp"]).toBe(new Date(1700000000000).toISOString());
		expect(parsed.log.level).toBe("info");
		expect(parsed.message).toBe("hi");
		expect(parsed.service).toBe("api");
		expect(parsed.userId).toBe(42);
		// Canonical-only fields must NOT leak into the ECS document.
		expect(parsed.level).toBeUndefined();
		expect(parsed.time).toBeUndefined();
		expect(parsed.bindings).toBeUndefined();
	});

	test("err round-trips into the ECS error block through serializeEvent", () => {
		const out = proc.process(
			event({
				msg: "boom",
				err: {
					name: "TypeError",
					message: "bad",
					stack: "at x",
					source: "$internal",
					layer: "internal",
				},
			}),
		);

		const parsed = JSON.parse(serializeEvent(out as ILogEvent));

		expect(parsed.error.type).toBe("TypeError");
		expect(parsed.error.message).toBe("bad");
		expect(parsed.error.stack_trace).toBe("at x");
		expect(parsed.err).toBeUndefined();
	});

	test("level stays readable for transport routing after reshaping", () => {
		const sink = new NullTransport();
		const log = new Logger({
			level: "info",
			transports: [sink],
			processors: [createEcsProcessor()],
		});

		log.error({ code: "E1" }, "down");

		const ev = sink.events[0];
		// FastStdio/Console route on event.level — it must remain accessible
		// even though it is absent from the serialised ECS line.
		expect(ev?.level).toBe("error");
		const parsed = JSON.parse(serializeEvent(ev as ILogEvent));
		expect(parsed.log.level).toBe("error");
		expect(parsed.code).toBe("E1");
		expect(parsed.level).toBeUndefined();
	});
});
