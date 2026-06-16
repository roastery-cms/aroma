import { afterEach, describe, expect, test } from "bun:test";
import { createSampleProcessor } from "@/processors/sample";
import type { ILogEvent } from "@/types/log-event.interface";

function makeEvent(level: ILogEvent["level"]): ILogEvent {
	return { level, time: 1, bindings: {} };
}

const originalRandom = Math.random;

describe("createSampleProcessor", () => {
	afterEach(() => {
		Math.random = originalRandom;
	});

	test("levels absent from rates map are kept (no sampling)", () => {
		const proc = createSampleProcessor({ trace: 0 });
		const event = makeEvent("info");
		expect(proc.process(event)).toBe(event);
	});

	test("rate 0 always drops", () => {
		const proc = createSampleProcessor({ trace: 0 });
		expect(proc.process(makeEvent("trace"))).toBeNull();
	});

	test("rate >= 1 always keeps", () => {
		const proc = createSampleProcessor({ debug: 1 });
		const event = makeEvent("debug");
		expect(proc.process(event)).toBe(event);
	});

	test("rate 0.5 keeps when Math.random < 0.5", () => {
		Math.random = () => 0.4;
		const proc = createSampleProcessor({ trace: 0.5 });
		expect(proc.process(makeEvent("trace"))).not.toBeNull();
	});

	test("rate 0.5 drops when Math.random >= 0.5", () => {
		Math.random = () => 0.6;
		const proc = createSampleProcessor({ trace: 0.5 });
		expect(proc.process(makeEvent("trace"))).toBeNull();
	});

	test("has name 'sample'", () => {
		expect(createSampleProcessor({}).name).toBe("sample");
	});
});
