# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

`@roastery/aroma` — structured, transport-based logger (pino-style API) for the Roastery CMS ecosystem. Library only: no app, no server. Runtime/toolchain is **Bun** (pinned via `mise.toml`); the published bundle is produced by tsup in ESM + CJS + `.d.ts`.

The stack is **terroir → beans → aroma → barista**: aroma sits *above* `@roastery/beans`, so both pillars are ordinary `dependencies` and the integration uses real types and `instanceof` rather than duck-typing. Import `beans` through its **narrow subpaths** (`/domain/entity`, `/domain/value-object`, `/domain/record`, `/domain/domain-event`, `/application/command`) so the logger's load cost doesn't drag in pillars it never touches; the root barrel is only for the redaction config, which has no narrower subpath.

## Commands

```bash
bun install                 # required — node_modules is not checked in

bun run test:unit           # bun test --env-file=.env.testing
bun test src/logger.spec.ts # single file (bunfig sets root/paths to ./src)
bun test -t "child()"       # single test/describe by name pattern
bun run test:coverage

bun run build               # biome check --fix && knip && tsup (writes ./dist)
bun run knip                # unused exports/deps only
bun run setup               # build + bun link (for consuming projects)

bun run bench               # writes bench/current.json (one child process per case)
bun run bench:compare       # bench + diff against bench/baseline.json (fails >5% regression)
bun bench/compare.ts --update          # re-measure everything 3× and record a new baseline
bun bench/compare.ts --threshold=0.1   # loosen the gate on a noisy machine
bun bench/case-runner.ts domain-entity # measure a single case
bun run bench:leak          # heap retention per scenario
bun run bench:import        # module-graph load cost (needs a build first)
```

`.env.testing` is untracked (`.env*` is gitignored); `bun test` alone works when it is absent. `bunfig.toml` preloads `test/set-max-listeners-to-zero.ts` and `test/replace-node-env.ts`, and runs tests serially (`serial = true`) — transports touch real fds/files, so keep new tests order-independent anyway.

### Benchmarks

`bench/baseline.json` is the committed reference; `bench/current.json` is a per-run, machine-specific artifact and is not worth committing.

- `bench/cases.ts` holds the scenarios; `bench/case-runner.ts` measures **one** of them and prints JSON; `bench/throughput.bench.ts` spawns a runner per case and aggregates. That process-per-case split is load-bearing, not tidiness: `Logger.emit` and `ITransport.write` are single call sites, so measuring a bare `Logger` beside a full `createAroma` pipeline degrades both their inline caches and every case pays for its neighbours' shapes — `core-msg` read 268 ns in a shared process and 50 ns alone.
- Each case owns its `for` loop (`BenchCase.batch`) for the same reason: a shared loop in the harness turns one call site megamorphic across every case.
- `bench/compare.ts` widens the 5% gate to each case's **measured** noise band, and re-measures a suspect before failing on it. Both halves are needed. The band comes from `--update`, which re-measures every case three times in fresh processes and stores the cross-process spread: the round-to-round spread inside one process understates reality badly (`domain-entity` varies ~10% within a process and ~40% between them). The confirmation pass then re-runs only the suspects, alongside the `control` case, and divides out how much slower the box is right now than when the baseline was taken.
- **What the gate can and cannot see.** It catches a change larger than a case's band — the 2× positive control reads +134% and fails, as it should. On allocating cases on a loaded dev box those bands are wide (20–40%), so a genuine 10% regression will pass unnoticed there. Bands recorded on a quiet machine are much tighter; that is the lever, not the threshold.
- `bench/leak.ts` samples the heap through **`Bun.gc(true)`'s return value**. `process.memoryUsage().heapUsed` is inert under Bun — it reported a flat 0.17 MB while a deliberately-retaining control grew the real heap from 8 MB to 48 MB.
- Bench-internal imports use the `#bench/*` alias (→ `bench/*`), the same way `src` uses `@/*`.

`.husky/pre-commit` runs `test:unit`, `test:coverage`, `knip` and `setup` through `mise exec`; commit messages are enforced by commitlint (conventional commits).

## Architecture

One event flows through a fixed pipeline, and every design decision hangs off it:

```
log.info(meta, msg)
  → Logger.makeLevelFn  (parse pino-style call shape)
  → Logger.emit         (build ILogEvent; merge bindings + AsyncLocalStorage context)
  → processors[]        (sync, in order; `null` drops the event)
       [domain]         (auto-injected: beans objects → their safe form)
       [redact]         (auto-injected: key-name masking)
       …user processors
  → transports[]        (fire-and-forget broadcast, per-transport `level` gate)
```

