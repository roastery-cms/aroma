import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	EmailVO,
	PasswordVO,
	StringVO,
} from "@roastery/beans/domain/collections/value-objects";
import { DomainEvent } from "@roastery/beans/domain/domain-event";
import { Entity } from "@roastery/beans/domain/entity";
import type { EntityDefinition } from "@roastery/beans/domain/entity/types";
import { DiscardTransport, table } from "#bench/harness";
import { runWithContext } from "@/context";
import { createAroma } from "@/create-aroma";
import { FileTransport } from "@/transports/file-transport";

/**
 * Retention check for the logging pipeline.
 *
 * A logger is the one component in a service that runs on *every* request
 * forever, so anything it holds onto — an event that never leaves a buffer, a
 * child logger's bindings, a transport's queue — becomes an outage rather
 * than a slow function. This script logs millions of events per scenario and
 * asks a single question: after a full collection, is the heap still growing?
 *
 * Each round logs {@link OPS_PER_ROUND} events, then collects and samples the
 * heap. The first {@link WARMUP_ROUNDS} rounds are dropped (lazy module
 * state, JIT tiering and the allocator reaching steady state all inflate
 * them), and the remaining samples are split in half: if the second half's
 * average heap is meaningfully above the first's, something is being
 * retained per event.
 *
 * ```bash
 * bun run bench:leak
 * ```
 *
 * Exits non-zero when any scenario retains more than
 * {@link BYTES_PER_OP_BUDGET} bytes per event.
 */

/** Events logged between heap samples. */
const OPS_PER_ROUND = 50_000;

/** Rounds discarded before sampling starts. */
const WARMUP_ROUNDS = 4;

/** Rounds kept, split in half for the comparison. */
const MEASURED_ROUNDS = 12;

/**
 * Sustained retention a scenario is allowed, per logged event.
 *
 * Not zero: `heapUsed` after a collection still moves by tens of kilobytes on
 * its own, so a budget of exactly zero would fail at random. Half a byte per
 * event is far below anything that matters (a retained event is hundreds of
 * bytes) and far above the sampling noise.
 */
const BYTES_PER_OP_BUDGET = 0.5;

/**
 * `Bun.gc` is declared `void` in `bun-types`, but the runtime returns JSC's
 * heap size after the collection — the only figure here that tracks
 * retention. Typed as `unknown` rather than `number` so
 * {@link heapAfterCollection} has to check it rather than trust it.
 */
const collect = Bun.gc as unknown as (force: boolean) => unknown;

type Scenario = {
	id: string;
	label: string;
	/** Log `count` events. */
	run: (count: number) => void;
	/** Drain anything the scenario buffered, so what remains is genuinely retained. */
	settle?: () => Promise<void>;
	teardown?: () => void;
};

const userProperties = { name: StringVO, email: EmailVO, password: PasswordVO };

class User extends Entity<typeof userProperties> {
	protected defineEntity(): EntityDefinition<typeof userProperties> {
		return { properties: userProperties, source: "user" };
	}
}

class OrderConfirmed extends DomainEvent {
	protected defineName(): string {
		return "order.confirmed";
	}
}

const sink = new DiscardTransport();
const log = createAroma({ transports: [sink] });

const META = { userId: 42, requestId: "01J8Z9", route: "/checkout", ms: 12 };
const user = new User({
	name: "alan",
	email: "alan@roastery.dev",
	password: "Sup3rS3cret!",
});
const domainEvent = new OrderConfirmed(user.toJSON().id);

const logDirectory = mkdtempSync(join(tmpdir(), "aroma-leak-"));
const fileTransport = new FileTransport({
	path: join(logDirectory, "app.log"),
});
const fileLog = createAroma({ transports: [fileTransport] });

const scenarios: Scenario[] = [
	{
		id: "pipeline",
		label: "createAroma → [domain] → discard",
		run: (count) => {
			for (let index = 0; index < count; index++) {
				log.info(META, "checkout completed");
			}
		},
	},
	{
		id: "domain",
		label: "meta carrying an Entity and a domain event",
		run: (count) => {
			for (let index = 0; index < count; index++) {
				log.info({ user, event: domainEvent }, "order confirmed");
			}
		},
	},
	{
		id: "child",
		label: "a fresh child logger per event",
		run: (count) => {
			for (let index = 0; index < count; index++) {
				log.child({ requestId: "01J8Z9" }).info(META, "scoped");
			}
		},
	},
	{
		id: "context",
		label: "runWithContext (AsyncLocalStorage) per event",
		run: (count) => {
			for (let index = 0; index < count; index++) {
				runWithContext({ requestId: "01J8Z9" }, () => {
					log.info(META, "scoped");
				});
			}
		},
	},
	{
		id: "file",
		label: "FileTransport, buffered writes drained each round",
		run: (count) => {
			for (let index = 0; index < count; index++) {
				fileLog.info(META, "checkout completed");
			}
		},
		settle: () => fileTransport.flush(),
		teardown: () => {
			void fileTransport.close();
		},
	},
];

