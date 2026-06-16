# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Buffered transports now flush on the next event-loop tick.**
  `FastStdioTransport` / `FileTransport` previously only scheduled a flush once
  the buffer crossed `bufferSize` (4 KB), so low-volume `info`/`warn` logs were
  stranded in memory — and lost entirely if a short-lived process exited before
  the buffer filled. `BufferedWriter.push()` now schedules a flush every tick
  (coalescing repeated writes into one syscall), so logs appear without an
  explicit `flush()`. `bufferSize` is now an advisory hint and no longer gates
  flush timing. `error`/`fatal` remain synchronous.

### Fixed

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

- Added ECS round-trip tests through `serializeEvent` and a real transport.
- Added a `WorkerTransport` end-to-end spec covering the structured-clone
  boundary (plain + ECS events), the `onError`/worker-crash path, and a
  `BigInt` serializer test.
- Added `FileTransport` coverage for interval-timer rotation (via fake timers)
  and the hourly rotation suffix.
- Wired the `test/` setup helpers via `bunfig.toml` `preload`.