- **`src/logger.ts`** is the core. The dropped-log path is the optimisation target: in the constructor, every level method below the threshold is bound to the shared `NOOP_VOID` (`src/internal/noop.ts`) — zero allocation, no event ever built. Keep new work out of `emit` unless it must run per effective event.
- **Context is injected, not imported.** The core never statically imports `node:async_hooks`. `src/context/index.ts` calls `_registerContextReader(getContext)` as an import side effect; the core lazy-reads it in `emit`. Context bindings **override** logger bindings on key collision (narrower scope wins). Do not add a static dependency from the core to `context/`.
- **Transports never throw at the caller.** `Logger.emit` catches sync throws and attaches `.catch` to returned promises, wrapping both in an `AromaException` delivered to `onError`. One failing transport must never block peers or the caller.
- **Processors never throw at the caller either.** The guarantee above used to cover only half the pipeline. `Logger.emit` now runs the processor loop under `try`, reports a `ProcessorFailureException` through `onError`, and writes a diagnostic line straight to the transports — bypassing the pipeline, so the processor that just threw cannot take down the report of its own failure. The event in flight is **discarded**: a processor that failed midway leaves it indeterminate, possibly still holding what the redaction step had not finished redacting, and forwarding that would turn a processor failure into the leak it exists to prevent. This matters more since the domain integration, because the pipeline now runs beans code and a consumer-supplied placeholder function.
- **The transports' level gate is resolved at construction, like the logger's own.** `minTransportLevel` is the lowest level any transport accepts; an event below it returns from `emit` before the pipeline runs, instead of after. The corollary is a contract: a processor must not change an event's severity — see `IProcessor`. A `Logger` with no transports accepts nothing and therefore runs no processors.
- **Processors own cross-cutting concerns** (`src/processors/`), so a transport can never "forget to redact". `createAroma` auto-injects `[domain, redact]` ahead of user processors unless `redact: false` (the single switch turns off both). Processors are synchronous and should return a new event rather than mutating — `event.bindings` is frozen when no async context is active.
- **The domain conversion runs at four points, not one.** The processor covers `bindings`/`meta`; `serializeError` converts `err.cause` (it runs inside `emit`, *before* the pipeline, so the processor never sees that branch); `Logger.makeLevelFn` converts a domain object passed as `meta` itself (before the spread — afterwards it is unrecognisable, and the line silently reads `"meta":{}`); and the converter descends into `Array`/`Map`/`Set`, because a collection is how call sites carry domain objects. `src/processors/domain.spec.ts` has an adversarial spec covering all four routes — if you add a fifth way into a log line, add a door to it.
- **The domain processor closes a leak neither package could close alone** (`src/processors/domain.ts` → `src/internal/domain-safe.ts`). `Entity.toJSON()` / `DomainRecord.toJSON()` are the lossless, *unredacted* persistence contract, and `JSON.stringify` — which every serialisation path reaches — calls exactly that; key-name redaction can't help because the sensitive field sits one level below a harmless top-level key. The processor swaps in `toSafeJSON()` (`Command.toJSON()` already redacts), unwraps non-sensitive `ValueObject`s, replaces sensitive ones with the placeholder, and flattens domain events into `key.*` siblings. It runs **before** redact, so what it produces still passes under key-name masking. Detection is ordered — named `instanceof` first, then the structural `toSafeJSON` branch, which is **required**, not legacy duck-typing: `arrayOf`/`optionalOf`/`nullableOf` mint anonymous classes at runtime, so there is no class to match on. Depth is one level, matching redact; recursion inside a domain object is `toSafeJSON`'s job.
- **Detection is `instanceof` first, structural second, and the second is not optional.** Two copies of `@roastery/beans` in one `node_modules` mint two class bases, so an instance of one is not `instanceof` the other — detection fails with no type error and no exception, and the leak returns silently. The `toSafeJSON` branch catches foreign entities/records/wrappers; `defineMeta` catches foreign value objects (the same discriminant beans uses internally). A value object whose `[Meta]` is unreachable — what a duplicated *terroir* looks like — is **redacted, not unwrapped**: "cannot tell" has to resolve to the safe answer. Keep `bun pm ls` down to one copy of each pillar.
- **The redaction placeholder is the beans one** (`src/internal/redacted-value.ts`). `redactionConfig()` is read per call, never cached, so a runtime `configureRedaction` applies to loggers already built — and one setting governs both packages, which is the only way they can't disagree on a single line. It may be a function, so never assume the placeholder is a string.
- **Format processors brand the event.** `serializeEvent` (`src/internal/serializer.ts`) has a hand-rolled fast path that only understands the canonical `ILogEvent` keys. A processor that reshapes the event (e.g. `createEcsProcessor`) must stamp the `FORMATTED` symbol (`src/internal/formatted.ts`) or its remapped keys are silently dropped on serialisation. Such processors must run **last**.
- **Buffered writing** lives in `src/internal/buffered-writer.ts` (shared by `FastStdioTransport` and `FileTransport`): `push()` schedules a flush on the next tick via `setImmediate` (coalescing to one syscall per tick), `maxBuffered` triggers the backpressure policy (`drop` | `sample` | `block`). `error`/`fatal` bypass the buffer and use `writeSync` (`syncFatal: true`) so a line survives an immediate `process.exit()` — preserve that guarantee.
- **Errors are normalised to the terroir hierarchy.** `serializeError` (`src/internal/serialize-error.ts`) converts any thrown value to a plain JSON-safe `{ name, message, stack, source, layer, cause }`; non-`CoreException` values are wrapped in `UnknownException` with the original under `cause` (walked recursively). `ILogEvent.err` is never a live `Error`. Ad-hoc own-properties are still deliberately not carried over — `code` is the one exception, and only for `ApplicationException`, where terroir declares it as an abstract canonical member (the HTTP status) rather than a field someone happened to attach.
- **`@opentelemetry/api` is an optional peer**, dynamically imported in `src/otel/trace-context.ts` and cached; `primeOtel()` resolves it once so processor reads stay synchronous. Never import it statically.

