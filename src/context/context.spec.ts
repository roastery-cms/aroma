import { describe, expect, test } from "bun:test";
import { getContext, runWithContext } from "@/context";
import { Logger } from "@/logger";
import { NullTransport } from "@/transports/null-transport";

describe("@roastery/aroma/context", () => {
	test("runWithContext propagates bindings to a logger inside it", () => {
		const sink = new NullTransport();
		const log = new Logger({ transports: [sink] });

		runWithContext({ requestId: "abc-123" }, () => {
			log.info("inside");
		});

		expect(sink.events[0]?.bindings).toMatchObject({ requestId: "abc-123" });
	});

	test("getContext returns undefined outside any run", () => {
		expect(getContext()).toBeUndefined();
	});

	test("getContext returns the active bindings inside a run", () => {
		runWithContext({ tenant: "acme" }, () => {
			expect(getContext()).toEqual({ tenant: "acme" });
		});
	});

	test("nested runWithContext merges parent + child", () => {
		const sink = new NullTransport();
		const log = new Logger({ transports: [sink] });

		runWithContext({ a: 1 }, () => {
			runWithContext({ b: 2 }, () => {
				log.info("nested");
			});
		});

		expect(sink.events[0]?.bindings).toMatchObject({ a: 1, b: 2 });
	});

	test("child overrides parent on key collision", () => {
		runWithContext({ key: "outer" }, () => {
			runWithContext({ key: "inner" }, () => {
				expect(getContext()?.key).toBe("inner");
			});
		});
	});

	test("ALS context overrides logger instance bindings on collision", () => {
		const sink = new NullTransport();
		const log = new Logger({
			transports: [sink],
			bindings: { source: "logger-instance" },
		});

		runWithContext({ source: "als-context" }, () => {
			log.info("merge-check");
		});

		// Request-scoped context wins over the logger's global bindings —
		// the narrower scope overrides the broader one.
		expect(sink.events[0]?.bindings).toMatchObject({
			source: "als-context",
		});
	});

	test("ALS context isolates across async chains", async () => {
		const sink = new NullTransport();
		const log = new Logger({ transports: [sink] });

		const chainA = new Promise<void>((resolve) =>
			setImmediate(() => {
				runWithContext({ chain: "A" }, () => {
					log.info("from-A");
					resolve();
				});
			}),
		);

		const chainB = new Promise<void>((resolve) =>
			setImmediate(() => {
				runWithContext({ chain: "B" }, () => {
					log.info("from-B");
					resolve();
				});
			}),
		);

		await Promise.all([chainA, chainB]);

		const fromA = sink.events.find((e) => e.msg === "from-A");
		const fromB = sink.events.find((e) => e.msg === "from-B");
		expect(fromA?.bindings).toMatchObject({ chain: "A" });
		expect(fromB?.bindings).toMatchObject({ chain: "B" });
	});

	test("await inside runWithContext preserves the context", async () => {
		const sink = new NullTransport();
		const log = new Logger({ transports: [sink] });

		await runWithContext({ traceId: "xyz" }, async () => {
			await new Promise((r) => setTimeout(r, 1));
			log.info("after-await");
		});

		expect(sink.events[0]?.bindings).toMatchObject({ traceId: "xyz" });
	});
});
