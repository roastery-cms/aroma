# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-08-26

The first release since `0.0.3`, and everything below is written against it —
`0.0.3` is the only version any consumer can have installed. Four in-tree
version bumps (`0.2.0` through `0.5.0`) were staged during this work and never
reached the registry; they are not releases and are not listed. The record of
how the work was sequenced lives in `docs/plans/`.

### Changed

- **BREAKING — key-name masking is opt-in.** `0.0.3` applied a built-in key
  list to every event and offered `redact` to extend or disable it. The list is
  no longer applied by default, and the `redact` option is gone from
  `CreateAromaArgs` — all three forms (`redact: [...]`, `redact: false`,
  `redact: { keys, maxDepth }`) are removed rather than repurposed, so a stale
  line fails to compile instead of quietly changing meaning. These now reach
  the log as written:

  ```ts
  log.info({ password: "hunter2" }, "signup");
  log.info({ req: { headers: { authorization: "Bearer …" } } }, "request");
  log.info({ stripe: { token: "tok_…" } }, "charged");
  ```

  One line restores the old behaviour:

  ```ts
  import { createRedactProcessor, DEFAULT_REDACT_KEYS } from "@roastery/aroma/processors";

  createAroma({
    processors: [createRedactProcessor({ keys: [...DEFAULT_REDACT_KEYS] })],
  });
  ```

  The reasoning: the domain layer is what knows which of its fields are
  sensitive, and `toSafeJSON()` acts on that knowledge — see the domain
  integration below, which is new in this release and covers what the key list
  was mostly standing in for. A key-name list inside the logger duplicates that
  imperfectly, fires on fields that are not secrets, and charges every event
  for the scan. What it *did* cover is everything the domain layer never models
  — a Node request, a third-party response, a DTO at the edge — and that is now
  an explicit decision at the call site rather than a default nobody chose.

  Because nothing in the type system reaches someone who never passed `redact`,
  the logger says so itself at startup: once per process, on stderr **and** as
  one branded `warn` line on the log stream. Silence it with
  `acknowledgeNoMasking: true`.

- **BREAKING — `@roastery/terroir` moved from `^0.1.0` to `^0.2.2`**, and
  `@roastery/beans` (`~0.6.0`) is a new direct dependency. The stack is
  **terroir → beans → aroma → barista**: aroma sits above beans, so both are
  ordinary dependencies and the integration uses real types and `instanceof`
  rather than duck-typing. `beans` is pinned with a tilde rather than a caret
  because it is pre-1.0 and breaks by design; the behaviours this package
  relies on are listed in `CLAUDE.md` and each is pinned by a spec.

- **BREAKING — the redaction placeholder comes from `@roastery/beans`.**
  `redactionConfig()` is read per call and never cached, so a runtime
  `configureRedaction` applies to loggers already built, and one setting
  governs both packages — the only way they cannot disagree on a single line.
  It may be a function, so do not assume the placeholder is a string.

- **BREAKING — a `Map` is normalised to a plain object and a `Set` to an
  array** wherever either appears in `bindings` or `meta`. Passing them through
  by identity looked like preservation and was not: `JSON.stringify(new Map())`
  is `{}`, so a `Map` did not survive serialisation at all, and any masking
  applied inside it became invisible rather than absent.

- **The transports' level gate is resolved at construction.** An event below
  the lowest level any transport accepts returns from `emit` before the
  pipeline runs rather than after. The corollary is a contract: a processor
  must not change an event's severity. A `Logger` with no transports accepts
  nothing and therefore runs no processors.

- **`typescript` moved to `devDependencies`** at `5.9.3`, with the peer range
  widened to `^5 || ^7`. `tsconfig.json` no longer sets `baseUrl`, which
  TypeScript 7 removed; the `@/*` path alias carries the resolution instead.

### Added

- **Domain-object safety, injected into every `createAroma` pipeline and not
  removable.** This is the reason for the release. `Entity.toJSON()` and
  `DomainRecord.toJSON()` are the *persistence* contract — lossless and
  deliberately unredacted — and `JSON.stringify`, which every transport
  eventually reaches, calls exactly that. So `log.info({ user }, "created")`
  wrote a `sensitive` property in the clear, and key-name masking could not
  help: the top-level key (`user`) is not itself sensitive and the leak sat one
  level below it. The processor swaps in `toSafeJSON()`, unwraps non-sensitive
  `ValueObject`s, replaces sensitive ones with the placeholder, and flattens a
  top-level domain event into `key.*` siblings.

  It reaches **everywhere from every entry point**: under a plain literal,
  inside an array, a `Map`, a `Set`, an ordinary class instance, behind a
  `toJSON()` that reads state the walk cannot see, and through `err.cause` and
  a domain object passed as `meta` itself. Detection is `instanceof` first and
  structural (`toSafeJSON` / `defineMeta`) second, because two copies of
  `beans` in one `node_modules` mint two class bases — and a value object whose
  metadata is unreachable is **redacted, not unwrapped**: "cannot tell" has to
  resolve to the safe answer.

  There is no switch to turn it off. A logger that converts nothing is
  `new Logger({ … })`, exported from the root for exactly this kind of control.

