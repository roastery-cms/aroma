import { describe, expect, test } from "bun:test";
import { createEnrichProcessor } from "@/processors/enrich";
import type { ILogEvent } from "@/types/log-event.interface";

function makeEvent(bindings: ILogEvent["bindings"]): ILogEvent {
	return {
		level: "info",
		time: 1,
		bindings,
	};
}

describe("createEnrichProcessor", () => {
	test("merges fixed extras into bindings", () => {
		const proc = createEnrichProcessor({ service: "api", version: "1.0" });
		const result = proc.process(makeEvent({ requestId: "x" }));

		expect(result?.bindings).toEqual({
			service: "api",
			version: "1.0",
			requestId: "x",
		});
	});

	test("existing bindings override enrich defaults on key collision", () => {
		const proc = createEnrichProcessor({ service: "default" });
		const result = proc.process(makeEvent({ service: "specific" }));

		expect(result?.bindings).toEqual({ service: "specific" });
	});

	test("has name 'enrich'", () => {
		expect(createEnrichProcessor({}).name).toBe("enrich");
	});
});
