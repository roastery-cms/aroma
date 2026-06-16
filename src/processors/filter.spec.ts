import { describe, expect, test } from "bun:test";
import { createFilterProcessor } from "@/processors/filter";
import type { ILogEvent } from "@/types/log-event.interface";

function makeEvent(level: ILogEvent["level"]): ILogEvent {
	return { level, time: 1, bindings: {} };
}

describe("createFilterProcessor", () => {
	test("keeps event when predicate returns true", () => {
		const proc = createFilterProcessor((e) => e.level === "info");
		const event = makeEvent("info");
		expect(proc.process(event)).toBe(event);
	});

	test("drops event when predicate returns false", () => {
		const proc = createFilterProcessor(() => false);
		expect(proc.process(makeEvent("warn"))).toBeNull();
	});

	test("has name 'filter'", () => {
		expect(createFilterProcessor(() => true).name).toBe("filter");
	});
});
