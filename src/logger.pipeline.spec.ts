import { describe, expect, test } from "bun:test";
import { BadRequestException } from "@roastery/terroir/exceptions/application";
import { createAroma } from "@/create-aroma";
import type { AromaException } from "@/exceptions/aroma-exception";
import { ProcessorFailureException } from "@/exceptions/aroma-exception";
import { serializeEvent } from "@/internal/serializer";
import { Logger } from "@/logger";
import { NullTransport } from "@/transports/null-transport";
import type { ILogEvent } from "@/types/log-event.interface";
import type { IProcessor } from "@/types/processor.interface";

/**
 * The pipeline half of the guarantee `CLAUDE.md` states for transports: a
 * failing processor must not reach the caller, must not forward a
 * half-processed event, and must not fail silently.
 */

const BOOM = new Error("processor exploded");

function throwing(name: string): IProcessor {
	return {
		name,
		process(): ILogEvent {
			throw BOOM;
		},
	};
}

function passing(name: string): IProcessor {
	return { name, process: (event) => event };
}

function build(
	processors: IProcessor[],
	onError?: (e: AromaException) => void,
) {
	const sink = new NullTransport();
	return {
		sink,
		log: new Logger({ transports: [sink], processors, onError }),
	};
}

describe("a processor that throws", () => {
	test("never reaches the caller — first, middle or last in the pipeline", () => {
		const positions: IProcessor[][] = [
			[throwing("first"), passing("b"), passing("c")],
			[passing("a"), throwing("middle"), passing("c")],
			[passing("a"), passing("b"), throwing("last")],
		];

		for (const processors of positions) {
			const { log } = build(processors);
			expect(() => log.info({ userId: 42 }, "hello")).not.toThrow();
		}
	});

	test("reports a ProcessorFailureException carrying the name and the cause", () => {
		const errors: AromaException[] = [];
		const { log } = build([throwing("redact")], (error) => errors.push(error));

		log.info({ userId: 42 }, "hello");

		const [failure] = errors;
		expect(failure).toBeInstanceOf(ProcessorFailureException);
		expect((failure as ProcessorFailureException).processorName).toBe("redact");
		expect(failure?.cause).toBe(BOOM);
		expect(failure?.message).toContain("redact");
	});

	test("falls back to <unnamed> for a processor with no name", () => {
		const errors: AromaException[] = [];
		const { log } = build(
			[
				{
					process: (): ILogEvent => {
						throw BOOM;
					},
				},
			],
			(error) => errors.push(error),
		);

		log.info("hello");

		expect((errors[0] as ProcessorFailureException).processorName).toBe(
			"<unnamed>",
		);
	});

	test("discards the event — the payload never reaches a transport", () => {
		const { sink, log } = build([throwing("redact")]);

		log.info({ password: "Sup3rS3cret!", userId: 42 }, "sensitive payload");

		// Exactly one line, and it is the diagnostic — not the original event.
		expect(sink.events).toHaveLength(1);
		const [diagnostic] = sink.events as ILogEvent[];
		expect(diagnostic?.msg).not.toBe("sensitive payload");
		expect(JSON.stringify(diagnostic)).not.toContain("Sup3rS3cret!");
	});

	test("the diagnostic line names the processor and carries no payload", () => {
		const { sink, log } = build([throwing("domain")]);

		log.info({ password: "Sup3rS3cret!" }, "sensitive payload");

		const [diagnostic] = sink.events as ILogEvent[];
		expect(diagnostic?.level).toBe("error");
		expect(diagnostic?.meta?.processor).toBe("domain");
		expect(diagnostic?.meta?.reason).toBe("processor exploded");
		expect(diagnostic?.bindings).toEqual({});
	});

	test("the diagnostic line does not re-enter the pipeline", () => {
		// Otherwise the processor that just threw would take down the report of
		// its own failure, and the loop would be the only thing left running.
		let calls = 0;
		const counting: IProcessor = {
			name: "counting",
			process(): ILogEvent {
				calls++;
				throw BOOM;
			},
		};
		const { sink, log } = build([counting]);

		log.info("hello");

		expect(calls).toBe(1);
		expect(sink.events).toHaveLength(1);
	});

	test("does not carry the logger's bindings into the diagnostic", () => {
		const sink = new NullTransport();
		const log = new Logger({
			transports: [sink],
			bindings: { service: "checkout", apiKey: "unredacted-here" },
			processors: [throwing("redact")],
		});

		log.info("hello");

		expect(JSON.stringify(sink.events[0])).not.toContain("unredacted-here");
	});

	test("survives a missing onError", () => {
		const { sink, log } = build([throwing("redact")]);

		expect(() => log.info("hello")).not.toThrow();
		expect(sink.events).toHaveLength(1);
	});

	test("survives an onError that throws in turn", () => {
		const { sink, log } = build([throwing("redact")], () => {
			throw new Error("onError exploded");
		});

		expect(() => log.info("hello")).not.toThrow();
		// …and the diagnostic still goes out.
		expect(sink.events).toHaveLength(1);
	});

	test("a processor returning null still drops the event silently", () => {
		// Unchanged behaviour: `null` is a deliberate drop, not a failure, so it
		// produces no diagnostic and no onError.
		const errors: AromaException[] = [];
		const { sink, log } = build(
			[{ name: "filter", process: () => null }],
			(error) => errors.push(error),
		);

		log.info("hello");

		expect(sink.events).toHaveLength(0);
		expect(errors).toHaveLength(0);
	});
});

