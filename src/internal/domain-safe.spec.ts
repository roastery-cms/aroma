import { afterEach, describe, expect, test } from "bun:test";
import { configureRedaction } from "@roastery/beans";
import { Command } from "@roastery/beans/application/command";
import type {
	CommandDefinition,
	CommandResult,
} from "@roastery/beans/application/command/types";
import { EmailSchema } from "@roastery/beans/domain/collections/schemas";
import {
	EmailVO,
	PasswordVO,
	PositiveIntegerVO,
	StringVO,
} from "@roastery/beans/domain/collections/value-objects";
import { DomainEvent } from "@roastery/beans/domain/domain-event";
import { Entity } from "@roastery/beans/domain/entity";
import type { EntityDefinition } from "@roastery/beans/domain/entity/types";
import { DomainRecord } from "@roastery/beans/domain/record";
import type { RecordDefinition } from "@roastery/beans/domain/record/types";
import { ValueObject } from "@roastery/beans/domain/value-object";
import type { IValueObjectMetadata } from "@roastery/beans/domain/value-object/types";
import { arrayOf } from "@roastery/beans/domain/wrapper/helpers";
import { Meta } from "@roastery/terroir/symbols";
import { domainSafeShallow, domainSafeValue } from "@/internal/domain-safe";

const CONTEXT = { name: "password", source: "user" };
const PASSWORD = "Sup3rS3cret!";

/** Sensitive VO overriding the package placeholder with a masking function. */
class MaskedEmailVO extends ValueObject<string, typeof EmailSchema, true> {
	protected defineMeta(): IValueObjectMetadata<
		string,
		typeof EmailSchema,
		true
	> {
		return {
			default: "demo@roastery.dev",
			schema: EmailSchema,
			sensitive: true,
			redactWith: (value, context) =>
				`${String(value).slice(0, 1)}***@${context.source}.${context.name}`,
		};
	}
}

const userProperties = {
	name: StringVO,
	email: EmailVO,
	password: PasswordVO,
};

class User extends Entity<typeof userProperties> {
	protected defineEntity(): EntityDefinition<typeof userProperties> {
		return { properties: userProperties, source: "user" };
	}
}

const moneyProperties = { amount: PositiveIntegerVO, password: PasswordVO };

class Money extends DomainRecord<typeof moneyProperties> {
	protected defineRecord(): RecordDefinition<typeof moneyProperties> {
		return { properties: moneyProperties, source: "money" };
	}
}

const signInProperties = { email: EmailVO, password: PasswordVO };

class SignIn extends Command<typeof signInProperties, undefined, string> {
	protected defineCommand(): CommandDefinition<typeof signInProperties> {
		return { properties: signInProperties, source: "sign-in" };
	}

	public async execute(): Promise<CommandResult<string>> {
		return { result: "ok", events: [] };
	}
}

class OrderConfirmed extends DomainEvent {
	protected defineName(): string {
		return "order.confirmed";
	}
}

const Passwords = arrayOf(PasswordVO);

// `configureRedaction` is module state inside beans — restore the default so a
// test that changes it cannot colour the ones that follow.
afterEach(() => {
	configureRedaction();
});

function makeUser(): User {
	return new User({
		name: "alan",
		email: "alan@roastery.dev",
		password: PASSWORD,
	});
}

