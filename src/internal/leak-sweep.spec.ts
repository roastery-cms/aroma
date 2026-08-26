import { describe, expect, test } from "bun:test";
import {
	PasswordVO,
	StringVO,
} from "@roastery/beans/domain/collections/value-objects";
import { Entity } from "@roastery/beans/domain/entity";
import type { EntityDefinition } from "@roastery/beans/domain/entity/types";
import { createAroma } from "@/create-aroma";
import { MAX_WALK_DEPTH } from "@/internal/safe-walk";
import { serializeEvent } from "@/internal/serializer";
import { Logger } from "@/logger";
import {
	createRedactProcessor,
	DEFAULT_REDACT_KEYS,
} from "@/processors/redact";
import { NullTransport } from "@/transports/null-transport";
import type { ILogger } from "@/types/logger.interface";
import type { IProcessor } from "@/types/processor.interface";

/**
 * The generative half of this package's leak testing.
 *
 * @remarks
 * Four rounds of hand-written adversarial probes found four ways for a
 * `sensitive` field to reach `JSON.stringify` unconverted, each one in code the
 * previous round had just fixed. A fifth round would have found a fifth. What
 * changes that argument is not another round: it is enumerating the space —
 * every container shape × every entry point into a log line — and sweeping it
 * on every run.
 *
 * Adding a shape here is how a new one gets an answer. If the walk cannot reach
 * inside it, this file says so immediately instead of an incident saying so
 * later.
 */

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

class Holder {
	public constructor(public readonly held: unknown) {}
}

class PrivateHolder {
	readonly #held: unknown;

	public constructor(held: unknown) {
		this.#held = held;
	}

