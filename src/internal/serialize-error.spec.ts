import { describe, expect, test } from "bun:test";
import { PasswordVO } from "@roastery/beans/domain/collections/value-objects";
import { UnknownException } from "@roastery/terroir/exceptions";
import { ForbiddenException } from "@roastery/terroir/exceptions/application";
import { OperationFailedException } from "@roastery/terroir/exceptions/domain";
import { AromaException } from "@/exceptions/aroma-exception";
import { serializeError } from "@/internal/serialize-error";

describe("serializeError", () => {
	test("keeps name, source and layer of a CoreException", () => {
		const serialized = serializeError(new AromaException("transport down"));

		expect(serialized.name).toBe("Aroma Exception");
		expect(serialized.message).toBe("transport down");
		expect(serialized.source).toBe("@roastery/aroma");
		expect(serialized.layer).toBe("infra");
	});

	test("wraps a native Error in an UnknownException, keeping it as cause", () => {
		const original = new TypeError("bad");
		const serialized = serializeError(original);

		expect(serialized.name).toBe("Unknown Error");
		expect(serialized.source).toBe("$internal");
		expect(serialized.layer).toBe("internal");
		expect(serialized.cause).toMatchObject({
			name: "TypeError",
			message: "bad",
		});
	});

	test("wraps a non-Error thrown value", () => {
		const serialized = serializeError("just a string");

		expect(serialized.message).toBe("just a string");
		expect(serialized.cause).toBe("just a string");
	});

	test("never returns a live Error instance", () => {
		expect(serializeError(new Error("boom"))).not.toBeInstanceOf(Error);
	});

	test("carries code for an application-layer exception", () => {
		const serialized = serializeError(new ForbiddenException("checkout"));

		expect(serialized.layer).toBe("application");
		expect(serialized.code).toBe(403);
	});

	test("omits code for a domain-layer exception", () => {
		const serialized = serializeError(new OperationFailedException("order"));

		expect(serialized.layer).toBe("domain");
		expect(serialized.code).toBeUndefined();
	});

	test("omits code for an infra-layer exception", () => {
		const serialized = serializeError(new AromaException("transport down"));

		expect(serialized.code).toBeUndefined();
	});

	test("omits code for a wrapped UnknownException", () => {
		expect(serializeError(new UnknownException("nope")).code).toBeUndefined();
		expect(serializeError(new Error("nope")).code).toBeUndefined();
	});

	test("carries code on a nested application-layer cause", () => {
		const serialized = serializeError(
			new AromaException("transport down", {
				cause: new ForbiddenException("checkout"),
			}),
		);

		expect(serialized.code).toBeUndefined();
		expect(serialized.cause).toMatchObject({
			layer: "application",
			code: 403,
		});
	});

	test("survives JSON.stringify with code included", () => {
		const line = JSON.stringify(serializeError(new ForbiddenException("api")));

		expect(JSON.parse(line).code).toBe(403);
	});
});

describe("a domain object reaching err.cause", () => {
	// serializeError runs inside Logger.emit, before the processor pipeline, so
	// this is the one route into a log line the domain processor never sees —
	// and terroir's own TSDoc encourages putting the original failure in cause.
	const PASSWORD = "Sup3rS3cret!";
	const CONTEXT = { name: "password", source: "user" };

	test("is converted to its safe form rather than passed through live", () => {
		const serialized = serializeError(
			new ForbiddenException("checkout", "denied", {
				cause: new PasswordVO(PASSWORD, CONTEXT),
			}),
		);

		expect(serialized.cause).toBe("[redacted]");
	});

	test("is converted inside a collection too", () => {
		const serialized = serializeError(
			new ForbiddenException("checkout", "denied", {
				cause: [new PasswordVO(PASSWORD, CONTEXT)],
			}),
		);

		expect(serialized.cause).toEqual(["[redacted]"]);
	});

	test("survives JSON.stringify without the real value", () => {
		const line = JSON.stringify(
			serializeError(
				new ForbiddenException("checkout", "denied", {
					cause: new PasswordVO(PASSWORD, CONTEXT),
				}),
			),
		);

		expect(line).not.toContain(PASSWORD);
	});

	test("a plain non-Error cause still passes through untouched", () => {
		const serialized = serializeError(
			new ForbiddenException("checkout", "denied", { cause: { code: 42 } }),
		);

		expect(serialized.cause).toEqual({ code: 42 });
	});
});
