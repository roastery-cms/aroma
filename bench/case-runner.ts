import { CASES, sink } from "#bench/cases";
import { measureCase } from "#bench/harness";

/**
 * Measure exactly one case and print its `CaseResult` as JSON on stdout.
 *
 * Not run by hand: `bench/throughput.bench.ts` spawns one of these per case
 * so no two cases share a process. See {@link measureCase} for why that
 * isolation is the difference between a number and a rumour.
 *
 * ```bash
 * bun bench/case-runner.ts domain-entity
 * ```
 */

const id = process.argv[2];
const benchCase = CASES.find((candidate) => candidate.id === id);

if (!benchCase) {
	console.error(
		`unknown case ${JSON.stringify(id)}\nknown: ${CASES.map((c) => c.id).join(", ")}`,
	);
	process.exit(1);
}

const result = await measureCase(benchCase);

// Reading the sink keeps the whole pipeline observable, so nothing in it can
// be optimised away as dead.
if (sink.received < 0) throw new Error("unreachable");

console.log(JSON.stringify(result));
