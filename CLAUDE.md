# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

`@roastery/aroma` — structured, transport-based logger (pino-style API) for the Roastery CMS ecosystem. Library only: no app, no server. Runtime/toolchain is **Bun** (pinned via `mise.toml`); the published bundle is produced by tsup in ESM + CJS + `.d.ts`.

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

bun run bench               # writes bench/current.json
bun run bench:compare       # bench + diff against bench/baseline.json (fails >5% regression)
bun run bench:leak
```

`.env.testing` is untracked (`.env*` is gitignored); `bun test` alone works when it is absent. `bunfig.toml` preloads `test/set-max-listeners-to-zero.ts` and `test/replace-node-env.ts`, and runs tests serially (`serial = true`) — transports touch real fds/files, so keep new tests order-independent anyway.

`.husky/pre-commit` runs `test:unit`, `test:coverage`, `knip` and `setup` through `mise exec`; commit messages are enforced by commitlint (conventional commits).

## Architecture

One event flows through a fixed pipeline, and every design decision hangs off it:

```
log.info(meta, msg)
  → Logger.makeLevelFn  (parse pino-style call shape)
  → Logger.emit         (build ILogEvent; merge bindings + AsyncLocalStorage context)
  → processors[]        (sync, in order; `null` drops the event)
  → transports[]        (fire-and-forget broadcast, per-transport `level` gate)
```

- **`src/logger.ts`** is the core. The dropped-log path is the optimisation target: in the constructor, every level method below the threshold is bound to the shared `NOOP_VOID` (`src/internal/noop.ts`) — zero allocation, no event ever built. Keep new work out of `emit` unless it must run per effective event.
- **Context is injected, not imported.** The core never statically imports `node:async_hooks`. `src/context/index.ts` calls `_registerContextReader(getContext)` as an import side effect; the core lazy-reads it in `emit`. Context bindings **override** logger bindings on key collision (narrower scope wins). Do not add a static dependency from the core to `context/`.
- **Transports never throw at the caller.** `Logger.emit` catches sync throws and attaches `.catch` to returned promises, wrapping both in an `AromaException` delivered to `onError`. One failing transport must never block peers or the caller.
- **Processors own cross-cutting concerns** (`src/processors/`), so a transport can never "forget to redact". `createAroma` auto-injects the redact processor ahead of user processors unless `redact: false`. Processors are synchronous and should return a new event rather than mutating — `event.bindings` is frozen when no async context is active.
- **Format processors brand the event.** `serializeEvent` (`src/internal/serializer.ts`) has a hand-rolled fast path that only understands the canonical `ILogEvent` keys. A processor that reshapes the event (e.g. `createEcsProcessor`) must stamp the `FORMATTED` symbol (`src/internal/formatted.ts`) or its remapped keys are silently dropped on serialisation. Such processors must run **last**.
- **Buffered writing** lives in `src/internal/buffered-writer.ts` (shared by `FastStdioTransport` and `FileTransport`): `push()` schedules a flush on the next tick via `setImmediate` (coalescing to one syscall per tick), `maxBuffered` triggers the backpressure policy (`drop` | `sample` | `block`). `error`/`fatal` bypass the buffer and use `writeSync` (`syncFatal: true`) so a line survives an immediate `process.exit()` — preserve that guarantee.
- **Errors are normalised to the terroir hierarchy.** `serializeError` (`src/internal/serialize-error.ts`) converts any thrown value to a plain JSON-safe `{ name, message, stack, source, layer, cause }`; non-`CoreException` values are wrapped in `UnknownException` with the original under `cause` (walked recursively). `ILogEvent.err` is never a live `Error`. Custom own-properties (`err.code`, …) are deliberately not carried over.
- **`@opentelemetry/api` is an optional peer**, dynamically imported in `src/otel/trace-context.ts` and cached; `primeOtel()` resolves it once so processor reads stay synchronous. Never import it statically.

## Conventions

- Import via the `@/*` alias (→ `src/*`), including inside `src` itself and in `bench/`. Relative imports are not used.
- **Each directory's `index.ts` is a public subpath** — `package.json` `exports` maps `./*` to `dist/*/index.js`, and tsup builds exactly `src/**/index.ts` plus `src/transports/worker/file-worker.ts`. Adding a new public surface means adding a directory with a barrel; anything not reachable from a barrel is flagged by knip (entries are configured in `knip.json`).
- Tests are colocated `*.spec.ts` next to the source, using `bun:test`. Transport behaviour is asserted through `NullTransport` (`transport.events`), never by inspecting a return value — level methods return `void`.
- Public API carries heavy TSDoc (`@remarks`, `@example`, `@see`). Match that density when adding exported symbols; internal helpers are tagged `@internal`.
- Biome formats with **tabs** and double quotes and sorts imports — run `bun run build` (or `biome check --fix`) rather than hand-formatting.
- Notable API surprise to preserve: `transports: []` means "no preference" and injects a `FastStdioTransport`; a silent logger requires an explicit `NullTransport`.

## Current state note

`src/**` still imports `@roastery/terroir` (exceptions hierarchy, `serialize-error.ts` and `aroma-exception.ts`), but the working tree has removed it from `package.json` `dependencies` and deleted `bun.lock`. Anything touching those files needs the dependency reinstated (or the imports replaced) before it can build or test.
