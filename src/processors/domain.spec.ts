import { describe, expect, test } from "bun:test";
import {
	PasswordVO,
	StringVO,
} from "@roastery/beans/domain/collections/value-objects";
import { DomainEvent } from "@roastery/beans/domain/domain-event";
import { Entity } from "@roastery/beans/domain/entity";
import type { EntityDefinition } from "@roastery/beans/domain/entity/types";
import { BadRequestException } from "@roastery/terroir/exceptions/application";
import { createAroma } from "@/create-aroma";
import { CONVERSION_ERROR_KEY } from "@/internal/conversion-failure";
import {
	MAX_WALK_DEPTH,
	MAX_WALK_NODES,
	PROJECTED_VALUE_KEY,
} from "@/internal/safe-walk";
import { serializeEvent } from "@/internal/serializer";
import { Logger } from "@/logger";
import { createDomainProcessor } from "@/processors/domain";
import { NullTransport } from "@/transports/null-transport";
import type { ILogEvent } from "@/types/log-event.interface";

const PASSWORD = "Sup3rS3cret!";

const userProperties = { name: StringVO, password: PasswordVO };

class User extends Entity<typeof userProperties> {
	protected defineEntity(): EntityDefinition<typeof userProperties> {
		return { properties: userProperties, source: "user" };
	}
}

class OrderConfirmed extends DomainEvent {
	protected defineName(): string {
		return "order.confirmed";
	}
}

function makeEvent(overrides: Partial<ILogEvent> = {}): ILogEvent {
	return {
		level: "info",
		time: 1700000000000,
		bindings: {},
		...overrides,
	};
}

function makeUser(): User {
	return new User({ name: "alan", password: PASSWORD });
}

describe("createDomainProcessor", () => {
	test("has name 'domain'", () => {
		expect(createDomainProcessor().name).toBe("domain");
	});

	test("returns the same event by identity when nothing matches", () => {
		const event = makeEvent({
			bindings: { service: "checkout" },
			meta: { userId: 42 },
		});

		expect(createDomainProcessor().process(event)).toBe(event);
	});

	test("replaces a domain object in meta with its safe form", () => {
		const result = createDomainProcessor().process(
			makeEvent({ meta: { user: makeUser() } }),
		);
		const user = result?.meta?.user as Record<string, unknown>;

		expect(user.name).toBe("alan");
		expect(user.password).toBe("[redacted]");
	});

	test("does not mutate frozen bindings", () => {
		const bindings = Object.freeze({ user: makeUser() });
		const event = makeEvent({ bindings });

		const result = createDomainProcessor().process(event);

		expect(result).not.toBe(event);
		expect(bindings.user).toBeInstanceOf(User);
		expect(result?.bindings.user).not.toBeInstanceOf(User);
	});

	test("a hostile bindings is replaced without costing meta", () => {
		// Unreachable through `createAroma` — the `Logger` constructor freezes a
		// spread of `bindings`, which resolves any accessor once and for all. It
		// is reachable by hand, when a user processor runs ahead of this one and
		// hands back bindings of its own, so the two records are guarded
		// symmetrically rather than on a guess about who calls what.
		const bindings: Record<string, unknown> = {};
		Object.defineProperty(bindings, "boom", {
			enumerable: true,
			get() {
				throw new Error("bindings getter exploded");
			},
		});

		const result = createDomainProcessor().process(
			makeEvent({ bindings, meta: { user: makeUser() } }),
		);

		expect(result?.bindings[CONVERSION_ERROR_KEY]).toContain(
			"bindings getter exploded",
		);
		const user = result?.meta?.user as Record<string, unknown>;
		expect(user.password).toBe("[redacted]");
	});

	test("flattens a domain event carried in meta", () => {
		const domainEvent = new OrderConfirmed("01J-order");
		const result = createDomainProcessor().process(
			makeEvent({ meta: { event: domainEvent } }),
		);

		expect(result?.meta).toEqual({
			"event.name": "order.confirmed",
			"event.aggregateId": "01J-order",
			"event.occurredAt": domainEvent.occurredAt,
		});
	});
});

