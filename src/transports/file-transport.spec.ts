import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileTransport } from "@/transports/file-transport";
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

describe("FileTransport", () => {
	let tmpDir: string;
	let logPath: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "aroma-file-"));
		logPath = join(tmpDir, "app.log");
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	test("writes events to the target file as NDJSON", async () => {
		const transport = new FileTransport({ path: logPath });

		transport.write(makeEvent("info", { msg: "hello" }));
		transport.write(makeEvent("warn", { msg: "uh oh" }));
		await transport.flush();
		await transport.close();

		const content = readFileSync(logPath, "utf8");
		const lines = content.trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[0] as string).msg).toBe("hello");
		expect(JSON.parse(lines[1] as string).msg).toBe("uh oh");
	});

	test("rotates on size threshold", async () => {
		const transport = new FileTransport({
			path: logPath,
			rotation: { size: "1KB" },
		});

		// Each event ~50-80 bytes — write enough to cross 1KB.
		for (let i = 0; i < 50; i++) {
			transport.write(makeEvent("info", { msg: `msg-${i}` }));
		}
		await transport.flush();
		// Wait a tick for rotate to complete.
		await new Promise((r) => setTimeout(r, 50));
		await transport.close();

		const files = readdirSync(tmpDir);
		const rotated = files.filter(
			(f) => f !== "app.log" && f.startsWith("app.log."),
		);
		expect(rotated.length).toBeGreaterThanOrEqual(1);
	});

	test("rotated file uses an hourly suffix when interval is 'hourly'", async () => {
		const transport = new FileTransport({
			path: logPath,
			rotation: { size: "256B", interval: "hourly" },
		});

		for (let i = 0; i < 30; i++) {
			transport.write(makeEvent("info", { msg: `m-${i}` }));
		}
		await transport.flush();
		await new Promise((r) => setTimeout(r, 50));
		await transport.close();

		const rotated = readdirSync(tmpDir).filter(
			(f) => f !== "app.log" && f.startsWith("app.log."),
		);
		expect(rotated.length).toBeGreaterThanOrEqual(1);
		// Hourly suffix: app.log.YYYY-MM-DD-HH
		expect(
			rotated.some((f) => /^app\.log\.\d{4}-\d{2}-\d{2}-\d{2}$/.test(f)),
		).toBe(true);
	});

	test("compress: gzip produces a .gz file after rotation", async () => {
		const transport = new FileTransport({
			path: logPath,
			rotation: { size: "256B" },
			compress: "gzip",
		});

		for (let i = 0; i < 30; i++) {
			transport.write(makeEvent("info", { msg: `m-${i}` }));
		}
		await transport.flush();
		// Wait for gzip background completion.
		await new Promise((r) => setTimeout(r, 150));
		await transport.close();

		const files = readdirSync(tmpDir);
		const gz = files.filter((f) => f.endsWith(".gz"));
		expect(gz.length).toBeGreaterThanOrEqual(1);
	});

	test("close() releases the fd and silences further writes", async () => {
		const transport = new FileTransport({ path: logPath });

		transport.write(makeEvent("info", { msg: "before" }));
		await transport.close();

		transport.write(makeEvent("info", { msg: "after" }));
		await transport.flush();

		const content = readFileSync(logPath, "utf8");
		expect(content).toContain("before");
		expect(content).not.toContain("after");
	});

	test("getStats() reports bytesWritten and buffer stats", async () => {
		const transport = new FileTransport({ path: logPath });

		transport.write(makeEvent("info", { msg: "x".repeat(100) }));
		const stats = transport.getStats();

		expect(stats.bytesWritten).toBeGreaterThan(0);
		expect(stats.buffer).toBeDefined();

		await transport.close();
	});

	test("name is 'file' and level is exposed", () => {
		const transport = new FileTransport({ path: logPath, level: "warn" });
		expect(transport.name).toBe("file");
		expect(transport.level).toBe("warn");
		void transport.close();
	});

	test("appends to existing file rather than truncating", async () => {
		const first = new FileTransport({ path: logPath });
		first.write(makeEvent("info", { msg: "first-run" }));
		await first.flush();
		await first.close();

		const second = new FileTransport({ path: logPath });
		second.write(makeEvent("info", { msg: "second-run" }));
		await second.flush();
		await second.close();

		const content = readFileSync(logPath, "utf8");
		expect(content).toContain("first-run");
		expect(content).toContain("second-run");
	});

	test("the interval timer fires a rotation", async () => {
		jest.useFakeTimers();
		try {
			const transport = new FileTransport({
				path: logPath,
				rotation: { interval: "hourly" },
			});

			// Keep the buffer empty so rotate()'s flush() resolves immediately and
			// the rotation doesn't depend on a (faked) setImmediate flush cycle.
			jest.advanceTimersByTime(3600_000); // fires `() => void this.rotate()`
			jest.useRealTimers();

			// rotate() is async (one microtask + synchronous fs ops); let it settle.
			await new Promise((r) => setTimeout(r, 50));
			await transport.close();

			const rotated = readdirSync(tmpDir).filter(
				(f) => f !== "app.log" && f.startsWith("app.log."),
			);
			expect(rotated.length).toBeGreaterThanOrEqual(1);
		} finally {
			jest.useRealTimers();
		}
	});

	test("rotation by interval is scheduled and cleared on close", async () => {
		const transport = new FileTransport({
			path: logPath,
			rotation: { interval: "hourly" },
		});

		transport.write(makeEvent("info", { msg: "tick" }));
		await transport.flush();
		await transport.close();

		// Just confirms construction + close don't throw with interval rotation.
		expect(existsSync(logPath)).toBe(true);
	});
});
