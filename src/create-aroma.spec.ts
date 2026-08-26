import { beforeEach, describe, expect, test } from "bun:test";
import {
	PasswordVO,
	StringVO,
} from "@roastery/beans/domain/collections/value-objects";
import { Entity } from "@roastery/beans/domain/entity";
import type { EntityDefinition } from "@roastery/beans/domain/entity/types";
import { createAroma } from "@/create-aroma";
import { AromaException } from "@/exceptions/aroma-exception";
import { isDiagnostic } from "@/internal/diagnostic";
import { _setMaskingWarningClaimed } from "@/internal/masks-keys";
import { MAX_CONFIGURABLE_DEPTH } from "@/internal/safe-walk";
import { Logger } from "@/logger";
import {
	createRedactProcessor,
	DEFAULT_REDACT_KEYS,
} from "@/processors/redact";
import { FastStdioTransport } from "@/transports/fast-stdio-transport";
import { NullTransport } from "@/transports/null-transport";
import type { ILogEvent } from "@/types/log-event.interface";
import type { IProcessor } from "@/types/processor.interface";
import type { ITransport } from "@/types/transport.interface";

const userProperties = { name: StringVO, password: PasswordVO };

class User extends Entity<typeof userProperties> {
	protected defineEntity(): EntityDefinition<typeof userProperties> {
		return { properties: userProperties, source: "user" };
	}
}

function makeUser(): User {
	return new User({ name: "alan", password: "Sup3rS3cret!" });
}

describe("createAroma", () => {
	test("returns a Logger instance", () => {
		const logger = createAroma();

		expect(logger).toBeInstanceOf(Logger);
	});

	test("uses FastStdioTransport by default", () => {
		const logger = createAroma() as Logger;
		const transports = (
			logger as unknown as { transports: ReadonlyArray<ITransport> }
		).transports;

		expect(transports).toHaveLength(1);
		expect(transports[0]).toBeInstanceOf(FastStdioTransport);
	});

	test("injects FastStdioTransport when transports array is empty", () => {
		const logger = createAroma({ transports: [] }) as Logger;
		const transports = (
			logger as unknown as { transports: ReadonlyArray<ITransport> }
		).transports;

		expect(transports).toHaveLength(1);
		expect(transports[0]).toBeInstanceOf(FastStdioTransport);
	});

	test("uses provided transports when given", () => {
		const sink = new NullTransport();

		const logger = createAroma({ transports: [sink] });
		logger.info("hi");

		expect(sink.events).toHaveLength(1);
	});

	test("passes level through to Logger", () => {
		const sink = new NullTransport();
		const logger = createAroma({ level: "warn", transports: [sink] });

		logger.info("ignored");
		logger.warn("kept");

		expect(sink.events).toHaveLength(1);
		expect(sink.events[0]?.level).toBe("warn");
	});

	test("does not mask by field name — that is opt-in since 0.1.0", () => {
		// Pinned positively, not by the absence of a deleted test. The domain
		// layer knows which of *its* fields are sensitive; a plain literal is
		// nobody's domain object and nothing here claims to guess.
		const sink = new NullTransport();
		const logger = createAroma({ transports: [sink] });

		logger.info(
			{ authorization: "Bearer x", token: "y", apiKey: "z", safe: "ok" },
			"sensitive",
		);

		expect(sink.events[0]?.meta).toEqual({
			authorization: "Bearer x",
			token: "y",
			apiKey: "z",
			safe: "ok",
		});
	});

	test("createRedactProcessor is the one line that restores the masking", () => {
		const sink = new NullTransport();
		const logger = createAroma({
			transports: [sink],
			processors: [createRedactProcessor({ keys: [...DEFAULT_REDACT_KEYS] })],
		});

		logger.info(
			{ authorization: "Bearer x", token: "y", apiKey: "z", safe: "ok" },
			"sensitive",
		);

		expect(sink.events[0]?.meta).toEqual({
			authorization: "[redacted]",
			token: "[redacted]",
			apiKey: "[redacted]",
			safe: "ok",
		});
	});

	test("user processors run after the auto-injected domain processor", () => {
		const sink = new NullTransport();
		const seen: unknown[] = [];
		const logger = createAroma({
			transports: [sink],
			processors: [
				{
					name: "capture",
					process: (e) => {
						seen.push(e.meta);
						return e;
					},
				},
			],
		});

		logger.info({ user: makeUser() }, "test");

		// capture sees the already-converted entity, never the live instance
		const meta = seen[0] as Record<string, Record<string, unknown>>;
		expect(meta.user).not.toBeInstanceOf(User);
		expect(meta.user?.password).toBe("[redacted]");
	});

	test("injects [domain] ahead of user processors", () => {
		const user: IProcessor = { name: "user", process: (e) => e };
		const logger = createAroma({ processors: [user] }) as Logger;
		const processors = (
			logger as unknown as { processors: ReadonlyArray<IProcessor> }
		).processors;

		expect(processors.map((p) => p.name)).toEqual(["domain", "user"]);
	});

	test("there is no switch to turn the domain processor off", () => {
		// `redact: false` used to remove both processors. Dropping domain safety
		// was never what a consumer asking for "no key masking" meant, so the
		// coupled switch is gone and the escape hatch is an explicit `new Logger`.
		const logger = createAroma({}) as Logger;
		const processors = (
			logger as unknown as { processors: ReadonlyArray<IProcessor> }
		).processors;

		expect(processors.map((p) => p.name)).toEqual(["domain"]);
	});

	test("passes onError through to Logger", () => {
		const errors: AromaException[] = [];
		const bad: ITransport = {
			name: "bad",
			write() {
				throw new Error("down");
			},
		};
		const logger = createAroma({
			transports: [bad],
			onError: (err) => errors.push(err),
		});

		logger.info("hi");

		expect(errors).toHaveLength(1);
		expect(errors[0]?.cause).toBeInstanceOf(Error);
	});
});

