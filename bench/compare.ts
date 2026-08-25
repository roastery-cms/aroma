import { CASES } from "#bench/cases";
import {
	type BenchReport,
	buildReport,
	type CaseResult,
	CONTROL_CASE_ID,
	formatNs,
	formatPercent,
	measureInIsolation,
	REPORT_VERSION,
	table,
} from "#bench/harness";

/**
 * Regression gate for `bun run bench:compare`.
 *
 * Diffs `bench/current.json` (just written by `throughput.bench.ts`) against
 * the committed `bench/baseline.json` and exits non-zero when any case got
 * more than {@link REGRESSION_THRESHOLD} slower.
 *
 * A case that looks slower is **re-measured before the gate fails on it**,
 * alongside the `control` case — a fixed workload containing none of this
 * package. One run cannot tell a real regression from a busy machine
 * (identical code has read 45% slower here), and a plain second measurement
 * cannot either: if the box is now uniformly slower, the suspect confirms and
 * so would everything else. Dividing the suspect's change by the control's
 * says what changed *relative to the machine*, which is the question. Pass
 * `--no-confirm` to skip the whole pass.
 *
 * Run `bun bench/compare.ts --update` to record a new baseline. It does not
 * copy `current.json`: it re-measures every case {@link BASELINE_REPEATS}
 * times in fresh processes and stores the **cross-process** spread it
 * observed as that case's noise band. That band is the honest one. The
 * round-to-round spread inside a single process badly understates reality —
 * `domain-entity` varies ~10% within a process and ~40% between them — so a
 * gate built on the within-process figure fails on noise all day. Record a
 * baseline deliberately, on as quiet a machine as you have, and say why in
 * the commit message.
 *
 * @see `bench/harness.ts` — why `nsPerOp` is the fastest round rather than the median.
 */

/**
 * Slowdown a case is allowed before the gate fails. Mirrors the 5% claimed in
 * `package.json`; override with `--threshold=0.1` on a noisy machine, or
 * tighten it on a quiet one.
 */
const DEFAULT_THRESHOLD = 0.05;

/**
 * A case must also regress by at least this many nanoseconds to fail.
 *
 * Without it the `dropped` case — which measures a no-op at a fraction of a
 * nanosecond — would fail the 5% gate on pure jitter, every run.
 */
const NOISE_FLOOR_NS = 2;

/**
 * Measurements of each case taken when recording a baseline.
 *
 * Three was the first try and proved too thin: `domain-collection`'s three
 * runs all landed on the low side, so its band came out both too low and too
 * tight, and the very next comparison of *unchanged* code confirmed a
 * regression against it. Five costs a couple more minutes on a command that
 * runs rarely, and a baseline is the one measurement worth paying for.
 */
const BASELINE_REPEATS = 5;

/**
 * Fold repeated measurements of one case into the entry stored in the
 * baseline: the median cost, and a noise band wide enough to cover both what
 * varied *between* the processes and what varied inside the worst of them.
 */
function mergeRepeats(repeats: CaseResult[]): CaseResult {
	const costs = repeats.map((repeat) => repeat.nsPerOp).sort((a, b) => a - b);
	const lowest = costs[0] ?? 0;
	const highest = costs[costs.length - 1] ?? 0;
	const median = costs[(costs.length - 1) >> 1] ?? 0;

	const crossProcess = lowest > 0 ? (highest - lowest) / lowest : 0;
	const withinProcess = Math.max(...repeats.map((repeat) => repeat.spread));

	const first = repeats[0] as CaseResult;
	return {
		...first,
		nsPerOp: median,
		fastestNsPerOp: lowest,
		opsPerSec: median > 0 ? Math.round(1e9 / median) : 0,
		spread: Math.round(Math.max(crossProcess, withinProcess) * 1000) / 1000,
		rounds: first.rounds * repeats.length,
	};
}

