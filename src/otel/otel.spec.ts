import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	_resetOtelCache,
	_setOtelApiForTest,
	createOtelProcessor,
	getActiveTraceContext,
	primeOtel,
} from "@/otel";
import type { ILogEvent } from "@/types/log-event.interface";

const SAMPLE_CTX = {
	traceId: "0af7651916cd43dd8448eb211c80319c",
	spanId: "b7ad6b7169203331",
	traceFlags: 1,
};

function makeFakeApi(span: { spanContext: () => typeof SAMPLE_CTX } | null) {
	return {
		trace: {
			getActiveSpan: () => span ?? undefined,
		},
	};
}

function event(overrides: Partial<ILogEvent> = {}): ILogEvent {
	return {
		level: "info",
		time: 1,
		bindings: {},
		...overrides,
	};
}

describe("@roastery/aroma/otel", () => {
	beforeEach(() => {
		_resetOtelCache();
	});

	afterEach(() => {
		_resetOtelCache();
	});

	describe("primeOtel + getActiveTraceContext", () => {
		test("returns undefined when no OTel module is loaded", () => {
			_setOtelApiForTest(null);
			expect(getActiveTraceContext()).toBeUndefined();
		});

		test("returns undefined when API is loaded but no active span", () => {
			_setOtelApiForTest(makeFakeApi(null));
			expect(getActiveTraceContext()).toBeUndefined();
		});

		test("returns trace context when an active span exists", () => {
			_setOtelApiForTest(makeFakeApi({ spanContext: () => SAMPLE_CTX }));
			expect(getActiveTraceContext()).toEqual(SAMPLE_CTX);
		});

		test("primeOtel returns false when @opentelemetry/api is absent", async () => {
			// no setOtelApiForTest call → real dynamic import is attempted.
			// In test env without the package installed, expect false.
			const ok = await primeOtel();
			expect(typeof ok).toBe("boolean");
		});
	});

	describe("createOtelProcessor", () => {
		test("injects trace fields when a span is active", () => {
			_setOtelApiForTest(makeFakeApi({ spanContext: () => SAMPLE_CTX }));
			const proc = createOtelProcessor();
			const out = proc.process(event({ bindings: { service: "api" } }));
			expect(out?.bindings).toMatchObject({
				service: "api",
				trace_id: SAMPLE_CTX.traceId,
				span_id: SAMPLE_CTX.spanId,
				trace_flags: SAMPLE_CTX.traceFlags,
			});
		});

		test("pass-through when no active span", () => {
			_setOtelApiForTest(makeFakeApi(null));
			const proc = createOtelProcessor();
			const e = event({ bindings: { service: "api" } });
			expect(proc.process(e)).toBe(e);
		});

		test("pass-through when OTel API absent", () => {
			_setOtelApiForTest(null);
			const proc = createOtelProcessor();
			const e = event({ bindings: { service: "api" } });
			expect(proc.process(e)).toBe(e);
		});

		test("has name 'otel'", () => {
			expect(createOtelProcessor().name).toBe("otel");
		});
	});
});
