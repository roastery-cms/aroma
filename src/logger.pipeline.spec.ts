import { describe, expect, test } from "bun:test";
import {
	PasswordVO,
	StringVO,
} from "@roastery/beans/domain/collections/value-objects";
import { Entity } from "@roastery/beans/domain/entity";
import type { EntityDefinition } from "@roastery/beans/domain/entity/types";
import { BadRequestException } from "@roastery/terroir/exceptions/application";
import { createAroma } from "@/create-aroma";
import type { AromaException } from "@/exceptions/aroma-exception";
import { ProcessorFailureException } from "@/exceptions/aroma-exception";
import { CONVERSION_ERROR_KEY } from "@/internal/conversion-failure";
import { isDiagnostic } from "@/internal/diagnostic";
import { serializeEvent } from "@/internal/serializer";
import { DIAGNOSTIC_WINDOW_MS, Logger } from "@/logger";
import { createEcsProcessor } from "@/processors/ecs-mapping";
import {
	createRedactProcessor,
	DEFAULT_REDACT_KEYS,
} from "@/processors/redact";
import { NullTransport } from "@/transports/null-transport";
import type { ILogEvent } from "@/types/log-event.interface";
import type { IProcessor } from "@/types/processor.interface";

/**
 * The pipeline half of the guarantee `CLAUDE.md` states for transports: a
 * failing processor must not reach the caller, must not forward a
 * half-processed event, and must not fail silently.
 */

const BOOM = new Error("processor exploded");

const PASSWORD = "Sup3rS3cret!";

const userProperties = { name: StringVO, password: PasswordVO };

class User extends Entity<typeof userProperties> {
	protected defineEntity(): EntityDefinition<typeof userProperties> {
		return { properties: userProperties, source: "user" };
	}
}

