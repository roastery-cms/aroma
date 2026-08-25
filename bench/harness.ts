import type { ILogEvent } from "@/types/log-event.interface";
import type { ITransport } from "@/types/transport.interface";

/**
 * Sink that throws every event away while still *touching* it, so neither
 * the JIT nor a future refactor can treat a `log.info()` call as dead code.
 *
 * `NullTransport` is unusable here: it retains every event it receives, so a
 * million-iteration round would measure array growth and GC pressure instead
 * of the logger.
 */
export class DiscardTransport implements ITransport {
	public readonly name = "discard";
	public received = 0;
	public lastLevel = "";

	public write(event: ILogEvent): void {
		this.received++;
		this.lastLevel = event.level;
	}
}

/** One scenario to time. */
export type BenchCase = {
	/** Stable key — `compare.ts` matches baseline to current on it, so renaming one loses its history. */
	id: string;
	/** Human-readable description for the printed table. */
	label: string;
	/** Calls per measured round. Tune so a round lands around 50–100 ms. */
	iterations: number;
	/** Footnote appended to the table, for a case whose number needs a caveat. */
	note?: string;
	/** Built once, before the first pass. */
	setup?: () => void | Promise<void>;
	/**
	 * The measured work: run the operation `iterations` times.
	 *
	 * **Each case writes its own loop, and that is the whole point.** A shared
	 * `for` loop in the harness calling a per-case `run()` puts every case
	 * through one call site; after a few cases that site is megamorphic,
	 * nothing inlines, and the cheap cases inflate 3–5× (`core-msg` 50 ns →
	 * 265 ns, and its rounds spread ±379%). A loop written here is its own
	 * source location with its own inline cache, so it stays specialised to
	 * this one operation however many times the suite comes back to it.
	 *
	 * Keep the body to the operation itself: no allocation of the arguments,
	 * no branching on the index.
	 */
	batch: (iterations: number) => void;
};

/** What one scenario produced. Written verbatim into `current.json`. */
export type CaseResult = {
	id: string;
	label: string;
	note?: string;
	iterations: number;
	rounds: number;
	/**
	 * **Median** round — the number the regression gate reads.
	 *
	 * The minimum is the usual estimator for a microbenchmark, on the logic
	 * that noise only ever makes a round slower. That reasoning breaks for
	 * allocating code: garbage collection is not noise, it is part of what
	 * `log.info({ user })` costs, and the fastest round is simply the one
	 * that got away with deferring it. The median over long rounds — long
	 * enough that every round contains several collections — is both more
	 * honest and, measured here, no less reproducible.
	 */
	nsPerOp: number;
	/** Fastest round, kept as a diagnostic floor — not what the gate compares. */
	fastestNsPerOp: number;
	/** Derived from {@link CaseResult.nsPerOp}. */
	opsPerSec: number;
	/**
	 * `(median - min) / min` — this run's own noise band.
	 *
	 * It is what the regression gate widens its threshold to when the
	 * machine is busy: a delta smaller than the measurement's own error is
	 * not a finding, and reporting it as one trains people to ignore the
	 * gate.
	 */
	spread: number;
};

/** Shape of `current.json` / `baseline.json`. */
export type BenchReport = {
	/** Bumped when the file layout changes, so `compare.ts` can refuse a stale baseline. */
	version: number;
	createdAt: string;
	runtime: {
		bun: string;
		platform: string;
		arch: string;
	};
	cases: CaseResult[];
};

/** Current on-disk format of a report. */
export const REPORT_VERSION = 2;

/**
 * Id of the case that measures the **machine** rather than this package.
 *
 * It runs a fixed workload containing no `@roastery/aroma` code, so any
 * change in it is the box, not the diff. `compare.ts` divides it out before
 * judging the other cases — without that, re-running on a busier machine
 * reports genuine-looking 30% regressions across the board.
 */
export const CONTROL_CASE_ID = "control";

const WARMUP_ROUNDS = 2;
const MEASURED_ROUNDS = 9;

function round(value: number, digits = 3): number {
	const factor = 10 ** digits;
	return Math.round(value * factor) / factor;
}

/**
 * Time one round and return the average nanoseconds per operation.
 *
 * The case's own loop overhead is inside the measurement, which is
 * deliberate: for the dropped-log path that overhead *is* most of the cost,
 * and hiding it would flatter the number.
 */
function measureRound(benchCase: BenchCase): number {
	const start = Bun.nanoseconds();
	benchCase.batch(benchCase.iterations);
	return (Bun.nanoseconds() - start) / benchCase.iterations;
}

/** Value at `quantile` (0–1) of an already-sorted sample list. */
function quantile(sorted: number[], q: number): number {
	if (sorted.length === 0) return 0;
	const index = Math.min(
		sorted.length - 1,
		Math.max(0, Math.round((sorted.length - 1) * q)),
	);
	return sorted[index] ?? 0;
}