/** `--threshold=0.1` → `0.1`. */
function readThreshold(): number {
	const flag = process.argv.find((argument) =>
		argument.startsWith("--threshold="),
	);
	if (!flag) return DEFAULT_THRESHOLD;

	const parsed = Number.parseFloat(flag.slice("--threshold=".length));
	if (!Number.isFinite(parsed) || parsed <= 0) {
		console.error(`bad --threshold: ${flag}`);
		process.exit(1);
	}
	return parsed;
}

const BASELINE_PATH = `${import.meta.dir}/baseline.json`;
const CURRENT_PATH = `${import.meta.dir}/current.json`;

async function readReport(path: string): Promise<BenchReport | null> {
	const file = Bun.file(path);
	if (!(await file.exists())) return null;
	return (await file.json()) as BenchReport;
}

function byId(report: BenchReport): Map<string, CaseResult> {
	return new Map(report.cases.map((result) => [result.id, result]));
}

/** One line for the failure summary. */
function describe(suspect: Suspect, measured: CaseResult): string {
	return `  ${suspect.result.id}: ${formatNs(suspect.previous.nsPerOp)} → ${formatNs(measured.nsPerOp)} (${percent(suspect.delta)}, gate ±${(suspect.effective * 100).toFixed(1)}%)`;
}

function percent(value: number): string {
	const sign = value > 0 ? "+" : "";
	return `${sign}${(value * 100).toFixed(1)}%`;
}

const current = await readReport(CURRENT_PATH);

if (!current) {
	console.error(
		`no ${CURRENT_PATH}\nrun \`bun run bench\` first — compare only diffs, it never measures.`,
	);
	process.exit(1);
}

if (process.argv.includes("--update") || process.argv.includes("-u")) {
	console.log(
		`\nrecording a baseline — ${BASELINE_REPEATS} measurements of each case, in fresh processes\n`,
	);

	const recorded: CaseResult[] = [];

	for (const benchCase of CASES) {
		const repeats: CaseResult[] = [];
		for (let attempt = 0; attempt < BASELINE_REPEATS; attempt++) {
			repeats.push(await measureInIsolation(benchCase.id));
		}

		const merged = mergeRepeats(repeats);
		recorded.push(merged);

		console.log(
			`  ${merged.id.padEnd(16)} ${formatNs(merged.nsPerOp).padStart(9)}  noise band ±${formatPercent(merged.spread)}`,
		);
	}

	const report = buildReport(recorded);
	await Bun.write(BASELINE_PATH, `${JSON.stringify(report, null, "\t")}\n`);
	console.log(`\nwrote ${BASELINE_PATH}\n`);
	process.exit(0);
}

const baseline = await readReport(BASELINE_PATH);

if (!baseline) {
	console.log(
		[
			"no bench/baseline.json — nothing to compare against.",
			"",
			"Record one on an idle machine with:",
			"  bun run bench && bun bench/compare.ts --update",
		].join("\n"),
	);
	process.exit(0);
}

if (baseline.version !== REPORT_VERSION) {
	console.error(
		`baseline.json is format v${baseline.version}, this harness writes v${REPORT_VERSION} — re-record it with \`bun bench/compare.ts --update\`.`,
	);
	process.exit(1);
}

const threshold = readThreshold();
const baselineCases = byId(baseline);
const seen = new Set<string>();

type Suspect = {
	result: CaseResult;
	previous: CaseResult;
	delta: number;
	effective: number;
};

const rows: string[][] = [];
const suspects: Suspect[] = [];

