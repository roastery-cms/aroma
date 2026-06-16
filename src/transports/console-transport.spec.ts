import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { ConsoleTransport } from "@/transports/console-transport";
import type { ILogEvent } from "@/types/log-event.interface";
import type { LogLevel } from "@/types/log-level";

type WriteCallback = (err?: Error | null) => void;
type WriteSpy = ReturnType<typeof mock>;

const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);

function makeEvent(
	level: LogLevel,
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

function installSpy(target: "stdout" | "stderr"): WriteSpy {
	const spy = mock((_line: string, cb?: WriteCallback) => {
		if (typeof cb === "function") {
			cb(null);
		}
		return true;
	});
	process[target].write = spy as unknown as typeof process.stdout.write;
	return spy;
}

describe("ConsoleTransport", () => {
	let stdoutSpy: WriteSpy;
	let stderrSpy: WriteSpy;

	beforeEach(() => {
		stdoutSpy = installSpy("stdout");
		stderrSpy = installSpy("stderr");
	});

	afterEach(() => {
		process.stdout.write = originalStdoutWrite;
		process.stderr.write = originalStderrWrite;
	});

	test("trace, debug, info and warn go to stdout", async () => {
		const transport = new ConsoleTransport();
		await transport.write(makeEvent("trace"));
		await transport.write(makeEvent("debug"));
		await transport.write(makeEvent("info"));
		await transport.write(makeEvent("warn"));

		expect(stdoutSpy).toHaveBeenCalledTimes(4);
		expect(stderrSpy).not.toHaveBeenCalled();
	});

	test("error and fatal go to stderr", async () => {
		const transport = new ConsoleTransport();
		await transport.write(makeEvent("error"));
		await transport.write(makeEvent("fatal"));

		expect(stderrSpy).toHaveBeenCalledTimes(2);
		expect(stdoutSpy).not.toHaveBeenCalled();
	});

	test("each line ends with a newline", async () => {
		const transport = new ConsoleTransport();
		await transport.write(makeEvent("info"));

		const line = stdoutSpy.mock.calls[0]?.[0] as string;
		expect(line.endsWith("\n")).toBe(true);
	});

	test("output is JSON that round-trips", async () => {
		const transport = new ConsoleTransport();
		await transport.write(
			makeEvent("info", {
				msg: "hi",
				bindings: { service: "api" },
				meta: { userId: 1 },
			}),
		);

		const line = stdoutSpy.mock.calls[0]?.[0] as string;
		const parsed = JSON.parse(line);
		expect(parsed.msg).toBe("hi");
		expect(parsed.bindings).toEqual({ service: "api" });
		expect(parsed.meta).toEqual({ userId: 1 });
	});

	test("write resolves after the stream callback fires", async () => {
		let captured: WriteCallback | undefined;
		process.stdout.write = ((_line: string, cb?: WriteCallback) => {
			captured = cb;
			return true;
		}) as unknown as typeof process.stdout.write;

		const transport = new ConsoleTransport();
		let resolved = false;
		const writePromise = transport.write(makeEvent("info")).then(() => {
			resolved = true;
		});

		await Promise.resolve();
		expect(resolved).toBe(false);

		captured?.(null);
		await writePromise;
		expect(resolved).toBe(true);
	});

	test("write rejects when the stream callback receives an error", async () => {
		process.stdout.write = ((_line: string, cb?: WriteCallback) => {
			cb?.(new Error("disk full"));
			return false;
		}) as unknown as typeof process.stdout.write;

		const transport = new ConsoleTransport();
		await expect(transport.write(makeEvent("info"))).rejects.toThrow(
			"disk full",
		);
	});

	test("circular reference in meta does not throw", async () => {
		const transport = new ConsoleTransport();
		const circular: Record<string, unknown> = { name: "loop" };
		circular.self = circular;

		await expect(
			transport.write(makeEvent("info", { meta: circular })),
		).resolves.toBeUndefined();
	});

	test("exposes name and optional level", () => {
		const defaultTransport = new ConsoleTransport();
		const leveled = new ConsoleTransport({ level: "warn" });

		expect(defaultTransport.name).toBe("console");
		expect(defaultTransport.level).toBeUndefined();
		expect(leveled.level).toBe("warn");
	});
});