- **`createAroma({ maxDepth })`** — how many levels the conversion descends
  into `bindings`, `meta` and `err.cause`. An integer in `1..64`, default 24,
  rejected at construction rather than clamped: a bound you did not get is
  worse than an error you did. A `child` inherits it. Past the bound the walk
  substitutes `"[truncated: depth]"` rather than passing a subtree through
  unconverted — a bound here costs visibility, never safety.

- **A bound on width as well as depth.** A walk enters at most 10.000 objects
  per event and substitutes `"[truncated: node budget]"` at the door of the
  first one past that. Nesting was bounded and breadth was not.

- **`isDiagnostic(event)`**, exported from the root. The line reporting a
  processor failure is re-run through the pipeline to keep the stream's format,
  which means every other processor sees it — a metric counter or a sampling
  budget would otherwise count the logger's own failure as traffic. Excluding
  it is a call only that processor's author can make, so this is the hook
  rather than a default.

- **`ProcessorFailureException`**, exported from the root and from
  `@roastery/aroma/exceptions`, carrying the failing processor's name.

- **A domain-object overload on every level method** — `log.info(user,
  "created")` converts before the `{ ...meta }` snapshot, which would otherwise
  leave the line reading `"meta":{}`.

- **`err.code` for application-layer exceptions.** `terroir` declares it as an
  abstract canonical member (the HTTP status) rather than a field someone
  happened to attach, so it is carried; other ad-hoc own-properties still are
  not.

- **A generative leak sweep** (`src/internal/leak-sweep.spec.ts`): every
  container shape × every entry point into a log line, every nested pair of
  shapes, and the whole depth ladder, asserted on each run for both the
  `[domain]` and `[domain, redact]` pipelines — with a positive control, so a
  sweep that has stopped being able to fail says so.

- **Benchmark and diagnostic tooling**: `bun run bench:import` (module-graph
  load cost of the built package), `bun run bench:leak` (heap retention per
  scenario), and throughput cases covering nesting, width, class instances and
  the domain conversion.

### Fixed

- **A processor that throws no longer takes down the caller.** `Logger.emit`
  runs the processor loop under `try`, reports a `ProcessorFailureException`
  through `onError`, and writes a diagnostic line — re-run through the pipeline
  with **only the processor that threw removed**, so the culprit cannot take
  down the report of its own failure while a format processor still shapes it.
  The event in flight is discarded: a processor that failed midway leaves it
  indeterminate, and forwarding that would turn a failure into a leak.

- **A hostile getter or `Proxy` trap in the payload no longer takes down the
  log call.** The event is built before the pipeline exists, and both
  `asMeta` and the `{ ...meta }` snapshot invoke every own enumerable getter.
  Both reads are now guarded and degrade the affected record rather than the
  line.

- **A failing processor no longer floods the stream.** One diagnostic line per
  second per failure message, with the swallowed count carried into the next
  one; keying on the message as well as the processor is what stops a second,
  different failure from vanishing inside the first one's window. `onError`
  still fires every time — it is your telemetry hook, not the log stream.

- **A cycle no longer carries an unredacted copy out through the back
  reference**, and a self-referential domain event no longer exhausts the
  stack.

- **`err.cause` is converted and masked** when it is a plain object or a domain
  object. `serializeError` runs inside `emit`, before the pipeline, so this is
  the one path into a log line a processor never sees — and terroir actively
  encourages putting the original failure there.

- **`createEcsProcessor` no longer drops `err.code`**, and flattened
  domain-event keys no longer collide with the reserved ECS `event` namespace.

- **`AromaException` forwards `cause` through the native `ErrorOptions` slot**,
  so it survives serialisation like any other exception's.

### Performance

- The default pipeline is substantially faster than the `0.0.3` shape despite
  doing more: a flat payload and an event carrying an `Entity` both improved,
  because the built-in key scan no longer runs on every event and the single
  shared traversal returns the original by identity when nothing matched.
- **One traversal**, not two. Domain conversion and key-name masking are the
  same walk over the same payload with a different decision per node, so there
  is one depth bound, one set of descent rules and one cycle guard — which is
  also why they cannot drift apart and open a gap between them again.
- Dropped-level calls are bound to a shared no-op at construction: zero
  allocation, no event ever built.
- Benchmarks run one child process per case, because `Logger.emit` and
  `ITransport.write` are single call sites and measuring cases side by side
  degrades their inline caches. The regression gate widens the 5% threshold to
  each case's measured noise band and re-measures a suspect before failing.

## [0.0.3] - 2026-06-16

> Numbered `0.0.2` until this release. The registry has `0.0.1` and `0.0.3` and
> never had a `0.0.2`; comparing the two published tarballs puts the error
> normalisation below in `0.0.3`, so that is what this block is.

### Changed