	public toJSON(): unknown {
		return { held: this.#held };
	}
}

class SubArray extends Array<unknown> {}
class SubMap extends Map<string, unknown> {}

/**
 * Every way a payload can wrap a value. One entry per shape whose reachability
 * rules differ from the others — not per shape that merely looks different.
 */
const WRAPPERS: ReadonlyArray<readonly [string, (held: unknown) => unknown]> = [
	["plain literal", (held) => ({ held })],
	["array", (held) => [held]],
	["Map", (held) => new Map([["held", held]])],
	["Set", (held) => new Set([held])],
	["class instance", (held) => new Holder(held)],
	["class with #private + toJSON", (held) => new PrivateHolder(held)],
	["literal toJSON over a closure", (held) => ({ toJSON: () => ({ held }) })],
	[
		"literal toJSON over this",
		(held) => ({
			held,
			toJSON(this: { held: unknown }) {
				return { held: this.held };
			},
		}),
	],
	[
		"toJSON inherited from a prototype",
		(held) => Object.create({ toJSON: () => ({ held }) }),
	],
	[
		"own enumerable getter",
		(held) => ({
			get held() {
				return held;
			},
		}),
	],
	["null prototype", (held) => Object.assign(Object.create(null), { held })],
	["frozen literal", (held) => Object.freeze({ held })],
	["Proxy over a literal", (held) => new Proxy({ held }, {})],
	[
		"Array subclass",
		(held) => {
			const list = new SubArray();
			list.push(held);
			return list;
		},
	],
	[
		"Map subclass",
		(held) => {
			const map = new SubMap();
			map.set("held", held);
			return map;
		},
	],
	[
		"Error with an attached property",
		(held) => Object.assign(new Error("e"), { held }),
	],
	[
		"non-enumerable own property",
		(held) => {
			const box: Record<string, unknown> = {};
			Object.defineProperty(box, "held", { value: held, enumerable: false });
			return box;
		},
	],
	["symbol key", (held) => ({ [Symbol("held")]: held })],
	["array of two", (held) => [{ other: 1 }, held]],
	["Map with an object key", (held) => new Map([[{ k: 1 }, held]])],
];

/** Every way a value reaches a log line. */
const POSITIONS: ReadonlyArray<
	readonly [string, (log: ILogger, value: unknown) => void]
> = [
	["meta.key", (log, value) => log.info({ payload: value }, "line")],
	["meta root", (log, value) => log.info(value as never, "line")],
	[
		"child bindings",
		(log, value) => log.child(value as never).info({ n: 1 }, "line"),
	],
	[
		"err.cause",
		(log, value) => log.error(new Error("boom", { cause: value }), "line"),
	],
	[
		"meta.key inside an array",
		(log, value) => log.info({ list: [value] }, "line"),
	],
];

const PIPELINES: ReadonlyArray<readonly [string, ReadonlyArray<IProcessor>]> = [
	["domain only", []],
	[
		"domain + redact",
		[createRedactProcessor({ keys: [...DEFAULT_REDACT_KEYS] })],
	],
];

/**
 * Run one payload through a real logger and hand back the line a transport
 * would see. A throw is an answer too: reading the caller's payload must never
 * take down `log.info()`.
 */
function lineFor(
	processors: ReadonlyArray<IProcessor>,
	emit: (log: ILogger, value: unknown) => void,
	value: unknown,
): string {
	const transport = new NullTransport();
	const log = createAroma({
		transports: [transport],
		processors,
		acknowledgeNoMasking: true,
	});

	try {
		emit(log, value);
	} catch (reason) {
		return `THREW: ${String(reason)}`;
	}

	const event = transport.events[0];
	if (!event) {
		return "NO LINE";
	}

	return serializeEvent(event);
}

/** What a swept case is allowed to produce. Anything else is the failure. */
function verdict(line: string): string | undefined {
	if (line.startsWith("THREW")) return line;
	if (line === "NO LINE") return line;
	if (line.includes(PASSWORD)) return "LEAKED";
	return undefined;
}

describe("leak sweep", () => {
	for (const [pipelineName, processors] of PIPELINES) {
		describe(pipelineName, () => {
			test("no shape leaks from any position", () => {
				const failures: string[] = [];

				for (const [shapeName, wrap] of WRAPPERS) {
					for (const [positionName, emit] of POSITIONS) {
						const line = lineFor(processors, emit, wrap(makeUser()));
						const failure = verdict(line);
						if (failure) {
							failures.push(`${shapeName} @ ${positionName}: ${failure}`);
						}
					}
				}

				expect(failures).toEqual([]);
			});

			test("no pair of nested shapes leaks", () => {
				const failures: string[] = [];
				const [, emit] = POSITIONS[0] as (typeof POSITIONS)[number];

				for (const [outerName, outer] of WRAPPERS) {
					for (const [innerName, inner] of WRAPPERS) {
						const line = lineFor(processors, emit, outer(inner(makeUser())));
						const failure = verdict(line);
						if (failure) {
							failures.push(`${outerName} → ${innerName}: ${failure}`);
						}
					}
				}

				expect(failures).toEqual([]);
			});

			test("no depth leaks, and past the bound the walk substitutes a marker", () => {
				const failures: string[] = [];
				const [, emit] = POSITIONS[0] as (typeof POSITIONS)[number];

				for (let depth = 0; depth <= MAX_WALK_DEPTH + 4; depth++) {
					let payload: unknown = makeUser();
					for (let level = 0; level < depth; level++) {
						payload = { nested: payload };
					}

					const line = lineFor(processors, emit, payload);
					const failure = verdict(line);
					if (failure) {
						failures.push(`depth ${depth}: ${failure}`);
					}
				}

				expect(failures).toEqual([]);
			});
		});
	}

	test("positive control — the same payload leaks without the domain processor", () => {
		// A sweep that cannot fail proves nothing. Every spec in this package's
		// leak history was seen red before it was seen green; this is how the
		// sweep itself stays honest once every real case is green.
		const transport = new NullTransport();
		const bare = new Logger({ transports: [transport] });

		bare.info({ payload: { held: makeUser() } }, "line");

		expect(serializeEvent(transport.events[0] as never)).toContain(PASSWORD);
	});

	test("every shape is exercised by the sweep", () => {
		expect(new Set(WRAPPERS.map(([name]) => name)).size).toBe(WRAPPERS.length);
		expect(new Set(POSITIONS.map(([name]) => name)).size).toBe(
			POSITIONS.length,
		);
	});
});