describe("the transport level gate, resolved before the pipeline", () => {
	function counting(): IProcessor & { calls: number } {
		const processor = {
			name: "counting",
			calls: 0,
			process(event: ILogEvent): ILogEvent {
				processor.calls++;
				return event;
			},
		};
		return processor;
	}

	test("skips the pipeline when no transport accepts the level", () => {
		const processor = counting();
		const sink = new NullTransport();
		Object.defineProperty(sink, "level", { value: "error" });

		const log = new Logger({
			level: "trace",
			transports: [sink],
			processors: [processor],
		});

		log.debug({ userId: 42 }, "nobody is listening");

		expect(processor.calls).toBe(0);
		expect(sink.events).toHaveLength(0);
	});

	test("still runs the pipeline when one transport would accept", () => {
		const processor = counting();
		const quiet = new NullTransport();
		Object.defineProperty(quiet, "level", { value: "error" });
		const loud = new NullTransport();
		Object.defineProperty(loud, "level", { value: "debug" });

		const log = new Logger({
			level: "trace",
			transports: [quiet, loud],
			processors: [processor],
		});

		log.debug({ userId: 42 }, "someone is listening");

		expect(processor.calls).toBe(1);
		expect(quiet.events).toHaveLength(0);
		expect(loud.events).toHaveLength(1);
	});

	test("a transport without its own level disables the shortcut", () => {
		const processor = counting();
		const sink = new NullTransport();

		const log = new Logger({
			level: "trace",
			transports: [sink],
			processors: [processor],
		});

		log.trace("anything goes");

		expect(processor.calls).toBe(1);
	});

	test("no transports at all means nothing to receive, so no work is done", () => {
		const processor = counting();
		const log = new Logger({ level: "trace", processors: [processor] });

		log.info({ userId: 42 }, "into the void");

		expect(processor.calls).toBe(0);
	});
});

describe("the five ways to break the pipeline", () => {
	// The adversarial check for this plan, against the pipeline rather than the
	// payload: none of these may crash the process, leak a value, hang, or do
	// work nobody asked for.
	const SECRET = "Bearer super-secret";

	test("1 — a processor that throws does not reach the caller", () => {
		const { sink, log } = build([throwing("exploder")]);

		expect(() => log.info({ userId: 42 }, "hello")).not.toThrow();
		expect(sink.events).toHaveLength(1);
		expect(sink.events[0]?.level).toBe("error");
	});

	test("2 — authorization four levels down is redacted", () => {
		const sink = new NullTransport();
		const log = createAroma({ transports: [sink] });

		log.info(
			{ ctx: { request: { headers: { authorization: SECRET } } } },
			"request",
		);

		expect(JSON.stringify(sink.events[0])).not.toContain(SECRET);
	});

	test("3 — a plain err.cause holding a password is redacted", () => {
		const sink = new NullTransport();
		const log = createAroma({ transports: [sink] });

		log.error(
			new BadRequestException("auth", "failed", {
				cause: { password: "hunter2" },
			}),
			"login failed",
		);

		expect(JSON.stringify(sink.events[0])).not.toContain("hunter2");
	});

	test("4 — a cycle in the payload neither hangs nor throws", () => {
		const sink = new NullTransport();
		const log = createAroma({ transports: [sink] });
		const cyclic: Record<string, unknown> = { password: "hunter2" };
		cyclic.self = cyclic;

		expect(() => log.info({ cyclic }, "cyclic")).not.toThrow();
		expect(serializeEvent(sink.events[0] as ILogEvent)).not.toContain(
			"hunter2",
		);
	});

	test("5 — a debug nobody accepts costs no pipeline work", () => {
		let calls = 0;
		const sink = new NullTransport();
		Object.defineProperty(sink, "level", { value: "error" });

		const log = createAroma({
			level: "trace",
			transports: [sink],
			processors: [
				{
					name: "counting",
					process: (event) => {
						calls++;
						return event;
					},
				},
			],
		});

		log.debug({ heavy: { nested: { payload: true } } }, "nobody listening");

		expect(calls).toBe(0);
		expect(sink.events).toHaveLength(0);
	});
});
