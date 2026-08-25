import { describe, expect, test } from "bun:test";
import { CoreException } from "@roastery/terroir/exceptions/core";
import { InfraException } from "@roastery/terroir/exceptions/models";
import { Layer } from "@roastery/terroir/symbols";
import {
	AromaException,
	BackpressureDropException,
} from "@/exceptions/aroma-exception";

describe("AromaException", () => {
	test("is an instance of Error, CoreException and InfraException", () => {
		const err = new AromaException("boom");

		expect(err).toBeInstanceOf(Error);
		expect(err).toBeInstanceOf(CoreException);
		expect(err).toBeInstanceOf(InfraException);
	});

	test("name is 'Aroma Exception'", () => {
		const err = new AromaException("boom");
		expect(err.name).toBe("Aroma Exception");
	});

	test("source defaults to '@roastery/aroma'", () => {
		const err = new AromaException("boom");
		expect(err.source).toBe("@roastery/aroma");
	});

	test("source can be overridden via options", () => {
		const err = new AromaException("boom", { source: "custom-source" });
		expect(err.source).toBe("custom-source");
	});

	test("[Layer] is 'infra'", () => {
		const err = new AromaException("boom");
		expect((err as unknown as Record<symbol, unknown>)[Layer]).toBe("infra");
	});

	test("message is preserved", () => {
		const err = new AromaException("transport failed");
		expect(err.message).toBe("transport failed");
	});

	test("cause is preserved when provided", () => {
		const original = new Error("network down");
		const err = new AromaException("transport failed", { cause: original });
		expect(err.cause).toBe(original);
	});

	test("cause stays undefined when not provided", () => {
		const err = new AromaException("boom");
		expect(err.cause).toBeUndefined();
	});
});

describe("BackpressureDropException", () => {
	test("is an AromaException", () => {
		const err = new BackpressureDropException("dropped 5", { dropCount: 5 });

		expect(err).toBeInstanceOf(AromaException);
		expect(err).toBeInstanceOf(InfraException);
	});

	test("name is 'Backpressure Drop Exception'", () => {
		const err = new BackpressureDropException("x", { dropCount: 1 });
		expect(err.name).toBe("Backpressure Drop Exception");
	});

	test("dropCount is preserved", () => {
		const err = new BackpressureDropException("dropped 42", { dropCount: 42 });
		expect(err.dropCount).toBe(42);
	});

	test("inherits source default", () => {
		const err = new BackpressureDropException("x", { dropCount: 1 });
		expect(err.source).toBe("@roastery/aroma");
	});

	test("source can be overridden", () => {
		const err = new BackpressureDropException("x", {
			dropCount: 1,
			source: "fast-stdio",
		});
		expect(err.source).toBe("fast-stdio");
	});
});