describe("createAroma — the opt-in redact processor", () => {
	function withRedact(options: Parameters<typeof createRedactProcessor>[0]) {
		const sink = new NullTransport();
		const logger = createAroma({
			transports: [sink],
			processors: [createRedactProcessor(options)],
		});
		return { sink, logger };
	}

	test("masks a nested key at the shared default depth", () => {
		const { sink, logger } = withRedact({ keys: [...DEFAULT_REDACT_KEYS] });

		logger.info({ req: { headers: { authorization: "Bearer x" } } }, "req");

		expect(JSON.stringify(sink.events[0])).not.toContain("Bearer x");
	});

	test("maxDepth: 1 restricts masking to the top level", () => {
		const { sink, logger } = withRedact({
			keys: [...DEFAULT_REDACT_KEYS],
			maxDepth: 1,
		});

		logger.info({ req: { headers: { authorization: "Bearer x" } } }, "req");

		expect(JSON.stringify(sink.events[0])).toContain("Bearer x");
	});

	test("keys are whatever you pass — the defaults are a starting list", () => {
		const { sink, logger } = withRedact({
			keys: [...DEFAULT_REDACT_KEYS, "customSecret"],
		});

		logger.info({ nested: { customSecret: "s", password: "p" } }, "both");

		const nested = sink.events[0]?.meta?.nested as Record<string, unknown>;
		expect(nested.customSecret).toBe("[redacted]");
		expect(nested.password).toBe("[redacted]");
	});
});

describe("createAroma — the missing-masking warning", () => {
	// The removal of the `redact` option is a compile error for anyone who
	// configured redaction, and nothing at all for anyone who relied on the
	// default. This warning is the only thing that reaches the second group.
	function capture(run: () => void): string[] {
		const lines: string[] = [];
		const original = console.warn;
		console.warn = (message: unknown) => {
			lines.push(String(message));
		};
		try {
			run();
		} finally {
			console.warn = original;
		}
		return lines;
	}

	beforeEach(() => {
		_setMaskingWarningClaimed(false);
	});

	test("warns when the pipeline has no key-name masking", () => {
		const lines = capture(() => {
			createAroma({ transports: [new NullTransport()] });
		});

		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("does not mask fields by name");
		expect(lines[0]).toContain("createRedactProcessor");
	});

	test("warns once per process, not once per logger", () => {
		const lines = capture(() => {
			createAroma({ transports: [new NullTransport()] });
			createAroma({ transports: [new NullTransport()] });
			createAroma({ transports: [new NullTransport()] });
		});

		expect(lines).toHaveLength(1);
	});

	test("stays quiet when a redact processor is in the pipeline", () => {
		const lines = capture(() => {
			createAroma({
				transports: [new NullTransport()],
				processors: [createRedactProcessor({ keys: [...DEFAULT_REDACT_KEYS] })],
			});
		});

		expect(lines).toEqual([]);
	});

	test("stays quiet when the choice is acknowledged", () => {
		const lines = capture(() => {
			createAroma({
				transports: [new NullTransport()],
				acknowledgeNoMasking: true,
			});
		});

		expect(lines).toEqual([]);
	});

	test("also puts the warning on the log stream, where it is collected", () => {
		// stderr is the channel that works when the logger is not up; the log
		// stream is the one an operator actually reads. A containerised service
		// that discards stderr would never have seen this.
		const sink = new NullTransport();

		capture(() => {
			createAroma({ transports: [sink] });
		});

		expect(sink.events).toHaveLength(1);
		expect(sink.events[0]?.level).toBe("warn");
		expect(sink.events[0]?.msg).toBe(
			"this logger does not mask fields by name",
		);
		expect(isDiagnostic(sink.events[0] as ILogEvent)).toBe(true);
	});

	test("the stream half is once per process too", () => {
		const first = new NullTransport();
		const second = new NullTransport();

		capture(() => {
			createAroma({ transports: [first] });
			createAroma({ transports: [second] });
		});

		expect(first.events).toHaveLength(1);
		expect(second.events).toEqual([]);
	});

	test("acknowledging silences both channels", () => {
		const sink = new NullTransport();

		const lines = capture(() => {
			createAroma({ transports: [sink], acknowledgeNoMasking: true });
		});

		expect(lines).toEqual([]);
		expect(sink.events).toEqual([]);
	});

	test("a logger above warn keeps the stderr half and drops the stream half", () => {
		const sink = new NullTransport();

		const lines = capture(() => {
			createAroma({ transports: [sink], level: "error" });
		});

		expect(lines).toHaveLength(1);
		expect(sink.events).toEqual([]);
	});

	test("the stream half goes through the pipeline, so it keeps the stream's format", () => {
		// Running it through the processors is what stops one canonical
		// `ILogEvent` landing in the middle of a run of reshaped documents.
		const sink = new NullTransport();
		const seen: string[] = [];

		capture(() => {
			createAroma({
				transports: [sink],
				processors: [
					{
						name: "capture",
						process(event) {
							seen.push(event.msg ?? "");
							return event;
						},
					},
				],
			});
		});

		expect(seen).toEqual(["this logger does not mask fields by name"]);
	});

	test("detects masking by brand, not by the processor's name", () => {
		// `name` is a free-form diagnostic label; a consumer may rename it or
		// reuse it. Whether someone is told their secrets are in the clear must
		// not hinge on a string match.
		const impostor: IProcessor = { name: "redact", process: (e) => e };

		const lines = capture(() => {
			createAroma({
				transports: [new NullTransport()],
				processors: [impostor],
			});
		});

		expect(lines).toHaveLength(1);
	});
});