/** Turn a case's per-round samples into its reported result. */
function summarise(benchCase: BenchCase, samples: number[]): CaseResult {
	const sorted = [...samples].sort((a, b) => a - b);
	const fastest = sorted[0] ?? 0;
	const median = quantile(sorted, 0.5);

	return {
		id: benchCase.id,
		label: benchCase.label,
		note: benchCase.note,
		iterations: benchCase.iterations,
		rounds: sorted.length,
		nsPerOp: round(median),
		fastestNsPerOp: round(fastest),
		opsPerSec: Math.round(1e9 / median),
		spread: round(fastest > 0 ? (median - fastest) / fastest : 0),
	};
}

/**
 * Measure one case: warm the JIT, then take the median of several long
 * rounds.
 *
 * **One case per process.** Sharing a process across cases was tried and is
 * how this benchmark first went wrong: `Logger.emit` and `ITransport.write`
 * are one call site each, so running a bare `Logger` and a `createAroma`
 * pipeline in the same process degrades both their inline caches, and every
 * case pays for the shapes its neighbours introduced. `core-msg` measured
 * 268 ns next to its neighbours and 75 ns alone. A service runs one logger
 * configuration, so the isolated number is also the representative one.
 *
 * Rounds are long on purpose (tune `iterations` for ~100–200 ms on an
 * allocating case). Short rounds were tried too and are worse: a round that
 * finishes before the collector runs reports a cost the code never really
 * has, so which rounds happened to dodge a collection decides the number.
 * Long rounds put several collections inside every round, which is the
 * steady state a service actually sees.
 *
 * @param benchCase - the scenario to time.
 * @returns its median cost, with the fastest round and the noise band.
 */
export async function measureCase(benchCase: BenchCase): Promise<CaseResult> {
	await benchCase.setup?.();

	for (let round = 0; round < WARMUP_ROUNDS; round++) {
		measureRound(benchCase);
	}

	const samples: number[] = [];
	for (let round = 0; round < MEASURED_ROUNDS; round++) {
		samples.push(measureRound(benchCase));
	}

	return summarise(benchCase, samples);
}

/**
 * Measure one case in a **fresh process** and return its result.
 *
 * Both the suite runner and the regression gate go through here: the gate
 * re-measures a suspected regression before failing on it, and that
 * confirmation is only meaningful if it is measured the same way.
 *
 * @param id - the case's {@link BenchCase.id}.
 * @returns the child's `CaseResult`.
 * @throws when the child exits non-zero — an unknown id, or a case that threw.
 */
export async function measureInIsolation(id: string): Promise<CaseResult> {
	const child = Bun.spawn(
		[process.execPath, `${import.meta.dir}/case-runner.ts`, id],
		{ stdout: "pipe", stderr: "inherit" },
	);

	const output = await new Response(child.stdout).text();
	const code = await child.exited;

	if (code !== 0) {
		throw new Error(`case ${id} exited with ${code}`);
	}

	return JSON.parse(output) as CaseResult;
}

/** Assemble the report `throughput.bench.ts` writes to `current.json`. */
export function buildReport(cases: CaseResult[]): BenchReport {
	return {
		version: REPORT_VERSION,
		createdAt: new Date().toISOString(),
		runtime: {
			bun: Bun.version,
			platform: process.platform,
			arch: process.arch,
		},
		cases,
	};
}

/** `1234.5` → `"1.23 µs"`. Keeps the table readable across four orders of magnitude. */
export function formatNs(ns: number): string {
	if (ns < 1_000) return `${ns.toFixed(ns < 10 ? 2 : 1)} ns`;
	if (ns < 1_000_000) return `${(ns / 1_000).toFixed(2)} µs`;
	return `${(ns / 1_000_000).toFixed(2)} ms`;
}

/** `0.123` → `"12.3%"`. */
export function formatPercent(fraction: number): string {
	return `${(fraction * 100).toFixed(1)}%`;
}

/** `833333` → `"833.3K"`. */
export function formatOps(opsPerSec: number): string {
	if (opsPerSec >= 1_000_000) return `${(opsPerSec / 1_000_000).toFixed(1)}M`;
	if (opsPerSec >= 1_000) return `${(opsPerSec / 1_000).toFixed(1)}K`;
	return String(opsPerSec);
}

/** Render rows as a fixed-width table with a rule under the header. */
export function table(headers: string[], rows: string[][]): string {
	const widths = headers.map((header, column) =>
		Math.max(header.length, ...rows.map((row) => (row[column] ?? "").length)),
	);

	const line = (cells: string[]): string =>
		cells
			.map((cell, column) =>
				column === 0
					? cell.padEnd(widths[column] ?? 0)
					: cell.padStart(widths[column] ?? 0),
			)
			.join("  ");

	return [
		line(headers),
		widths.map((width) => "─".repeat(width)).join("  "),
		...rows.map(line),
	].join("\n");
}
