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
import { BufferedWriter } from "@/internal/buffered-writer";

describe("BufferedWriter", () => {
	let tmpDir: string;
	let outPath: string;
	let outFd: number;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "aroma-bw-"));
		outPath = join(tmpDir, "out.log");
		outFd = openSync(outPath, "w");
	});

	afterEach(() => {
		try {
			closeSync(outFd);
		} catch {
			// already closed
		}
		rmSync(tmpDir, { recursive: true, force: true });
	});

	describe("buffering", () => {
		test("push below bufferSize buffers synchronously without flushing yet", async () => {
			const writer = new BufferedWriter({ fd: outFd, bufferSize: 4096 });

			writer.push("a".repeat(100));

			// The flush is deferred to the next tick — nothing has been written
			// synchronously.
			const stats = writer.getStats();
			expect(stats.bufferedBytes).toBe(100);
			expect(stats.pendingCount).toBe(1);
			expect(stats.flushCount).toBe(0);

			// Drain the deferred flush so it doesn't fire on a reused fd later.
			await writer.close();
		});

		test("a single small push flushes on the next tick without an explicit flush()", async () => {
			const writer = new BufferedWriter({ fd: outFd, bufferSize: 4096 });

			writer.push("low-volume line\n");
			// No flush()/close() call — just let the event loop turn over.
			await new Promise((resolve) => setTimeout(resolve, 20));

			const stats = writer.getStats();
			expect(stats.flushCount).toBe(1);
			expect(stats.bufferedBytes).toBe(0);
			expect(readFileSync(outPath, "utf8")).toBe("low-volume line\n");
		});

		test("crossing bufferSize triggers a single flush", async () => {
			const writer = new BufferedWriter({ fd: outFd, bufferSize: 100 });

			writer.push("a".repeat(50));
			writer.push("b".repeat(60));
			await writer.flush();

			const stats = writer.getStats();
			expect(stats.flushCount).toBe(1);
			expect(stats.bufferedBytes).toBe(0);
			expect(stats.pendingCount).toBe(0);
		});

		test("amortises many small writes into fewer flushes than pushes", async () => {
			const writer = new BufferedWriter({ fd: outFd, bufferSize: 4096 });

			for (let i = 0; i < 200; i++) {
				writer.push(`line-${i}\n`);
			}
			await writer.flush();

			const stats = writer.getStats();
			expect(stats.flushCount).toBeGreaterThan(0);
			expect(stats.flushCount).toBeLessThan(200);
		});
	});

	describe("backpressure policies", () => {
		test("'drop' discards lines past maxBuffered and reports via onDrop", async () => {
			const drops: number[] = [];
			const writer = new BufferedWriter({
				fd: outFd,
				bufferSize: 4096,
				maxBuffered: 200,
				backpressure: "drop",
				onDrop: (count) => drops.push(count),
			});

			const line = "x".repeat(150);
			writer.push(line); // fits (150)
			writer.push(line); // overflow → dropped
			writer.push(line); // overflow → dropped

			await writer.flush();

			const stats = writer.getStats();
			expect(stats.droppedCount).toBe(2);
			expect(drops).toEqual([1, 2]);
		});

		test("'block' accepts overflow lines instead of dropping", async () => {
			const drops: number[] = [];
			const writer = new BufferedWriter({
				fd: outFd,
				bufferSize: 4096,
				maxBuffered: 200,
				backpressure: "block",
				onDrop: (count) => drops.push(count),
			});

			const line = "y".repeat(150);
			writer.push(line);
			writer.push(line);
			writer.push(line);

			await writer.flush();

			const stats = writer.getStats();
			expect(stats.droppedCount).toBe(0);
			expect(drops).toEqual([]);
			expect(readFileSync(outPath, "utf8").length).toBe(150 * 3);
		});

		test("'sample' keeps a fraction of lines under sustained saturation", async () => {
			const drops: number[] = [];
			const writer = new BufferedWriter({
				fd: outFd,
				bufferSize: 4096,
				maxBuffered: 50,
				backpressure: "sample",
				onDrop: (count) => drops.push(count),
			});

			const line = "z".repeat(100); // each push saturates
			for (let i = 0; i < 100; i++) {
				writer.push(line);
			}
			await writer.flush();

			const stats = writer.getStats();
			// Roughly 1 in 10 lines should be kept (the 10th, 20th, …).
			expect(stats.droppedCount).toBeGreaterThan(50);
			expect(stats.droppedCount).toBeLessThan(100);
			expect(drops.length).toBe(stats.droppedCount);
		});
	});

	describe("flush() waiters", () => {
		test("multiple concurrent flush() calls all resolve", async () => {
			const writer = new BufferedWriter({ fd: outFd, bufferSize: 50 });

			writer.push("a".repeat(60));

			const results = await Promise.all([
				writer.flush(),
				writer.flush(),
				writer.flush(),
			]);

			expect(results).toEqual([undefined, undefined, undefined]);
			expect(writer.getStats().bufferedBytes).toBe(0);
		});

		test("flush() on an empty buffer resolves immediately", async () => {
			const writer = new BufferedWriter({ fd: outFd });

			await writer.flush();

			expect(writer.getStats().flushCount).toBe(0);
		});

		test("synchronous pushes after flush() are absorbed into the same flush cycle", async () => {
			const writer = new BufferedWriter({ fd: outFd, bufferSize: 50 });

			writer.push("a".repeat(60));
			const inFlight = writer.flush();
			writer.push("b".repeat(60));
			await inFlight;

			const stats = writer.getStats();
			// Synchronous follow-up pushes ride the already-scheduled flush.
			expect(stats.flushCount).toBe(1);
			expect(stats.bufferedBytes).toBe(0);
			expect(readFileSync(outPath, "utf8").length).toBe(120);
		});

		test("a push that lands after the in-flight flush starts gets its own cycle", async () => {
			const writer = new BufferedWriter({ fd: outFd, bufferSize: 50 });

			writer.push("a".repeat(60));
			const inFlight = writer.flush();
			// Yield long enough for the scheduled setImmediate to fire and
			// doFlush() to begin draining its first chunk.
			await new Promise((resolve) => setImmediate(resolve));
			writer.push("b".repeat(60));
			await inFlight;
			await writer.flush();

			expect(writer.getStats().flushCount).toBeGreaterThanOrEqual(2);
			expect(readFileSync(outPath, "utf8").length).toBe(120);
		});
	});

	describe("writeSync", () => {
		test("writeSync writes directly without buffering", () => {
			const writer = new BufferedWriter({ fd: outFd });

			writer.writeSync("immediate\n");

			expect(readFileSync(outPath, "utf8")).toBe("immediate\n");
		});

		test("writeSync on a closed fd surfaces via onWriteError", () => {
			const errors: Error[] = [];
			const writer = new BufferedWriter({
				fd: outFd,
				onWriteError: (err) => errors.push(err),
			});

			closeSync(outFd);

			writer.writeSync("after-close-fd\n");

			expect(errors).toHaveLength(1);
			expect(errors[0]).toBeInstanceOf(Error);
			expect(writer.getStats().writeErrorCount).toBe(1);
		});
	});

	describe("close()", () => {
		test("close() drains the buffer before resolving", async () => {
			const writer = new BufferedWriter({ fd: outFd, bufferSize: 50 });

			writer.push("a".repeat(60));
			await writer.close();

			expect(readFileSync(outPath, "utf8").length).toBe(60);
			expect(writer.getStats().bufferedBytes).toBe(0);
		});

		test("push() after close() is a silent no-op", async () => {
			const writer = new BufferedWriter({ fd: outFd });

			await writer.close();
			writer.push("ignored\n");

			expect(readFileSync(outPath, "utf8")).toBe("");
			expect(writer.getStats().bufferedBytes).toBe(0);
		});

		test("writeSync() after close() is a silent no-op", async () => {
			const writer = new BufferedWriter({ fd: outFd });

			await writer.close();
			writer.writeSync("also-ignored\n");

			expect(readFileSync(outPath, "utf8")).toBe("");
		});
	});

	describe("getStats()", () => {
		test("reflects pending bytes and count before flush", () => {
			const writer = new BufferedWriter({ fd: outFd, bufferSize: 4096 });

			writer.push("a".repeat(40));
			writer.push("b".repeat(60));

			const stats = writer.getStats();
			expect(stats.bufferedBytes).toBe(100);
			expect(stats.pendingCount).toBe(2);
			expect(stats.flushCount).toBe(0);
			expect(stats.droppedCount).toBe(0);
			expect(stats.writeErrorCount).toBe(0);
		});

		test("resets bufferedBytes/pendingCount after flush", async () => {
			const writer = new BufferedWriter({ fd: outFd, bufferSize: 50 });

			writer.push("a".repeat(60));
			await writer.flush();

			const stats = writer.getStats();
			expect(stats.bufferedBytes).toBe(0);
			expect(stats.pendingCount).toBe(0);
			expect(stats.flushCount).toBe(1);
		});
	});
});
