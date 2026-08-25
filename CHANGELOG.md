# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-08-25

### Fixed

- **A processor that throws no longer takes down the caller.** `Logger.emit`
  ran the pipeline unguarded — the guarantee `CLAUDE.md` states for transports
  covered only half of it. That was tolerable while every processor was our
  own trivial synchronous code; it stopped being tolerable when the pipeline
  began running `@roastery/beans` code (`toSafeJSON`, recursive) and, through
  the redaction placeholder, **arbitrary consumer code**. A throw is now
  wrapped in a `ProcessorFailureException` delivered to `onError`, plus a
  diagnostic line written straight to the transports; the event in flight is
  **discarded**, because a processor that failed midway leaves it possibly
  still holding what a redaction step had not finished redacting.
- **Redaction is no longer top-level only.** `{ req: { headers: {
  authorization } } }` — the commonest shape in an HTTP service — came out in
  the clear, and nothing in the domain integration reached it, because a Node
  request is not a `beans` object. Keys now match by name at any depth (six by
  default), with a lazy clone at every level so an event carrying nothing
  sensitive still allocates nothing.
- **`err.cause` is redacted when it is a plain object.** `new
  BadRequestException("auth", "failed", { cause: { password } })` wrote it out:
  neither redact module had ever looked at `err`. `err`'s canonical fields
  (`name`, `message`, `stack`, `source`, `layer`, `code`) are deliberately left
  alone — a key list containing `"message"` must not erase the diagnostic.
- **A cycle no longer carries an unredacted copy out.** Found by the
  adversarial spec: on meeting a back reference the traversal returned the
  ancestor object itself, which still held the values being redacted one frame
  up. It now substitutes `"[Circular]"`, the same sentinel `safeStringify`
  already used.

### Added

- `ProcessorFailureException`, exported from the root and from
  `@roastery/aroma/exceptions`, carrying `processorName` and the thrown value
  as `cause`.
- **A domain-object overload on every level method.** `log.info(user,
  "created")` did not compile: `Bindings` is `Record<string, unknown>`, and
  TypeScript gives an implicit index signature to object literals but not to
  class instances — so the runtime support for it was reachable only from
  JavaScript or through a cast. `IDomainLoggable` (exported from
  `@roastery/aroma/types`) describes it structurally, for the same reason the
  runtime detection is structural.
- `redact` accepts `{ keys, maxDepth }`. `maxDepth: 1` restores the previous
  top-level-only behaviour exactly.
- `deep-miss` / `deep-hit` throughput cases, and the `maxDepth` default is now
  backed by a measurement rather than a guess.

### Changed

- **BREAKING — more fields are redacted than before.** Any key in the redact
  list is now masked wherever it appears, not only at the top level. A
  consumer who depends on seeing a nested field in the clear should pass
  `redact: { maxDepth: 1 }`. This is a separate breaking change from the
  placeholder change in 0.2.0 and needs its own look at dashboards and alerts.
- **The transports' level gate is resolved at construction.** An event no
  transport would accept now returns from `emit` *before* the pipeline runs
  rather than after, so a `log.debug({ aggregate })` in a service whose
  transports are all at `error` no longer pays for a full `toSafeJSON`. The
  corollary is a new contract, documented on `IProcessor`: **a processor must
  not change an event's severity.** No bundled processor ever did. A `Logger`
  built with no transports now runs no processors, since nothing could receive
  the result.
- Redaction keys are now built into a `Set` once per processor instead of once
  per event. The per-event `new Set(…)` cost 248 ns — more than the traversal
  it was for — and the cycle-detection `WeakSet` is now allocated only on the
  first real descent, not on every call. Together these took a flat 4-key
  payload from 1060 ns back to 256 ns.

### Tests

- `test/reset-beans-redaction.ts` is preloaded, restoring the beans redaction
  default before every test. `configureRedaction` is module state and the suite
  runs serially, so a spec that changed it and forgot to restore it did not
  fail itself — it failed whichever spec ran next, far from the cause.
- An adversarial pipeline spec covering the five ways to break it: a throwing
  processor, `authorization` four levels down, a plain `err.cause` holding a
  password, a cycle, and a `log.debug` no transport accepts.
- A type-level spec exercising all four level-method overloads, so one placed
  in the wrong order — or degraded to `any` — fails `tsc` instead of failing
  silently.

## [0.3.0] - 2026-08-25