describe("domain leak regression", () => {
	test("beans' Entity.toJSON() still does NOT redact — the premise of this processor", () => {
		// If this ever fails, `beans` closed the gap itself and the domain
		// processor's reason for existing should be re-examined, rather than
		// quietly becoming dead code.
		expect(makeUser().toJSON().password).toBe(PASSWORD);
		expect(JSON.stringify(makeUser())).toContain(PASSWORD);
	});

	test("a sensitive property never reaches the serialised line", () => {
		const sink = new NullTransport();
		const log = createAroma({ transports: [sink] });

		log.info({ user: makeUser() }, "user created");

		const line = serializeEvent(sink.events[0] as ILogEvent);

		expect(line).not.toContain(PASSWORD);
		expect(line).toContain("[redacted]");
		expect(line).toContain("user created");
	});

	test("a bare sensitive ValueObject is redacted rather than unwrapped to {value}", () => {
		const sink = new NullTransport();
		const log = createAroma({ transports: [sink] });

		log.info(
			{
				password: new PasswordVO(PASSWORD, {
					name: "password",
					source: "user",
				}),
			},
			"login",
		);

		expect(serializeEvent(sink.events[0] as ILogEvent)).not.toContain(PASSWORD);
	});

	test("a bare Logger converts nothing, and the value leaks", () => {
		// `createAroma` always injects the domain processor now — there is no
		// argument that removes it. The escape hatch is building the Logger
		// yourself, and this pins what that costs.
		const sink = new NullTransport();
		const log = new Logger({ transports: [sink] });

		log.info({ user: makeUser() }, "user created");

		expect(serializeEvent(sink.events[0] as ILogEvent)).toContain(PASSWORD);
	});

	test("a live domain object cannot cross a worker boundary", () => {
		// Pinning a consequence rather than a bug, and the reason the escape
		// hatch is worth documenting. With the domain processor on, the event
		// reaching a transport is already plain, so `postMessage`'s structured
		// clone has nothing to lose. Without it the live instance survives to
		// the transport, and structured clone keeps only own enumerable
		// *string* keys — an entity holds its state under symbols, so it
		// arrives at the worker as `{}`. The fix is at the call site
		// (`user.toSafeJSON()`), not here.
		const sink = new NullTransport();
		const log = new Logger({ transports: [sink] });

		log.info({ user: makeUser() }, "user created");

		const meta = (sink.events[0] as ILogEvent).meta as Record<string, unknown>;
		expect(meta.user).toBeInstanceOf(User);
		expect(structuredClone(meta.user)).toEqual({});
	});
});