for (const result of current.cases) {
	seen.add(result.id);
	const previous = baselineCases.get(result.id);

	// The control measures the box, not the package: it cannot regress from a
	// diff, and reporting it as a regression would only ever be a distraction.
	const isControl = result.id === CONTROL_CASE_ID;

	if (!previous) {
		rows.push([result.id, "—", formatNs(result.nsPerOp), "new", ""]);
		continue;
	}

	const delta = (result.nsPerOp - previous.nsPerOp) / previous.nsPerOp;
	const absolute = result.nsPerOp - previous.nsPerOp;

	// Never claim a finding smaller than the run's own measurement error: on a
	// busy machine the noise band is the honest floor, and a gate that cries
	// wolf every other run is a gate everyone learns to skip. Both runs get a
	// say, so a quiet baseline can't be used to sharpen a noisy current run.
	const noiseBand = Math.max(result.spread, previous.spread);
	const effective = Math.max(threshold, noiseBand);

	const regressed =
		!isControl && delta > effective && absolute > NOISE_FLOOR_NS;

	let verdict = "ok";
	if (regressed) verdict = "REGRESSION";
	else if (isControl) verdict = "machine";
	else if (delta > threshold) verdict = "noisy";
	else if (delta < -effective) verdict = "faster";

	rows.push([
		result.id,
		formatNs(previous.nsPerOp),
		formatNs(result.nsPerOp),
		percent(delta),
		verdict,
	]);

	if (regressed) {
		suspects.push({ result, previous, delta, effective });
	}
}

for (const previous of baseline.cases) {
	if (!seen.has(previous.id)) {
		rows.push([previous.id, formatNs(previous.nsPerOp), "—", "gone", ""]);
	}
}

console.log(`\nbaseline  ${baseline.createdAt}  (bun ${baseline.runtime.bun})`);
console.log(`current   ${current.createdAt}  (bun ${current.runtime.bun})\n`);
console.log(table(["case", "baseline", "current", "delta", ""], rows));
console.log(
	`\ngate: ${(threshold * 100).toFixed(0)}%, widened per case to that run's noise band; "noisy" means over the gate but inside the noise.`,
);
console.log(
	`the \`${CONTROL_CASE_ID}\` row measures the machine, not the package — it is never gated, only divided out.`,
);

if (baseline.runtime.bun !== current.runtime.bun) {
	console.log(
		`\nnote: bun ${baseline.runtime.bun} → ${current.runtime.bun}; a runtime change can move every number at once.`,
	);
}

if (suspects.length === 0) {
	console.log("\nno case regressed beyond its noise band.\n");
	process.exit(0);
}

const confirmed: string[] = [];

if (process.argv.includes("--no-confirm")) {
	for (const suspect of suspects) {
		confirmed.push(describe(suspect, suspect.result));
	}
} else {
	console.log(
		`\nre-measuring ${suspects.length} suspected regression(s) against the control…`,
	);

	const baselineControl = baselineCases.get(CONTROL_CASE_ID);
	const currentControl = await measureInIsolation(CONTROL_CASE_ID);

	// How much slower this box is right now than when the baseline was taken.
	// Only ever used to *forgive* a regression, never to manufacture one: a
	// machine that got faster cannot turn an unchanged case into a finding.
	const machineFactor =
		baselineControl && baselineControl.nsPerOp > 0
			? Math.max(1, currentControl.nsPerOp / baselineControl.nsPerOp)
			: 1;

	console.log(
		`  ${CONTROL_CASE_ID.padEnd(16)} ${formatNs(currentControl.nsPerOp).padStart(9)}  machine is ${machineFactor.toFixed(2)}× the baseline's speed${machineFactor > 1.05 ? " — discounting that from every suspect" : ""}`,
	);

	for (const suspect of suspects) {
		const again = await measureInIsolation(suspect.result.id);
		const adjusted =
			again.nsPerOp / machineFactor / suspect.previous.nsPerOp - 1;
		const effective = Math.max(
			suspect.effective,
			again.spread,
			suspect.previous.spread,
		);
		const stillSlower = adjusted > effective;

		console.log(
			`  ${suspect.result.id.padEnd(16)} ${formatNs(again.nsPerOp).padStart(9)}  ${percent(adjusted).padStart(7)}  ${stillSlower ? "confirmed" : "not reproduced — noise"}`,
		);

		if (stillSlower) {
			confirmed.push(
				describe({ ...suspect, delta: adjusted, effective }, again),
			);
		}
	}
}

if (confirmed.length === 0) {
	console.log("\nnothing reproduced on a second measurement.\n");
	process.exit(0);
}

console.error(
	`\n${confirmed.length} regression(s):\n${confirmed.join("\n")}\n`,
);
process.exit(1);
