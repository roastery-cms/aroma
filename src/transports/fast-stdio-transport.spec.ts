import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	closeSync,
	mkdtempSync,
	openSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackpressureDropException } from "@/exceptions/aroma-exception";
import { FastStdioTransport } from "@/transports/fast-stdio-transport";
import type { ILogEvent } from "@/types/log-event.interface";

function makeEvent(
	level: ILogEvent["level"],
	overrides: Partial<ILogEvent> = {},
): ILogEvent {
	return {
		level,
		time: 1700000000000,
		msg: "test",
		bindings: {},
		...overrides,
	};
}

describe("FastStdioTransport", () => {
	let tmpDir: string;
	let outPath: string;
	let errPath: string;
	let outFd: number;
	let errFd: number;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "aroma-stdio-"));
		outPath = join(tmpDir, "out.log");
		errPath = join(tmpDir, "err.log");
		outFd = openSync(outPath, "w");
		errFd = openSync(errPath, "w");
	});

	afterEach(() => {
		try {
			closeSync(outFd);
		} catch {
			// already closed
		}
		try {
			closeSync(errFd);
		} catch {
			// already closed
		}
		rmSync(tmpDir, { recursive: true, force: true });
	});

	test("info goes to stdout fd, error/fatal go to errorFd", async () => {
		const transport = new FastStdioTransport({
			fd: outFd,
			errorFd: errFd,
			syncFatal: false,
		});

		transport.write(makeEvent("info", { msg: "hello-info" }));
		transport.write(makeEvent("error", { msg: "hello-error" }));
		transport.write(makeEvent("fatal", { msg: "hello-fatal" }));

		await transport.flush();

		const out = readFileSync(outPath, "utf8");
		const err = readFileSync(errPath, "utf8");

		expect(out).toContain("hello-info");
		expect(out).not.toContain("hello-error");
		expect(err).toContain("hello-error");
		expect(err).toContain("hello-fatal");
	});

	test("syncFatal writes immediately without flush", () => {
		const transport = new FastStdioTransport({
			fd: outFd,
			errorFd: errFd,
			syncFatal: true,
		});

		transport.write(makeEvent("fatal", { msg: "die-now" }));

		const err = readFileSync(errPath, "utf8");
		expect(err).toContain("die-now");
	});

	test("buffered writes amortise into fewer flushes than events", async () => {
		const transport = new FastStdioTransport({
			fd: outFd,
			errorFd: errFd,
			syncFatal: false,
			bufferSize: 4096,
		});

		for (let i = 0; i < 500; i++) {
			transport.write(makeEvent("info", { msg: `msg-${i}` }));
		}

		await transport.flush();

		const stats = transport.getStats();
		expect(stats.stdout.flushCount).toBeLessThan(500);
		expect(stats.stdout.flushCount).toBeGreaterThan(0);
	});

	test("output is single-line JSON that round-trips", async () => {
		const transport = new FastStdioTransport({
			fd: outFd,
			errorFd: errFd,
			syncFatal: false,
		});

		transport.write(
			makeEvent("info", {
				msg: "hi",
				bindings: { service: "api" },
				meta: { userId: 1 },
			}),
		);

		await transport.flush();

		const content = readFileSync(outPath, "utf8").trim();
		const parsed = JSON.parse(content);
		expect(parsed.msg).toBe("hi");
		expect(parsed.bindings).toEqual({ service: "api" });
		expect(parsed.meta).toEqual({ userId: 1 });
	});

	test("backpressure drop: dispatches BackpressureDropException via onDrop", async () => {
		const drops: BackpressureDropException[] = [];
		const transport = new FastStdioTransport({
			fd: outFd,
			errorFd: errFd,
			syncFatal: false,
			bufferSize: 4096,
			maxBuffered: 200,
			backpressure: "drop",
			onDrop: (err) => drops.push(err),
		});

		const bigLine = makeEvent("info", { msg: "x".repeat(300) });
		// First push fits, second/third saturate.
		transport.write(bigLine);
		transport.write(bigLine);
		transport.write(bigLine);

		await transport.flush();

		expect(drops.length).toBeGreaterThan(0);
		expect(drops[0]).toBeInstanceOf(BackpressureDropException);
		expect(drops[0]?.dropCount).toBeGreaterThan(0);
	});

	test("circular reference does not throw", async () => {
		const transport = new FastStdioTransport({
			fd: outFd,
			errorFd: errFd,
			syncFatal: false,
		});

		const circular: Record<string, unknown> = { name: "loop" };
		circular.self = circular;

		expect(() => {
			transport.write(makeEvent("info", { meta: circular }));
		}).not.toThrow();

		await transport.flush();
	});

	test("close() drains buffer and silences further writes", async () => {
		const transport = new FastStdioTransport({
			fd: outFd,
			errorFd: errFd,
			syncFatal: false,
		});

		transport.write(makeEvent("info", { msg: "before-close" }));
		await transport.close();

		transport.write(makeEvent("info", { msg: "after-close" }));
		await transport.flush();

		const content = readFileSync(outPath, "utf8");
		expect(content).toContain("before-close");
		expect(content).not.toContain("after-close");
	});

	test("name is 'fast-stdio'", () => {
		const transport = new FastStdioTransport({ fd: outFd, errorFd: errFd });
		expect(transport.name).toBe("fast-stdio");
	});

	test("level option is exposed", () => {
		const transport = new FastStdioTransport({
			fd: outFd,
			errorFd: errFd,
			level: "warn",
		});
		expect(transport.level).toBe("warn");
	});
});