function makeUser(): User {
	return new User({ name: "alan", password: PASSWORD });
}

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

	test("the diagnostic line does not re-enter the processor that failed", () => {
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

	test("runs the diagnostic through the rest of the pipeline, so ECS stays ECS", () => {
		// Skipping the pipeline entirely used to mean one canonical ILogEvent
		// interleaved in a stream of ECS documents — the schema broke on
		// precisely the line reporting that something else had broken. Only the
		// culprit is removed now.
		const sink = new NullTransport();
		const log = new Logger({
			transports: [sink],
			processors: [throwing("boom"), createEcsProcessor()],
		});

		log.info({ a: 1 }, "hello");

		const [diagnostic] = sink.events as unknown as Record<string, unknown>[];
		expect(diagnostic?.["@timestamp"]).toBeDefined();
		expect(diagnostic?.log).toEqual({ level: "error" });
		expect(diagnostic?.message).toContain('processor "boom" failed');
	});

	test("falls back to the raw line when the rest of the pipeline also throws", () => {
		const sink = new NullTransport();
		const log = new Logger({
			transports: [sink],
			processors: [throwing("first"), throwing("second")],
		});

		log.info({ a: 1 }, "hello");

		// One line, and it is the unformatted diagnostic for the *first*
		// failure — never a recursion, never silence.
		expect(sink.events).toHaveLength(1);
		expect(sink.events[0]?.meta?.processor).toBe("first");
	});

	test("a processor returning null cannot silence the diagnostic", () => {
		const dropping: IProcessor = { name: "dropping", process: () => null };
		const sink = new NullTransport();
		const log = new Logger({
			transports: [sink],
			processors: [throwing("boom"), dropping],
		});

		log.info({ a: 1 }, "hello");

		expect(sink.events).toHaveLength(1);
		expect(sink.events[0]?.meta?.processor).toBe("boom");
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

describe("a processor that fails on every event", () => {
	// The guarantee is "never a silent drop", not "one error line per dropped
	// line". A broken processor on a hot path otherwise converts a stream of
	// info into a stream of error, one for one — burying the signal under
	// itself and paging someone about it.

	test("puts one diagnostic on the stream per window, not one per event", () => {
		const { sink, log } = build([throwing("flooder")]);

		for (let index = 0; index < 200; index++) {
			log.info({ index }, "hello");
		}

		expect(sink.events).toHaveLength(1);
	});

	test("still reports every failure to onError, which is the consumer's hook", () => {
		const errors: AromaException[] = [];
		const { log } = build([throwing("flooder")], (e) => errors.push(e));

		for (let index = 0; index < 5; index++) {
			log.info({ index }, "hello");
		}

		expect(errors).toHaveLength(5);
	});

	test("counts what it suppressed and carries it into the next window", async () => {
		const { sink, log } = build([throwing("flooder")]);

		log.info({ index: 0 }, "hello");
		for (let index = 1; index < 20; index++) {
			log.info({ index }, "hello");
		}

		expect(sink.events).toHaveLength(1);
		expect(sink.events[0]?.meta?.suppressed).toBeUndefined();

		await Bun.sleep(DIAGNOSTIC_WINDOW_MS + 50);
		log.info({ index: 20 }, "hello");

		expect(sink.events).toHaveLength(2);
		expect(sink.events[1]?.meta?.suppressed).toBe(19);
	});

	test("the window is per processor, and a child cannot reopen it", () => {
		// The counter lives in a WeakMap keyed by the processor, not on the
		// instance: `child()` shares the processor array by reference, so a
		// per-instance counter would give every request its own fresh flood.
		const { sink, log } = build([throwing("flooder")]);

		log.info("parent");
		for (let index = 0; index < 10; index++) {
			log.child({ requestId: String(index) }).info("child");
		}

		expect(sink.events).toHaveLength(1);
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

	function withRedact(sink: NullTransport) {
		return createAroma({
			transports: [sink],
			processors: [createRedactProcessor({ keys: [...DEFAULT_REDACT_KEYS] })],
		});
	}

	test("1 — a processor that throws does not reach the caller", () => {
		const { sink, log } = build([throwing("exploder")]);

		expect(() => log.info({ userId: 42 }, "hello")).not.toThrow();
		expect(sink.events).toHaveLength(1);
		expect(sink.events[0]?.level).toBe("error");
	});

	test("2 — authorization four levels down, once the redact processor is on", () => {
		const sink = new NullTransport();
		const log = withRedact(sink);

		log.info(
			{ ctx: { request: { headers: { authorization: SECRET } } } },
			"request",
		);

		expect(JSON.stringify(sink.events[0])).not.toContain(SECRET);
	});

	test("2b — and is NOT masked without it, which is the default since 0.1.0", () => {
		// The counterpart of 2, pinned deliberately rather than left as the
		// absence of a test. A Node request is not a domain object and never
		// will be, so nothing in the default pipeline claims to know that
		// `authorization` is a secret. Whoever logs one opts in.
		const sink = new NullTransport();
		const log = createAroma({ transports: [sink] });

		log.info(
			{ ctx: { request: { headers: { authorization: SECRET } } } },
			"request",
		);

		expect(JSON.stringify(sink.events[0])).toContain(SECRET);
	});

	test("3 — a plain err.cause holding a password, once the processor is on", () => {
		const sink = new NullTransport();
		const log = withRedact(sink);

		log.error(
			new BadRequestException("auth", "failed", {
				cause: { password: "hunter2" },
			}),
			"login failed",
		);

		expect(JSON.stringify(sink.events[0])).not.toContain("hunter2");
	});

	test("4 — a cycle in the payload neither hangs nor throws nor leaks", () => {
		// Reframed against the default pipeline: the sensitive value is inside a
		// domain object rather than under a key name, so the domain conversion
		// is what has to survive the cycle. It descends into plain literals now,
		// which is exactly what put it in reach of a back reference for the
		// first time.
		const sink = new NullTransport();
		const log = createAroma({ transports: [sink] });
		const cyclic: Record<string, unknown> = { user: makeUser() };
		cyclic.self = cyclic;

		expect(() => log.info({ cyclic }, "cyclic")).not.toThrow();

		const line = serializeEvent(sink.events[0] as ILogEvent);
		expect(line).not.toContain(PASSWORD);
		expect(line).toContain("[Circular]");
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

describe("the logger's own diagnostic line", () => {
	test("is marked, so a side-effecting processor can exclude it", () => {
		// Re-running the diagnostic through the pipeline is what keeps it in the
		// stream's format, and it also means every other processor sees it. A
		// metric counter that must not count the logger's own failure needs a way
		// to tell — this is it.
		const seen: boolean[] = [];
		const watcher: IProcessor = {
			name: "watcher",
			process(event) {
				seen.push(isDiagnostic(event));
				return event;
			},
		};
		const sink = new NullTransport();
		const log = new Logger({
			transports: [sink],
			processors: [throwing("boom"), watcher],
		});

		log.info({ a: 1 }, "hello");

		expect(seen).toEqual([true]);
	});

	test("an ordinary line is not marked", () => {
		const seen: boolean[] = [];
		const watcher: IProcessor = {
			name: "watcher",
			process(event) {
				seen.push(isDiagnostic(event));
				return event;
			},
		};
		const { log } = build([watcher]);

		log.info({ a: 1 }, "hello");

		expect(seen).toEqual([false]);
	});
});

describe("a processor failing for two different reasons", () => {
	test("both are reported, even inside the same window", () => {
		// The window used to be keyed on the processor alone, so a second and
		// completely different failure vanished into the first one's second —
		// counted, but never named.
		let reason = "reason-A";
		const flaky: IProcessor = {
			name: "flaky",
			process(): ILogEvent {
				throw new Error(reason);
			},
		};
		const { sink, log } = build([flaky]);

		log.info("1");
		reason = "reason-B";
		log.info("2");

		expect(sink.events.map((e) => e.meta?.reason)).toEqual([
			"reason-A",
			"reason-B",
		]);
	});

	test("a message that carries an id does not grow the map without bound", () => {
		// The message is arbitrary consumer text. Tracking every distinct one
		// would trade a log flood for a memory leak, so past the cap they share
		// a window — still rate limited, no longer distinguished.
		let order = 0;
		const flaky: IProcessor = {
			name: "flaky",
			process(): ILogEvent {
				throw new Error(`failed for order ${order}`);
			},
		};
		const { sink, log } = build([flaky]);

		for (order = 0; order < 200; order++) {
			log.info("x");
		}

		// Eight distinct messages get their own window, and everything past that
		// shares one — so the ceiling is nine lines for two hundred failures,
		// not two hundred.
		expect(sink.events.length).toBe(9);
		expect(sink.events[8]?.meta?.reason).toBe("failed for order 8");
	});
});

describe("reading the caller's payload never reaches the caller", () => {
	// The package guarantees that a transport cannot throw at the call site, and
	// that a processor cannot either. Both were guarantees about the *pipeline* —
	// and the event is built before the pipeline exists. A spread reads every own
	// enumerable property, so a payload with a hostile accessor took down the
	// `log.info()` that was describing it, with no processor to blame.
	function hostile(): Record<string, unknown> {
		const payload: Record<string, unknown> = { requestId: "abc" };
		Object.defineProperty(payload, "boom", {
			enumerable: true,
			get() {
				throw new Error("getter exploded");
			},
		});
		return payload;
	}

	test("a throwing getter at the top of meta does not reach the caller", () => {
		const { sink, log } = build([]);

		expect(() => log.info(hostile(), "request")).not.toThrow();
		expect(sink.events).toHaveLength(1);
		expect(sink.events[0]?.msg).toBe("request");
	});

	test("the line survives and says what went wrong", () => {
		const { sink, log } = build([]);

		log.info(hostile(), "request");

		expect(sink.events[0]?.meta?.[CONVERSION_ERROR_KEY]).toContain(
			"getter exploded",
		);
	});

	test("a Proxy whose ownKeys trap throws does not reach the caller either", () => {
		const trap = new Proxy(
			{},
			{
				ownKeys() {
					throw new Error("trap exploded");
				},
			},
		);
		const { sink, log } = build([]);

		expect(() => log.info({ trap }, "request")).not.toThrow();
		expect(sink.events).toHaveLength(1);
	});
});