describe("createAroma — maxDepth", () => {
	function deep(levels: number, leaf: unknown): unknown {
		let node = leaf;
		for (let level = 0; level < levels; level++) {
			node = { nested: node };
		}
		return node;
	}

	test("defaults to a bound past any realistic payload", () => {
		const sink = new NullTransport();
		const logger = createAroma({
			transports: [sink],
			acknowledgeNoMasking: true,
		});

		logger.info({ root: deep(12, makeUser()) }, "deep");

		const line = JSON.stringify(sink.events[0]);
		expect(line).not.toContain("Sup3rS3cret!");
		expect(line).not.toContain("[truncated: depth]");
	});

	test("lowering it truncates rather than letting the subtree through", () => {
		// The whole point of the guard: below the bound the walk has not
		// converted anything, so handing the subtree back would leak.
		const sink = new NullTransport();
		const logger = createAroma({
			transports: [sink],
			acknowledgeNoMasking: true,
			maxDepth: 2,
		});

		logger.info({ root: deep(4, makeUser()) }, "deep");

		const line = JSON.stringify(sink.events[0]);
		expect(line).not.toContain("Sup3rS3cret!");
		expect(line).toContain("[truncated: depth]");
	});

	test("the bound governs err.cause too, which the processor never sees", () => {
		const sink = new NullTransport();
		const logger = createAroma({
			transports: [sink],
			acknowledgeNoMasking: true,
			maxDepth: 2,
		});

		logger.error(new Error("boom", { cause: deep(4, makeUser()) }), "failed");

		expect(JSON.stringify(sink.events[0])).not.toContain("Sup3rS3cret!");
	});

	test("a child inherits the bound", () => {
		const sink = new NullTransport();
		const logger = createAroma({
			transports: [sink],
			acknowledgeNoMasking: true,
			maxDepth: 2,
		}).child({ requestId: "abc" });

		logger.info({ root: deep(4, makeUser()) }, "deep");

		expect(JSON.stringify(sink.events[0])).toContain("[truncated: depth]");
	});

	test.each([0, -1, 1.5, MAX_CONFIGURABLE_DEPTH + 1, Number.NaN])(
		"rejects %p at construction rather than clamping it",
		(bad) => {
			// Clamping would leave someone believing they have a depth they do
			// not have. Construction is the right place to be loud: it is not the
			// `log.info()` path the never-throw guarantee is about.
			expect(() =>
				createAroma({
					transports: [new NullTransport()],
					acknowledgeNoMasking: true,
					maxDepth: bad,
				}),
			).toThrow(AromaException);
		},
	);

	test("accepts the boundaries", () => {
		for (const good of [1, MAX_CONFIGURABLE_DEPTH]) {
			expect(() =>
				createAroma({
					transports: [new NullTransport()],
					acknowledgeNoMasking: true,
					maxDepth: good,
				}),
			).not.toThrow();
		}
	});
});
