import { table } from "#bench/harness";

/**
 * Startup cost of importing the built logger, and how much of it is
 * `@roastery/beans`.
 *
 * The question this answers is whether putting `beans` in `dependencies` — and
 * therefore typebox and slugify in the load graph — is something a process
 * that only ever logs strings should have to pay for. Measuring it settles
 * whether the narrow-subpath discipline is worth tightening further (a
 * `@roastery/beans/shared/redaction` subpath so nothing has to touch the root
 * barrel) or whether the cost is beneath notice.
 *
 * Each target is imported in a **fresh process**, because a module graph is
 * loaded once and every later `import` of it is a cache hit. `empty` is the
 * floor: interpreter boot with nothing imported, which every other row
 * includes and which you subtract to read the real number.
 *
 * ```bash
 * bun run bench:import
 * ```
 *
 * Requires `bun run build` first — it measures `dist/`, the thing consumers
 * actually load, not the TypeScript sources.
 */

const RUNS = 7;

const TARGETS: ReadonlyArray<[id: string, specifier: string | null]> = [
	["empty", null],
	["aroma (built)", "./dist/index.js"],
	["beans: entity", "@roastery/beans/domain/entity"],
	["beans: value-object", "@roastery/beans/domain/value-object"],
	["beans: command", "@roastery/beans/application/command"],
	["beans: root barrel", "@roastery/beans"],
	["terroir: exceptions", "@roastery/terroir/exceptions"],
];

async function timeImport(specifier: string | null): Promise<number> {
	const source = specifier
		? `const t = Bun.nanoseconds(); await import(${JSON.stringify(specifier)}); console.log(Bun.nanoseconds() - t);`
		: "console.log(0);";

	const samples: number[] = [];

	for (let run = 0; run < RUNS; run++) {
		const started = Bun.nanoseconds();
		const child = Bun.spawn([process.execPath, "-e", source], {
			stdout: "pipe",
			stderr: "inherit",
			cwd: import.meta.dir.replace(/\/bench$/, ""),
		});
		const output = await new Response(child.stdout).text();
		const wall = Bun.nanoseconds() - started;

		if ((await child.exited) !== 0) {
			throw new Error(`failed to import ${specifier}`);
		}

		// Wall time includes process spawn, which is the honest figure for a
		// short-lived CLI; the in-process number isolates the module graph.
		samples.push(specifier ? Number(output.trim()) : wall);
	}

	samples.sort((a, b) => a - b);
	return samples[(samples.length - 1) >> 1] ?? 0;
}

const rows: string[][] = [];

for (const [id, specifier] of TARGETS) {
	const nanoseconds = await timeImport(specifier);
	rows.push([
		id,
		specifier === null
			? `${(nanoseconds / 1e6).toFixed(1)} ms (process boot)`
			: `${(nanoseconds / 1e6).toFixed(2)} ms`,
	]);
}

console.log(`\n@roastery/aroma — import cost (bun ${Bun.version})\n`);
console.log(table(["target", "median of 7"], rows));
console.log(
	"\nEach row is a fresh process. `empty` is interpreter boot; the rest are the\n" +
		"in-process cost of the module graph alone.\n",
);