### Fixed

- **Three more routes a `sensitive` field could take out of the process.**
  0.2.0 closed `log.info({ user }, "…")` and left three call shapes just as
  common open. All four are now covered by an adversarial spec that tries each
  door in turn:
  - **`err.cause`.** `serializeError` runs inside `Logger.emit`, *before* the
    processor pipeline, so the domain processor never saw that branch — while
    terroir's own TSDoc encourages translating a low-level failure by passing
    the original as `cause`. `new BadRequestException("checkout", "…", { cause:
    user })` wrote the password out. The error serialiser now converts it,
    recursively.
  - **Inside a collection.** `{ users: [alice, bob] }` matched no `instanceof`
    and carried no `toSafeJSON`, so it came back by identity and
    `JSON.stringify` called each item's lossless `toJSON()`. The converter now
    descends into `Array`, `Map` and `Set`. This is not deep redaction of plain
    objects — a nested literal is still left alone; a collection is simply how
    call sites carry domain objects.
  - **An instance from a second copy of `@roastery/beans`.** Two copies in one
    `node_modules` mint two class bases, so `instanceof` fails while the object
    is an entity in every way that matters — detection failed with no type
    error and no exception. Detection now also matches structurally
    (`toSafeJSON`, and `defineMeta` for value objects, the same discriminant
    beans uses internally). A value object whose `[Meta]` is unreachable is
    **redacted rather than unwrapped**: "cannot tell" resolves to the safe
    answer.
- **`log.info(user, "created")` no longer silently empties the entry.** Passing
  a domain object as `meta` itself was not a leak but a disappearance: `emit`
  spreads `meta`, a spread copies symbol keys, an entity keeps its state under
  `[Context]`/`[Properties]`/`[Source]`, and `JSON.stringify` drops symbols —
  so the line read `"meta":{}`. The object is now converted **before** the
  spread, where it is still recognisable. Plain literals pay one
  `getPrototypeOf` for the check.
- **`err.code` survives the ECS mapping.** `createEcsProcessor` mapped only
  `name`/`message`/`stack`, dropping the status code in the one format where it
  is most useful. It now emits `error.code` (a string, per ECS) and, on the
  application layer, `http.response.status_code` (a number) — the field HTTP
  dashboards actually query.
- **Flattened domain-event keys no longer collide with the ECS `event`
  namespace.** The ECS processor spreads `meta` at the document root, so
  `"order.name"` reached Elasticsearch as a dotted path, expanded into an
  `event` object, and collided with the reserved ECS meanings of
  `event.action` / `event.id` / `event.created` — producing a document that
  looked like ECS and was not. Those keys are now translated to their real ECS
  fields, with `event.kind` and an `event.dataset` from the prefix; any
  `<k>.payload` stays outside the namespace.

### Changed

- `@roastery/beans` is pinned with a tilde (`~0.6.0`). It is pre-1.0 and breaks
  by design, and this package now depends on several of its behaviours; a minor
  should not arrive on its own. The assumed contracts are tabulated in
  `CLAUDE.md`, each with the spec that pins it.
- `typescript` moved to `devDependencies` at `5.9.3`, and the peer range
  widened from the exact `7.0.2` to `^5 || ^7`. TypeScript 7 is the native port
  and exposes no `ts.sys`, which tsup's declaration bundler reads — the package
  could not build a `.d.ts` under the version its own peer range demanded.

### Added

- Collections (`Array`, `Map`, `Set`) are converted item by item. A `Map`
  becomes a plain object and a `Set` an array rather than coming back by
  identity, because `JSON.stringify` renders both as `{}` — for those two,
  identity does not preserve the entry, it erases it.
- `bun run bench:import` reports the module-graph load cost of the built
  package, and a `domain-collection` throughput case covers the new per-item
  descent.

### Docs

- `CreateAromaArgs.redact` and the README record what `redact: false` costs:
  serialise domain objects at the call site, and note that a live instance
  cannot cross a `WorkerTransport` boundary (structured clone keeps only own
  enumerable string keys, and an entity keeps its state under symbols, so it
  arrives as `{}`). Pinned by a spec so it stays a documented choice rather
  than a bug waiting to be filed.

## [0.2.0] - 2026-08-25

### Added

