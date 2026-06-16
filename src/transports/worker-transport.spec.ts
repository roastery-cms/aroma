import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Logger } from "@/logger";
import { createEcsProcessor } from "@/processors/ecs-mapping";
import { WorkerTransport } from "@/transports/worker-transport";

const WORKER = new URL("./worker/file-worker.ts", import.meta.url).pathname;

describe("WorkerTransport", () => {
	let tmpDir: string;
	let logPath: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "aroma-worker-"));
		logPath = join(tmpDir, "app.log");
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	test("plain events write as canonical NDJSON through the file worker", async () => {
		const transport = new WorkerTransport({
			target: WORKER,
			targetOptions: { path: logPath },
		});
		const log = new Logger({ level: "info", transports: [transport] });

		log.info({ a: 1 }, "hello");

		await transport.flush();
		await transport.close();

		const parsed = JSON.parse(readFileSync(logPath, "utf8").trim());
		expect(parsed.level).toBe("info");
		expect(parsed.msg).toBe("hello");
		expect(parsed.meta).toEqual({ a: 1 });
	});

	test("ECS events survive the structured-clone boundary into the worker", async () => {
		const transport = new WorkerTransport({
			target: WORKER,
			targetOptions: { path: logPath },
		});
		const log = new Logger({
			level: "info",
			transports: [transport],
			processors: [createEcsProcessor()],
		});

		log.error({ userId: 42 }, "checkout failed");

		await transport.flush();
		await transport.close();

		const content = readFileSync(logPath, "utf8").trim();
		// Regression guard: the pre-fix bug emitted `{"level":"undefined",…}`.
		expect(content).not.toContain("undefined");

		const parsed = JSON.parse(content);
		expect(parsed["@timestamp"]).toBeDefined();
		expect(parsed.log.level).toBe("error");
		expect(parsed.message).toBe("checkout failed");
		expect(parsed.userId).toBe(42);
		// Canonical-only fields must not leak into the ECS document.
		expect(parsed.level).toBeUndefined();
		expect(parsed.time).toBeUndefined();
		expect(parsed.bindings).toBeUndefined();
	});

	test("surfaces a worker failure via onError and does not hang on close()", async () => {
		const errors: Error[] = [];
		const transport = new WorkerTransport({
			target: WORKER,
			// Parent directory doesn't exist → FileTransport's openSync throws as
			// the worker module loads, crashing the worker.
			targetOptions: { path: join(tmpDir, "missing-subdir", "app.log") },
			onError: (err) => errors.push(err),
		});

		await new Promise((resolve) => setTimeout(resolve, 300));

		expect(errors.length).toBeGreaterThan(0);
		expect(errors[0]).toBeInstanceOf(Error);

		// The worker already exited, so the "exit" handler marked the transport
		// closed — close() must return promptly instead of awaiting a flush reply.
		await transport.close();
	});
});
