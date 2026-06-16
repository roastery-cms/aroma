/**
 * Snapshot of the OTel trace context active at the moment of capture.
 * Mirrors the W3C Trace Context fields that aggregators correlate logs
 * with traces by.
 *
 * @see {@link getActiveTraceContext}
 */
export type ActiveTraceContext = {
	traceId: string;
	spanId: string;
	traceFlags: number;
};

type OtelApi = {
	trace: {
		getActiveSpan():
			| undefined
			| {
					spanContext(): {
						traceId: string;
						spanId: string;
						traceFlags: number;
					};
			  };
	};
};

let cachedApi: OtelApi | null | undefined;

async function loadOtel(): Promise<OtelApi | null> {
	if (cachedApi !== undefined) return cachedApi;
	try {
		// @ts-expect-error — peer dependency optional; absence is part of the contract
		const mod = (await import("@opentelemetry/api")) as unknown as OtelApi;
		cachedApi = mod;
	} catch {
		cachedApi = null;
	}
	return cachedApi;
}

/**
 * Read the W3C trace context (`traceId` / `spanId` / `traceFlags`) of the
 * currently active OpenTelemetry span — if `@opentelemetry/api` is
 * installed and a span is active. Returns `undefined` when no OTel is in
 * the process or when no span is on the call stack.
 *
 * This is the sync version that consults a one-time cached module
 * reference. The first call to {@link primeOtel} eagerly resolves the
 * import so subsequent calls are fully synchronous and zero-cost when
 * OTel is absent.
 *
 * @returns trace context snapshot, or `undefined`.
 *
 * @example
 * ```ts
 * import { getActiveTraceContext, primeOtel } from "@roastery/aroma/otel";
 *
 * await primeOtel();                          // resolves lazy import
 * const ctx = getActiveTraceContext();
 * console.log(ctx?.traceId);                  // "abcd..." or undefined
 * ```
 *
 * @see {@link primeOtel}
 * @see {@link createOtelProcessor}
 */
export function getActiveTraceContext(): ActiveTraceContext | undefined {
	if (!cachedApi) return undefined;
	const span = cachedApi.trace.getActiveSpan();
	if (!span) return undefined;
	const ctx = span.spanContext();
	return {
		traceId: ctx.traceId,
		spanId: ctx.spanId,
		traceFlags: ctx.traceFlags,
	};
}

/**
 * Eagerly resolve the optional `@opentelemetry/api` peer dependency.
 * Call this once at boot if you intend to use OTel correlation. After
 * priming, `getActiveTraceContext()` is fully synchronous.
 *
 * Safe to call when OTel isn't installed — the function returns `false`
 * and subsequent `getActiveTraceContext()` calls return `undefined`.
 *
 * @returns `true` when the API was loaded, `false` otherwise.
 */
export async function primeOtel(): Promise<boolean> {
	const api = await loadOtel();
	return api !== null;
}

/**
 * Reset the cached module reference. Tests only.
 *
 * @internal
 */
export function _resetOtelCache(): void {
	cachedApi = undefined;
}

/**
 * Inject a pre-loaded API reference. Tests only.
 *
 * @internal
 */
export function _setOtelApiForTest(api: OtelApi | null): void {
	cachedApi = api;
}
