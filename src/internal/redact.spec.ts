import { afterEach, describe, expect, test } from "bun:test";
import { configureRedaction } from "@roastery/beans";
import { redactDeep } from "@/internal/redact";
import { MAX_WALK_DEPTH } from "@/internal/safe-walk";

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
		// Deliberately *not* truncated, unlike the domain walk. Masking is a
		// heuristic over a payload the domain conversion has already made safe,
		// so a subtree this walk did not reach is unmasked and nothing worse —
		// exactly as it would be if the key were spelled differently. Deleting it
		// would trade real data for no secrecy. See `WalkPlan.truncateWhenBounded`.
		const result = redactDeep(nested(MAX_WALK_DEPTH + 2), ["password"], 6);

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
		// A Map arrives as a plain object and a Set as an array — see the
		// normalisation test below. The casts go through `unknown` because the
		// generic return type claims the input shape is preserved, which it is
		// not for these two.
		expect((result.map as unknown as Record<string, unknown>).password).toBe(
			"[redacted]",
		);
		expect(
			(result.set as unknown as Record<string, unknown>[])[0]?.password,
		).toBe("[redacted]");
	});

	test("normalises a Map to an object and a Set to an array", () => {
		// Not a convenience — the walk is the last chance to make these
		// readable. `JSON.stringify(new Map([["a", 1]]))` is `"{}"`, so handing
		// the Map back by identity does not preserve the entry, it erases it,
		// and any redaction just applied inside becomes invisible rather than
		// absent. An array is lazy because it survives serialisation; these two
		// do not, so they are always materialised.
		const map = new Map<string, unknown>([["a", 1]]);
		const set = new Set([1, 2]);

		expect(JSON.stringify({ map, set })).toBe('{"map":{},"set":{}}');

		const result = redactDeep({ map, set }, ["password"]);

		expect(result.map as unknown).toEqual({ a: 1 });
		expect(result.set as unknown).toEqual([1, 2]);
		expect(JSON.stringify(result)).toBe('{"map":{"a":1},"set":[1,2]}');
	});

	test("descends into a class instance", () => {
		// This test used to assert the opposite, and what it pinned was a
		// limitation dressed as a contract: refusing every prototype also refused
		// an ordinary class carrying an entity, which is how door 6 stayed open.
		// A listed key inside a class instance is a secret like any other.
		class Opaque {
			public password = "in-instance";
		}
		const instance = new Opaque();

		const result = redactDeep({ instance }, ["password"]);

		expect(
			(result.instance as unknown as Record<string, unknown>).password,
		).toBe("[redacted]");
		// The original is never mutated, whatever the copy says.
		expect(instance.password).toBe("in-instance");
	});

	test("reaches a Node-style request object, not just its literal form", () => {
		// The shape that motivated deep masking in the first place. Until the
		// walk entered class instances it only worked when the request had been
		// spread into a literal — which is not how anyone logs a request.
		class IncomingMessage {
			public headers = { authorization: "Bearer abc", accept: "json" };
		}

		const result = redactDeep({ req: new IncomingMessage() }, [
			"authorization",
		]);

		expect(JSON.stringify(result)).not.toContain("Bearer abc");
		expect(JSON.stringify(result)).toContain("json");
	});

	test("leaves a Date alone — by having nothing to walk, not by a special case", () => {
		// `Object.keys(new Date())` is empty, so the ordinary lazy clone returns
		// it by identity. No rule in `descendable` mentions Date.
		const when = new Date(0);

		expect(Object.keys(when)).toHaveLength(0);
		expect(redactDeep({ when }, ["password"]).when).toBe(when);
	});

	test("never walks binary, however many indices it would expose", () => {
		const bytes = new Uint8Array(1024);

		expect(Object.keys(bytes)).toHaveLength(1024);
		expect(redactDeep({ bytes }, ["password"]).bytes).toBe(bytes);
	});
});
