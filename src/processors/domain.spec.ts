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
import { serializeEvent } from "@/internal/serializer";
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

	test("redact: false opts out and the value leaks — documented behaviour", () => {
		const sink = new NullTransport();
		const log = createAroma({ transports: [sink], redact: false });

		log.info({ user: makeUser() }, "user created");

		expect(serializeEvent(sink.events[0] as ILogEvent)).toContain(PASSWORD);
	});

	test("redact: false also means a domain object cannot cross a worker boundary", () => {
		// Pinning a consequence rather than a bug. With the processors on, the
		// event reaching a transport is already plain, so `postMessage`'s
		// structured clone has nothing to lose. With `redact: false` the live
		// instance survives to the transport, and structured clone keeps only
		// own enumerable *string* keys — an entity holds its state under
		// symbols, so it arrives at the worker as `{}`. The fix is at the call
		// site (`user.toSafeJSON()`), not here: "no redaction" has to keep
		// meaning "no scan".
		const sink = new NullTransport();
		const log = createAroma({ transports: [sink], redact: false });

		log.info({ user: makeUser() }, "user created");

		const meta = (sink.events[0] as ILogEvent).meta as Record<string, unknown>;
		expect(meta.user).toBeInstanceOf(User);
		expect(structuredClone(meta.user)).toEqual({});
	});
});

describe("the four doors a sensitive value could leave by", () => {
	// The whole domain integration exists so that none of these four call
	// shapes can put a `sensitive` property on a log line. Each one reaches the
	// serialiser by a different route, and each was open at some point:
	// inside meta, inside err.cause, inside a collection, and as meta itself.
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
});
