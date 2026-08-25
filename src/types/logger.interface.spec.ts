import { describe, expect, test } from "bun:test";
import {
	PasswordVO,
	StringVO,
} from "@roastery/beans/domain/collections/value-objects";
import { Entity } from "@roastery/beans/domain/entity";
import type { EntityDefinition } from "@roastery/beans/domain/entity/types";
import { createAroma } from "@/create-aroma";
import { NullTransport } from "@/transports/null-transport";

/**
 * Overload-resolution guard for `ILogger`'s level methods.
 *
 * The value of this file is what the **type checker** does with it, not what
 * the assertions do: overloads resolve in declaration order, so one placed
 * after the `Bindings` overload (the widest) would never be reached, and one
 * that degraded to `any` would silently accept everything. Either failure is
 * invisible at runtime and invisible in review. The `@ts-expect-error` lines
 * are what catch the second kind — if the overload set ever widens to `any`,
 * those calls stop being errors and `tsc` fails on the unused expectation.
 */

const userProperties = { name: StringVO, password: PasswordVO };

class User extends Entity<typeof userProperties> {
	protected defineEntity(): EntityDefinition<typeof userProperties> {
		return { properties: userProperties, source: "user" };
	}
}

describe("ILogger level-method overloads", () => {
	test("all four shapes resolve, and unsupported ones do not", () => {
		const sink = new NullTransport();
		const log = createAroma({ transports: [sink] });
		const user = new User({ name: "alan", password: "Sup3rS3cret!" });

		// 1 — message only
		log.info("plain message");

		// 2 — Error first, optional message
		log.info(new Error("boom"));
		log.info(new Error("boom"), "with a message");

		// 3 — a domain object, which is a class instance and therefore has no
		// implicit index signature. This is the overload Phase 2 added; without
		// it this line is `TS2345: Index signature for type 'string' is
		// missing`, and the runtime support for it is unreachable from TypeScript.
		log.info(user);
		log.info(user, "user created");

		// …and a domain event, by shape rather than by class.
		log.info({
			name: "order.confirmed",
			occurredAt: "2026-08-25T13:04:11.000Z",
			aggregateId: "01J-order",
		});

		// 4 — the widest: any bindings-shaped literal
		log.info({ userId: 42 }, "user registered");

		// Not loggable as meta: if the overload set ever collapses to `any`,
		// these stop erroring and this file fails to compile.
		// @ts-expect-error a number is not a message, an Error, a domain object or bindings
		log.info(42);
		// @ts-expect-error a boolean likewise
		log.info(true);
		// @ts-expect-error the second argument is always a message
		log.info("message", 42);

		// Seven well-typed calls plus the three rejected ones, which the runtime
		// still accepts: a level method never throws on an argument it does not
		// recognise, it just emits an event with neither `msg` nor `meta`. The
		// types are the guard here, not the runtime.
		expect(sink.events).toHaveLength(10);
		expect(sink.events[7]?.msg).toBeUndefined();
		expect(sink.events[7]?.meta).toBeUndefined();
	});

	test("the domain overload carries through to every level", () => {
		const sink = new NullTransport();
		const log = createAroma({ level: "trace", transports: [sink] });
		const user = new User({ name: "alan", password: "Sup3rS3cret!" });

		log.trace(user, "trace");
		log.debug(user, "debug");
		log.info(user, "info");
		log.warn(user, "warn");
		log.error(user, "error");
		log.fatal(user, "fatal");

		expect(sink.events).toHaveLength(6);
		expect(sink.events.map((event) => event.level)).toEqual([
			"trace",
			"debug",
			"info",
			"warn",
			"error",
			"fatal",
		]);
	});

	test("a domain object passed as meta is converted, not emptied", () => {
		const sink = new NullTransport();
		const log = createAroma({ transports: [sink] });

		log.info(new User({ name: "alan", password: "Sup3rS3cret!" }), "created");

		expect(sink.events[0]?.meta?.name).toBe("alan");
		expect(sink.events[0]?.meta?.password).toBe("[redacted]");
	});
});