describe("the nine doors a sensitive value could leave by", () => {
	// The whole domain integration exists so that none of these seven call
	// shapes can put a `sensitive` property on a log line. Each one reaches the
	// serialiser by a different route, and each was open at some point: inside
	// meta, inside err.cause, inside a collection, as meta itself, below a plain
	// object literal, inside an ordinary class instance, and through a `toJSON()`
	// that reaches state the walk cannot see.
	function lineFor(log: (logger: ReturnType<typeof createAroma>) => void): {
		line: string;
		event: ILogEvent;
	} {
		const sink = new NullTransport();
		const logger = createAroma({ transports: [sink] });
		log(logger);
		const event = sink.events[0] as ILogEvent;
		return { line: serializeEvent(event), event };
	}

	test("door 1 — inside meta", () => {
		const { line } = lineFor((log) => {
			log.info({ user: makeUser() }, "user created");
		});

		expect(line).not.toContain(PASSWORD);
	});

	test("door 2 — inside err.cause", () => {
		const { line } = lineFor((log) => {
			log.error(
				new BadRequestException("checkout", "invalid cart", {
					cause: makeUser(),
				}),
				"checkout failed",
			);
		});

		expect(line).not.toContain(PASSWORD);
		expect(line).toContain("[redacted]");
	});

	test("door 3 — inside a collection", () => {
		const { line } = lineFor((log) => {
			log.info(
				{
					users: [makeUser(), makeUser()],
					byId: new Map([["a", makeUser()]]),
					unique: new Set([makeUser()]),
				},
				"listing",
			);
		});

		expect(line).not.toContain(PASSWORD);
	});

	test("door 4 — as meta itself", () => {
		const { line, event } = lineFor((log) => {
			// `Bindings` is `Record<string, unknown>`, which a class instance does
			// not satisfy, so TypeScript rejects this call — the cast is how it
			// reaches the runtime in practice: a JS consumer, or a payload that
			// arrived as `any`/`unknown` and was passed straight through.
			log.info(
				makeUser() as unknown as Record<string, unknown>,
				"user created",
			);
		});

		expect(line).not.toContain(PASSWORD);
		// …and the entry is not silently emptied, which is how this one failed.
		expect(event.meta?.name).toBe("alan");
		expect(line).not.toContain('"meta":{}');
	});

	test("door 4 again, with a prototype from another copy of beans", () => {
		// A second @roastery/beans in node_modules mints a second `Entity`
		// base, so `instanceof` says no while the object is still an entity in
		// every way that matters. The structural `toSafeJSON` branch is what
		// catches it; without that, detection fails silently and the leak is
		// back with no error anywhere.
		const real = makeUser();
		const foreign = Object.create(Object.getPrototypeOf({})) as Record<
			string,
			unknown
		>;
		foreign.toSafeJSON = () => real.toSafeJSON();
		foreign.toJSON = () => real.toJSON();

		const { line } = lineFor((log) => {
			log.info({ user: foreign }, "user created");
		});

		expect(foreign).not.toBeInstanceOf(User);
		expect(line).not.toContain(PASSWORD);
	});

	// Door 5 was open while the conversion was top-level only, and by omission rather than by
	// oversight: the conversion stopped at the top level because redaction did
	// too, and then redaction went to six levels without it. What was left is a
	// gap neither half covers — redaction refuses to enter a class instance,
	// and the conversion never reaches one that far down. An `Entity` sitting
	// there is serialised by its lossless `toJSON()`, which is the exact leak
	// this package exists to prevent.
	test("door 5 — below a plain object literal", () => {
		const { line } = lineFor((log) => {
			log.info({ ctx: { user: makeUser() } }, "request handled");
		});

		expect(line).not.toContain(PASSWORD);
	});

	test("door 5 — several literals down", () => {
		const { line } = lineFor((log) => {
			log.info({ a: { b: { user: makeUser() } } }, "request handled");
		});

		expect(line).not.toContain(PASSWORD);
	});

	test("door 5 — a literal inside a collection", () => {
		// The nastiest of the three, because the collection descent exists for
		// exactly this kind of payload and still misses it: `rows` is walked,
		// the literal inside it is not. A list of result rows is the most
		// ordinary payload a service has.
		const { line } = lineFor((log) => {
			log.info({ rows: [{ user: makeUser() }] }, "listing");
		});

		expect(line).not.toContain(PASSWORD);
	});

	test("a domain event below a literal becomes a nested object, not dotted keys", () => {
		// Flattening is a top-level affair on purpose. `mapDomainEvents` in the
		// ECS processor folds `<prefix>.name` / `.aggregateId` / `.occurredAt`
		// back into an ECS `event` object and scans only the root of the
		// document, so a dotted key minted at depth 2 would be invisible to it —
		// and Elasticsearch would expand it into a real `event` object anyway,
		// colliding with the reserved ECS namespace. A nested object also just
		// reads better down there.
		const domainEvent = new OrderConfirmed("01J-order");
		const { event } = lineFor((log) => {
			log.info({ ctx: { event: domainEvent } }, "confirmed");
		});

		expect(event.meta?.ctx).toEqual({
			event: {
				name: "order.confirmed",
				aggregateId: "01J-order",
				occurredAt: domainEvent.occurredAt,
			},
		});
	});

	test("a top-level domain event is still flattened, so ECS can fold it", () => {
		const domainEvent = new OrderConfirmed("01J-order");
		const { event } = lineFor((log) => {
			log.info({ event: domainEvent }, "confirmed");
		});

		expect(event.meta).toEqual({
			"event.name": "order.confirmed",
			"event.aggregateId": "01J-order",
			"event.occurredAt": domainEvent.occurredAt,
		});
	});

	test("descending into literals does not make a cycle hang or throw", () => {
		// Going deep is what buys door 5, and it is also what puts the domain
		// conversion in reach of a back reference for the first time. The
		// sentinel is the one `safeStringify` already substitutes, so the line
		// reads the same as it always did.
		const cyclic: Record<string, unknown> = { user: makeUser() };
		cyclic.self = cyclic;

		const { line } = lineFor((log) => {
			log.info({ ctx: cyclic }, "cyclic");
		});

		expect(line).not.toContain(PASSWORD);
		expect(line).toContain("[Circular]");
	});

	// Door 6 is the one the single-traversal rewrite left open, and it is the same leak as door 5 through
	// a different gap: the walk refuses to enter a class instance — which is what
	// stops it rummaging through a Date, an Error or a database handle — and so it
	// also refuses one that merely *carries* an entity. `JSON.stringify` then
	// serialises that instance's own enumerable properties and reaches the
	// entity's lossless `toJSON()`.
	test("door 6 — inside an ordinary class instance", () => {
		class Wrapper {
			public constructor(public readonly user: User) {}
		}

		const { line } = lineFor((log) => {
			log.info({ ctx: new Wrapper(makeUser()) }, "request handled");
		});

		expect(line).not.toContain(PASSWORD);
	});

	test("door 6 — two levels inside a class instance", () => {
		class Wrapper {
			public constructor(public readonly data: { user: User }) {}
		}

		const { line } = lineFor((log) => {
			log.info({ ctx: new Wrapper({ user: makeUser() }) }, "request handled");
		});

		expect(line).not.toContain(PASSWORD);
	});

	test("binary is never walked, however many indices it would expose", () => {
		// The one special case left in `descendable`. `Object.keys` on a typed
		// array returns one entry per element, so walking a megabyte buffer would
		// mean a million visits — and there is no domain object hiding in one.
		const bytes = new Uint8Array(1024);
		const buffer = Buffer.alloc(1024);

		const sink = new NullTransport();
		const log = createAroma({ transports: [sink] });
		log.info({ bytes, buffer }, "upload");

		const meta = (sink.events[0] as ILogEvent).meta as Record<string, unknown>;
		expect(meta.bytes).toBe(bytes);
		expect(meta.buffer).toBe(buffer);
	});

	test("the node budget truncates instead of passing a value through", () => {
		// A runaway structure must not become unbounded work on the hot path —
		// but the guard has to fail towards silence, not towards leaking. What
		// it refuses to enter is replaced, never forwarded as it was.
		const sink = new NullTransport();
		const log = createAroma({ transports: [sink] });
		const many = Array.from({ length: MAX_WALK_NODES + 10 }, () => ({}));

		log.info({ many }, "runaway");

		const walked = (sink.events[0] as ILogEvent).meta?.many as unknown[];
		expect(walked[0]).toEqual({});
		expect(walked[walked.length - 1]).toBe("[truncated: node budget]");
	});

	test("a realistic payload never comes near the budget", () => {
		// 200 rows of 11 fields — the widest shape measured — enters about 200
		// objects against a budget of 10.000. The guard is for structures that
		// have gone wrong, not a policy about payload size.
		const rows = Array.from({ length: 200 }, (_, index) => ({
			id: index,
			sku: `SKU-${index}`,
			qty: index,
		}));
		const sink = new NullTransport();
		const log = createAroma({ transports: [sink] });

		log.info({ rows }, "listing");

		expect(JSON.stringify(sink.events[0])).not.toContain("truncated");
	});

	test("a getter that throws costs its record, not the line", () => {
		// Entering class instances put own enumerable accessors in reach of an
		// ordinary log call. A throw there used to take the whole event down
		// through `ProcessorFailureException`; now it costs the record it was in,
		// and the half-converted payload is still never forwarded.
		const hostile: Record<string, unknown> = { ctx: {} };
		Object.defineProperty(hostile.ctx as object, "boom", {
			enumerable: true,
			get() {
				throw new Error("getter exploded");
			},
		});

		const sink = new NullTransport();
		const log = createAroma({ transports: [sink] });
		log.info(hostile, "request handled");

		const event = sink.events[0] as ILogEvent;
		expect(event.msg).toBe("request handled");
		expect(event.meta?.[CONVERSION_ERROR_KEY]).toContain("getter exploded");
	});

	test("a hostile meta does not take the bindings with it", () => {
		const hostile: Record<string, unknown> = {};
		Object.defineProperty(hostile, "boom", {
			enumerable: true,
			get() {
				throw new Error("nope");
			},
		});

		const sink = new NullTransport();
		const log = createAroma({ transports: [sink] });
		log.child({ requestId: "abc-123" }).info(hostile, "request handled");

		const event = sink.events[0] as ILogEvent;
		expect(event.bindings.requestId).toBe("abc-123");
		expect(event.meta?.[CONVERSION_ERROR_KEY]).toBeDefined();
	});

	// Door 7 is a contract mismatch rather than a missed branch: the walk decides
	// what to convert by reading own enumerable properties, and `JSON.stringify`
	// decides what to emit by calling `toJSON()`. While the two agree, converting
	// the properties is enough. When they disagree — state in a `#private` field
	// or a non-enumerable property — the conversion is bypassed entirely and the
	// entity's unredacted `toJSON()` is what comes out.
	test("door 7 — a toJSON() reading a private field", () => {
		class Envelope {
			readonly #user: User;
			public constructor(user: User) {
				this.#user = user;
			}
			public toJSON(): unknown {
				return { data: this.#user };
			}
		}

		const { line } = lineFor((log) => {
			log.info({ env: new Envelope(makeUser()) }, "response");
		});

		expect(line).not.toContain(PASSWORD);
	});

	test("door 7 — a public property alongside the private one", () => {
		class Envelope {
			readonly #user: User;
			public readonly id = 7;
			public constructor(user: User) {
				this.#user = user;
			}
			public toJSON(): unknown {
				return { id: this.id, data: this.#user };
			}
		}

		const { line } = lineFor((log) => {
			log.info({ env: new Envelope(makeUser()) }, "response");
		});

		expect(line).not.toContain(PASSWORD);
	});

	test("door 7 — a toJSON() reading a non-enumerable property", () => {
		class Envelope {
			public constructor(user: User) {
				Object.defineProperty(this, "user", {
					value: user,
					enumerable: false,
				});
			}
			public toJSON(): unknown {
				return { data: (this as unknown as { user: User }).user };
			}
		}

		const { line } = lineFor((log) => {
			log.info({ env: new Envelope(makeUser()) }, "response");
		});

		expect(line).not.toContain(PASSWORD);
	});

	test("a projection that changes nothing leaves the original alone", () => {
		// The pin that keeps following `toJSON()` from turning into replacing by
		// it. A Date projects to a string, nothing inside changes, so the Date
		// itself comes back — by identity, which is what the lazy clone promises
		// and what a transport reading the raw event depends on.
		const when = new Date(0);
		const sink = new NullTransport();
		const log = createAroma({ transports: [sink] });

		log.info({ when }, "timed");

		expect((sink.events[0] as ILogEvent).meta?.when).toBe(when);
		expect(serializeEvent(sink.events[0] as ILogEvent)).toContain(
			"1970-01-01T00:00:00.000Z",
		);
	});

	test("a class that projects to another of itself terminates", () => {
		class Forever {
			public toJSON(): unknown {
				return new Forever();
			}
		}
		const sink = new NullTransport();
		const log = createAroma({ transports: [sink] });

		expect(() => log.info({ f: new Forever() }, "loop")).not.toThrow();
		expect(sink.events).toHaveLength(1);
	});

	test("a toJSON() that reshapes now survives a conversion next to it", () => {
		// A behaviour change, and a fix. The walk clones on conversion, and a
		// clone is a plain object with no `toJSON` — so a DTO that renames fields
		// came out renamed when nothing was converted and raw when something was.
		// Which of the two you got depended on whether the payload happened to
		// hold a domain object.
		class Response {
			public constructor(public readonly user: User) {}
			public toJSON(): unknown {
				return { profile: this.user };
			}
		}

		const { event, line } = lineFor((log) => {
			log.info({ res: new Response(makeUser()) }, "response");
		});

		expect(line).not.toContain(PASSWORD);
		const res = event.meta?.res as Record<string, unknown>;
		expect(Object.keys(res)).toEqual(["profile"]);
	});

	test("door 8 — a plain literal whose toJSON() reads from a closure", () => {
		// This was pinned for a while as a known limit, with an assertion that
		// *expected* the leak: following `toJSON()` was gated on the value having
		// a prototype of its own, on the reasoning that a literal's properties
		// are visible to the walk anyway. A closure is the exception — the entity
		// is reachable by the projection and by nothing else — and the gate was
		// defended on a cost that turned out not to exist.
		const captured = makeUser();
		const literal = {
			toJSON(): unknown {
				return { data: captured };
			},
		};

		const { line } = lineFor((log) => {
			log.info({ e: literal }, "response");
		});

		expect(line).not.toContain(PASSWORD);
		expect(line).toContain("[redacted]");
	});

	test("door 8 — the same literal as meta itself, not under a key", () => {
		// `bindings` and `meta` are reached by name, so they never pass through
		// `descend` and never saw the projection rule at all.
		const captured = makeUser();

		const { line } = lineFor((log) => {
			log.info({ toJSON: () => ({ data: captured }) }, "response");
		});

		expect(line).not.toContain(PASSWORD);
		expect(line).toContain("[redacted]");
	});

	test("door 8 — the same literal as a child's bindings", () => {
		const captured = makeUser();

		const { line } = lineFor((log) => {
			log.child({ toJSON: () => ({ data: captured }) }).info({ n: 1 }, "x");
		});

		expect(line).not.toContain(PASSWORD);
	});

	test("door 8 — the same literal under err.cause", () => {
		const captured = makeUser();

		const { line } = lineFor((log) => {
			log.error(
				new Error("boom", { cause: { toJSON: () => ({ data: captured }) } }),
				"failed",
			);
		});

		expect(line).not.toContain(PASSWORD);
	});

	test("a record whose projection is not a record still gets converted", () => {
		// `{ toJSON: () => [entity] }` as meta serialises as an array, so the
		// record cannot simply be replaced by the walked projection. Handing the
		// original back would be the leak returning, so the converted value is
		// carried under a namespaced key.
		const captured = makeUser();

		const { line, event } = lineFor((log) => {
			log.info({ toJSON: () => [captured] }, "response");
		});

		expect(line).not.toContain(PASSWORD);
		expect(Object.keys(event.meta ?? {})).toEqual([PROJECTED_VALUE_KEY]);
	});

	test("door 9 — a domain object below the depth bound", () => {
		// The depth guard used to hand the subtree back untouched, which meant an
		// entity from the seventh level down left through its unredacted
		// `toJSON()`. Seven levels is a nested API response, not a pathology.
		let payload: unknown = makeUser();
		for (let level = 0; level < MAX_WALK_DEPTH + 2; level++) {
			payload = { nested: payload };
		}

		const { line } = lineFor((log) => {
			log.info({ root: payload }, "response");
		});

		expect(line).not.toContain(PASSWORD);
		expect(line).toContain("[truncated: depth]");
	});

	test("a payload with nothing of ours in it comes back by identity", () => {
		// The lazy clone is what keeps the deep walk off the cost of an
		// ordinary log line. If this ever fails, the walk started allocating on
		// every event and the bench will say so a moment later.
		const sink = new NullTransport();
		const log = createAroma({ transports: [sink] });
		const meta = { ctx: { requestId: "abc", nested: { n: 1 } } };

		log.info(meta, "plain");

		const seen = (sink.events[0] as ILogEvent).meta as typeof meta;
		expect(seen.ctx).toBe(meta.ctx);
		expect(seen.ctx.nested).toBe(meta.ctx.nested);
	});
});
