import { afterEach, describe, expect, test } from "bun:test";
import { configureRedaction } from "@roastery/beans";
import { redactDeep } from "@/internal/redact";

// `configureRedaction` is module state inside beans — restore the default so a
// test that changes it cannot colour the ones that follow.
afterEach(() => {
	configureRedaction();
});

describe("redactDeep", () => {
	test("replaces listed keys with the beans placeholder", () => {
		expect(redactDeep({ user: "alan", password: "x" }, ["password"])).toEqual({
			user: "alan",
			password: "[redacted]",
		});
	});

	test("returns the original object by identity when no key matches", () => {
		const target = { safe: "ok" };

		expect(redactDeep(target, ["password"])).toBe(target);
	});

	test("returns the original object by identity when keys is empty", () => {
		const target = { password: "x" };

		expect(redactDeep(target, [])).toBe(target);
	});

	test("passes undefined through", () => {
		expect(redactDeep(undefined, ["password"])).toBeUndefined();
	});

	test("does not mutate the original object", () => {
		const target = { password: "x" };

		redactDeep(target, ["password"]);

		expect(target.password).toBe("x");
	});

	test("follows configureRedaction's placeholder", () => {
		configureRedaction({ placeholder: "***" });

		expect(redactDeep({ token: "abc" }, ["token"])).toEqual({
			token: "***",
		});
	});

	test("supports a placeholder function, passing the value and the key", () => {
		configureRedaction({
			placeholder: (value, { name, source }) =>
				`${name}@${source}:${String(value).slice(-2)}`,
		});

		expect(redactDeep({ token: "abcdef" }, ["token"])).toEqual({
			token: "token@@roastery/aroma:ef",
		});
	});

	test("restores the default when configureRedaction is called bare", () => {
		configureRedaction({ placeholder: "***" });
		configureRedaction();

		expect(redactDeep({ token: "abc" }, ["token"])).toEqual({
			token: "[redacted]",
		});
	});
});

describe("redactDeep — depth", () => {
	function nested(depth: number): Record<string, unknown> {
		let node: Record<string, unknown> = { password: "Sup3rS3cret!" };
		for (let level = 1; level < depth; level++) {
			node = { down: node };
		}
		return node;
	}

	function deepest(value: unknown): unknown {
		let node = value as Record<string, unknown>;
		while (node && typeof node === "object" && "down" in node) {
			node = node.down as Record<string, unknown>;
		}
		return node?.password;
	}

	test("redacts a key at every depth up to the bound", () => {
		for (let depth = 1; depth <= 6; depth++) {
			const result = redactDeep(nested(depth), ["password"], 6);
			expect(deepest(result)).toBe("[redacted]");
		}
	});

	test("leaves a key beyond the bound alone, by design", () => {
		const result = redactDeep(nested(8), ["password"], 6);

		expect(deepest(result)).toBe("Sup3rS3cret!");
	});

	test("maxDepth: 1 restores the old top-level-only behaviour exactly", () => {
		const result = redactDeep(
			{ password: "top", req: { password: "nested" } },
			["password"],
			1,
		);

		expect(result.password).toBe("[redacted]");
		expect((result.req as Record<string, unknown>).password).toBe("nested");
	});

	test("the real case: authorization inside req.headers", () => {
		const result = redactDeep(
			{ req: { method: "POST", headers: { authorization: "Bearer abc" } } },
			["authorization"],
		);

		const req = result.req as Record<string, unknown>;
		expect((req.headers as Record<string, unknown>).authorization).toBe(
			"[redacted]",
		);
		expect(req.method).toBe("POST");
	});
});

describe("redactDeep — lazy clone", () => {
	test("returns every untouched subtree by identity", () => {
		const headers = { accept: "json" };
		const req = { method: "POST", headers };
		const target = { req, other: { deep: { deeper: true } } };

		const result = redactDeep(target, ["password"]);

		expect(result).toBe(target);
		expect(result.req).toBe(req);
		expect((result.req as typeof req).headers).toBe(headers);
	});

	test("rebuilds only the path down to a match", () => {
		const untouched = { deep: { deeper: true } };
		const target = {
			untouched,
			req: { headers: { authorization: "Bearer abc" }, method: "POST" },
		};

		const result = redactDeep(target, ["authorization"]);

		expect(result).not.toBe(target);
		expect(result.untouched).toBe(untouched);
	});

	test("does not mutate the original at any level", () => {
		const target = { req: { headers: { authorization: "Bearer abc" } } };

		redactDeep(target, ["authorization"]);

		expect(target.req.headers.authorization).toBe("Bearer abc");
	});
});

describe("redactDeep — traversal limits", () => {
	test("terminates on a direct cycle, without carrying the original out", () => {
		const target: Record<string, unknown> = { password: "x" };
		target.self = target;

		const result = redactDeep(target, ["password"]);

		expect(result.password).toBe("[redacted]");
		// The back reference must not be the original object: that copy still
		// holds the real value, and following it would leak what was just masked.
		expect(result.self).toBe("[Circular]");
		expect(JSON.stringify(result)).not.toContain('"x"');
		// …and the original is untouched, cycle and all.
		expect(target.self).toBe(target);
	});

	test("terminates on an indirect cycle", () => {
		const a: Record<string, unknown> = {};
		const b: Record<string, unknown> = { a, password: "x" };
		a.b = b;

		expect(() => redactDeep({ a }, ["password"])).not.toThrow();
	});

	test("descends into arrays, Maps and Sets", () => {
		const result = redactDeep(
			{
				list: [{ password: "in-array" }],
				map: new Map([["password", "in-map"]]),
				set: new Set([{ password: "in-set" }]),
			},
			["password"],
		);

		expect((result.list as Record<string, unknown>[])[0]?.password).toBe(
			"[redacted]",
		);
		expect((result.map as Map<string, unknown>).get("password")).toBe(
			"[redacted]",
		);
		expect([...(result.set as Set<Record<string, unknown>>)][0]?.password).toBe(
			"[redacted]",
		);
	});

	test("does not descend into a class instance", () => {
		// A domain object was already converted by the domain processor, and
		// anything else with a prototype is none of the logger's business.
		class Opaque {
			public password = "untouched";
		}
		const instance = new Opaque();

		const result = redactDeep({ instance }, ["password"]);

		expect(result.instance).toBe(instance);
		expect(instance.password).toBe("untouched");
	});

	test("does not descend into a Date", () => {
		const when = new Date(0);

		expect(redactDeep({ when }, ["password"]).when).toBe(when);
	});
});