### Contracts this package assumes from `@roastery/beans`

`beans` is pre-1.0 and breaks by design, so the integration rests on behaviours a minor could change. Each is pinned by a spec — if you raise the beans version, re-read these first:

| Assumed | Why it matters | Pinned by |
|---|---|---|
| `Entity.toJSON()` / `DomainRecord.toJSON()` do **not** redact | the entire reason the domain processor exists | `src/processors/domain.spec.ts` ("premise") |
| `Command.toJSON()` **does** redact | why commands take the `toJSON` branch | `src/internal/domain-safe.spec.ts` |
| `[Meta]` is an **instance** slot keyed by terroir's `Meta` symbol | how `sensitive` / `redactWith` are read | `src/internal/domain-safe.spec.ts` |
| `defineMeta` is a prototype method on every value object | the cross-copy fallback | `src/internal/domain-safe.spec.ts` |
| `arrayOf`/`optionalOf`/`nullableOf` guarantee `toSafeJSON` | wrappers are anonymous classes, unreachable by `instanceof` | `src/internal/domain-safe.spec.ts` |
| `redactionConfig()` is module state with `"[redacted]"` as default | shared placeholder | `src/internal/redact.spec.ts` |

The version is pinned with a tilde (`~0.6.0`) rather than a caret so a minor cannot arrive on its own.

## Conventions

- Import via the `@/*` alias (→ `src/*`), including inside `src` itself and in `bench/`; bench-to-bench imports use `#bench/*` (→ `bench/*`). Relative imports are not used. Both aliases are tsconfig `paths` — `baseUrl` is gone, TypeScript 7 removed it.
- **Each directory's `index.ts` is a public subpath** — `package.json` `exports` maps `./*` to `dist/*/index.js`, and tsup builds exactly `src/**/index.ts` plus `src/transports/worker/file-worker.ts`. Adding a new public surface means adding a directory with a barrel; anything not reachable from a barrel is flagged by knip (entries are configured in `knip.json`).
- Tests are colocated `*.spec.ts` next to the source, using `bun:test`. Transport behaviour is asserted through `NullTransport` (`transport.events`), never by inspecting a return value — level methods return `void`.
- Public API carries heavy TSDoc (`@remarks`, `@example`, `@see`). Match that density when adding exported symbols; internal helpers are tagged `@internal`.
- Biome formats with **tabs** and double quotes and sorts imports — run `bun run build` (or `biome check --fix`) rather than hand-formatting.
- Notable API surprise to preserve: `transports: []` means "no preference" and injects a `FastStdioTransport`; a silent logger requires an explicit `NullTransport`.