- **Domain processor — `@roastery/beans` objects are made safe before they are
  serialised.** `createDomainProcessor()` sweeps the top level of `bindings` /
  `meta` and swaps every domain object for its loggable form: an `Entity` /
  `DomainRecord` / multiplicity wrapper becomes `toSafeJSON()`, a `Command`
  becomes `toJSON()` (which `beans` already redacts), a `ValueObject` is
  unwrapped to its raw `.value` — or replaced by the redaction placeholder when
  its class declares `sensitive: true` — and a domain event is flattened into
  prefixed sibling keys (`event.name`, `event.aggregateId`, `event.occurredAt`,
  `event.payload`). `createAroma` injects it automatically **ahead of** the
  redact processor, so the final pipeline is `[domain, redact, ...processors]`.
  `redact: false` opts out of both. Exported from `@roastery/aroma/processors`.
- **`err.code` is now emitted for application-layer exceptions.** `terroir`
  0.2.x declares `code` as an abstract, canonical member of
  `ApplicationException` — every one of its concrete classes has one — so
  carrying it preserves the hierarchy rather than promoting an ad-hoc
  own-property (which 0.0.2 deliberately excluded, and still does). Absent for
  the domain, infra and internal layers, which are transport-agnostic by
  design. Serialised recursively, so an application-layer `cause` carries its
  status too.
- **`@roastery/beans` is a direct dependency.** The stack is
  terroir → beans → aroma → barista: the logger sits *above* beans, so the
  integration is by real types and `instanceof`, not duck-typing.

### Changed

- **BREAKING — the redaction placeholder now comes from `@roastery/beans`.**
  `redactShallow` no longer hard-codes a sentinel; it reads
  `redactionConfig().placeholder` per call. The default output therefore
  changes from `"[REDACTED]"` to `"[redacted]"`, and a single
  `configureRedaction({ placeholder })` at startup now governs the logger and
  the domain layer together — they can no longer disagree on the same log line.
  **Alerts, dashboards and log queries that match the literal string need
  updating.** A **function** placeholder is now supported as well
  (`(value, { name, source }) => unknown`, for partial masking such as
  `a***@b.dev`): where the logger masks by key name it passes
  `{ name: <the key>, source: "@roastery/aroma" }`; where it redacts a
  sensitive `ValueObject` it passes the VO's own `[Context]`, whose `source` is
  the owning aggregate.
- `AromaException` now forwards `cause` through the native `ErrorOptions` slot
  that every `terroir` 0.2.x exception accepts, instead of assigning
  `this.cause` after `super()` — the slot is populated during construction.

### Fixed

- **A `sensitive` domain property could be logged in the clear.**
  `Entity.toJSON()` and `DomainRecord.toJSON()` are the persistence contract:
  lossless and deliberately unredacted. `JSON.stringify` — which the serialiser,
  `safeStringify` and `ConsoleTransport` all reach — calls exactly that, so
  `log.info({ user }, "created")` wrote the password out. The redact processor
  could not catch it: it is shallow, and the top-level key (`user`) is not
  itself sensitive — the leak sat one level below. A bare `ValueObject` had the
  same problem from the other side, serialising as `{"value":"…"}` because
  `value` is a public enumerable field and the class has no `toJSON`. Both are
  closed by the domain processor.
- Migrated to the `terroir` 0.2.x symbol layout: `ExceptionLayer` (from the
  removed `@roastery/terroir/exceptions/symbols` subpath) is now `Layer` from
  `@roastery/terroir/symbols`. The package did not typecheck against 0.2.2
  before this.
- `tsconfig.json` no longer sets `baseUrl`, which TypeScript 7 removed; the
  `@/*` alias is now a tsconfig-relative path.

### Tests

- New `domain-safe` specs covering every detection branch against **real**
  `beans` instances rather than doubles, including the runtime-minted
  `arrayOf` wrapper (which has no exported class to match on, only the
  `toSafeJSON` contract) and a `redactWith` function placeholder.
- New end-to-end leak regression: a real `Entity` with a `sensitive` property,
  logged through `createAroma`, asserted absent from the serialised line — plus
  a spec pinning the *premise*, that `Entity.toJSON()` does **not** redact, so
  the day `beans` closes the gap itself the processor is flagged rather than
  quietly becoming dead code.
- New `serializeError` spec covering `code` presence per layer, and new
  `redactShallow` specs covering `configureRedaction` in both its value and
  function forms.

## [0.0.2] - 2026-06-16

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
