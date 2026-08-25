import { CASES } from "#bench/cases";
import {
	buildReport,
	type CaseResult,
	formatNs,
	formatOps,
	measureInIsolation,
	table,
} from "#bench/harness";

/**
 * Throughput benchmark for the event pipeline.
 *
 * Spawns `bench/case-runner.ts` once **per case**, so no two scenarios share
 * a process. That isolation is not ceremony: `Logger.emit` and
 * `ITransport.write` are single call sites, so measuring a bare `Logger` and
 * a full `createAroma` pipeline in one process degrades both their inline
 * caches and every case ends up paying for the shapes its neighbours
 * introduced — `core-msg` read 268 ns beside its neighbours and 75 ns alone.
 * A service runs one logger configuration; the isolated number is the
 * representative one.
 *
 * Writes `bench/current.json`; `bench/compare.ts` diffs that against
 * `bench/baseline.json` and fails on a regression.
 *
 * @see `bench/cases.ts` — the scenarios.
 * @see `bench/compare.ts` — the regression gate.
 */

console.log(`\n@roastery/aroma — throughput (bun ${Bun.version})\n`);

const results: CaseResult[] = [];

for (const benchCase of CASES) {
	process.stdout.write(`  ${benchCase.id.padEnd(16)} …`);
	const result = await measureInIsolation(benchCase.id);
	results.push(result);
	console.log(
		`\r  ${benchCase.id.padEnd(16)} ${formatNs(result.nsPerOp).padStart(9)}  ±${(result.spread * 100).toFixed(1)}%`,
	);
}

const report = buildReport(results);

const rows = report.cases.map((result, index) => [
	`${result.id}${result.note ? ` [${index + 1}]` : ""}`,
	formatNs(result.nsPerOp),
	`${formatOps(result.opsPerSec)}/s`,
	`±${(result.spread * 100).toFixed(1)}%`,
	result.label,
]);

console.log(
	`\n${table(["case", "ns/op", "throughput", "noise", "what"], rows)}`,
);

report.cases.forEach((result, index) => {
	if (result.note) console.log(`\n[${index + 1}] ${result.note}`);
});

const outputPath = `${import.meta.dir}/current.json`;
await Bun.write(outputPath, `${JSON.stringify(report, null, "\t")}\n`);

console.log(`\nwrote ${outputPath}\n`);
