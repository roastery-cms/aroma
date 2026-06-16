import { describe, expect, test } from "bun:test";
import { createAroma } from "@/create-aroma";
import type { AromaException } from "@/exceptions/aroma-exception";
import { Logger } from "@/logger";
import { FastStdioTransport } from "@/transports/fast-stdio-transport";
import { NullTransport } from "@/transports/null-transport";
import type { ITransport } from "@/types/transport.interface";

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

	test("default redact keys are applied even without explicit redact option", () => {
		const sink = new NullTransport();
		const logger = createAroma({ transports: [sink] });

		logger.info(
			{ authorization: "Bearer x", token: "y", apiKey: "z", safe: "ok" },
			"sensitive",
		);

		expect(sink.events[0]?.meta).toEqual({
			authorization: "[REDACTED]",
			token: "[REDACTED]",
			apiKey: "[REDACTED]",
			safe: "ok",
		});
	});

	test("explicit redact keys are added on top of defaults", () => {
		const sink = new NullTransport();
		const logger = createAroma({
			transports: [sink],
			redact: ["customSecret"],
		});

		logger.info({ password: "p", customSecret: "x", safe: "ok" }, "login");

		expect(sink.events[0]?.meta).toEqual({
			password: "[REDACTED]",
			customSecret: "[REDACTED]",
			safe: "ok",
		});
	});

	test("redact: false disables all redaction including defaults", () => {
		const sink = new NullTransport();
		const logger = createAroma({
			transports: [sink],
			redact: false,
		});

		logger.info({ password: "p", token: "t" }, "leak");

		expect(sink.events[0]?.meta).toEqual({ password: "p", token: "t" });
	});

	test("user processors run after the auto-injected redact", () => {
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

		logger.info({ password: "secret" }, "test");

		// capture sees the already-redacted password
		expect(seen[0]).toEqual({ password: "[REDACTED]" });
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