/**
 * Fully collect, then return the live heap in bytes.
 *
 * **Not `process.memoryUsage().heapUsed`**, which this script trusted at
 * first and which is inert under Bun: a workload deliberately retaining 1.2M
 * objects reported the same 0.17 MB on every round while the real heap went
 * from 8 MB to 48 MB. `Bun.gc(true)` returns JSC's heap size after the
 * collection it just performed, which does track. `rss` tracks too but never
 * shrinks back, so it cannot tell retention from a high-water mark.
 *
 * Collected twice because one pass can leave objects whose finalisers free
 * more; the second pass's return value is the settled figure.
 *
 * @throws when `Bun.gc` stops returning a heap size — better to fail loudly
 *   than to compare `NaN`s and report every scenario clean forever.
 */
function heapAfterCollection(): number {
	collect(true);
	const heap = collect(true);

	if (typeof heap !== "number" || !Number.isFinite(heap)) {
		throw new Error(
			"Bun.gc(true) no longer returns the heap size — this script needs another heap probe",
		);
	}

	return heap;
}

function formatBytes(bytes: number): string {
	const sign = bytes < 0 ? "-" : "";
	const absolute = Math.abs(bytes);
	if (absolute >= 1024 * 1024)
		return `${sign}${(absolute / 1024 / 1024).toFixed(2)} MB`;
	if (absolute >= 1024) return `${sign}${(absolute / 1024).toFixed(1)} KB`;
	return `${sign}${absolute.toFixed(0)} B`;
}

function mean(values: number[]): number {
	return values.reduce((total, value) => total + value, 0) / values.length;
}

console.log(
	`\n@roastery/aroma — retention (bun ${Bun.version})\n` +
		`  ${MEASURED_ROUNDS} sampled rounds × ${OPS_PER_ROUND.toLocaleString("en-US")} events, after ${WARMUP_ROUNDS} warmup rounds\n`,
);

const rows: string[][] = [];
const leaks: string[] = [];

for (const scenario of scenarios) {
	for (let round = 0; round < WARMUP_ROUNDS; round++) {
		scenario.run(OPS_PER_ROUND);
		await scenario.settle?.();
	}

	const samples: number[] = [];
	for (let round = 0; round < MEASURED_ROUNDS; round++) {
		scenario.run(OPS_PER_ROUND);
		await scenario.settle?.();
		samples.push(heapAfterCollection());
	}

	scenario.teardown?.();

	const half = samples.length / 2;
	const early = mean(samples.slice(0, half));
	const late = mean(samples.slice(half));

	// The two halves' midpoints are `half` rounds apart, which is how many
	// rounds of events the growth accumulated over.
	const growth = late - early;
	const bytesPerOp = growth / (half * OPS_PER_ROUND);
	const leaking = bytesPerOp > BYTES_PER_OP_BUDGET;

	rows.push([
		scenario.id,
		formatBytes(early),
		formatBytes(late),
		formatBytes(growth),
		`${bytesPerOp.toFixed(3)} B/op`,
		leaking ? "LEAK" : "ok",
		scenario.label,
	]);

	if (leaking) {
		leaks.push(
			`  ${scenario.id}: heap grew ${formatBytes(growth)} over ${(half * OPS_PER_ROUND).toLocaleString("en-US")} events (${bytesPerOp.toFixed(3)} B/op, budget ${BYTES_PER_OP_BUDGET})`,
		);
	}
}

rmSync(logDirectory, { recursive: true, force: true });

console.log(
	table(
		["scenario", "heap early", "heap late", "growth", "per event", "", "what"],
		rows,
	),
);

if (leaks.length === 0) {
	console.log(
		`\nno scenario retained more than ${BYTES_PER_OP_BUDGET} B per event.\n`,
	);
	process.exit(0);
}

console.error(
	`\n${leaks.length} scenario(s) retaining memory:\n${leaks.join("\n")}\n`,
);
process.exit(1);