- **Logged errors are normalised to the `terroir` exception hierarchy.** A
  thrown value that already derives from `CoreException` (any layer) is
  serialised as-is, preserving its `name`, `source` and layer discriminator;
  anything else — a native `Error`, or a non-`Error` value caught as
  `unknown` — is wrapped in an `UnknownException` (`source: "$internal"`,
  `layer: "internal"`) with the original value preserved under `cause`.
  `ILogEvent.err` is consequently re-typed from a `CoreException` *instance*
  to a plain, JSON-safe `{ name, message, stack?, source, layer, cause? }`
  object (`cause` is serialised recursively). Custom own-properties on the
  error (`err.code`, `err.statusCode`, …) are intentionally **not** carried
  over — only the canonical fields are emitted.
- **Buffered transports now flush on the next event-loop tick.**
  `FastStdioTransport` / `FileTransport` previously only scheduled a flush once
  the buffer crossed `bufferSize` (4 KB), so low-volume `info`/`warn` logs were
  stranded in memory — and lost entirely if a short-lived process exited before
  the buffer filled. `BufferedWriter.push()` now schedules a flush every tick
  (coalescing repeated writes into one syscall), so logs appear without an
  explicit `flush()`. `bufferSize` is now an advisory hint and no longer gates
  flush timing. `error`/`fatal` remain synchronous.

### Fixed

- **`log.error()` no longer emits an empty `err: {}`.** `serializeError` had
  been reduced to an identity stub while `ILogEvent.err` was typed as a
  `CoreException` *instance*, so `JSON.stringify` produced `{}` — `Error`'s
  `name`/`message`/`stack`/`cause` are non-enumerable and never made it into
  the serialised line. Errors are again converted to a plain object carrying
  `name`/`message`/`stack`/`source`/`layer`, with `cause` walked recursively,
  so the full error is visible in the log output.
- **ECS processor now actually works with the bundled transports.** Events
  reshaped by `createEcsProcessor()` were silently stripped back to
  `{level,time,bindings}` by `serializeEvent`, which only understood the
  canonical event shape. Format-final events are now branded and serialised
  verbatim, so `@timestamp` / `log.level` / `message` / `error.*` survive.
  Canonical `level`/`time` stay readable for transport routing but no longer
  leak into the ECS line.
- **`BufferedWriter` / `FileTransport` size accounting now counts UTF-8 bytes**
  (`Buffer.byteLength`) instead of UTF-16 code units, so `bufferSize`,
  `maxBuffered` and `rotation.size` are honest for multibyte payloads.
- **ECS now survives the `WorkerTransport` boundary.** `postMessage`'s
  structured clone drops symbol-keyed and non-enumerable properties, so the
  format brand and `level`/`time` were lost off-main-thread — producing
  invalid, content-free lines. `WorkerTransport` now carries them in the
  message envelope and the bundled `file-worker` re-applies them before
  serialising.
- **`FileTransport.bytesWritten` no longer counts dropped lines.**
  `BufferedWriter.push()` now reports whether a line was accepted, so bytes
  discarded by the `"drop"`/`"sample"` policies no longer inflate the counter
  or trigger size rotation on phantom bytes.
- **`safeStringify` coerces `BigInt` to its decimal string** instead of
  throwing, so a `BigInt` in `meta`/`bindings` is preserved through the
  fallback path rather than silently lost.
- **`WorkerTransport.flush()`/`close()` no longer hang if the worker dies.**
  A crashed worker never replies `"flushed"`, leaving `flush()` pending
  forever; a new `"exit"` handler marks the transport closed and resolves any
  in-flight flush so graceful shutdown completes.
- **`IProcessor` is now re-exported from `@roastery/aroma/types`**, matching
  the documented public surface (the barrel previously omitted it).
- **Bundled `file-worker` is now built and exported** at
  `@roastery/aroma/transports/worker/file-worker` (previously absent from the
  published `dist`, so the documented `WorkerTransport` example could not
  resolve it).
- Removed a dead `dirname()` statement in `FileTransport` and unused test
  imports flagged by Biome.

### Docs

- Added a `README.md`, package `description` and `keywords`.
- Corrected the `createAroma` doc (default transport is `FastStdioTransport`,
  not `ConsoleTransport`).
- Fixed the `"block"` backpressure policy docs: it never drops and may grow
  past `maxBuffered`; removed the reference to a non-existent `pushAsync()`.
- Clarified `IProcessor` mutation guidance (`event.bindings` is frozen — return
  a new object instead of mutating it).
- Strengthened the `createEcsProcessor` "must run last" contract and corrected
  the serializer comment about `BigInt`/`Symbol` handling.

### Tests

- Updated error-serialisation specs for the wrapped-`UnknownException` shape
  and added a case asserting a `CoreException` (e.g. `AromaException`) passes
  through with its `source`/`layer` intact.
- Added ECS round-trip tests through `serializeEvent` and a real transport.
- Added a `WorkerTransport` end-to-end spec covering the structured-clone
  boundary (plain + ECS events), the `onError`/worker-crash path, and a
  `BigInt` serializer test.
- Added `FileTransport` coverage for interval-timer rotation (via fake timers)
  and the hourly rotation suffix.
- Wired the `test/` setup helpers via `bunfig.toml` `preload`.