describe("domainSafeValue", () => {
	test("replaces a sensitive ValueObject with the placeholder", () => {
		const password = new PasswordVO(PASSWORD, CONTEXT);

		expect(domainSafeValue(password, "password")).toBe("[redacted]");
	});

	test("unwraps a non-sensitive ValueObject to its raw value", () => {
		const email = new EmailVO("alan@roastery.dev", {
			name: "email",
			source: "user",
		});

		expect(domainSafeValue(email, "email")).toBe("alan@roastery.dev");
	});

	test("a function placeholder receives the value and the VO's own context", () => {
		const email = new MaskedEmailVO("alan@roastery.dev", {
			name: "email",
			source: "user",
		});

		// context comes from the VO's `[Context]`, not from the logging key.
		expect(domainSafeValue(email, "whatever")).toBe("a***@user.email");
	});

	test("an Entity is serialised through toSafeJSON", () => {
		const user = makeUser();
		const safe = domainSafeValue(user, "user") as Record<string, unknown>;

		expect(safe.password).toBe("[redacted]");
		expect(safe.name).toBe("alan");
		expect(safe.id).toBe(user.toJSON().id);
	});

	test("a DomainRecord is serialised through toSafeJSON", () => {
		const money = new Money({ amount: 1500, password: PASSWORD });
		const safe = domainSafeValue(money, "money") as Record<string, unknown>;

		expect(safe).toEqual({ amount: 1500, password: "[redacted]" });
	});

	test("a Command is serialised through toJSON, which beans already redacts", () => {
		const command = new SignIn({
			email: "alan@roastery.dev",
			password: PASSWORD,
		});
		const safe = domainSafeValue(command, "command") as Record<string, unknown>;

		expect(safe.email).toBe("alan@roastery.dev");
		expect(safe.password).toBe("[redacted]");
	});

	test("a runtime wrapper class is caught by the structural toSafeJSON branch", () => {
		const passwords = new Passwords([PASSWORD, "An0therS3cret!"]);

		expect(domainSafeValue(passwords, "passwords")).toEqual([
			"[redacted]",
			"[redacted]",
		]);
	});

	test("a DomainEvent becomes its plain loggable fields", () => {
		const event = new OrderConfirmed("01J-order");
		const safe = domainSafeValue(event, "event") as Record<string, unknown>;

		expect(safe.name).toBe("order.confirmed");
		expect(safe.aggregateId).toBe("01J-order");
		expect(typeof safe.occurredAt).toBe("string");
		expect("payload" in safe).toBe(false);
	});

	test("a plain object with the IDomainEvent shape is treated as an event", () => {
		const safe = domainSafeValue(
			{
				name: "order.cancelled",
				occurredAt: "2026-08-25T13:04:11.000Z",
				aggregateId: "01J-order",
				payload: { total: 1500 },
			},
			"event",
		);

		expect(safe).toEqual({
			name: "order.cancelled",
			aggregateId: "01J-order",
			occurredAt: "2026-08-25T13:04:11.000Z",
			payload: { total: 1500 },
		});
	});

	test("an event payload holding a live instance is converted too", () => {
		const safe = domainSafeValue(
			{
				name: "user.registered",
				occurredAt: "2026-08-25T13:04:11.000Z",
				aggregateId: "01J-user",
				payload: new PasswordVO(PASSWORD, CONTEXT),
			},
			"event",
		) as Record<string, unknown>;

		expect(safe.payload).toBe("[redacted]");
	});

	test("returns a non-domain value by identity", () => {
		const plain = { user: "alan", nested: { deep: true } };
		const list = [1, 2, 3];

		expect(domainSafeValue(plain, "plain")).toBe(plain);
		expect(domainSafeValue(list, "list")).toBe(list);
	});

	test("primitives and null pass straight through", () => {
		expect(domainSafeValue(null, "k")).toBeNull();
		expect(domainSafeValue(undefined, "k")).toBeUndefined();
		expect(domainSafeValue(42, "k")).toBe(42);
		expect(domainSafeValue("text", "k")).toBe("text");
		expect(domainSafeValue(true, "k")).toBe(true);
	});
});

describe("domainSafeShallow", () => {
	test("returns the record by identity when it holds no domain object", () => {
		const record: Record<string, unknown> = {
			userId: 42,
			tags: ["a"],
			nested: { ok: true },
		};

		expect(domainSafeShallow(record)).toBe(record);
	});

	test("passes undefined through", () => {
		expect(domainSafeShallow(undefined)).toBeUndefined();
	});

	test("converts matching keys and leaves the rest untouched", () => {
		const nested = { ok: true };
		const record: Record<string, unknown> = {
			requestId: "abc",
			nested,
			password: new PasswordVO(PASSWORD, CONTEXT),
		};
		const result = domainSafeShallow(record);

		expect(result).toEqual({
			requestId: "abc",
			nested,
			password: "[redacted]",
		});
		expect(result.nested).toBe(nested);
	});

	test("does not mutate the original record", () => {
		const user = makeUser();
		const record: Record<string, unknown> = { user };

		domainSafeShallow(record);

		expect(record.user).toBe(user);
	});

	test("flattens a domain event into prefixed sibling keys", () => {
		const event = new OrderConfirmed("01J-order");
		const result = domainSafeShallow({ event, requestId: "abc" } as Record<
			string,
			unknown
		>);

		expect(result).toEqual({
			requestId: "abc",
			"event.name": "order.confirmed",
			"event.aggregateId": "01J-order",
			"event.occurredAt": event.occurredAt,
		});
		expect("event" in result).toBe(false);
	});

	test("keeps an event payload under the prefixed key when present", () => {
		const result = domainSafeShallow({
			event: {
				name: "order.confirmed",
				occurredAt: "2026-08-25T13:04:11.000Z",
				aggregateId: "01J-order",
				payload: { total: 1500 },
			},
		} as Record<string, unknown>);

		expect(result["event.payload"]).toEqual({ total: 1500 });
	});

	test("does not mistake an entity for an event", () => {
		const user = makeUser();
		const result = domainSafeShallow({ user } as Record<string, unknown>);

		expect(Object.keys(result)).toEqual(["user"]);
	});

	test("tracks configureRedaction, including its function form", () => {
		configureRedaction({ placeholder: "***" });
		expect(domainSafeValue(new PasswordVO(PASSWORD, CONTEXT), "password")).toBe(
			"***",
		);

		configureRedaction({
			placeholder: (_value, { name }) => `<${name} hidden>`,
		});
		expect(domainSafeValue(new PasswordVO(PASSWORD, CONTEXT), "password")).toBe(
			"<password hidden>",
		);

		configureRedaction();
		expect(domainSafeValue(new PasswordVO(PASSWORD, CONTEXT), "password")).toBe(
			"[redacted]",
		);
	});
});

describe("collections", () => {
	test("descends into an array and redacts each domain item", () => {
		const safe = domainSafeValue(
			[new PasswordVO(PASSWORD, CONTEXT), "plain"],
			"passwords",
		) as unknown[];

		expect(safe).toEqual(["[redacted]", "plain"]);
	});

	test("returns an array of plain values by identity — no allocation", () => {
		const values = [1, "two", { three: true }];

		expect(domainSafeValue(values, "values")).toBe(values);
	});

	test("descends into a nested array", () => {
		const safe = domainSafeValue(
			[[new PasswordVO(PASSWORD, CONTEXT)]],
			"grid",
		) as unknown[][];

		expect(safe[0]).toEqual(["[redacted]"]);
	});

	test("does not mutate the original array", () => {
		const password = new PasswordVO(PASSWORD, CONTEXT);
		const values = [password];

		domainSafeValue(values, "passwords");

		expect(values[0]).toBe(password);
	});

	test("converts a Map to a plain object — identity would serialise as {}", () => {
		const safe = domainSafeValue(
			new Map([["secret", new PasswordVO(PASSWORD, CONTEXT)]]),
			"byKey",
		);

		expect(safe).toEqual({ secret: "[redacted]" });
		expect(JSON.stringify(safe)).toBe('{"secret":"[redacted]"}');
	});

	test("converts a Set to an array, for the same reason", () => {
		const safe = domainSafeValue(
			new Set([new PasswordVO(PASSWORD, CONTEXT), "plain"]),
			"unique",
		);

		expect(safe).toEqual(["[redacted]", "plain"]);
	});

	test("survives a self-referential array instead of exhausting the stack", () => {
		const cycle: unknown[] = [new PasswordVO(PASSWORD, CONTEXT)];
		cycle.push(cycle);

		expect(() => domainSafeValue(cycle, "cycle")).not.toThrow();
	});

	test("stops descending past the depth bound through Maps and Sets too", () => {
		let nested: unknown = new PasswordVO(PASSWORD, CONTEXT);
		for (let level = 0; level < 6; level++) {
			nested = new Map([["down", new Set([nested])]]);
		}

		expect(() => domainSafeValue(nested, "deep")).not.toThrow();
	});

	test("stops descending past the depth bound", () => {
		// 12 levels of nesting, bound is 8 — the value object sits out of reach
		// and comes back untouched rather than costing unbounded recursion.
		let nested: unknown = new PasswordVO(PASSWORD, CONTEXT);
		for (let level = 0; level < 12; level++) {
			nested = [nested];
		}

		expect(() => domainSafeValue(nested, "deep")).not.toThrow();
	});
});

describe("a value object from another copy of beans", () => {
	// Two copies of @roastery/beans mint two `ValueObject` bases, so
	// `instanceof` fails while the object is a value object in every way that
	// matters. `defineMeta` lives on the prototype and survives the boundary,
	// which is the same discriminant beans itself uses.
	function foreignValueObject(meta: unknown): object {
		const prototype = {
			defineMeta() {
				return meta;
			},
		};
		const instance = Object.create(prototype) as Record<
			string | symbol,
			unknown
		>;
		instance.value = PASSWORD;
		if (meta !== undefined) {
			instance[Meta] = meta;
		}
		return instance;
	}

	test("is redacted when its metadata says sensitive", () => {
		const foreign = foreignValueObject({ sensitive: true });

		expect(foreign).not.toBeInstanceOf(PasswordVO);
		expect(domainSafeValue(foreign, "password")).toBe("[redacted]");
	});

	test("is unwrapped when its metadata says it is not sensitive", () => {
		const foreign = foreignValueObject({ sensitive: false });

		expect(domainSafeValue(foreign, "email")).toBe(PASSWORD);
	});

	test("is redacted, not unwrapped, when the metadata is unreachable", () => {
		// What a duplicated *terroir* looks like: `Meta` is a unique symbol, so
		// a second copy mints a different one and the slot reads `undefined`.
		// "Cannot tell" has to resolve to the safe answer.
		const foreign = foreignValueObject(undefined);

		expect(domainSafeValue(foreign, "password")).toBe("[redacted]");
	});
});
